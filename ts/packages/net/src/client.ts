import { connect as tcpConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { canonical, isLoopback, parseIp } from "./ip.ts";
import { socketAddr, type Dest } from "./shared.ts";
import { rewound, connect as tlsConnect, tailnetIp, type Identity } from "./tls.ts";
import { wire, type Json } from "./wire.ts";

const CONNECT = 3000;
const MAX_ANSWER = 64 << 20;

let hello: { id: string; name: string } = { id: "", name: "" };
let me: Identity | null = null;

/** This PC was renamed: its requests to peers carry the new name (the id and key stay). */
export function setHelloName(name: string): void {
  hello = { ...hello, name };
}

/** Who this PC says it is on its requests to peers, and the key it shows. */
export function setHello(id: string, name: string, identity: Identity | null): void {
  hello = { id, name };
  me = identity;
}

export function identity(): Identity {
  if (!me) throw new Error("no TLS identity");
  return me;
}

export interface Answer {
  status: number;
  ctype: string;
  range: string;
  body: Uint8Array;
}

export interface Body {
  ctype: string;
  data: Uint8Array | string;
}

/** HARBOR_UNREACHABLE=ip:port,…: addresses this instance can't reach directly (tests on one PC). */
export function unreachable(addr: string, env: Record<string, string | undefined> = process.env): boolean {
  const l = env.HARBOR_UNREACHABLE;
  if (l === undefined) return false;
  const a = socketAddr(addr)?.text;
  return a !== undefined && l.split(",").some((x) => socketAddr(x.trim())?.text === a);
}

function tcp(host: string, port: number, ms: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("connection timed out"));
    }, ms);
    s.once("connect", () => {
      clearTimeout(t);
      s.setNoDelay(true);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      reject(new Error(e.code === "ECONNREFUSED" ? `connection refused (${e.message})` : e.message));
    });
  });
}

/** Reads one HTTP head off a stream, byte-exact: what follows stays in `rest`. */
export function readAnswerHead(s: Duplex, max = 64 << 10): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (e: Error | null, v?: { head: string; rest: Buffer }) => {
      s.off("data", onData);
      s.off("end", onEnd);
      s.off("error", onErr);
      if (e) reject(e);
      else if (v) resolve(v);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i >= 0) {
        s.pause();
        done(null, { head: buf.subarray(0, i).toString("latin1"), rest: buf.subarray(i + 4) });
      } else if (buf.length > max) done(new Error("head too large"));
    };
    const onEnd = () => done(new Error("closed before an answer"));
    const onErr = (e: Error) => done(e);
    s.on("data", onData);
    s.once("end", onEnd);
    s.once("error", onErr);
    s.resume();
  });
}

function readExact(s: Duplex, pre: Buffer, len: number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [pre];
    let got = pre.length;
    const finish = () => {
      cleanup();
      const all = Buffer.concat(parts);
      if (len !== null && all.length < len) reject(new Error("the answer came cut short"));
      else resolve(len === null ? all : all.subarray(0, len));
    };
    const onData = (d: Buffer) => {
      parts.push(d);
      got += d.length;
      if (got > MAX_ANSWER) {
        cleanup();
        reject(new Error("answer too large"));
      } else if (len !== null && got >= len) finish();
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      s.off("data", onData);
      s.off("end", finish);
      s.off("close", finish);
      s.off("error", onErr);
    };
    if (len !== null && got >= len) {
      resolve(pre.subarray(0, len));
      return;
    }
    s.on("data", onData);
    s.once("end", finish);
    s.once("close", finish);
    s.once("error", onErr);
    s.resume();
  });
}

export function parseStatus(head: string): number {
  const n = Number(head.split("\r\n")[0]?.split(/\s+/)[1]);
  return Number.isInteger(n) ? n : 0;
}

export function headerOf(head: string, name: string): string | null {
  for (const l of head.split("\r\n").slice(1)) {
    const i = l.indexOf(":");
    if (i > 0 && l.slice(0, i).trim().toLowerCase() === name) return l.slice(i + 1).trim();
  }
  return null;
}

const clean = (s: string) => s.replace(/[\r\n]/g, "");

/** Writes a request and reads its answer on an open connection (mesh.rs `exchange`). */
export async function exchange(s: Duplex, host: string, method: string, path: string, body: Body | null, range = "", wait = 20_000): Promise<Answer> {
  const data = body ? (typeof body.data === "string" ? Buffer.from(body.data) : Buffer.from(body.data)) : Buffer.alloc(0);
  const ctype = body?.ctype ?? "application/json";
  const r = range === "" ? "" : `Range: ${clean(range)}\r\n`;
  const head = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nX-Harbor-Id: ${clean(hello.id)}\r\nX-Harbor-Name: ${clean(hello.name)}\r\n${r}Content-Type: ${ctype}\r\nContent-Length: ${data.length}\r\nConnection: close\r\n\r\n`;
  const timer = setTimeout(() => s.destroy(new Error("timed out")), wait);
  try {
    s.write(Buffer.concat([Buffer.from(head, "latin1"), data]));
    const got = await readAnswerHead(s);
    const status = parseStatus(got.head);
    if (status === 0) throw new Error("not Harbor");
    const lenText = headerOf(got.head, "content-length");
    const len = lenText !== null && /^\d+$/.test(lenText) ? Number(lenText) : null;
    if (len !== null && len > MAX_ANSWER) throw new Error("answer too large");
    const bytes = await readExact(s, got.rest, len);
    return { status, ctype: headerOf(got.head, "content-type") ?? "", range: headerOf(got.head, "content-range") ?? "", body: new Uint8Array(bytes) };
  } finally {
    clearTimeout(timer);
    s.destroy();
  }
}

/** A raw stream to the PC with key `fp`, at `port`, through the PC at `via` (relay.rs `open`). */
export async function relayOpen(via: Dest, fp: string, port: number, wait = 20_000): Promise<Duplex> {
  const sa = socketAddr(via.addr);
  if (!sa) throw new Error("no address");
  const { sock } = await tlsConnect({ id: via.as ?? identity(), pin: via.fp, host: sa.ip, port: sa.port, timeout: CONNECT });
  sock.write(`POST /relay/v1/${fp}/${port} HTTP/1.1\r\nHost: ${via.addr}\r\nContent-Length: 0\r\n\r\n`);
  const timer = setTimeout(() => sock.destroy(new Error("the relay didn't answer")), wait);
  try {
    const { head, rest } = await readAnswerHead(sock, 8192);
    const status = parseStatus(head);
    if (status !== 200) {
      const more = await readExact(sock, rest, null).catch(() => rest);
      let msg = `the relay answered ${status}`;
      try {
        const v: unknown = JSON.parse(more.toString().split("\n")[0] ?? "");
        if (typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string") msg = (v as { error: string }).error;
      } catch {
        // not JSON: the status says it
      }
      sock.destroy();
      throw new Error(msg);
    }
    return rewound(sock, rest);
  } finally {
    clearTimeout(timer);
  }
}

/** An open stream to `dest`: TLS pinned to its key (through its relay if it has one), or plain to loopback/Tailscale. */
export async function open(dest: Dest, wait = 20_000): Promise<Duplex> {
  const sa = socketAddr(dest.addr);
  if (!sa) throw new Error("no address");
  if (dest.via) {
    if (dest.fp === "" || dest.via.via) throw new Error("not sent: a relay needs the peer's key, and only one relay");
    const outer = await relayOpen({ ...dest.via, as: dest.as }, dest.fp, sa.port, wait);
    return (await tlsConnect({ id: dest.as ?? identity(), pin: dest.fp, stream: outer, timeout: wait })).sock;
  }
  if (dest.fp === "") {
    const ip = parseIp(sa.ip);
    if (!ip || (!isLoopback(canonical(ip)) && !tailnetIp(sa.ip))) throw new Error("not sent: no key on file for this PC (pair it again)");
    return tcp(sa.ip, sa.port, CONNECT);
  }
  if (unreachable(dest.addr)) throw new Error("unreachable (HARBOR_UNREACHABLE)");
  return (await tlsConnect({ id: dest.as ?? identity(), pin: dest.fp, host: sa.ip, port: sa.port, timeout: CONNECT })).sock;
}

/** A request to a peer as it came: status, content type, Content-Range and bytes. */
export async function httpPart(dest: Dest, method: string, path: string, body: Body | null, range: string, wait: number): Promise<Answer> {
  const s = await open(dest, wait);
  return exchange(s, dest.addr, method, path, body, range, wait);
}

export function httpRaw(dest: Dest, method: string, path: string, body: Body | null, wait: number): Promise<Answer> {
  return httpPart(dest, method, path, body, "", wait);
}

/** One request to a peer: [status, JSON body (null when empty)]. */
export async function http(dest: Dest, method: string, path: string, body: Body | null, wait: number): Promise<[number, unknown]> {
  const a = await httpRaw(dest, method, path, body, wait);
  if (a.body.length === 0) return [a.status, null];
  return [a.status, JSON.parse(Buffer.from(a.body).toString("utf8")) as unknown];
}

export function jsonBody(v: Json): Body {
  return { ctype: "application/json", data: wire(v) };
}

/** GET that must answer 200 (mesh.rs `get`). */
export async function get(dest: Dest, path: string, wait: number): Promise<unknown> {
  const [status, v] = await http(dest, "GET", path, null, wait);
  if (status === 200) return v;
  const e = typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string" ? (v as { error: string }).error : "";
  throw new Error(`${status}: ${e}`);
}
