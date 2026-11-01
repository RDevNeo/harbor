import type { Duplex } from "node:stream";
import { wire, type Json } from "./wire.ts";

export interface Request {
  method: string;
  path: string;
  query: [string, string][];
  headers: [string, string][];
  len: number;
  chunked: boolean;
}

export function header(r: Request, k: string): string | null {
  return r.headers.find(([h]) => h === k)?.[1] ?? null;
}

export function query(r: { query: [string, string][] }, k: string): string | null {
  return r.query.find(([q]) => q === k)?.[1] ?? null;
}

export function bearer(r: Request): string | null {
  const v = header(r, "authorization");
  if (v === null) return null;
  const i = v.indexOf(" ");
  if (i < 0 || v.slice(0, i).toLowerCase() !== "bearer") return null;
  const t = v.slice(i + 1).trim();
  return t === "" ? null : t;
}

/** "/v1/chats/3" → ["v1","chats","3"]. */
export function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/** %xx and '+' decoding of a query part (bad escapes stay as they are; invalid UTF-8 → U+FFFD). */
export function urlDecode(s: string): string {
  const b = Buffer.from(s);
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i] ?? 0;
    if (c === 0x2b) out.push(0x20);
    else if (c === 0x25 && i + 2 < b.length) {
      const h = b.subarray(i + 1, i + 3).toString("latin1");
      if (/^[0-9a-fA-F]{2}$/.test(h)) {
        out.push(parseInt(h, 16));
        i += 2;
      } else out.push(0x25);
    } else out.push(c);
  }
  return new TextDecoder().decode(Uint8Array.from(out));
}

/** Percent-encoding for a URI component (unreserved characters kept). */
export function urlEncode(s: string): string {
  return Array.from(Buffer.from(s), (c) =>
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e
      ? String.fromCharCode(c)
      : `%${c.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A buffered reader over a stream: lines, exact byte counts, what's left. */
export class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private failed: Error | null = null;
  private wake: (() => void) | null = null;

  private onData = (d: Buffer) => {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
    if (this.buf.length > 1 << 20) this.s.pause();
    this.poke();
  };
  private onEnd = () => {
    this.ended = true;
    this.poke();
  };
  private onError = (e: Error) => {
    this.failed = e;
    this.poke();
  };

  constructor(readonly s: Duplex) {
    s.on("data", this.onData);
    s.on("end", this.onEnd);
    s.on("close", this.onEnd);
    s.on("error", this.onError);
    s.resume();
  }

  /** Stops reading: the stream is someone else's now, with what was buffered. */
  detach(): Buffer {
    this.s.pause();
    this.s.off("data", this.onData);
    this.s.off("end", this.onEnd);
    this.s.off("close", this.onEnd);
    this.s.off("error", this.onError);
    return this.rest();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private more(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.ended) return Promise.resolve();
    this.s.resume();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  /** One line without its CRLF; at most `max` bytes with the newline (else 431). */
  async line(max: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0 && i + 1 <= max + 1) {
        if (i + 1 > max) throw new HttpError(431, "request header too long");
        const l = this.buf.subarray(0, i + 1);
        this.buf = this.buf.subarray(i + 1);
        return new TextDecoder().decode(l).replace(/[\r\n]+$/, "");
      }
      if (this.buf.length > max) throw new HttpError(431, "request header too long");
      if (this.ended || this.failed) {
        if (this.buf.length === 0) throw new HttpError(400, "empty request");
        const l = this.buf;
        this.buf = Buffer.alloc(0);
        return new TextDecoder().decode(l).replace(/[\r\n]+$/, "");
      }
      await this.more().catch(() => {
        throw new HttpError(400, "unreadable request");
      });
    }
  }

  /** Exactly `n` bytes, or what came before the end. */
  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n && !this.ended && !this.failed) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  /** What's buffered and not read yet. */
  rest(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }
}

function decodePath(p: string): string {
  return urlDecode(p.replaceAll("+", "%2B"));
}

/** The request line and headers; chunked bodies only when `chunked` is allowed. */
export async function readHead(r: Reader, chunked = false): Promise<Request> {
  const first = await r.line(8192);
  const parts = first.split(" ");
  const [method = "", target = "", version] = parts;
  if (version === undefined || !version.startsWith("HTTP/1.") || method === "" || !target.startsWith("/")) throw new HttpError(400, "bad request line");
  const qi = target.indexOf("?");
  const path = qi < 0 ? target : target.slice(0, qi);
  const q = qi < 0 ? "" : target.slice(qi + 1);
  const req: Request = {
    method: method.toUpperCase(),
    path: decodePath(path),
    query: q
      .split("&")
      .filter((p) => p !== "")
      .map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [urlDecode(p), ""] : [urlDecode(p.slice(0, i)), urlDecode(p.slice(i + 1))];
      }),
    headers: [],
    len: 0,
    chunked: false,
  };
  for (let n = 0; n < 100; n++) {
    const l = await r.line(8192);
    if (l === "") {
      if (req.chunked && !chunked) throw new HttpError(411, "send a content-length");
      return req;
    }
    const i = l.indexOf(":");
    if (i < 0) throw new HttpError(400, "bad header");
    const k = l.slice(0, i).trim().toLowerCase();
    const v = l.slice(i + 1).trim();
    if (k === "content-length") {
      if (!/^\d+$/.test(v)) throw new HttpError(400, "bad content-length");
      req.len = Number(v);
    }
    if (k === "transfer-encoding" && v.toLowerCase() !== "identity") {
      if (v.toLowerCase() !== "chunked") throw new HttpError(411, "send a content-length");
      req.chunked = true;
    }
    req.headers.push([k, v]);
  }
  throw new HttpError(431, "too many headers");
}

/** A body of `len` bytes of at most `max`: 413 past it, 400 when it comes short. */
export async function readBody(r: Reader, len: number, max: number): Promise<Buffer> {
  if (len > max) throw new HttpError(413, "body too large");
  const b = await r.take(len);
  if (b.length !== len) throw new HttpError(400, "short body");
  return b;
}

/** A chunked body of at most `max` bytes. */
export async function readChunked(r: Reader, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let got = 0;
  for (;;) {
    const size = (await r.line(1024)).split(";")[0]?.trim() ?? "";
    if (!/^[0-9a-fA-F]+$/.test(size)) throw new HttpError(400, "bad chunk");
    const n = parseInt(size, 16);
    if (n === 0) {
      for (let i = 0; i < 100; i++) if ((await r.line(8192)) === "") return Buffer.concat(parts);
      throw new HttpError(400, "bad chunk");
    }
    if (n > max - got) throw new HttpError(413, "body too large");
    const b = await r.take(n);
    if (b.length !== n || (await r.line(16)) !== "") throw new HttpError(400, "bad chunk");
    parts.push(b);
    got += n;
  }
}

const STATUS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  206: "Partial Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  411: "Length Required",
  413: "Payload Too Large",
  416: "Range Not Satisfiable",
  426: "Status",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export function response(status: number, ctype: string, len: number, extra = ""): string {
  return `HTTP/1.1 ${status} ${STATUS[status] ?? "Status"}\r\nContent-Type: ${ctype}\r\nContent-Length: ${len}\r\nCache-Control: no-store\r\nConnection: close\r\n${extra}\r\n`;
}

/** Writes a JSON answer and closes the write side. */
export function sendJson(w: Duplex, status: number, v: Json): void {
  const body = Buffer.from(wire(v));
  w.end(Buffer.concat([Buffer.from(response(status, "application/json; charset=utf-8", body.length)), body]));
}

export function sendBytes(w: Duplex, status: number, ctype: string, body: Uint8Array, extra = ""): void {
  w.end(Buffer.concat([Buffer.from(response(status, ctype, body.length, extra)), body]));
}

export interface Reply {
  status: number;
  body: Json;
}

export function ok(body: Json): Reply {
  return { status: 200, body };
}

export function err(status: number, msg: string): Reply {
  return { status, body: { error: msg } };
}

/** A body as JSON: whitespace-only is null; bad JSON is 400 "bad JSON: …". */
export function parseJson(b: Uint8Array): unknown {
  const t = Buffer.from(b).toString("utf8");
  if (t.trim() === "") return null;
  try {
    return JSON.parse(t) as unknown;
  } catch (e) {
    throw new HttpError(400, `bad JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}
