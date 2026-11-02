/** `v["a"]["b"][0]` of serde_json: a missing step gives undefined instead of failing. */
export function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const p of path) {
    if (typeof p === "number") cur = Array.isArray(cur) ? cur[p] : undefined;
    else cur = typeof cur === "object" && cur !== null && !Array.isArray(cur) ? (cur as Record<string, unknown>)[p] : undefined;
  }
  return cur;
}

export const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const asUint = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
