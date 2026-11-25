// Hub's phones pair with this PC directly: no account service, no directory, no workspace.
//
// 1. `hub pair` (or Settings) asks the running Hub for a one-time code (`POST v1/pair/start` through the control
//    socket only): 10 base32 characters, good for 10 minutes and one phone. It is shown with a `hub://pair?…` link
//    (and its QR) that also carries this PC's name, key fingerprint, port and addresses.
// 2. The phone connects with mutual TLS pinned to that fingerprint, showing its own key, and sends
//    `POST /v1/pair {code, name}` with no token. A right code gives it a device token (`hubd_…`).
// 3. Every later call carries `Authorization: Bearer hubd_…`, and only counts from the same key (fingerprint) that
//    paired. Only the token's SHA-256 is kept (kv `hub_devices`).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PhoneClaims } from "./hub.ts";

export interface PairKv {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

export interface PairedHubDevice {
  fp: string;
  name: string;
  /** sha256 of the token, hex. */
  token_sha256: string;
  /** Unix seconds. */
  created: number;
}

/** What api.ts asks of the phones' sign-in (the shape of Harbor's account `phoneAuth()`). */
export interface PhoneAuth {
  isToken(t: string): boolean;
  admit(t: string, fp: string): PhoneClaims;
  knownDevice(fp: string): boolean;
}

export const DEVICES_KEY = "hub_devices";
export const TOKEN_PREFIX = "hubd_";
export const CODE_TTL_MS = 10 * 60_000;
const CODE_LEN = 10;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FP = /^[0-9a-f]{64}$/;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A code as typed: case and spaces/dashes don't matter. */
export function normalizePairCode(c: string): string {
  return c.toUpperCase().replace(/[\s-]/g, "");
}

export function newPairCode(bytes: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const b = bytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += B32[(b[i] ?? 0) & 31];
  return out;
}

export interface PairLinkInfo {
  name: string;
  /** The PC's mesh id. */
  id: string;
  fp: string;
  /** "host:port" each ("[v6]:port"). */
  addrs: string[];
  code: string;
}

/** The link the phone scans (android/PROTOCOL.md "Hub pairing"): hub://pair?fp=…&addrs=host:port,…&name=…&id=…&code=… */
export function pairLink(i: PairLinkInfo): string {
  const q = new URLSearchParams({ fp: i.fp, addrs: i.addrs.join(","), name: i.name, id: i.id, code: i.code });
  return `hub://pair?${q.toString()}`;
}

export function parsePairLink(link: string): PairLinkInfo | null {
  if (!link.startsWith("hub://pair?")) return null;
  const q = new URLSearchParams(link.slice("hub://pair?".length));
  const fp = q.get("fp") ?? "";
  const code = normalizePairCode(q.get("code") ?? "");
  if (!FP.test(fp) || code === "" || code.length > 128) return null;
  return { name: q.get("name") ?? "", id: q.get("id") ?? "", fp, addrs: (q.get("addrs") ?? "").split(",").filter((a) => a !== ""), code };
}

export class HubPairing {
  private code: { code: string; until: number } | null = null;

  constructor(
    private readonly kv: PairKv,
    private readonly now: () => number = Date.now,
    private readonly bytes: (n: number) => Uint8Array = (n) => randomBytes(n),
  ) {}

  devices(): PairedHubDevice[] {
    try {
      const v = JSON.parse(this.kv.get(DEVICES_KEY) ?? "[]") as unknown;
      if (!Array.isArray(v)) return [];
      return v.filter((d): d is PairedHubDevice => typeof d === "object" && d !== null && FP.test(String((d as PairedHubDevice).fp)) && typeof (d as PairedHubDevice).token_sha256 === "string");
    } catch {
      return [];
    }
  }

  private save(list: PairedHubDevice[]): void {
    this.kv.set(DEVICES_KEY, JSON.stringify(list));
  }

  /** A new one-time code (the last one stops working). */
  start(): { code: string; expires_ms: number } {
    const code = newPairCode(this.bytes);
    this.code = { code, until: this.now() + CODE_TTL_MS };
    return { code, expires_ms: this.code.until };
  }

  /** The code shown now, if it's still good. */
  current(): { code: string; expires_ms: number } | null {
    return this.code && this.code.until > this.now() ? { code: this.code.code, expires_ms: this.code.until } : null;
  }

  /** A phone with key `fp` sent `code`: its token, or why not. A phone that pairs again gets a new token (the old one ends). */
  pair(code: string, fp: string, name: string): { ok: true; token: string } | { ok: false; error: string } {
    const c = this.code;
    if (c === null || c.until <= this.now()) return { ok: false, error: "No pairing code is open on this PC: run `hub pair` there and try again" };
    if (!sameText(normalizePairCode(code), c.code)) return { ok: false, error: "That pairing code isn't the one this PC shows" };
    if (!FP.test(fp)) return { ok: false, error: "Pairing needs the phone's own key (TLS)" };
    this.code = null;
    const token = `${TOKEN_PREFIX}${Buffer.from(this.bytes(32)).toString("base64url")}`;
    const label = Array.from(name.trim()).filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20).slice(0, 60).join("") || "Phone";
    const list = this.devices().filter((d) => d.fp !== fp);
    list.push({ fp, name: label, token_sha256: sha(token), created: Math.floor(this.now() / 1000) });
    this.save(list);
    return { ok: true, token };
  }

  /** Forgets a paired phone (by key): its token stops working. */
  revoke(fp: string): boolean {
    const list = this.devices();
    const kept = list.filter((d) => d.fp !== fp);
    if (kept.length === list.length) return false;
    this.save(kept);
    return true;
  }

  /** A call with no token from a paired phone's own key (android/PROTOCOL.md "Hub pairing": the key is the pairing). */
  byKey(fp: string): PhoneClaims | null {
    const d = this.devices().find((x) => x.fp === fp);
    return d ? { sub: `hub:${d.fp}`, email: "", name: d.name } : null;
  }

  auth(): PhoneAuth {
    return {
      isToken: (t) => t.startsWith(TOKEN_PREFIX),
      admit: (t, fp) => {
        const h = sha(t);
        const d = this.devices().find((x) => sameText(x.token_sha256, h));
        if (!d) throw new Error("This phone isn't paired with this PC (or was removed): pair it again");
        if (d.fp !== fp) throw new Error("That token belongs to another phone's key: pair this phone again");
        return { sub: `hub:${d.fp}`, email: "", name: d.name };
      },
      knownDevice: (fp) => this.devices().some((d) => d.fp === fp),
    };
  }
}

/** The addresses a pairing link offers: the network's IPv4 first, then Tailscale's (100.64/10), then IPv6 in brackets; no loopback. */
export function pairAddrs(all: readonly string[], port: number): string[] {
  const v4 = all.filter((a) => !a.includes(":") && !a.startsWith("127."));
  const tail = (a: string): boolean => {
    const m = /^100\.(\d+)\./.exec(a);
    return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
  };
  const v6 = all.filter((a) => a.includes(":") && a !== "::1" && !a.toLowerCase().startsWith("fe80")).map((a) => `[${a}]`);
  return [...v4.filter((a) => !tail(a)), ...v4.filter(tail), ...v6].map((a) => `${a}:${port}`);
}

/** A phone's call is let in by its pairing token (`hubd_…`) or, once Hub has its account service, by a sign-in token. */
export function hubPhoneAuth(paired: PhoneAuth, account: PhoneAuth | null): PhoneAuth {
  return {
    isToken: (t) => paired.isToken(t) || (account?.isToken(t) ?? false),
    admit: (t, fp) => (paired.isToken(t) || account === null ? paired.admit(t, fp) : account.admit(t, fp)),
    knownDevice: (fp) => paired.knownDevice(fp) || (account?.knownDevice(fp) ?? false),
  };
}
