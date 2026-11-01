import { connect as tcpConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { ConnPeer } from "./api.ts";
import { unreachable } from "./client.ts";
import { sendJson, segments, type Reader, type Request } from "./http.ts";
import type { Hub } from "./hub.ts";
import { canonical, ipString, parseIp } from "./ip.ts";
import { label, socketAddr, type Allowed } from "./shared.ts";
import { DEFAULT_PORT, hostPort, normalizeFp, tailnetIp } from "./tls.ts";

const CONNECT = 3000;
/** A relayed stream with no traffic this long is closed. */
export const RELAY_IDLE = 15 * 60 * 1000;

/** "host:port" candidates for a peer at `port`: the IPs it's known by, its network's first. */
export function relayTargets(addrs: string[], port: number): string[] {
  const v: string[] = [];
  for (const a of addrs) {
    const sa = socketAddr(a);
    if (!sa) continue;
    const t = hostPort(sa.ip, port);
    if (!v.includes(t)) v.push(t);
  }
  const ts = (a: string) => (tailnetIp(socketAddr(a)?.ip ?? "") ? 1 : 0);
  return v.map((a, i) => ({ a, i })).sort((x, y) => ts(x.a) - ts(y.a) || x.i - y.i).map((e) => e.a);
}

function tcp(addr: string): Promise<Socket | null> {
  const sa = socketAddr(addr);
  if (!sa) return Promise.resolve(null);
  return new Promise((resolve) => {
    const s = tcpConnect({ host: sa.ip, port: sa.port });
    const t = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, CONNECT);
    s.once("connect", () => {
      clearTimeout(t);
      s.removeAllListeners("error");
      s.setNoDelay(true);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

/** The first of `to` that accepts a TCP connection. */
export async function dial(to: string[], env: Record<string, string | undefined> = process.env): Promise<Socket | null> {
  for (const a of to) {
    if (unreachable(a, env)) continue;
    const s = await tcp(a);
    if (s) return s;
  }
  return null;
}

/** Copies both ways until both sides end or nothing moves for `idle`; half-closes pass through. */
export function pump(a: Duplex, b: Duplex, pre: Buffer, idle = RELAY_IDLE): void {
  let timer = setTimeout(() => stop(), idle);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(), idle);
  };
  const stop = () => {
    clearTimeout(timer);
    a.destroy();
    b.destroy();
  };
  if (pre.length > 0) b.write(pre);
  a.on("data", (d: Buffer) => {
    touch();
    if (!b.write(d)) a.pause();
  });
  b.on("data", (d: Buffer) => {
    touch();
    if (!a.write(d)) b.pause();
  });
  a.on("drain", () => b.resume());
  b.on("drain", () => a.resume());
  a.on("end", () => b.end());
  b.on("end", () => a.end());
  a.on("error", stop);
  b.on("error", stop);
  a.on("close", () => {
    if (b.writableEnded) stop();
  });
  b.on("close", () => {
    if (a.writableEnded) stop();
  });
  a.resume();
  b.resume();
}

export interface RelayDeps {
  hub: Hub;
  myFp: () => string;
  /** A signed-in phone of the workspace (api.ts `caller` without a level). */
  isPhone: (peer: ConnPeer, req: Request) => boolean;
  env?: Record<string, string | undefined>;
}

/** `POST /relay/v1/<fp>/<port>` on the API listener: an error, or 200 and then the stream. */
export async function relayServe(d: RelayDeps, peer: ConnPeer, req: Request, r: Reader, w: Duplex): Promise<void> {
  const segs = segments(req.path);
  const fp = normalizeFp(segs[2] ?? "");
  const portText = segs[3] ?? "";
  const port = /^\d+$/.test(portText) && Number(portText) <= 65535 ? Number(portText) : null;
  if (fp === null || port === null) return sendJson(w, 400, { error: "bad relay request" });
  if (peer.via.kind !== "tls" || peer.via.fp === null) return sendJson(w, 403, { error: "a relay needs TLS and a key" });
  const caller = peer.via.fp;
  const pc = d.hub.mesh.allowedFp(caller) !== null;
  const phone = !pc && d.hub.enabled && d.isPhone(peer, req);
  if (!pc && !phone) return sendJson(w, 403, { error: "only paired PCs and phones may use this PC as a relay" });
  const target = fp !== d.myFp() && fp !== caller ? d.hub.mesh.allowedFp(fp) : null;
  if (!target) return sendJson(w, 404, { error: "that PC isn't paired with this one" });
  const known = d.hub.mesh.addrsOfFp(fp);
  const harborPort = [...known, ...target.addrs].map((a) => socketAddr(a)?.port).find((p) => p !== undefined) ?? DEFAULT_PORT;
  if (phone && port !== harborPort) return sendJson(w, 403, { error: "a phone may only reach a PC's Harbor" });
  const out = await dial(relayTargets(known, port), d.env ?? process.env);
  if (!out) return sendJson(w, 502, { error: `${target.name === "" ? "that PC" : target.name} doesn't answer from here either` });
  w.write("HTTP/1.1 200 Connection established\r\n\r\n");
  pump(w, out, r.detach());
}

/** The paired PC a remote device is: by peer id, name, or one of its addresses. */
export function findPc(list: Allowed[], device: string, host: string): Allowed | null {
  const lbl = host.split(".")[0] ?? host;
  const ip = parseIp(host.replace(/^\[|\]$/g, ""));
  const ipText = ip ? ipString(canonical(ip)) : null;
  return (
    list
      .filter((a) => a.fp !== "")
      .find(
        (a) =>
          (device !== "" && a.id === device) ||
          (a.id !== "" && a.id === host) ||
          a.name.toLowerCase() === lbl.toLowerCase() ||
          label(a.id).toLowerCase() === lbl.toLowerCase() ||
          (ipText !== null && a.addrs.some((x) => socketAddr(x)?.ip === ipText)),
      ) ?? null
  );
}
