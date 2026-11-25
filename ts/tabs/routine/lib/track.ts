/**
 * Pure GPS track math for rides: fix filtering, distance (haversine) and smoothed elevation gain.
 * No I/O here, so everything is unit-tested.
 */

/** One GPS fix. `t` = epoch ms; accuracies in meters (68% radius / vertical). */
export interface Fix {
  t: number
  lat: number
  lon: number
  acc: number
  alt?: number | null
  altAcc?: number | null
  /** Ground speed reported by the device (m/s, Doppler-based), when available. */
  speed?: number | null
  /** Recording segment (bumped on each resume after a pause). Distance and climb never cross segments. */
  seg?: number
}

const segOf = (p: Pick<Fix, 'seg'>) => p.seg ?? 0
/** Consecutive points that belong to the same segment (no pause between them). */
export const sameSeg = (a: Pick<Fix, 'seg'>, b: Pick<Fix, 'seg'>) => segOf(a) === segOf(b)

/** Ride summary stored on the entry (the full track is stored separately). */
export interface RideSummary {
  km: number
  gainM: number
  durationSec: number
  avgKmh: number
  /** Up to ~32 route points normalized to 0..1 (x → east, y → south) for a thumbnail. */
  thumb?: [number, number][]
}

export const MAX_ACCURACY_M = 25 // drop fixes less accurate than this
export const MIN_STEP_M = 4 // ignore movement smaller than this (standing-still jitter)
export const MAX_SPEED_MS = 25 // ~90 km/h: anything faster between fixes is a GPS jump
export const MAX_ALT_ACC_M = 20 // ignore altitudes with worse vertical accuracy (when reported)
export const MIN_MOVING_SPEED_MS = 0.5 // device-reported speed below this = standing still
export const CLIMB_THRESHOLD_M = 4 // hysteresis for elevation gain (3 m let long noisy rides add 10-40 m)

const R = 6_371_008.8 // mean Earth radius, m
const rad = (d: number) => (d * Math.PI) / 180

/** Great-circle distance in meters. */
export function haversine(a: Pick<Fix, 'lat' | 'lon'>, b: Pick<Fix, 'lat' | 'lon'>): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Should `p` be appended after the last accepted fix `prev`? (The first fix of a new segment starts fresh.) */
export function acceptFix(last: Fix | undefined, p: Fix): boolean {
  const prev = last && sameSeg(last, p) ? last : undefined
  if (![p.lat, p.lon, p.acc, p.t].every(Number.isFinite)) return false
  if (p.acc > MAX_ACCURACY_M) return false
  if (typeof p.speed === 'number' && p.speed < MIN_MOVING_SPEED_MS && prev) return false
  if (!prev) return true
  const dt = (p.t - prev.t) / 1000
  if (dt <= 0) return false
  const d = haversine(prev, p)
  if (d < MIN_STEP_M) return false
  return d / dt <= MAX_SPEED_MS
}

/** Append if accepted; returns the same array when rejected. */
export function addFix(points: Fix[], p: Fix): Fix[] {
  return acceptFix(points[points.length - 1], p) ? [...points, p] : points
}

/** Keep only the fixes that pass the filter, in order. */
export function filterFixes(fixes: Fix[]): Fix[] {
  const out: Fix[] = []
  for (const f of fixes) if (acceptFix(out[out.length - 1], f)) out.push(f)
  return out
}

/** Track length, excluding the gaps between segments (movement while paused doesn't count). */
export function distanceM(points: Fix[]): number {
  let d = 0
  for (let i = 1; i < points.length; i++) if (sameSeg(points[i - 1]!, points[i]!)) d += haversine(points[i - 1]!, points[i]!)
  return d
}

/** Split into runs of the same segment. */
export function segments(points: Fix[]): Fix[][] {
  const out: Fix[][] = []
  for (const p of points) {
    const cur = out[out.length - 1]
    if (cur && sameSeg(cur[cur.length - 1]!, p)) cur.push(p)
    else out.push([p])
  }
  return out
}

/** Centered window around i (shrinks at the edges). */
const around = (arr: number[], i: number, window: number) => arr.slice(Math.max(0, i - (window >> 1)), Math.min(arr.length, i + (window >> 1) + 1))

/** Median filter (kills spikes) then a centered moving average (kills wobble). */
export function smooth(values: number[], medianWindow = 5, avgWindow = 15): number[] {
  const median = values.map((_, i) => {
    const s = around(values, i, medianWindow).sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]!
  })
  return median.map((_, i) => {
    const s = around(median, i, avgWindow)
    return s.reduce((a, b) => a + b, 0) / s.length
  })
}

/**
 * Total climb with hysteresis. A climb is confirmed once the altitude rises `threshold` above the
 * lowest point (then the whole rise counts); it ends once it falls `threshold` below the peak.
 * Noise smaller than the threshold adds nothing.
 */
export function climb(alts: number[], threshold = CLIMB_THRESHOLD_M): number {
  if (alts.length < 2) return 0
  let gain = 0
  let low = alts[0]!
  let high = alts[0]!
  let climbing = false
  for (const v of alts) {
    if (climbing) {
      if (v > high) {
        gain += v - high
        high = v
      } else if (high - v >= threshold) {
        climbing = false
        low = v
      }
    } else if (v < low) low = v
    else if (v - low >= threshold) {
      climbing = true
      gain += v - low
      high = v
    }
  }
  return gain
}

/**
 * Elevation gain in meters from the fixes' altitudes (smoothed; poor-accuracy altitudes ignored).
 * Each segment is measured on its own, so a climb while paused doesn't count.
 */
export function elevationGainM(points: Fix[]): number {
  return segments(points).reduce((sum, seg) => sum + segmentGain(seg), 0)
}

function segmentGain(points: Fix[]): number {
  const alts = points
    .filter((p) => typeof p.alt === 'number' && Number.isFinite(p.alt) && (p.altAcc == null || p.altAcc <= MAX_ALT_ACC_M))
    .map((p) => p.alt as number)
  return climb(smooth(alts))
}

/** Evenly sampled, normalized route for a tiny SVG thumbnail (keeps aspect ratio). */
export function thumbnail(points: Fix[], n = 32): [number, number][] | undefined {
  if (points.length < 2) return undefined
  const step = Math.max(1, (points.length - 1) / (n - 1))
  const picked: Fix[] = []
  for (let i = 0; i < points.length - 1; i += step) picked.push(points[Math.round(i)]!)
  picked.push(points[points.length - 1]!)
  const k = Math.cos(rad(picked[0]!.lat))
  const xs = picked.map((p) => p.lon * k)
  const ys = picked.map((p) => -p.lat)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1
  const r = (v: number) => Math.round(v * 1000) / 1000
  return xs.map((x, i) => [r((x - minX) / span), r((ys[i]! - minY) / span)])
}

/** `movingMs` = recorded time (paused time excluded). */
export function summarize(points: Fix[], movingMs: number): RideSummary {
  const durationSec = Math.max(0, Math.round(movingMs / 1000))
  const km = distanceM(points) / 1000
  const r2 = (v: number) => Math.round(v * 100) / 100
  const thumb = thumbnail(points)
  return {
    km: r2(km),
    gainM: Math.round(elevationGainM(points)),
    durationSec,
    avgKmh: durationSec > 0 ? r2(km / (durationSec / 3600)) : 0,
    ...(thumb ? { thumb } : {}),
  }
}
