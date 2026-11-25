import { addDays, dateKey, parseKey } from './date'
import { isBonus, isScheduled } from './schedule'
import type { DailyTotals, Goal } from './types'

export function amount(logs: DailyTotals, day: string, goalId: string): number {
  return logs[day]?.[goalId] ?? 0
}

export function isDone(logs: DailyTotals, day: string, g: Goal): boolean {
  return amount(logs, day, g.id) >= g.target
}

/** A bonus day counts once it's done — or, for GPS rides, once any ride was recorded. */
export function bonusDone(logs: DailyTotals, day: string, g: Goal): boolean {
  return isDone(logs, day, g) || (g.kind === 'ride' && amount(logs, day, g.id) > 0)
}

/** How a day counts for a goal: required (scheduled), done bonus (counts like a done day) or skipped. */
function dayRole(logs: DailyTotals, g: Goal, d: Date): 'required' | 'bonus' | 'skip' {
  if (isScheduled(g, d)) return 'required'
  return isBonus(g, d) && bonusDone(logs, dateKey(d), g) ? 'bonus' : 'skip'
}

/**
 * Consecutive completed scheduled days ending today (or before today, if today isn't done yet).
 * Days the goal isn't scheduled on are skipped: they neither count nor break the streak.
 * A completed bonus day counts; an uncompleted one is skipped like a rest day.
 */
export function streak(logs: DailyTotals, g: Goal, today = new Date()): number {
  let d = today
  // Today only counts once it's done; an unfinished today doesn't break anything yet.
  if (dayRole(logs, g, d) === 'required' && !isDone(logs, dateKey(d), g)) d = addDays(d, -1)
  let n = 0
  for (let guard = 0; guard < 3660; guard++, d = addDays(d, -1)) {
    const role = dayRole(logs, g, d)
    if (role === 'skip') continue
    if (role === 'required' && !isDone(logs, dateKey(d), g)) break
    n++
  }
  return n
}

/** Longest run of completed scheduled days (unscheduled days are skipped, not breaks). */
export function bestStreak(logs: DailyTotals, g: Goal, today = new Date()): number {
  const keys = Object.keys(logs).sort()
  if (!keys.length) return 0
  const last = keys[keys.length - 1]!
  const end = last > dateKey(today) ? parseKey(last) : today
  let best = 0
  let cur = 0
  for (let d = parseKey(keys[0]!); d <= end; d = addDays(d, 1)) {
    const k = dateKey(d)
    const role = dayRole(logs, g, d)
    if (role === 'skip') continue
    if (role === 'bonus' || isDone(logs, k, g)) best = Math.max(best, ++cur)
    else if (k !== dateKey(today)) cur = 0 // unfinished today doesn't end a run
  }
  return best
}

/** Goals scheduled (required) on a given day; bonus goals aren't included. */
export function goalsOn(goals: Goal[], day: string): Goal[] {
  return goals.filter((g) => isScheduled(g, day))
}

/**
 * Fraction (0..1) of the goals scheduled that day that were completed; for the heatmap and the
 * overall ring. Bonus goals only count once done (as complete). Null when nothing counts (rest day).
 */
export function dayCompletion(logs: DailyTotals, day: string, goals: Goal[]): number | null {
  const on = goals.filter((g) => isScheduled(g, day) || (isBonus(g, day) && bonusDone(logs, day, g)))
  if (!on.length) return null
  const sum = on.reduce((acc, g) => acc + (isScheduled(g, day) ? Math.min(1, amount(logs, day, g.id) / g.target) : 1), 0)
  return sum / on.length
}
