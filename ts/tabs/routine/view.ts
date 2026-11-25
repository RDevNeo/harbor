// What Routine's screens show, computed once from its data (Schedule Fixer's Today, History and Goals screens):
// the PC window (packages/ui/src/tabs/routine/ui.ts) draws it in Slint, and Hub for Android gets the same through
// GET v1/routine/view, so both show the same numbers.
import { addDays, dateKey, fmtClock, fmtDuration, parseKey } from "./lib/date.ts";
import { fmtKm, fmtProgress, fmtQty, fmtSecs, isRideGoal, isTimerGoal, quickLabel } from "./lib/format.ts";
import { goalGlyph } from "./lib/goalicons.ts";
import { activeGoals, COLORS, PLANS, planLabel } from "./lib/plans.ts";
import { DAY_SHORT, fmtDays, isBonus, isScheduled, isShownOn } from "./lib/schedule.ts";
import { elapsedMs, isPaused, type Session } from "./lib/session.ts";
import { wakeOptions } from "./lib/sleepCycles.ts";
import { amount, bestStreak, bonusDone, dayCompletion, isDone, streak } from "./lib/stats.ts";
import { quickAddsFor, totalsFrom } from "./lib/store.ts";
import type { AppData, DailyTotals, Entry, Goal } from "./lib/types.ts";
import { fmtWalk, HISTORY_DAYS, weekKm, type WalkDays } from "./lib/walking.ts";

export const WALK = "__walk";
export const WEEKS = 8;

export interface ActiveRide {
  goalId: string;
  session: Session;
  distM: number;
  gainM: number;
}

/** An arc from 12 o'clock, clockwise, `frac` of the circle (r 44 in a 100 box): "" for none. */
export function ringPath(frac: number): string {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0) return "";
  if (f >= 0.9999) return "M 50 6 A 44 44 0 1 1 49.99 6";
  const a = f * 2 * Math.PI - Math.PI / 2;
  return `M 50 6 A 44 44 0 ${f > 0.5 ? 1 : 0} 1 ${(50 + 44 * Math.cos(a)).toFixed(2)} ${(50 + 44 * Math.sin(a)).toFixed(2)}`;
}

/** A goal's color as an index of the palette (COLORS; water's blue is COLORS[7]). */
export function colorIndex(c: string): number {
  const i = COLORS.findIndex((x) => x.toLowerCase() === c.trim().toLowerCase());
  return i < 0 ? 2 : i;
}

/** A ride's thumbnail (0..1 points) as a path in a -0.1..1.1 box. */
export function thumbPath(points: [number, number][] | undefined): string {
  if (!points || points.length < 2) return "";
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${(x + 0.1).toFixed(3)} ${(y + 0.1).toFixed(3)}`).join(" ");
}

const ddmm = (d: Date): string => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

export interface TodayGoal {
  id: string;
  name: string;
  color: number;
  hex: string;
  glyph: string;
  done: boolean;
  bonus: boolean;
  value: string;
  rest: string;
  frac: number;
  ring: string;
  streak: number;
  kind: "count" | "timer" | "ride";
  quick: { label: string; amount: number }[];
  session: "idle" | "running" | "paused";
  /** The stopwatch's (or ride's) seconds now, and when it runs, the epoch ms it started counting from (clock = (now - base) / 1000). */
  secs: number;
  base: number;
  sub: string;
  todayKm: number;
  canUndo: boolean;
  canReset: boolean;
}

export interface TodayView {
  pct: number;
  ring: string;
  walk: string;
  empty: "" | "first" | "rest";
  dense: boolean;
  goals: TodayGoal[];
}

export function todayView(d: AppData, walking: WalkDays, ride: ActiveRide | null, now = Date.now()): TodayView {
  const totals = totalsFrom(d.entries);
  const all = activeGoals(d.goals);
  const today = dateKey(new Date(now));
  const goals = all
    .filter((g) => isShownOn(g, today) || d.timers[g.id] != null || ride?.goalId === g.id)
    .sort((a, b) => Number(isBonus(a, today)) - Number(isBonus(b, today)));
  const pct = dayCompletion(totals, today, goals) ?? 0;
  const todayEntries = d.entries[today] ?? [];
  return {
    pct,
    ring: ringPath(pct),
    walk: Object.keys(walking).length > 0 ? fmtWalk(walking[today]) : "",
    empty: all.length === 0 ? "first" : goals.length === 0 ? "rest" : "",
    dense: goals.length >= 5,
    goals: goals.map((g) => {
      const n = amount(totals, today, g.id);
      const prog = fmtProgress(n, g);
      const started = d.timers[g.id];
      const riding = ride?.goalId === g.id ? ride : null;
      const isRide = isRideGoal(g);
      const timer = !isRide && isTimerGoal(g);
      const todayKm = todayEntries.reduce((km, e) => km + (e.goalId === g.id && e.ride ? e.ride.km : 0), 0);
      const s = isRide ? (riding?.session ?? null) : timer ? (started ?? null) : null;
      const session = s ? (isPaused(s) ? "paused" : "running") : "idle";
      const secs = s ? elapsedMs(s, now) / 1000 : 0;
      return {
        id: g.id,
        name: g.name,
        color: colorIndex(g.color),
        hex: g.color,
        glyph: goalGlyph(g.icon),
        done: n >= g.target,
        bonus: isBonus(g, today),
        value: prog.value,
        rest: prog.rest,
        frac: g.target > 0 ? n / g.target : 0,
        ring: ringPath(g.target > 0 ? n / g.target : 0),
        streak: streak(totals, g, new Date(now)),
        kind: isRide ? "ride" : timer ? "timer" : "count",
        quick: isRide || timer ? [] : quickAddsFor(g.unit).map((k) => ({ label: quickLabel(k, g.unit), amount: k })),
        session,
        secs,
        base: s && !isPaused(s) ? now - secs * 1000 : 0,
        sub: isRide ? (riding ? `${fmtKm(riding.distM / 1000)} km · ↑${Math.round(riding.gainM)} m` : `${fmtKm(todayKm)} km`) : "",
        todayKm,
        canUndo: todayEntries.some((e) => e.goalId === g.id),
        canReset: todayEntries.some((e) => e.goalId === g.id) || started != null,
      };
    }),
  };
}

export interface HistoryView {
  sel: string;
  segs: { id: string; label: string }[];
  walkView: boolean;
  walkTotals: string[];
  walkBars: { frac: number; approx: boolean; today: boolean; tip: string }[];
  walkFrom: string;
  walkTo: string;
  streaks: { id: string; name: string; color: number; hex: string; glyph: string; line: string; streak: number }[];
  /** 8 weeks × Mon..Sun; level 0..4 done, 5 rest day, 6 future. */
  cells: { col: number; row: number; level: number; today: boolean; tip: string }[];
  heat: number;
  heatHex: string;
  fullDays: string;
  rides: { day: string; km: string; time: string; gain: string; thumb: string }[];
  ridesWeek: string;
  ridesTotal: string;
}

export function historyView(d: AppData, walking: WalkDays, selected: string, now = Date.now()): HistoryView {
  const totals: DailyTotals = totalsFrom(d.entries);
  const goals = activeGoals(d.goals);
  const today = dateKey(new Date(now));
  const hasWalk = Object.keys(walking).length > 0;
  let sel = selected;
  if (sel !== "all" && sel !== WALK && !goals.some((g) => g.id === sel)) sel = "all";
  if (sel === WALK && !hasWalk) sel = "all";
  const t = parseKey(today);
  const v: HistoryView = {
    sel,
    segs: [{ id: "all", label: "All" }, ...goals.map((g) => ({ id: g.id, label: g.name })), ...(hasWalk ? [{ id: WALK, label: "Walking" }] : [])],
    walkView: sel === WALK,
    walkTotals: [],
    walkBars: [],
    walkFrom: "",
    walkTo: "",
    streaks: [],
    cells: [],
    heat: -1,
    heatHex: "",
    fullDays: "",
    rides: [],
    ridesWeek: "",
    ridesTotal: "",
  };
  if (sel === WALK) {
    const list = Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const dd = addDays(t, i - (HISTORY_DAYS - 1));
      const k = dateKey(dd);
      return { k, dd, w: walking[k] };
    });
    const max = Math.max(1, ...list.map((x) => x.w?.km ?? 0));
    const logged = list.filter((x) => x.w);
    const avg = logged.length ? logged.reduce((s, x) => s + (x.w?.km ?? 0), 0) / logged.length : 0;
    v.walkTotals = [fmtWalk(weekKm(walking, t)), fmtWalk(walking[today]), fmtWalk({ km: avg })];
    v.walkBars = list.map(({ k, dd, w }) => ({ frac: (w?.km ?? 0) / max, approx: w?.approx === true, today: k === today, tip: `${ddmm(dd)} — ${fmtWalk(w)}` }));
    v.walkFrom = ddmm(list[0]?.dd ?? t);
    v.walkTo = ddmm(t);
    return v;
  }
  const goal = goals.find((g) => g.id === sel);
  const shown = goal ? [goal] : goals;
  v.streaks = shown.map((g) => ({
    id: g.id,
    name: g.name,
    color: colorIndex(g.color),
    hex: g.color,
    glyph: goalGlyph(g.icon),
    line: `Best ${days(bestStreak(totals, g, t))} · ${isDone(totals, today, g) ? "done today" : isScheduled(g, today) ? "not done today" : isBonus(g, today) ? "bonus today" : "rest today"}`,
    streak: streak(totals, g, t),
  }));
  const start = addDays(t, -((t.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const level = (k: string): number => {
    const lv = (x: number): number => (x >= 1 ? 4 : x >= 0.66 ? 3 : x >= 0.33 ? 2 : x > 0 ? 1 : 0);
    if (goal) {
      const x = amount(totals, k, goal.id) / goal.target;
      if (isBonus(goal, k)) return bonusDone(totals, k, goal) ? 4 : 5;
      return !isScheduled(goal, k) && x <= 0 ? 5 : lv(x);
    }
    const x = dayCompletion(totals, k, goals);
    return x == null ? 5 : lv(x);
  };
  let full = 0;
  for (let w = 0; w < WEEKS; w++) {
    for (let r = 0; r < 7; r++) {
      const day = addDays(start, w * 7 + r);
      const k = dateKey(day);
      const future = day > t;
      const l = future ? 6 : level(k);
      if (l === 4) full++;
      v.cells.push({ col: w, row: r, level: l, today: k === today, tip: future ? k : `${k} — ${l === 5 ? "rest day" : l === 4 ? "completed" : "not completed"}` });
    }
  }
  v.heat = goal ? colorIndex(goal.color) : -1;
  v.heatHex = goal?.color ?? "";
  v.fullDays = `${full} full ${full === 1 ? "day" : "days"} in the last ${WEEKS} weeks`;
  if (goal && isRideGoal(goal)) {
    const rides = Object.values(d.entries)
      .flat()
      .filter((e): e is Entry & { ride: NonNullable<Entry["ride"]> } => e.goalId === goal.id && e.ride !== undefined)
      .sort((a, b) => b.at - a.at);
    const weekStart = addDays(t, -((t.getDay() + 6) % 7)).getTime();
    const km = (list: typeof rides): number => list.reduce((s, e) => s + e.ride.km, 0);
    v.ridesWeek = fmtKm(km(rides.filter((e) => e.at >= weekStart)));
    v.ridesTotal = fmtKm(km(rides));
    v.rides = rides.slice(0, 4).map((e) => {
      const dd = new Date(e.at);
      return { day: `${DAY_SHORT[dd.getDay()]} ${ddmm(dd)}`, km: fmtKm(e.ride.km), time: fmtSecs(e.ride.durationSec), gain: String(e.ride.gainM), thumb: thumbPath(e.ride.thumb) };
    });
  }
  return v;
}

export interface GoalsView {
  planLabel: string;
  rows: { id: string; name: string; color: number; hex: string; glyph: string; line: string }[];
  plans: { id: string; name: string; meta: string; on: boolean }[];
}

export function goalsView(d: AppData): GoalsView {
  return {
    planLabel: planLabel(d.plan),
    rows: activeGoals(d.goals).map((g) => ({ id: g.id, name: g.name, color: colorIndex(g.color), hex: g.color, glyph: goalGlyph(g.icon), line: [fmtQty(g.target, g.unit), fmtDays(g.days, g.bonusDays)].join(" · ") })),
    plans: [
      ...PLANS.map((p) => ({ id: p.id, name: p.name, meta: p.goals.map((g) => `${g.name} ${fmtQty(g.target, g.unit)}`).join(" · "), on: d.plan?.id === p.id })),
      { id: "empty", name: "Empty", meta: "No goals: add your own", on: false },
    ],
  };
}

/** "Going to sleep now": the wake-up options from `now` (3–6 cycles), the recommended one marked. */
export function wakeView(wakeBy: string, now = new Date()): { time: string; hour: number; minute: number; cycles: number; meta: string; rec: boolean }[] {
  return wakeOptions(now, wakeBy).map((o) => ({
    time: fmtClock(o.wakeAt),
    hour: o.wakeAt.getHours(),
    minute: o.wakeAt.getMinutes(),
    cycles: o.cycles,
    meta: `${o.cycles} cycles · ${fmtDuration(o.sleepMin)}${o.short ? " · short" : ""}`,
    rec: o.recommended,
  }));
}

/** Everything a phone draws, in one answer (GET v1/routine/view?sel=…). */
export function fullView(d: AppData, walking: WalkDays, ride: ActiveRide | null, sel: string, now = Date.now()) {
  return {
    picking: d.plan === null,
    wakeBy: d.sleep.wakeBy,
    today: todayView(d, walking, ride, now),
    history: historyView(d, walking, sel, now),
    goals: goalsView(d),
    wakes: wakeView(d.sleep.wakeBy, new Date(now)),
    goalIcons: activeGoals(d.goals).map((g) => ({ id: g.id, icon: g.icon, color: g.color, unit: g.unit, kind: g.kind ?? "", target: g.target, days: g.days ?? [], bonusDays: g.bonusDays ?? [], name: g.name })),
  };
}
