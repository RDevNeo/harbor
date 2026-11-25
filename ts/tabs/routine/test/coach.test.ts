import { describe, expect, it } from 'bun:test'
import { coachSummary, recentCompletion } from '../lib/coach'
import { totalsFrom } from '../lib/store'
import { addDays, dateKey } from '../lib/date'
import type { Entry, Goal } from '../lib/types'

const g = (id: string, name: string, target: number, unit: string, extra: Partial<Goal> = {}): Goal => ({ id, name, target, unit, icon: 'activity', color: '#fff', createdAt: '2026-10-01', ...extra })
const at = (day: string, h = 12) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).getTime()

describe('coach summary', () => {
  // Sunday 22/11/2026; week starts Monday 16/11.
  const now = new Date(2026, 10, 22, 20, 0)
  const water = g('water', 'Water', 3500, 'ml')
  const push = g('pushups', 'Push-ups', 36, 'reps', { days: [1, 3, 5] })
  const plank = g('plank', 'Plank', 120, 'sec', { days: [1, 3, 5] })
  const bike = g('bike', 'Bike', 1800, 'sec', { kind: 'ride', days: [1, 2, 3, 5, 6] })
  const ride = (day: string, km: number, durationSec: number, gainM: number): Entry => ({ id: `r${day}`, goalId: 'bike', amount: durationSec, at: at(day), ride: { km, durationSec, gainM, avgKmh: 0 } })
  const entries: Record<string, Entry[]> = {
    '2026-11-22': [{ id: 'w0', goalId: 'water', amount: 1000, at: at('2026-11-22') }],
    '2026-11-21': [{ id: 'w1', goalId: 'water', amount: 3500, at: at('2026-11-21') }, ride('2026-11-21', 12.345, 1900, 40)],
    '2026-11-20': [{ id: 'p', goalId: 'pushups', amount: 36, at: at('2026-11-20') }, { id: 'pl', goalId: 'plank', amount: 125, at: at('2026-11-20') }, ride('2026-11-20', 10, 1800, 22)],
    '2026-11-18': [{ id: 'p2', goalId: 'pushups', amount: 36, at: at('2026-11-18') }, { id: 'pl2', goalId: 'plank', amount: 120, at: at('2026-11-18') }],
    '2026-11-13': [ride('2026-11-13', 5, 900, 10), ride('2026-11-12', 3, 600, 5)],
  }
  const totals = totalsFrom(entries)

  it('counts the last N scheduled days before today', () => {
    // Push-ups Mon/Wed/Fri: Fri 20 ✓, Wed 18 ✓, Mon 16 ✗, Fri 13 ✗, Wed 11 ✗, Mon 9 ✗, Fri 6 ✗.
    expect(recentCompletion(totals, push, new Date(2026, 10, 22), 7)).toEqual({ done: 2, of: 7 })
    // Never counts days before the goal existed.
    expect(recentCompletion(totals, { ...push, createdAt: '2026-11-17' }, new Date(2026, 10, 22), 28)).toEqual({ done: 2, of: 2 })
  })

  it('formats a compact plain-text summary', () => {
    const text = coachSummary({ now, plan: { id: 'igor' }, goals: [water, push, plank, bike], totals, entries })
    expect(text).toBe(
      [
        'Routine — Sunday 22/11/2026',
        "Plan: Igor's Plan",
        '',
        'Water: 3.5 L · Every day',
        '  today 1.0 L · streak 1 (best 1) · 7d 1/7 (14%) · 28d 1/28 (4%)',
        'Push-ups: 36 reps · Mon · Wed · Fri',
        '  today 0 reps (rest today) · streak 2 (best 2) · 7d 2/7 (29%) · 28d 2/22 (9%)',
        'Plank: 2 min · Mon · Wed · Fri',
        '  today 0 min (rest today) · streak 2 (best 2) · 7d 2/7 (29%) · 28d 2/22 (9%)',
        'Bike: 30 min · Mon–Wed · Fri–Sat',
        '  today 0 min (rest today) · streak 2 (best 2) · 7d 2/7 (29%) · 28d 2/28 (7%)',
        '',
        'Water avg (last 7 days): 500 ml/day',
        '',
        'Bike: 22.35 km this week · 30.35 km total',
        '  Sat 21/11: 12.35 km · 31:40 · ↑40 m',
        '  Fri 20/11: 10.00 km · 30:00 · ↑22 m',
        '  Fri 13/11: 5.00 km · 15:00 · ↑10 m',
        '',
        'This week: Plank 4:05',
      ].join('\n'),
    )
  })
})

describe('coach summary: walking', () => {
  it('adds walked km today and this week when Health Connect data is there', () => {
    const now = new Date(2026, 10, 22, 20, 0) // Sunday; week Mon 16–Sun 22
    const walk = { '2026-11-22': { km: 5.2 }, '2026-11-20': { km: 3.1, approx: true }, '2026-11-14': { km: 9 } }
    const text = coachSummary({ now, plan: null, goals: [], totals: {}, entries: {}, walk })
    expect(text).toContain('Walked today: 5.20 km (week ≈ 8.30 km)')
    expect(coachSummary({ now, plan: null, goals: [], totals: {}, entries: {} })).not.toContain('Walked')
  })
})

describe('coach context size', () => {
  const now = new Date(2026, 10, 22, 20, 0)
  const utf8Len = (s: string) => new TextEncoder().encode(s).length

  it('keeps a heavy data set within 4 KB of UTF-8, dropping oldest rides first', () => {
    const goals: Goal[] = Array.from({ length: 40 }, (_, i) => g(`g${i}`, `Ãçõé goal número ${i} 💪🚴`, 100, 'reps'))
    goals.push(g('bike', 'Bike 🚴', 1800, 'sec', { kind: 'ride' }), g('water', 'Water', 3500, 'ml'), g('plank', 'Plank', 120, 'sec'))
    const entries: Record<string, Entry[]> = {}
    for (let i = 0; i < 60; i++) {
      const day = dateKey(addDays(new Date(2026, 10, 21), -i))
      entries[day] = [
        ...goals.map((x, j) => ({ id: `${day}-${j}`, goalId: x.id, amount: 100, at: at(day, 8) })),
        { id: `${day}-r`, goalId: 'bike', amount: 1800, at: at(day, 18), ride: { km: 20 + i, durationSec: 1800, gainM: 100, avgKmh: 30 } },
      ]
    }
    const input = { now, plan: { id: 'igor' }, goals, totals: totalsFrom(entries), entries }
    const full = coachSummary(input, Infinity)
    expect(utf8Len(full)).toBeGreaterThan(4096)
    const ctx = coachSummary(input)
    expect(utf8Len(ctx)).toBeLessThanOrEqual(4096)
    expect(ctx.startsWith('Routine — Sunday 22/11/2026')).toBe(true)
    expect(ctx).toContain('Ãçõé goal número 0 💪🚴: 100 reps')
    expect(ctx).not.toContain('19/11: ') // oldest of the 3 listed rides went first
  })

  it('drops only the oldest ride when slightly over', () => {
    const bike = g('bike', 'Bike', 1800, 'sec', { kind: 'ride' })
    const ride = (day: string, km: number): Entry => ({ id: day, goalId: 'bike', amount: 1800, at: at(day), ride: { km, durationSec: 1800, gainM: 10, avgKmh: 0 } })
    const entries = { '2026-11-21': [ride('2026-11-21', 10)], '2026-11-20': [ride('2026-11-20', 11)], '2026-11-19': [ride('2026-11-19', 12)] }
    const input = { now, plan: null, goals: [bike], totals: totalsFrom(entries), entries }
    const full = coachSummary(input, Infinity)
    const text = coachSummary(input, utf8Len(full) - 1)
    expect(text).toBe(full.split('\n').filter((l) => !l.includes('19/11')).join('\n'))
  })
})
