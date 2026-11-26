// Numbers and times the way Collector shows them (the PC and the phone get them already written).

export function compactCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const a = Math.abs(n);
  const f = (v: number, s: string): string => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${s}`;
  if (a >= 1e9) return f(n / 1e9, "B");
  if (a >= 1e6) return f(n / 1e6, "M");
  if (a >= 1e3) return f(n / 1e3, "K");
  return String(n);
}

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === "" || iso === 0) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = (now - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = s / 86_400;
  if (d < 2) return "yesterday";
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

/** Day-level age, as an upload date reads ("today", "3 days ago"). */
export function dayAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = (now - t) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}
