import { describe, expect, it } from 'bun:test'
import { actionLabel, blockKey, checkAction, extractActions, findGoal, parseBlock } from '../lib/coachActions'
import type { Goal } from '../lib/types'

const g = (id: string, name: string, unit: string, extra: Partial<Goal> = {}): Goal => ({ id, name, target: 1, unit, icon: 'activity', color: '#fff', createdAt: '2026-11-01', ...extra })
const goals = [g('water', 'Water', 'ml'), g('push', 'Push-ups', 'reps'), g('plank', 'Plank', 'sec'), g('bike', 'Bike', 'sec', { kind: 'ride' })]

describe('coach actions', () => {
  it('pulls blocks out of the reply and keeps the text', () => {
    const r = extractActions('Done! Logged it.\n\n```sf-action\n{"type":"log","goal":"Water","amount":500}\n```\n```sf-action\n{"type":"undo","goal":"Push-ups"}\n```')
    expect(r.text).toBe('Done! Logged it.')
    expect(r.blocks.map((b) => b.ok && b.action)).toEqual([
      { type: 'log', goal: 'Water', amount: 500 },
      { type: 'undo', goal: 'Push-ups' },
    ])
  })

  it('hides a block still being written', () => {
    expect(extractActions('Logging…\n```sf-action\n{"type":"lo').text).toBe('Logging…')
    expect(extractActions('Logging…\n```sf-action\n{"type":"lo').blocks).toEqual([])
  })

  it('leaves other code blocks alone', () => {
    expect(extractActions('```js\nx\n```').text).toBe('```js\nx\n```')
  })

  it('validates blocks', () => {
    expect(parseBlock('nope')).toMatchObject({ ok: false, error: 'not JSON' })
    expect(parseBlock('{"type":"log","goal":"Water"}')).toMatchObject({ ok: false, error: 'no amount' })
    expect(parseBlock('{"type":"log","goal":"Water","amount":"250"}')).toMatchObject({ ok: true, action: { amount: 250 } })
    expect(parseBlock('{"type":"log","goal":"Water","amount":1e9}')).toMatchObject({ ok: false, error: 'amount too large' })
    expect(parseBlock('{"type":"timer","goal":"Plank","cmd":"START"}')).toMatchObject({ ok: true, action: { cmd: 'start' } })
    expect(parseBlock('{"type":"timer","goal":"Plank","cmd":"go"}')).toMatchObject({ ok: false })
    expect(parseBlock('{"type":"delete","goal":"Plank"}')).toMatchObject({ ok: false, error: 'unknown action' })
    expect(parseBlock('{"type":"log","amount":5}')).toMatchObject({ ok: false, error: 'no goal' })
  })

  it('finds goals loosely and checks what each can do', () => {
    expect(findGoal(goals, 'push ups')?.id).toBe('push')
    expect(findGoal(goals, 'WATER')?.id).toBe('water')
    const idle = () => 'idle' as const
    expect(checkAction({ type: 'log', goal: 'juice', amount: 1 }, goals, idle)).toEqual({ error: 'no goal “juice”' })
    expect(checkAction({ type: 'log', goal: 'bike', amount: 60 }, goals, idle)).toEqual({ error: 'Bike is logged by GPS' })
    expect(checkAction({ type: 'timer', goal: 'Water', cmd: 'start' }, goals, idle)).toEqual({ error: 'Water has no stopwatch' })
    expect(checkAction({ type: 'timer', goal: 'Bike', cmd: 'start' }, goals, idle)).toEqual({ error: 'Bike has no stopwatch' })
    expect(checkAction({ type: 'timer', goal: 'Plank', cmd: 'start' }, goals, idle)).toMatchObject({ goal: { id: 'plank' } })
    expect(checkAction({ type: 'timer', goal: 'Plank', cmd: 'pause' }, goals, idle)).toEqual({ error: 'Plank stopwatch is not running' })
    expect(checkAction({ type: 'timer', goal: 'Plank', cmd: 'start' }, goals, () => 'running')).toEqual({ error: 'Plank stopwatch is running' })
    expect(checkAction({ type: 'timer', goal: 'Plank', cmd: 'resume' }, goals, () => 'paused')).toMatchObject({ goal: { id: 'plank' } })
    expect(checkAction({ type: 'timer', goal: 'Plank', cmd: 'stop' }, goals, () => 'paused')).toMatchObject({ goal: { id: 'plank' } })
  })

  it('labels chips', () => {
    expect(actionLabel({ type: 'log', goal: 'water', amount: 500 }, goals[0])).toBe('+500 ml Water')
    expect(actionLabel({ type: 'log', goal: 'water', amount: 1500 }, goals[0])).toBe('+1.5 L Water')
    expect(actionLabel({ type: 'log', goal: 'push', amount: -10 }, goals[1])).toBe('−10 reps Push-ups')
    expect(actionLabel({ type: 'log', goal: 'plank', amount: 120 }, goals[2])).toBe('+2 min Plank')
    expect(actionLabel({ type: 'undo', goal: 'water' }, goals[0])).toBe('Undid last Water')
    expect(actionLabel({ type: 'timer', goal: 'plank', cmd: 'start' }, goals[2])).toBe('Plank started')
  })

  it('keys blocks by message, position and content', () => {
    expect(blockKey('5', 0, 'a')).toBe(blockKey('5', 0, 'a'))
    expect(blockKey('5', 0, 'a')).not.toBe(blockKey('5', 0, 'b'))
    expect(blockKey('5', 0, 'a')).not.toBe(blockKey('5', 1, 'a'))
  })
})
