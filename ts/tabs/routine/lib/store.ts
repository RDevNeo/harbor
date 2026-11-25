import { dateKey, parseKey } from './date'
import { normalizeBonusDays, normalizeDays } from './schedule'
import { readSession, type Session } from './session'
import { isGoalIconKey, type GoalIconKey } from './goalicons.ts'
import { COLORS, IGOR_PLAN, WATER_COLOR, applyPlan, planById } from './plans'
import { DATA_VERSION, type AppData, type DailyTotals, type Entry, type Goal, type PlanState } from './types'

/** Routine's main data, under Schedule Fixer's key (its exports import 1:1). */
export const DATA_KEY = 'schedule-fixer:data'

export { COLORS, WATER_COLOR }

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** Quick-add buttons on Today: water (ml) goals get 250/500/1000, everything else 1/5/10. */
export function quickAddsFor(unit: string): number[] {
  return unit.trim().toLowerCase() === 'ml' ? [250, 500, 1000] : [1, 5, 10]
}

export function waterGoal(today = dateKey()): Goal {
  return { id: 'water', name: 'Water', target: 2000, unit: 'ml', icon: 'droplet', color: WATER_COLOR, createdAt: today }
}

export function plankGoal(today = dateKey()): Goal {
  return { id: 'plank', name: 'Plank', target: 180, unit: 'sec', icon: 'timer', color: COLORS[3], createdAt: today }
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Fresh install: no goals and no plan yet (the first launch shows the plan picker). */
export function defaultData(): AppData {
  return {
    version: DATA_VERSION,
    goals: [],
    entries: {},
    sleep: { wakeBy: '07:00' },
    timers: {},
    plan: null,
  }
}

function readPlan(v: unknown): PlanState | null {
  if (!v || typeof v !== 'object') return null
  const { id, basedOn } = v as Record<string, unknown>
  if (typeof id !== 'string' || (id !== 'custom' && !planById(id))) return null
  return typeof basedOn === 'string' && planById(basedOn) ? { id, basedOn } : { id }
}

const EMOJI_ICONS: Record<string, GoalIconKey> = {
  '🔥': 'flame', '💪': 'arm', '💧': 'droplet', '🏃': 'run', '🧘': 'leaf', '🚴': 'bike',
  '🏋️': 'dumbbell', '🏋': 'dumbbell', '📚': 'book', '🦵': 'run', '🤸': 'activity',
}
const SEEDED_ICONS: Record<string, GoalIconKey> = { abs: 'activity', pushups: 'arm', water: 'droplet', plank: 'timer' }

/** v4: emoji → line icon key. Seeded goals get their new defaults; others map by emoji, then by unit. */
export function iconFor(g: { id?: string; icon?: unknown; emoji?: unknown; unit?: string }): GoalIconKey {
  if (isGoalIconKey(g.icon)) return g.icon
  const seeded = g.id ? SEEDED_ICONS[g.id] : undefined
  if (seeded) return seeded
  const byEmoji = typeof g.emoji === 'string' ? EMOJI_ICONS[g.emoji.trim()] : undefined
  if (byEmoji) return byEmoji
  return g.unit?.trim().toLowerCase() === 'ml' ? 'droplet' : 'activity'
}

const validTime = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : undefined)

/** Upgrade any older stored shape to the current version. Exported for tests. */
export function migrate(raw: unknown): AppData {
  const base = defaultData()
  if (!raw || typeof raw !== 'object') return base
  const d = raw as Record<string, unknown>
  const version = typeof d.version === 'number' ? d.version : 1
  const sleep = (d.sleep ?? {}) as Record<string, unknown>

  let goals: Goal[] = Array.isArray(d.goals)
    ? (d.goals as (Goal & { quickAdds?: unknown; emoji?: unknown })[]).map(({ quickAdds: _q, emoji: _e, ...g }) => ({
        ...g,
        unit: g.unit ?? 'reps',
        icon: iconFor({ ...g, emoji: _e }),
      }))
        .map(({ days, bonusDays, ...g }) => {
          const d = normalizeDays(days)
          const b = normalizeBonusDays(bonusDays, d)
          return { ...g, ...(d ? { days: d } : {}), ...(b ? { bonusDays: b } : {}) }
        })
    : base.goals
  let entries: Record<string, Entry[]> = {}

  if (version < 2) {
    // v1: logs[day][goalId] = total; undo stacks. Turn each total into one entry at noon that day.
    const logs = (d.logs ?? {}) as DailyTotals
    for (const [day, perGoal] of Object.entries(logs)) {
      const at = parseKey(day).getTime() + 12 * 3600_000
      const list = Object.entries(perGoal ?? {})
        .filter(([, n]) => typeof n === 'number' && n !== 0)
        .map(([goalId, n]) => ({ id: uid(), goalId, amount: n, at }))
      if (list.length) entries[day] = list
    }
    // v2 introduced water tracking: seed it unless a ml goal already exists.
    if (!goals.some((g) => g.unit === 'ml' || g.id === 'water')) goals = [...goals, waterGoal()]
  } else {
    entries = d.entries && typeof d.entries === 'object' ? (d.entries as Record<string, Entry[]>) : {}
  }

  // v4 introduced stopwatch goals: seed Plank unless a timer goal already exists.
  if (version < 4 && !goals.some((g) => g.unit === 'sec' || g.id === 'plank')) {
    const w = goals.findIndex((g) => g.id === 'water')
    goals = w < 0 ? [...goals, plankGoal()] : [...goals.slice(0, w), plankGoal(), ...goals.slice(w)]
  }
  // v5 introduced weekday scheduling and preloaded the weekly exercise plan (now "Igor's Plan");
  // goals outside it stayed visible back then, so they aren't archived here either.
  if (version < 5) goals = applyPlan(goals, IGOR_PLAN, { archiveOthers: false })
  // v6: Bike becomes a GPS ride goal; data from v5 (or migrated above) is on Igor's Plan.
  if (version < 6) goals = goals.map((g) => (nameKey(g.name) === 'bike' && g.unit === 'sec' ? { ...g, kind: 'ride' as const } : g))
  const plan: PlanState | null = version < 6 ? { id: IGOR_PLAN.id } : readPlan(d.plan)
  const igor = plan?.id === IGOR_PLAN.id || plan?.basedOn === IGOR_PLAN.id
  // v7 gave Igor's Plan Bike a Thursday bonus day (riding to soccer); v8 corrects it: soccer is on
  // Monday (already a Bike day). So pre-v7 data gets nothing, and v7 values are undone below.
  // v8: on Igor's Plan (or Custom based on it) Soccer moves Thu → Mon and Bike drops its Thu bonus,
  // but only where they still have the v7 values (user edits are left alone).
  if (version < 8 && igor) {
    const same = (a: number[] | undefined, b: number[]) => JSON.stringify(a ?? []) === JSON.stringify(b)
    goals = goals.map((g) => {
      const k = nameKey(g.name)
      if (k === 'soccer' && same(g.days, [4])) return { ...g, days: [1] }
      if (k === 'bike' && same(g.bonusDays, [4])) {
        const { bonusDays: _b, ...rest } = g
        return rest
      }
      return g
    })
  }
  // v8: stopwatches can be paused; a stored start time becomes a running session.
  const timers: Record<string, Session> = {}
  for (const [id, t] of Object.entries((d.timers ?? {}) as Record<string, unknown>)) {
    const s = readSession(t)
    if (s && goals.some((g) => g.id === id)) timers[id] = s
  }

  return {
    version: DATA_VERSION,
    goals,
    entries,
    // v3: only the "wake up by" time remains (v1/v2 called it `wake`).
    sleep: { wakeBy: validTime(sleep.wakeBy) ?? validTime(sleep.wake) ?? base.sleep.wakeBy },
    timers,
    plan,
  }
}

export function totalsFrom(entries: Record<string, Entry[]>): DailyTotals {
  const out: DailyTotals = {}
  for (const [day, list] of Object.entries(entries)) {
    const t: Record<string, number> = {}
    for (const e of list) t[e.goalId] = Math.max(0, (t[e.goalId] ?? 0) + e.amount)
    out[day] = t
  }
  return out
}
