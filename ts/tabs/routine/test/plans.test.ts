import { describe, expect, it } from 'bun:test'
import { BASIC_PLAN, IGOR_PLAN, activeGoals, applyPlan, planLabel, toCustom } from '../lib/plans'
import type { Goal } from '../lib/types'

const today = '2026-11-21'

describe('plans', () => {
  it('applies a plan to an empty install', () => {
    const goals = applyPlan([], BASIC_PLAN, { today })
    expect(goals.map((g) => [g.name, g.target, g.unit])).toEqual([['Water', 2000, 'ml'], ['Push-ups', 30, 'reps'], ['Abs', 50, 'reps']])
    expect(goals.every((g) => g.createdAt === today && !g.days && !g.archived)).toBe(true)
  })

  it('switching plans upserts by name, archives the rest, and brings them back later', () => {
    const igor = applyPlan([], IGOR_PLAN, { today })
    const custom: Goal = { id: 'yoga', name: 'Yoga', target: 10, unit: 'reps', icon: 'leaf', color: '#fff', createdAt: today }
    const basic = applyPlan([...igor, custom], BASIC_PLAN, { today })
    const by = (gs: Goal[], n: string) => gs.find((g) => g.name === n)!
    // Same ids (history kept), new targets, every day.
    expect(by(basic, 'Push-ups')).toMatchObject({ id: 'pushups', target: 30 })
    expect(by(basic, 'Push-ups').days).toBeUndefined()
    expect(by(basic, 'Water')).toMatchObject({ id: 'water', target: 2000 })
    // Not in Basic → hidden, not deleted.
    expect(basic).toHaveLength(igor.length + 1)
    expect(activeGoals(basic).map((g) => g.name)).toEqual(['Water', 'Push-ups', 'Abs'])
    expect(by(basic, 'Bike')).toMatchObject({ archived: true, kind: 'ride' })
    // Back to Igor's Plan: Bike returns with the same id, Yoga stays hidden.
    const again = applyPlan(basic, IGOR_PLAN, { today })
    expect(by(again, 'Bike')).toMatchObject({ id: 'bike', kind: 'ride', target: 1800, days: [1, 2, 3, 5, 6] })
    expect(by(again, 'Bike').archived).toBeUndefined()
    expect(by(again, 'Push-ups')).toMatchObject({ id: 'pushups', target: 36, days: [1, 3, 5] })
    expect(by(again, 'Yoga').archived).toBe(true)
    expect(new Set(again.map((g) => g.id)).size).toBe(again.length)
  })

  it('"Empty" (no plan) hides every goal', () => {
    expect(activeGoals(applyPlan(applyPlan([], BASIC_PLAN, { today }), null, { today }))).toEqual([])
  })

  it('labels and custom state', () => {
    expect(planLabel({ id: 'igor' })).toBe("Igor's Plan")
    expect(toCustom({ id: 'igor' })).toEqual({ id: 'custom', basedOn: 'igor' })
    expect(toCustom(toCustom({ id: 'igor' }))).toEqual({ id: 'custom', basedOn: 'igor' })
    expect(planLabel(toCustom({ id: 'igor' }))).toBe("Custom (based on Igor's Plan)")
    expect(planLabel(toCustom(null))).toBe('Custom')
  })
})
