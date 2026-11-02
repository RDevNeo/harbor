import { isObject } from "./json.ts";

export function argStr(a: unknown, k: string): string | undefined {
  const v = isObject(a) ? a[k] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** A non-negative whole number (serde_json's `as_u64`). */
export function argUint(a: unknown, k: string): number | undefined {
  const v = isObject(a) ? a[k] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function argBool(a: unknown, k: string): boolean | undefined {
  const v = isObject(a) ? a[k] : undefined;
  return typeof v === "boolean" ? v : undefined;
}

export function argStrings(a: unknown, k: string): string[] {
  const v = isObject(a) ? a[k] : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
