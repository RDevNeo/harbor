import { describe, expect, it } from 'bun:test'
import { fmtProgress, fmtQty, fmtSecs, quickLabel } from '../lib/format'
import { migrate, totalsFrom } from '../lib/store'

describe('format', () => {
  it('shows liters at or above 1000 ml', () => {
    expect(fmtProgress(1250, { target: 2000, unit: 'ml' })).toEqual({ value: '1.25', rest: '/ 2.0 L' })
    expect(fmtProgress(1500, { target: 2000, unit: 'ml' })).toEqual({ value: '1.5', rest: '/ 2.0 L' })
    expect(fmtProgress(750, { target: 2000, unit: 'ml' })).toEqual({ value: '750', rest: 'ml / 2.0 L' })
    expect(fmtQty(500, 'ml')).toBe('500 ml')
    expect(fmtQty(2000, 'ml')).toBe('2.0 L')
  })
  it('keeps reps as-is', () => {
    expect(fmtProgress(20, { target: 50, unit: 'reps' })).toEqual({ value: '20', rest: '/ 50 reps' })
    expect(quickLabel(5, 'reps')).toBe('+5')
    expect(quickLabel(250, 'ml')).toBe('+250 ml')
    expect(quickLabel(1000, 'ml')).toBe('+1 L')
  })
})

describe('stopwatch format', () => {
  it('shows seconds as m:ss and whole-minute targets as min', () => {
    expect(fmtSecs(80)).toBe('1:20')
    expect(fmtSecs(5.9)).toBe('0:05')
    expect(fmtProgress(80, { target: 180, unit: 'sec' })).toEqual({ value: '1:20', rest: '/ 3:00' })
    expect(fmtQty(180, 'sec')).toBe('3 min')
    expect(fmtQty(90, 'sec')).toBe('1:30')
  })
})

describe('migrate', () => {
  it('converts daily totals to entries and adds the water goal', () => {
    const v1 = {
      version: 1,
      goals: [{ id: 'abs', name: 'Abs', target: 50, unit: 'reps', color: '#fff', createdAt: '2026-11-01' }],
      logs: { '2026-11-20': { abs: 40 }, '2026-11-21': { abs: 15 } },
      undo: { date: '2026-11-21', stacks: { abs: [10, 5] } },
      sleep: { bedtime: '22:30', wake: '06:30', alarmEnabled: true, reminderEnabled: true, reminderLeadMin: 0 },
    }
    const d = migrate(v1)
    expect(d.version).toBe(8)
    expect(d.goals.filter((g) => g.unit === 'ml')).toMatchObject([{ id: 'water', target: 3500 }])
    expect(totalsFrom(d.entries)).toEqual({ '2026-11-20': { abs: 40 }, '2026-11-21': { abs: 15 } })
    expect(d.sleep).toEqual({ wakeBy: '06:30' })
  })
  it('migrates v2: keeps entries, drops quick-adds and removed sleep fields', () => {
    const v2 = {
      version: 2,
      goals: [{ id: 'water', name: 'Water', target: 2000, unit: 'ml', color: '#00f', quickAdds: [250, 500], createdAt: '2026-11-21' }],
      entries: { '2026-11-21': [{ id: 'x', goalId: 'water', amount: 250, at: 1 }] },
      sleep: { bedtime: '23:00', wake: '07:45', alarmEnabled: true, alarmSetFor: '07:45', reminderEnabled: true, reminderLeadMin: 0, fallAsleepMin: 20, cycleMin: 95 },
    }
    const d = migrate(v2)
    expect(d.version).toBe(8)
    expect(d.goals[0]).not.toHaveProperty('quickAdds')
    expect(d.goals.map((g) => g.id)).toEqual(['water', 'pushups', 'abs', 'squats', 'plank', 'bike', 'soccer'])
    expect(d.sleep).toEqual({ wakeBy: '07:45' })
    expect(totalsFrom(d.entries)['2026-11-21'].water).toBe(250)
  })

  it('migrates v3: emoji → line icon keys, seeds Plank before Water', () => {
    const g = (id: string, emoji: string | undefined, unit = 'reps') => ({ id, name: id, target: 10, unit, emoji, color: '#fff', createdAt: '2026-11-01' })
    const d = migrate({
      version: 3,
      goals: [g('abs', '🔥'), g('pushups', '💪'), g('squats', '🏋️'), g('read', '📚'), g('x', '🦄'), g('y', undefined), g('water', '💧', 'ml')],
      entries: {},
      sleep: { wakeBy: '06:15' },
    })
    expect(d.version).toBe(8)
    const icon = Object.fromEntries(d.goals.map((x) => [x.id, x.icon]))
    expect(icon).toMatchObject({ abs: 'activity', pushups: 'arm', squats: 'dumbbell', read: 'book', x: 'activity', y: 'activity', plank: 'timer', water: 'droplet' })
    expect(d.goals.some((x) => 'emoji' in x)).toBe(false)
    expect(d.goals.find((x) => x.id === 'plank')).toMatchObject({ unit: 'sec', target: 120, days: [1, 3, 5] })
    expect(d.sleep.wakeBy).toBe('06:15')
    expect(d.timers).toEqual({})
  })

  it('loads v5 data unchanged, keeps running timers (drops orphaned ones)', () => {
    const goals = [{ id: 'plank', name: 'Plank', target: 180, unit: 'sec', icon: 'timer', color: '#fff', createdAt: '2026-11-01', days: [2, 4] }]
    const d = migrate({ version: 5, goals, entries: {}, sleep: { wakeBy: '06:15' }, timers: { plank: 123, gone: 5 } })
    expect(d.goals).toEqual(goals)
    expect(d.timers).toEqual({ plank: { accMs: 0, runningSince: 123 } }) // v8: running session
  })

  it('migrates v5 → v8: marks Igor\'s Plan active, Bike as a GPS ride, Soccer on Monday, nothing else changes', () => {
    const goals = [
      { id: 'water', name: 'Water', target: 3500, unit: 'ml', icon: 'droplet', color: '#3b82f6', createdAt: '2026-11-21' },
      { id: 'bike', name: 'Bike', target: 1800, unit: 'sec', icon: 'bike', color: '#eab308', createdAt: '2026-11-21', days: [1, 2, 3, 5, 6] },
      { id: 'soccer', name: 'Soccer', target: 3600, unit: 'sec', icon: 'run', color: '#ec4899', createdAt: '2026-11-21', days: [4] },
    ]
    const entries = { '2026-11-21': [{ id: 'e', goalId: 'bike', amount: 600, at: 5 }] }
    const d = migrate({ version: 5, goals, entries, sleep: { wakeBy: '06:45' }, timers: { soccer: 7 } })
    expect(d.version).toBe(8)
    expect(d.plan).toEqual({ id: 'igor' })
    expect(d.goals).toEqual([goals[0], { ...goals[1], kind: 'ride' }, { ...goals[2], days: [1] }])
    expect(d.entries).toEqual(entries)
    expect(d.timers).toEqual({ soccer: { accMs: 0, runningSince: 7 } })
    expect(d.sleep).toEqual({ wakeBy: '06:45' })
  })

  it('fresh install: no goals and no plan (first launch shows the picker)', () => {
    expect(migrate(null)).toMatchObject({ version: 8, goals: [], plan: null })
  })

  it('keeps a stored v6 plan (and drops unknown ones)', () => {
    expect(migrate({ version: 6, goals: [], entries: {}, sleep: { wakeBy: '07:00' }, timers: {}, plan: { id: 'custom', basedOn: 'basic' } }).plan).toEqual({ id: 'custom', basedOn: 'basic' })
    expect(migrate({ version: 6, goals: [], entries: {}, sleep: { wakeBy: '07:00' }, timers: {}, plan: { id: 'nope' } }).plan).toBeNull()
  })

  it("migrates v7 → v8: Igor's Plan Soccer moves Thu → Mon and Bike drops its Thu bonus; entries untouched", () => {
    const bike = { id: 'bike', name: 'Bike', target: 1800, unit: 'sec', kind: 'ride', icon: 'bike', color: '#eab308', createdAt: '2026-11-21', days: [1, 2, 3, 5, 6] }
    const soccer = { id: 'soccer', name: 'Soccer', target: 3600, unit: 'sec', icon: 'run', color: '#ec4899', createdAt: '2026-11-21', days: [4] }
    const water = { id: 'water', name: 'Water', target: 3500, unit: 'ml', icon: 'droplet', color: '#3b82f6', createdAt: '2026-11-21' }
    const entries = { '2026-11-19': [{ id: 'r', goalId: 'bike', amount: 1900, at: 9, ride: { km: 15.6, gainM: 40, durationSec: 1900, avgKmh: 29.6 } }, { id: 's', goalId: 'soccer', amount: 3600, at: 10 }] }
    const v7 = { version: 7, goals: [water, { ...bike, bonusDays: [4] }, soccer], entries, sleep: { wakeBy: '06:45' }, timers: { soccer: 7 }, plan: { id: 'igor' } }
    const d = migrate(structuredClone(v7))
    expect(d.version).toBe(8)
    expect(d.goals).toEqual([water, bike, { ...soccer, days: [1] }])
    expect(d.entries).toEqual(entries)
    expect(d.timers).toEqual({ soccer: { accMs: 0, runningSince: 7 } })
    expect(d.plan).toEqual({ id: 'igor' })
    // Custom based on Igor's Plan too.
    expect(migrate({ ...structuredClone(v7), plan: { id: 'custom', basedOn: 'igor' } }).goals).toEqual([water, bike, { ...soccer, days: [1] }])
    // Other plans, and values the user changed after v7, are left alone.
    expect(migrate({ ...structuredClone(v7), plan: { id: 'basic' } }).goals).toEqual(v7.goals)
    const edited = [{ ...bike, bonusDays: [0] }, { ...soccer, days: [4, 6] }]
    expect(migrate({ ...structuredClone(v7), goals: structuredClone(edited) }).goals).toEqual(edited)
    // v6 data (never had the bonus) also gets Soccer on Monday.
    expect(migrate({ ...structuredClone(v7), version: 6, goals: [bike, soccer] }).goals).toEqual([bike, { ...soccer, days: [1] }])
    // Already v8: stored bonus days are kept (cleaned), never re-touched.
    expect(migrate({ ...structuredClone(v7), version: 8, goals: [{ ...bike, bonusDays: [4, 4, 1, 9] }, soccer] }).goals).toEqual([{ ...bike, bonusDays: [4] }, soccer])
  })

  it('v8 keeps paused and running stopwatch sessions, drops invalid ones', () => {
    const goals = [{ id: 'plank', name: 'Plank', target: 120, unit: 'sec', icon: 'timer', color: '#fff', createdAt: '2026-11-01' }, { id: 'soccer', name: 'Soccer', target: 3600, unit: 'sec', icon: 'run', color: '#fff', createdAt: '2026-11-01' }]
    const timers = { plank: { accMs: 30_000, runningSince: null }, soccer: { accMs: 5_000, runningSince: 99 }, gone: { accMs: 1, runningSince: null } }
    expect(migrate({ version: 8, goals, entries: {}, sleep: { wakeBy: '06:15' }, timers, plan: null }).timers).toEqual({ plank: timers.plank, soccer: timers.soccer })
    expect(migrate({ version: 8, goals, entries: {}, sleep: { wakeBy: '06:15' }, timers: { plank: { accMs: 'x' } }, plan: null }).timers).toEqual({})
  })

  it('does not re-seed goals the user deleted after v5', () => {
    expect(migrate({ version: 5, goals: [], entries: {}, sleep: { wakeBy: '06:15' }, timers: {} }).goals).toEqual([])
  })

  it("migrates v4 → v8: applies Igor's Plan by name, never deletes or duplicates", () => {
    const g = (id: string, name: string, target: number, unit: string, icon = 'activity') => ({ id, name, target, unit, icon, color: '#123', createdAt: '2026-11-01' })
    const entries = { '2026-11-20': [{ id: 'e1', goalId: 'p1', amount: 30, at: 1 }, { id: 'e2', goalId: 'mine', amount: 5, at: 2 }] }
    const d = migrate({
      version: 4,
      goals: [g('mine', 'Stretch', 10, 'reps'), g('p1', 'push-ups', 30, 'reps', 'arm'), g('a', 'ABS', 50, 'reps'), g('pl', 'Plank', 180, 'sec', 'timer'), g('w', 'Water', 2000, 'ml', 'droplet')],
      entries,
      sleep: { wakeBy: '06:15' },
      timers: { pl: 99 },
    })
    expect(d.version).toBe(8)
    expect(d.goals.map((x) => x.name)).toEqual(['Water', 'push-ups', 'ABS', 'Squats', 'Plank', 'Bike', 'Soccer', 'Stretch'])
    const by = Object.fromEntries(d.goals.map((x) => [x.name.toLowerCase(), x]))
    expect(by.water).toMatchObject({ id: 'w', target: 3500, unit: 'ml', color: '#123' })
    expect(by.water.days).toBeUndefined()
    expect(by['push-ups']).toMatchObject({ id: 'p1', target: 36, unit: 'reps', icon: 'arm', days: [1, 3, 5] })
    expect(by.abs).toMatchObject({ id: 'a', target: 45, days: [1, 3, 5] })
    expect(by.squats).toMatchObject({ target: 36, unit: 'reps', days: [1, 3, 5] })
    expect(by.plank).toMatchObject({ id: 'pl', target: 120, unit: 'sec', days: [1, 3, 5] })
    expect(by.bike).toMatchObject({ target: 1800, unit: 'sec', kind: 'ride', days: [1, 2, 3, 5, 6] })
    expect(by.bike.bonusDays).toBeUndefined()
    expect(d.plan).toEqual({ id: 'igor' })
    expect(d.goals.some((x) => x.archived)).toBe(false)
    expect(by.soccer).toMatchObject({ target: 3600, unit: 'sec', days: [1] })
    expect(by.stretch).toMatchObject({ id: 'mine', target: 10 })
    expect(by.stretch.days).toBeUndefined()
    expect(d.entries).toEqual(entries)
    expect(d.timers).toEqual({ pl: { accMs: 0, runningSince: 99 } })
    expect(new Set(d.goals.map((x) => x.id)).size).toBe(d.goals.length)
  })

  it('falls back to defaults for garbage', () => {
    const d = migrate({ version: 3, sleep: { wakeBy: 'nope' } })
    expect(d.sleep.wakeBy).toBe('07:00')
    expect(d.goals.map((g) => g.id)).toEqual(['water', 'pushups', 'abs', 'squats', 'plank', 'bike', 'soccer'])
  })
})

describe('fmtCycles', () => {
  it('drops the decimal for whole cycles', async () => {
    const { fmtCycles } = await import('../lib/date')
    expect(fmtCycles(6)).toBe('6')
    expect(fmtCycles(5.999)).toBe('6')
    expect(fmtCycles(5.333)).toBe('5.3')
  })
})

describe('fmtClock', () => {
  it('is always 24-hour HH:MM (pt-BR style), never AM/PM', async () => {
    const { fmtClock, fmtClockHM, fmtHHMM } = await import('../lib/date')
    expect(fmtClock(new Date(2026, 0, 1, 6, 45))).toBe('06:45')
    expect(fmtClock(new Date(2026, 0, 1, 22, 30))).toBe('22:30')
    expect(fmtClockHM(0, 5)).toBe('00:05')
    expect(fmtHHMM('07:00')).toBe('07:00')
  })
})
