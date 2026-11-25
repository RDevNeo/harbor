import { addDays, dateKey } from './date'
import { DAY_SHORT, fmtDays, isScheduled } from './schedule'
import { amount, bestStreak, isDone, streak } from './stats'
import { fmtKm, fmtQty, fmtSecs, isRideGoal, isTimerGoal, isWaterGoal } from './format'
import { planLabel } from './plans'
import type { DailyTotals, Entry, Goal, PlanState } from './types'
import { fmtWalk, weekKm, type WalkDays } from './walking'

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface CoachInput {
  now: Date
  plan: PlanState | null
  goals: Goal[] // visible (non-archived) goals
  totals: DailyTotals
  entries: Record<string, Entry[]>
  /** Walked km per day (Health Connect), when available. */
  walk?: WalkDays
}

/**
 * Done / counted over the last `n` scheduled days before today (today is still in progress).
 * Days before the goal existed (and before its first log) aren't counted.
 */
export function recentCompletion(totals: DailyTotals, g: Goal, today: Date, n: number): { done: number; of: number } {
  const firstLog = Object.keys(totals).filter((k) => (totals[k]?.[g.id] ?? 0) > 0).sort()[0]
  const startKey = [g.createdAt, firstLog].filter(Boolean).sort()[0] ?? dateKey(today)
  let done = 0
  let of = 0
  for (let d = addDays(today, -1); of < n && dateKey(d) >= startKey; d = addDays(d, -1)) {
    if (!isScheduled(g, d)) continue
    of++
    if (isDone(totals, dateKey(d), g)) done++
  }
  return { done, of }
}

const pct = ({ done, of }: { done: number; of: number }) => (of ? `${done}/${of} (${Math.round((done / of) * 100)}%)` : '–')
const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`

type Line = { text: string; rank: number } // lower rank is dropped first when trimming; Infinity = always kept

export const COACH_CONTEXT_MAX_BYTES = 4096
const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

/**
 * Compact plain-text summary for the Coach chat, trimmed to at most `maxBytes` of UTF-8.
 * Trimming drops oldest rides first, then the ride/week/water lines, then goals from the end.
 */
export function coachSummary({ now, plan, goals, totals, entries, walk }: CoachInput, maxBytes = COACH_CONTEXT_MAX_BYTES): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tk = dateKey(today)
  const weekStart = addDays(today, -((today.getDay() + 6) % 7))
  const all = Object.values(entries).flat()
  const keep = (text: string): Line => ({ text, rank: Infinity })
  const lines: Line[] = [keep(`Routine — ${WEEKDAY[today.getDay()]} ${ddmm(today)}/${today.getFullYear()}`), keep(`Plan: ${planLabel(plan)}`), keep('')]

  goals.forEach((g, i) => {
    const sched = isScheduled(g, today) ? '' : ' (rest today)'
    const rank = 1000 + goals.length - i
    lines.push({ text: `${g.name}: ${fmtQty(g.target, g.unit)} · ${fmtDays(g.days, g.bonusDays)}`, rank })
    lines.push({
      text: `  today ${fmtQty(amount(totals, tk, g.id), g.unit)}${isDone(totals, tk, g) ? ' ✓' : ''}${sched} · streak ${streak(totals, g, today)} (best ${bestStreak(totals, g, today)}) · 7d ${pct(recentCompletion(totals, g, today, 7))} · 28d ${pct(recentCompletion(totals, g, today, 28))}`,
      rank,
    })
  })

  const water = goals.find(isWaterGoal)
  if (water) {
    let sum = 0
    for (let i = 1; i <= 7; i++) sum += amount(totals, dateKey(addDays(today, -i)), water.id)
    lines.push({ text: '', rank: 300 }, { text: `Water avg (last 7 days): ${fmtQty(Math.round(sum / 7 / 10) * 10, water.unit)}/day`, rank: 300 })
  }

  for (const g of goals.filter(isRideGoal)) {
    const rides = all.filter((e) => e.goalId === g.id && e.ride).sort((a, b) => b.at - a.at)
    const km = (list: Entry[]) => list.reduce((s, e) => s + (e.ride?.km ?? 0), 0)
    lines.push({ text: '', rank: 200 }, { text: `${g.name}: ${fmtKm(km(rides.filter((e) => e.at >= weekStart.getTime())))} km this week · ${fmtKm(km(rides))} km total`, rank: 200 })
    rides.slice(0, 3).forEach((e, i) => {
      const d = new Date(e.at)
      lines.push({ text: `  ${DAY_SHORT[d.getDay()]} ${ddmm(d)}: ${fmtKm(e.ride!.km)} km · ${fmtSecs(e.ride!.durationSec)} · ↑${e.ride!.gainM} m`, rank: 3 - i })
    })
  }

  if (walk) {
    lines.push({ text: '', rank: 280 }, { text: `Walked today: ${fmtWalk(walk[tk])} (week ${fmtWalk(weekKm(walk, today))})`, rank: 280 })
  }

  const timers = goals.filter((g) => isTimerGoal(g) && !isRideGoal(g))
  if (timers.length) {
    const week = (g: Goal) => {
      let s = 0
      for (let d = weekStart; d <= today; d = addDays(d, 1)) s += amount(totals, dateKey(d), g.id)
      return s
    }
    lines.push({ text: '', rank: 250 }, { text: `This week: ${timers.map((g) => `${g.name} ${fmtSecs(week(g))}`).join(' · ')}`, rank: 250 })
  }

  let size = bytes(lines.map((l) => l.text).join('\n'))
  while (size > maxBytes) {
    const min = lines.reduce((m, l, i) => (l.rank < lines[m]!.rank ? i : m), 0)
    if (lines[min]!.rank === Infinity) break
    size -= bytes(lines[min]!.text) + 1
    lines.splice(min, 1)
  }
  let text = lines.map((l) => l.text).join('\n')
  // Last resort (e.g. absurdly long names): cut on a code-point boundary.
  while (bytes(text) > maxBytes) text = Array.from(text).slice(0, -1).join('')
  return text
}
