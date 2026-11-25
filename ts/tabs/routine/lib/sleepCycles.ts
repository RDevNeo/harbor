/**
 * Sleep-cycle math (pure functions, no side effects).
 *
 * Sleep runs in cycles of ~90 min (normal range 70–110): N1 → N2 → N3 (deep) → N2 → REM.
 * Waking at the END of a cycle (after REM, in the transition to light sleep) avoids
 * being pulled out of deep sleep, so wake times should land on cycle boundaries.
 */
import { fmtTime, fromMinutes, toMinutes } from './date'

/** Average time to fall asleep (sleep-onset latency), minutes. */
export const FALL_ASLEEP_MIN = 15
/** Average sleep-cycle length, minutes. */
export const CYCLE_MIN = 90
export const CYCLE_COUNTS = [3, 4, 5, 6]

export interface WakeOption {
  cycles: number
  wakeAt: Date
  /** "HH:MM" local */
  time: string
  /** Minutes actually asleep (cycles × cycle length). */
  sleepMin: number
  recommended: boolean
  /** 3 cycles: short — mostly loses the REM-rich late cycles. */
  short: boolean
}

/** Next occurrence (strictly after `from`) of a local "HH:MM" time. */
export function nextOccurrence(from: Date, hhmm: string): Date {
  const { hour, minute } = fromMinutes(toMinutes(hhmm))
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0)
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1)
  return d
}

/**
 * Wake-up options for "going to sleep now": now + fallAsleep + N × cycle, N = 3..6.
 * Recommends the latest option that does not go past `wakeBy`; if none fit, 5 cycles.
 */
export function wakeOptions(
  now: Date,
  wakeBy: string,
  fallAsleepMin = FALL_ASLEEP_MIN,
  cycleMin = CYCLE_MIN,
  counts: number[] = CYCLE_COUNTS,
): WakeOption[] {
  const deadline = nextOccurrence(now, wakeBy).getTime()
  const opts: WakeOption[] = counts.map((n) => {
    const wakeAt = new Date(now.getTime() + (fallAsleepMin + n * cycleMin) * 60_000)
    wakeAt.setSeconds(0, 0)
    return {
      cycles: n,
      wakeAt,
      time: fmtTime(wakeAt.getHours(), wakeAt.getMinutes()),
      sleepMin: n * cycleMin,
      recommended: false,
      short: n <= 3,
    }
  })
  const fitting = opts.filter((o) => o.wakeAt.getTime() <= deadline)
  const pick = fitting.length ? fitting[fitting.length - 1] : (opts.find((o) => o.cycles === 5) ?? opts[opts.length - 1])
  if (pick) pick.recommended = true
  return opts
}

/** The Sleep tab's "Test alarm" (phone only): next whole minute, or the one after if fewer than 30 s are left in this one. */
export function testAlarmTime(now: Date): Date {
  const t = new Date(now)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + (60 - now.getSeconds() < 30 ? 2 : 1))
  return t
}
