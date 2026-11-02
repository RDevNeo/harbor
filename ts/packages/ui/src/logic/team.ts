// `off` is the local zone's UTC offset in seconds.
import { remEuclid } from "./cost.ts";

/** "14:05" in local time. */
export function localHm(ts: number, off: number): string {
  const s = remEuclid(ts + off, 86400);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** "11:40 AM" in local time. */
export function clock(ts: number, off: number): string {
  const s = remEuclid(ts + off, 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** How long until `ts`: "<1m", "20m", "2h05m". */
export function until(ts: number, now: number): string {
  const d = Math.max(0, ts - now);
  if (d < 60) return "<1m";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, "0")}m`;
}
