export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Obj = { [k: string]: Json };

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function get(v: Json | undefined, k: string): Json {
  return isObj(v) ? (v[k] ?? null) : null;
}

export const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export const uint = (v: Json | undefined): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

export const items = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

export function parse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** Objects with their keys in order, as the tools' replies have always had them. */
export function sorted(v: Json): Json {
  if (Array.isArray(v)) return v.map(sorted);
  if (isObj(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k] ?? null)]));
  }
  return v;
}

export const pretty = (v: Json): string => (typeof v === "string" ? v : JSON.stringify(sorted(v), null, 2));

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
