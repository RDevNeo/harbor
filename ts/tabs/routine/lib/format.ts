import type { Goal } from './types'

const isMl = (unit: string) => unit.trim().toLowerCase() === 'ml'

function liters(n: number): string {
  const l = n / 1000
  return Number.isInteger(Math.round(l * 1000) / 100) ? l.toFixed(1) : String(Math.round(l * 100) / 100)
}

export const isTimerUnit = (unit: string) => unit.trim().toLowerCase() === 'sec'
export const isTimerGoal = (g: Pick<Goal, 'unit'>) => isTimerUnit(g.unit)

/** Seconds as "m:ss", e.g. 80 → "1:20". */
export function fmtSecs(total: number): string {
  const s = Math.max(0, Math.floor(total))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "1.25 L", "750 ml", "30 reps", "3 min" / "1:20" (timer goals store seconds) */
export function fmtQty(n: number, unit: string): string {
  if (isTimerUnit(unit)) return n % 60 === 0 ? `${n / 60} min` : fmtSecs(n)
  if (isMl(unit) && Math.abs(n) >= 1000) return `${liters(n)} L`
  return `${n} ${unit}`
}

/** Progress text split into the big number and the rest, e.g. {value:"1.25", rest:"/ 2.0 L"}. */
export function fmtProgress(n: number, g: Pick<Goal, 'target' | 'unit'>): { value: string; rest: string } {
  if (isTimerUnit(g.unit)) return { value: fmtSecs(n), rest: `/ ${fmtSecs(g.target)}` }
  if (isMl(g.unit) && n >= 1000 && g.target >= 1000) return { value: liters(n), rest: `/ ${liters(g.target)} L` }
  if (isMl(g.unit) && g.target >= 1000) return { value: String(n), rest: `ml / ${liters(g.target)} L` }
  return { value: String(n), rest: `/ ${fmtQty(g.target, g.unit)}` }
}

/** Quick-add chip label, e.g. "+5", "+250 ml", "+1 L". */
export function quickLabel(n: number, unit: string): string {
  if (!isMl(unit)) return `+${n}`
  return n >= 1000 ? `+${n / 1000} L` : `+${n} ml`
}

export const isWaterGoal = (g: Pick<Goal, 'unit'>) => isMl(g.unit)

export const isRideGoal = (g: Pick<Goal, 'kind'>) => g.kind === 'ride'

/** Kilometers with 2 decimals: "12.34". */
export const fmtKm = (km: number) => (Math.round(km * 100) / 100).toFixed(2)
