import { describe, expect, it } from 'bun:test'
import { CYCLE_MIN, FALL_ASLEEP_MIN, nextOccurrence, wakeOptions } from '../lib/sleepCycles'

describe('wakeOptions', () => {
  it('uses fixed research averages: 15 min to fall asleep, 90 min cycles', () => {
    expect(FALL_ASLEEP_MIN).toBe(15)
    expect(CYCLE_MIN).toBe(90)
  })

  it('builds now + 15 min + N×90 min for N=3..6', () => {
    const now = new Date(2026, 10, 21, 22, 0)
    const opts = wakeOptions(now, '07:00')
    expect(opts.map((o) => o.cycles)).toEqual([3, 4, 5, 6])
    expect(opts.map((o) => o.time)).toEqual(['02:45', '04:15', '05:45', '07:15'])
    expect(opts[0].short).toBe(true)
    expect(opts[2].sleepMin).toBe(450)
  })

  it('recommends the latest option not past the wake-up-by time', () => {
    const now = new Date(2026, 10, 21, 22, 0)
    expect(wakeOptions(now, '07:00').find((o) => o.recommended)?.cycles).toBe(5) // 07:15 is past 07:00
    expect(wakeOptions(now, '07:30').find((o) => o.recommended)?.cycles).toBe(6)
  })

  it('rolls over midnight (and the year) to the next day', () => {
    const now = new Date(2026, 11, 31, 23, 50) // New Year's Eve
    const opts = wakeOptions(now, '07:00')
    const five = opts.find((o) => o.cycles === 5)!
    expect(five.time).toBe('07:35')
    expect(five.wakeAt.getFullYear()).toBe(2027)
    expect(five.wakeAt.getDate()).toBe(1)
    expect(opts.find((o) => o.recommended)?.cycles).toBe(4) // 06:05
  })

  it('falls back to 5 cycles when nothing fits', () => {
    const now = new Date(2026, 10, 21, 5, 0)
    expect(wakeOptions(now, '06:00').find((o) => o.recommended)?.cycles).toBe(5)
  })
})

describe('nextOccurrence', () => {
  it('returns tomorrow when the time already passed today', () => {
    const d = nextOccurrence(new Date(2026, 10, 21, 8, 0), '07:00')
    expect(d.getDate()).toBe(22)
    expect(d.getHours()).toBe(7)
  })
})

describe('testAlarmTime', () => {
  it('uses the next minute, or +2 when under 30 s are left', async () => {
    const { testAlarmTime } = await import('../lib/sleepCycles')
    expect(testAlarmTime(new Date(2026, 0, 1, 22, 10, 10)).toTimeString().slice(0, 8)).toBe('22:11:00')
    expect(testAlarmTime(new Date(2026, 0, 1, 22, 10, 40)).toTimeString().slice(0, 8)).toBe('22:12:00')
    expect(testAlarmTime(new Date(2026, 0, 1, 23, 59, 45)).toTimeString().slice(0, 8)).toBe('00:01:00')
  })
})
