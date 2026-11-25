/**
 * Actions the Coach agent can ask the app to do, written at the end of a reply as fenced blocks:
 *
 *   ```sf-action
 *   {"type":"log","goal":"Water","amount":500}
 *   ```
 *
 * - log   {goal, amount}  amount in the goal's unit (reps / ml / seconds); negative subtracts
 * - undo  {goal}          removes the goal's last entry of that day
 * - timer {goal, cmd}     cmd: start | pause | resume | stop (timer goals, not GPS rides)
 *
 * Pure: parsing, validation and labels. Execution (once per block) is in useCoachActions.
 */
import { fmtQty, isRideGoal, isTimerGoal } from './format'
import type { Goal } from './types'

export type TimerCmd = 'start' | 'pause' | 'resume' | 'stop'
export type CoachAction =
  | { type: 'log'; goal: string; amount: number }
  | { type: 'undo'; goal: string }
  | { type: 'timer'; goal: string; cmd: TimerCmd }

export type ParsedBlock = { ok: true; action: CoachAction; raw: string } | { ok: false; error: string; raw: string }

const FENCE = /```sf-action[^\S\n]*\n([\s\S]*?)```/g
const OPEN = /```sf-action/

/** Max |amount| accepted per log (a typo guard: 100 L, 10 000 reps, 24 h). */
const MAX_AMOUNT = 100_000

/**
 * Split an agent message into the text to show (blocks removed; an unfinished block at the end
 * of a streaming reply is hidden too) and its action blocks, in order.
 */
export function extractActions(text: string): { text: string; blocks: ParsedBlock[] } {
  const blocks: ParsedBlock[] = []
  let shown = text.replace(FENCE, (_m, body: string) => {
    blocks.push(parseBlock(body.trim()))
    return ''
  })
  const open = shown.search(OPEN)
  if (open >= 0) shown = shown.slice(0, open) // still being written
  return { text: shown.replace(/\n{3,}/g, '\n\n').trim(), blocks }
}

const CMDS: TimerCmd[] = ['start', 'pause', 'resume', 'stop']

export function parseBlock(raw: string): ParsedBlock {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'not JSON', raw }
  }
  if (!v || typeof v !== 'object') return { ok: false, error: 'not an object', raw }
  const o = v as Record<string, unknown>
  const goal = typeof o.goal === 'string' ? o.goal.trim() : ''
  if (!goal) return { ok: false, error: 'no goal', raw }
  if (o.type === 'log') {
    const amount = typeof o.amount === 'number' ? o.amount : typeof o.amount === 'string' ? Number(o.amount) : NaN
    if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'no amount', raw }
    if (Math.abs(amount) > MAX_AMOUNT) return { ok: false, error: 'amount too large', raw }
    return { ok: true, action: { type: 'log', goal, amount: Math.round(amount) }, raw }
  }
  if (o.type === 'undo') return { ok: true, action: { type: 'undo', goal }, raw }
  if (o.type === 'timer') {
    const cmd = typeof o.cmd === 'string' ? (o.cmd.toLowerCase() as TimerCmd) : null
    if (!cmd || !CMDS.includes(cmd)) return { ok: false, error: 'unknown timer command', raw }
    return { ok: true, action: { type: 'timer', goal, cmd }, raw }
  }
  return { ok: false, error: 'unknown action', raw }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Visible goal by name, case- and punctuation-insensitive ("push ups" = "Push-ups"). */
export function findGoal(goals: Goal[], name: string): Goal | null {
  const n = norm(name)
  return goals.find((g) => norm(g.name) === n) ?? null
}

export type TimerState = 'idle' | 'running' | 'paused'

/** Check an action against the goals (and the timer's state); returns the goal or why not. */
export function checkAction(a: CoachAction, goals: Goal[], timerState: (g: Goal) => TimerState): { goal: Goal } | { error: string } {
  const goal = findGoal(goals, a.goal)
  if (!goal) return { error: `no goal “${a.goal}”` }
  if (a.type === 'log' && isRideGoal(goal)) return { error: `${goal.name} is logged by GPS` }
  if (a.type !== 'timer') return { goal }
  if (!isTimerGoal(goal) || isRideGoal(goal)) return { error: `${goal.name} has no stopwatch` }
  const s = timerState(goal)
  const ok = a.cmd === 'start' ? s === 'idle' : a.cmd === 'pause' ? s === 'running' : a.cmd === 'resume' ? s === 'paused' : s !== 'idle'
  return ok ? { goal } : { error: `${goal.name} stopwatch is ${s === 'idle' ? 'not running' : s}` }
}

const PAST: Record<TimerCmd, string> = { start: 'started', pause: 'paused', resume: 'resumed', stop: 'stopped' }

/** Chip text for a done action: "+500 ml Water", "−10 reps Push-ups", "Undid last Water", "Plank started". */
export function actionLabel(a: CoachAction, goal: Goal): string {
  if (a.type === 'log') return `${a.amount > 0 ? '+' : '−'}${fmtQty(Math.abs(a.amount), goal.unit)} ${goal.name}`
  if (a.type === 'undo') return `Undid last ${goal.name}`
  return `${goal.name} ${PAST[a.cmd]}`
}

/** Stable key of one block: message id, position, and its content (ids are reused after a chat reset). */
export function blockKey(messageId: string, index: number, raw: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${messageId}#${index}#${(h >>> 0).toString(36)}`
}
