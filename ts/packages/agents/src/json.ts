// Reading untyped JSON the way serde_json's `Value` indexing does: a missing key or a wrong type
// reads as null, never throws.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return null;
    if (Array.isArray(cur)) {
      if (typeof k !== "number") return null;
      cur = cur[k];
    } else {
      if (typeof k !== "string") return null;
      cur = Object.prototype.hasOwnProperty.call(cur, k) ? (cur as Record<string, unknown>)[k] : null;
    }
    if (cur === undefined) return null;
  }
  return cur;
}

export function isNull(v: unknown): boolean {
  return v === null || v === undefined;
}

export function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function f64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function u64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function i64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Keys in byte order at every level, as serde_json's default map (a BTreeMap) keeps them. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = obj(v);
  if (!o) return v ?? null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort(byteOrder)) out[k] = sortKeys(o[k]);
  return out;
}

function byteOrder(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

/** `Value::to_string()`. */
export function compact(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

/** `serde_json::to_string_pretty`. */
export function pretty(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2);
}

/** Rust's `chars().take(n)`: whole code points. */
export function takeChars(s: string, n: number): string {
  let out = "";
  let i = 0;
  for (const c of s) {
    if (i++ >= n) break;
    out += c;
  }
  return out;
}

/** Rust's `lines().next().unwrap_or("")`. */
export function firstLine(s: string): string {
  const i = s.indexOf("\n");
  if (i < 0) return s;
  const l = s.slice(0, i);
  return l.endsWith("\r") ? l.slice(0, -1) : l;
}
