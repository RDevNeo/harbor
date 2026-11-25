import { dateKey } from './date'
import type { Goal, PlanState } from './types'

export const COLORS: readonly [string, string, string, string, string, string, string, string] = ['#7c5cff', '#22c55e', '#f97316', '#06b6d4', '#ec4899', '#eab308', '#ef4444', '#3b82f6']
export const WATER_COLOR = '#3b82f6'

/** A goal as defined by a plan (`id` is only used when the goal has to be created). */
export type PlanGoal = Omit<Goal, 'createdAt' | 'archived'>

export interface Plan {
  id: string
  name: string
  goals: PlanGoal[]
}

const MWF = [1, 3, 5]

export const IGOR_PLAN: Plan = {
  id: 'igor',
  name: "Igor's Plan",
  goals: [
    { id: 'water', name: 'Water', target: 3500, unit: 'ml', icon: 'droplet', color: WATER_COLOR },
    { id: 'pushups', name: 'Push-ups', target: 36, unit: 'reps', icon: 'arm', color: COLORS[1], days: MWF }, // 3×12
    { id: 'abs', name: 'Abs', target: 45, unit: 'reps', icon: 'activity', color: COLORS[0], days: MWF }, // 3×15
    { id: 'squats', name: 'Squats', target: 36, unit: 'reps', icon: 'dumbbell', color: COLORS[2], days: MWF }, // 3×12
    { id: 'plank', name: 'Plank', target: 120, unit: 'sec', icon: 'timer', color: COLORS[3], days: MWF },
    { id: 'bike', name: 'Bike', target: 1800, unit: 'sec', kind: 'ride', icon: 'bike', color: COLORS[5], days: [1, 2, 3, 5, 6] }, // Monday's ride is to soccer
    { id: 'soccer', name: 'Soccer', target: 3600, unit: 'sec', icon: 'run', color: COLORS[4], days: [1] },
  ],
}

export const BASIC_PLAN: Plan = {
  id: 'basic',
  name: 'Basic',
  goals: [
    { id: 'water', name: 'Water', target: 2000, unit: 'ml', icon: 'droplet', color: WATER_COLOR },
    { id: 'pushups', name: 'Push-ups', target: 30, unit: 'reps', icon: 'arm', color: COLORS[1] },
    { id: 'abs', name: 'Abs', target: 50, unit: 'reps', icon: 'activity', color: COLORS[0] },
  ],
}

export const PLANS: Plan[] = [IGOR_PLAN, BASIC_PLAN]

export const planById = (id?: string) => PLANS.find((p) => p.id === id)

export function planLabel(s: PlanState | null): string {
  if (!s) return 'No plan'
  if (s.id !== 'custom') return planById(s.id)?.name ?? 'Custom'
  const base = planById(s.basedOn)
  return base ? `Custom (based on ${base.name})` : 'Custom'
}

/** After a manual goal edit the plan becomes custom (remembering what it was based on). */
export function toCustom(s: PlanState | null): PlanState {
  if (!s || s.id === 'custom') return { id: 'custom', ...(s?.basedOn ? { basedOn: s.basedOn } : {}) }
  return { id: 'custom', basedOn: s.id }
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Apply a plan to the current goals. Goals are matched by name (case-insensitive, ignoring
 * spaces/dashes): matches keep their id, icon, color and history and take the plan's target, unit,
 * type, days and bonus days; missing ones are created. With `archiveOthers`, goals not in the plan are hidden
 * (archived), never deleted. Result: plan goals in plan order, then the others.
 */
export function applyPlan(goals: Goal[], plan: Plan | null, { archiveOthers = true, today = dateKey() } = {}): Goal[] {
  const rest = [...goals]
  const planned: Goal[] = []
  for (const p of plan?.goals ?? []) {
    const i = rest.findIndex((g) => nameKey(g.name) === nameKey(p.name))
    if (i >= 0) {
      const { days: _d, bonusDays: _b, kind: _k, archived: _a, ...g } = rest.splice(i, 1)[0]!
      planned.push({ ...g, target: p.target, unit: p.unit, ...(p.days ? { days: p.days } : {}), ...(p.bonusDays ? { bonusDays: p.bonusDays } : {}), ...(p.kind ? { kind: p.kind } : {}) })
    } else {
      const id = goals.some((g) => g.id === p.id) ? `${p.id}-${Math.random().toString(36).slice(2, 8)}` : p.id
      planned.push({ ...p, id, createdAt: today })
    }
  }
  return [...planned, ...rest.map((g) => (archiveOthers ? { ...g, archived: true } : g))]
}

/** Goals shown in the app (not archived by a plan). */
export const activeGoals = (goals: Goal[]) => goals.filter((g) => !g.archived)
