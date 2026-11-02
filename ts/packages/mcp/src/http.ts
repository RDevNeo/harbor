import { createHash, randomBytes } from "node:crypto";
import { type Json, parseJson } from "./json.ts";

export interface Reply {
  status: number;
  body: Json;
}

/** One request; a non-JSON answer comes back as its first 300 characters. */
export async function http(method: string, url: string, ctype?: string, body?: string): Promise<Reply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (ctype !== undefined) headers["Content-Type"] = ctype;
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (ctype !== undefined) init.body = body ?? "";
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  return { status: res.status, body: parseJson(text) ?? Array.from(text).slice(0, 300).join("") };
}

export async function getJson(url: string): Promise<Record<string, Json> | undefined> {
  try {
    const r = await http("GET", url);
    if (r.status === 200 && typeof r.body === "object" && r.body !== null && !Array.isArray(r.body)) return r.body;
  } catch {
    // an unreachable well-known address just isn't there
  }
  return undefined;
}

export function enc(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function form(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
}

export function dec(s: string): string {
  const b = new TextEncoder().encode(s);
  const out: number[] = [];
  const hex = (c: number | undefined): number | undefined => {
    if (c === undefined) return undefined;
    const d = Number.parseInt(String.fromCharCode(c), 16);
    return c < 128 && !Number.isNaN(d) ? d : undefined;
  };
  for (let i = 0; i < b.length; i++) {
    const c = b[i] as number;
    if (c === 0x2b) out.push(0x20);
    else if (c === 0x25 && i + 2 < b.length) {
      const h = hex(b[i + 1]);
      const l = hex(b[i + 2]);
      if (h !== undefined && l !== undefined) {
        out.push((h << 4) | l);
        i += 2;
      } else out.push(c);
    } else out.push(c);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

export function sha256(data: string | Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

export function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function random(n: number): Uint8Array {
  return randomBytes(n);
}
