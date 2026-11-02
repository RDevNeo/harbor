/** A number Rust holds as f64: written "42.0", not "42". */
export class F64 {
  constructor(readonly v: number) {}
}

/** An object written in this key order, as a derived Serialize struct is. */
export class Ordered {
  constructor(readonly entries: [string, Json][]) {}
}

/** JSON already written (an item as store's itemJson writes it), sent as it is. */
export class RawJson {
  constructor(readonly text: string) {}
}

export type Json = null | boolean | number | bigint | string | F64 | Ordered | RawJson | Json[] | { [k: string]: Json | undefined };

function byteCompare(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

function f64(v: number): string {
  if (!Number.isFinite(v)) return "null";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  const s = String(v);
  return s.replace("e+", "e");
}

/** Serializes like serde_json::to_vec on a Value: Rust's `json!` objects are BTreeMaps (no
 * preserve_order feature), so plain objects go out with their keys sorted by bytes. */
export function wire(v: Json | undefined): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : f64(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof F64) return f64(v.v);
  if (v instanceof RawJson) return v.text;
  if (v instanceof Ordered) return `{${v.entries.filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${wire(x)}`).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map(wire).join(",")}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort(byteCompare);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${wire(v[k])}`).join(",")}}`;
}

/** Parsed JSON, before it's checked. */
export type Value = unknown;

export function obj(v: Value): Record<string, Value> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, Value>) : {};
}

export function str(v: Value): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: Value): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function int(v: Value): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** serde_json's as_u64: a non-negative integer. */
export function u64(v: Value): number | null {
  const n = int(v);
  return n !== null && n >= 0 ? n : null;
}

export function bool(v: Value): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function arr(v: Value): Value[] {
  return Array.isArray(v) ? v : [];
}


const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, b: bigint) => ((x << b) | (x >> (64n - b))) & MASK;

function round(s: bigint[]): void {
  let [v0 = 0n, v1 = 0n, v2 = 0n, v3 = 0n] = s;
  v0 = (v0 + v1) & MASK;
  v1 = rotl(v1, 13n);
  v1 ^= v0;
  v0 = rotl(v0, 32n);
  v2 = (v2 + v3) & MASK;
  v3 = rotl(v3, 16n);
  v3 ^= v2;
  v0 = (v0 + v3) & MASK;
  v3 = rotl(v3, 21n);
  v3 ^= v0;
  v2 = (v2 + v1) & MASK;
  v1 = rotl(v1, 17n);
  v1 ^= v2;
  v2 = rotl(v2, 32n);
  s[0] = v0;
  s[1] = v1;
  s[2] = v2;
  s[3] = v3;
}

/** SipHash-1-3 with zero keys over `data` (std's DefaultHasher::finish). */
export function sip13(data: Uint8Array): bigint {
  const s = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const n = data.length;
  const full = n - (n % 8);
  for (let i = 0; i < full; i += 8) {
    let m = 0n;
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(data[i + j] ?? 0);
    s[3] = (s[3] ?? 0n) ^ m;
    round(s);
    s[0] = (s[0] ?? 0n) ^ m;
  }
  let b = BigInt(n & 0xff) << 56n;
  for (let j = n - full - 1; j >= 0; j--) b |= BigInt(data[full + j] ?? 0) << BigInt(8 * j);
  s[3] = (s[3] ?? 0n) ^ b;
  round(s);
  s[0] = (s[0] ?? 0n) ^ b;
  s[2] = (s[2] ?? 0n) ^ 0xffn;
  round(s);
  round(s);
  round(s);
  return ((s[0] ?? 0n) ^ (s[1] ?? 0n) ^ (s[2] ?? 0n) ^ (s[3] ?? 0n)) & MASK;
}

/** Rust's `hash_of(&str)`: the string's bytes and the 0xff that ends a str. */
export function hashStr(s: string): bigint {
  const b = Buffer.from(s);
  return sip13(Buffer.concat([b, Uint8Array.of(0xff)]));
}
