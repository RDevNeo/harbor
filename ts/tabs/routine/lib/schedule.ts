import { parseKey } from './date'
import type { Goal } from './types'

/** Weekday numbers in display order (Mon-first). 0 = Sun … 6 = Sat (Date#getDay). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Clean a stored `days` value: unique 0..6, sorted; undefined when it means "every day". */
export function normalizeDays(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined
  const days = [...new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
  return days.length && days.length < 7 ? days : undefined
}

const weekday = (day: string | Date) => (typeof day === 'string' ? parseKey(day) : day).getDay()

/** Is the goal scheduled (required) on this day (date key or Date)? Missing/empty `days` = every day. */
export function isScheduled(g: Pick<Goal, 'days'>, day: string | Date): boolean {
  if (!g.days?.length) return true
  return g.days.includes(weekday(day))
}

/** v7: an optional "bonus" day — shown, but never required (only counts when done). */
export function isBonus(g: Pick<Goal, 'days' | 'bonusDays'>, day: string | Date): boolean {
  return !!g.bonusDays?.length && !isScheduled(g, day) && g.bonusDays.includes(weekday(day))
}

/** Shown on Today that day: scheduled or bonus. */
export const isShownOn = (g: Pick<Goal, 'days' | 'bonusDays'>, day: string | Date) => isScheduled(g, day) || isBonus(g, day)

/** Clean stored `bonusDays`: unique 0..6 not already scheduled; undefined when empty. */
export function normalizeBonusDays(v: unknown, days?: number[]): number[] | undefined {
  const sched = normalizeDays(days)
  if (!sched || !Array.isArray(v)) return undefined
  const b = [...new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6 && !sched.includes(n)))].sort((a, b) => a - b)
  return b.length ? b : undefined
}

/**
 * "Every day", "Mon · Wed · Fri", or consecutive days collapsed: "Mon–Wed · Fri–Sat" (Mon-first),
 * plus bonus days: "Mon–Wed · Fri–Sat · Thu bonus".
 */
export function fmtDays(days?: number[], bonusDays?: number[]): string {
  const d = normalizeDays(days)
  if (!d) return 'Every day'
  const bonus = normalizeBonusDays(bonusDays, d)
  return bonus ? `${fmtRuns(d)} · ${fmtRuns(bonus)} bonus` : fmtRuns(d)
}

function fmtRuns(d: number[]): string {
  const order = WEEK_ORDER.filter((n) => d.includes(n)).map((n) => WEEK_ORDER.indexOf(n as (typeof WEEK_ORDER)[number]))
  const parts: string[] = []
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j + 1 < order.length && order[j + 1] === order[j]! + 1) j++
    const name = (k: number) => DAY_SHORT[WEEK_ORDER[order[k]!]!]
    if (j > i) parts.push(`${name(i)}–${name(j)}`)
    else for (let k = i; k <= j; k++) parts.push(name(k))
    i = j + 1
  }
  return parts.join(' · ')
}
