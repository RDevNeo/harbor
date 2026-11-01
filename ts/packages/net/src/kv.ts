export interface Kv {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del?(key: string): void;
}

export class MemKv implements Kv {
  readonly map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k, v);
  }
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  del(key: string): void {
    this.map.delete(key);
  }
}

export function kvJson<T>(kv: Kv, key: string, fallback: T): T {
  const t = kv.get(key);
  if (t === null) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

/** Unix seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
