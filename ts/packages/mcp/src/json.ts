export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

export function parseObject(text: string): JsonObject | undefined {
  const v = parseJson(text);
  return isObject(v) ? v : undefined;
}

export function str(v: unknown, key: string): string | undefined {
  if (!isObject(v)) return undefined;
  const x = v[key];
  return typeof x === "string" ? x : undefined;
}

export function int(v: unknown, key: string): number | undefined {
  if (!isObject(v)) return undefined;
  const x = v[key];
  return typeof x === "number" && Number.isInteger(x) ? x : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
