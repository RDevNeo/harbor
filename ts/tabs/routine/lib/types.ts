import type { GoalIconKey } from './goalicons.ts'
import type { Session } from './session'
import type { RideSummary } from './track'

export const DATA_VERSION = 8

export interface Goal {
  id: string
  name: string
  target: number
  unit: string // e.g. "reps", "ml"; "sec" = stopwatch goal (target/amounts in seconds)
  icon: GoalIconKey // line icon key (v4; replaced emoji)
  color: string
  createdAt: string // YYYY-MM-DD
  /** v5: weekdays the goal is scheduled on (0=Sun..6=Sat). Missing/empty = every day. */
  days?: number[]
  /** v7: optional "bonus" weekdays (shown on Today, never required; count only when done). */
  bonusDays?: number[]
  /** v6: 'ride' = GPS-tracked stopwatch goal (unit 'sec'; entries carry a ride summary). */
  kind?: 'ride'
  /** v6: hidden because the active plan doesn't include it (history kept; comes back with a plan that has it). */
  archived?: boolean
}

/** One logged amount. Daily totals are derived from entries. */
export interface Entry {
  id: string
  goalId: string
  amount: number // may be negative (custom subtraction)
  at: number // epoch ms (local time of logging)
  /** v6: GPS ride summary (amount = duration in seconds). The full track is stored under its own key. */
  ride?: RideSummary
}

/** totals[dateKey][goalId] = amount done that day (derived) */
export type DailyTotals = Record<string, Record<string, number>>

export interface SleepSettings {
  /** Preferred latest wake-up time ("HH:MM"); picks the recommended cycle option. */
  wakeBy: string
}

export interface AppData {
  version: number
  goals: Goal[]
  /** entries[dateKey] = entries logged that local day, in order */
  entries: Record<string, Entry[]>
  sleep: SleepSettings
  /** Active stopwatches (running or paused): goalId → session. v8: was just the start time. */
  timers: Record<string, Session>
  /** v6: active plan; 'custom' after any goal edit. null = not chosen yet (first launch shows the picker). */
  plan: PlanState | null
}

export interface PlanState {
  id: string // a built-in plan id or 'custom'
  basedOn?: string // for 'custom': the plan it started from
}
