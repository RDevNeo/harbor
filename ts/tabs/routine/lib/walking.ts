/**
 * Daily walking distance from Android Health Connect (Samsung Health etc. sync into it). Not a
 * goal: just km per day. Distance totals when present; otherwise steps × 0.75 m, marked "≈".
 * Pure: aggregation, cache merging and formatting. Native reading is in useWalking.ts.
 */
import { addDays, dateKey } from './date'

export const STEP_METERS = 0.75
export const HISTORY_DAYS = 56

export interface WalkDay {
  km: number // 2 decimals
  /** Estimated from steps (no distance data that day). */
  approx?: boolean
}
export type WalkDays = Record<string, WalkDay>

/** One aggregated bucket as the plugin returns it (ISO start/end, value in meters or steps). */
export interface Bucket {
  startDate: string
  endDate: string
  value: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Local day of a bucket: the day containing its midpoint, so 24 h buckets that start an hour off
 * local midnight (a DST change) still land on the right day.
 */
export function bucketDay(b: Pick<Bucket, 'startDate' | 'endDate'>): string {
  const s = Date.parse(b.startDate)
  const e = Date.parse(b.endDate)
  return dateKey(new Date(Number.isFinite(e) && e > s ? s + (e - s) / 2 : s))
}

/** Per-day km from distance buckets (meters), falling back to steps buckets where a day has no distance. */
export function walkDays(distance: Bucket[], steps: Bucket[]): WalkDays {
  const meters: Record<string, number> = {}
  for (const b of distance) if (Number.isFinite(b.value) && b.value > 0) meters[bucketDay(b)] = (meters[bucketDay(b)] ?? 0) + b.value
  const stepCount: Record<string, number> = {}
  for (const b of steps) if (Number.isFinite(b.value) && b.value > 0) stepCount[bucketDay(b)] = (stepCount[bucketDay(b)] ?? 0) + b.value
  const out: WalkDays = {}
  for (const [day, m] of Object.entries(meters)) out[day] = { km: round2(m / 1000) }
  for (const [day, n] of Object.entries(stepCount)) if (!out[day]) out[day] = { km: round2((n * STEP_METERS) / 1000), approx: true }
  return out
}

/**
 * Put a fresh read into the cache: every day from `from` to `to` (inclusive keys) takes the fresh
 * value, and a day there with no data is dropped (it was 0); days outside the range are kept.
 */
export function mergeWalk(cache: WalkDays, fresh: WalkDays, from: string, to: string): WalkDays {
  const out: WalkDays = {}
  for (const [day, v] of Object.entries(cache)) if (day < from || day > to) out[day] = v
  for (const [day, v] of Object.entries(fresh)) if (day >= from && day <= to) out[day] = v
  // keep only what History can show (plus a little)
  const keys = Object.keys(out).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_DAYS - 7))) delete out[k]
  return out
}

/** km Monday..today (local week). */
export function weekKm(days: WalkDays, today: Date): { km: number; approx: boolean } {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let km = 0
  let approx = false
  for (let d = addDays(t, -((t.getDay() + 6) % 7)); d <= t; d = addDays(d, 1)) {
    const w = days[dateKey(d)]
    if (!w) continue
    km += w.km
    approx ||= !!w.approx
  }
  return { km: round2(km), approx }
}

/** "5.24 km", "≈ 3.10 km" (estimated from steps), "0.00 km". */
export function fmtWalk(w: { km: number; approx?: boolean } | undefined | null): string {
  const km = (w?.km ?? 0).toFixed(2)
  return `${w?.approx ? '≈ ' : ''}${km} km`
}
