import { describe, expect, it } from 'bun:test'
import { fmtDays, isBonus, isScheduled, isShownOn, normalizeBonusDays, normalizeDays } from '../lib/schedule'
import { bestStreak, bonusDone, dayCompletion, streak } from '../lib/stats'
import type { DailyTotals, Goal } from '../lib/types'

const goal = (days?: number[]): Goal => ({ id: 'g', name: 'G', target: 10, unit: 'reps', icon: 'activity', color: '#fff', createdAt: '2026-11-01', days })
// 2026-11-16 is a Monday.
const done = (...keys: string[]): DailyTotals => Object.fromEntries(keys.map((k) => [k, { g: 10 }]))

describe('schedule', () => {
  it('normalizes days: missing, empty or all 7 = every day', () => {
    expect(normalizeDays(undefined)).toBeUndefined()
    expect(normalizeDays([])).toBeUndefined()
    expect(normalizeDays([0, 1, 2, 3, 4, 5, 6])).toBeUndefined()
    expect(normalizeDays([5, 1, 3, 3, 9, 'x'])).toEqual([1, 3, 5])
  })
  it('checks weekdays and formats Mon-first', () => {
    expect(isScheduled(goal([1, 3, 5]), '2026-11-16')).toBe(true) // Mon
    expect(isScheduled(goal([1, 3, 5]), '2026-11-17')).toBe(false) // Tue
    expect(isScheduled(goal(), '2026-11-22')).toBe(true)
    expect(fmtDays([5, 0, 1])).toBe('Mon · Fri · Sun')
    expect(fmtDays()).toBe('Every day')
    expect(fmtDays([1, 3, 5])).toBe('Mon · Wed · Fri')
    expect(fmtDays([1, 2, 3, 5, 6])).toBe('Mon–Wed · Fri–Sat')
    expect(fmtDays([5, 6, 0])).toBe('Fri–Sun')
  })
})

describe('streaks with schedules', () => {
  const mwf = goal([1, 3, 5])
  it('unscheduled days neither count nor break the streak', () => {
    const logs = done('2026-11-16', '2026-11-18', '2026-11-20') // Mon, Wed, Fri
    expect(streak(logs, mwf, new Date(2026, 10, 22))).toBe(3) // Sunday
    expect(bestStreak(logs, mwf, new Date(2026, 10, 22))).toBe(3)
  })
  it('a missed scheduled day breaks it; an unfinished today does not', () => {
    const logs = done('2026-11-16', '2026-11-20') // Wed missed
    expect(streak(logs, mwf, new Date(2026, 10, 20))).toBe(1)
    expect(streak(done('2026-11-18', '2026-11-20'), mwf, new Date(2026, 10, 23))).toBe(2) // Mon today, not done yet
  })
  it('dayCompletion is null on rest days and only counts scheduled goals', () => {
    expect(dayCompletion({}, '2026-11-17', [mwf])).toBeNull()
    expect(dayCompletion(done('2026-11-16'), '2026-11-16', [mwf, { ...goal([2]), id: 'h' }])).toBe(1)
  })
})

describe('bonus days', () => {
  // Bike: Mon–Wed, Fri–Sat required; Thu bonus. 2026-11-19 is a Thursday.
  const bike: Goal = { ...goal([1, 2, 3, 5, 6]), id: 'g', kind: 'ride', unit: 'sec', target: 1800, bonusDays: [4] }
  const THU = '2026-11-19'

  it('normalizes, detects and formats bonus days', () => {
    expect(normalizeBonusDays([4, 4, 1, 9], [1, 2])).toEqual([4]) // scheduled days can't be bonus
    expect(normalizeBonusDays([4], undefined)).toBeUndefined() // every-day goals have no bonus days
    expect(normalizeBonusDays([], [1])).toBeUndefined()
    expect(isBonus(bike, THU)).toBe(true)
    expect(isScheduled(bike, THU)).toBe(false)
    expect(isShownOn(bike, THU)).toBe(true)
    expect(isShownOn(bike, '2026-11-22')).toBe(false) // Sunday rest
    expect(isBonus(bike, '2026-11-18')).toBe(false)
    expect(fmtDays(bike.days, bike.bonusDays)).toBe('Mon–Wed · Fri–Sat · Thu bonus')
    expect(fmtDays([1], [3, 4])).toBe('Mon · Wed–Thu bonus')
  })

  it('a bonus day never counts against completion; once done it counts as complete', () => {
    const water: Goal = { ...goal(), id: 'w', target: 100 }
    const logs: DailyTotals = { [THU]: { w: 50 } }
    expect(dayCompletion(logs, THU, [water, bike])).toBe(0.5) // bike not done: ignored
    expect(dayCompletion({ [THU]: { w: 50, g: 600 } }, THU, [water, bike])).toBe(0.75) // any ride counts as done
    expect(dayCompletion({}, THU, [bike])).toBeNull() // only a bonus goal: a rest day
    expect(bonusDone({ [THU]: { g: 1 } }, THU, bike)).toBe(true)
    expect(bonusDone({ [THU]: { g: 1 } }, THU, { ...bike, kind: undefined })).toBe(false) // non-ride bonus needs the target
  })

  it('skipping a bonus day keeps the streak; riding on it extends the streak', () => {
    const t = new Date(2026, 10, 20) // Fri
    const wed = '2026-11-18'
    const fri = '2026-11-20'
    const on = (...keys: string[]): DailyTotals => Object.fromEntries(keys.map((k) => [k, { g: 1800 }]))
    expect(streak(on(wed, fri), bike, t)).toBe(2) // Thu skipped: Wed + Fri
    expect(streak({ ...on(wed, fri), [THU]: { g: 900 } }, bike, t)).toBe(3) // a short ride on Thu counts
    expect(bestStreak({ ...on(wed, fri), [THU]: { g: 900 } }, bike, t)).toBe(3)
    expect(streak(on(wed), bike, new Date(2026, 10, 19))).toBe(1) // on Thu, nothing yet: Wed still counts
    expect(streak({ ...on(wed), [THU]: { g: 600 } }, bike, new Date(2026, 10, 19))).toBe(2) // ride today counts right away
  })
})
