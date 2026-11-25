import { describe, expect, it } from 'bun:test'
import { bucketDay, fmtWalk, mergeWalk, walkDays, weekKm, type Bucket } from '../lib/walking'

/** A 24 h bucket starting at local midnight of `day` (+ `shiftH` hours, e.g. a DST change). */
const bucket = (day: string, value: number, shiftH = 0): Bucket => {
  const s = new Date(`${day}T00:00:00`)
  s.setHours(s.getHours() + shiftH)
  const e = new Date(s.getTime() + 24 * 3600_000)
  return { startDate: s.toISOString(), endDate: e.toISOString(), value }
}

describe('walking', () => {
  it('assigns a bucket to the local day of its midpoint', () => {
    expect(bucketDay(bucket('2026-11-20', 1))).toBe('2026-11-20')
    expect(bucketDay(bucket('2026-11-20', 1, -1))).toBe('2026-11-20') // starts 23:00 the day before
    expect(bucketDay(bucket('2026-11-20', 1, 1))).toBe('2026-11-20')
  })

  it('uses distance, else steps × 0.75 m marked approximate', () => {
    const days = walkDays(
      [bucket('2026-11-20', 5234.4), bucket('2026-11-21', 0)],
      [bucket('2026-11-20', 7000), bucket('2026-11-21', 4000), bucket('2026-11-22', 10)],
    )
    expect(days).toEqual({
      '2026-11-20': { km: 5.23 },
      '2026-11-21': { km: 3, approx: true },
      '2026-11-22': { km: 0.01, approx: true },
    })
    expect(walkDays([], [])).toEqual({})
  })

  it('merges a fresh read into the cache by range', () => {
    const cache = { '2026-11-01': { km: 1 }, '2026-11-20': { km: 2 }, '2026-11-21': { km: 3 } }
    const fresh = { '2026-11-21': { km: 4 } }
    // today only
    expect(mergeWalk(cache, fresh, '2026-11-21', '2026-11-21')).toEqual({ '2026-11-01': { km: 1 }, '2026-11-20': { km: 2 }, '2026-11-21': { km: 4 } })
    // a range where a day now has no data drops it
    expect(mergeWalk(cache, fresh, '2026-11-20', '2026-11-21')).toEqual({ '2026-11-01': { km: 1 }, '2026-11-21': { km: 4 } })
  })

  it('sums this week (Monday to today)', () => {
    const days = { '2026-11-15': { km: 9 }, '2026-11-16': { km: 1.5 }, '2026-11-18': { km: 2.25, approx: true }, '2026-11-23': { km: 7 } }
    expect(weekKm(days, new Date(2026, 10, 22, 18))).toEqual({ km: 3.75, approx: true }) // Sun 22/11: week 16–22
    expect(weekKm(days, new Date(2026, 10, 23, 8))).toEqual({ km: 7, approx: false }) // Mon 23/11: new week
  })

  it('formats', () => {
    expect(fmtWalk({ km: 5.2 })).toBe('5.20 km')
    expect(fmtWalk({ km: 3.1, approx: true })).toBe('≈ 3.10 km')
    expect(fmtWalk(undefined)).toBe('0.00 km')
  })
})
