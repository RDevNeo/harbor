// Routine's changes as pure functions on AppData: what the React app's useAppData did, now done by Hub's engine
// (ts/tabs/routine/engine.ts) for the PC window and Hub for Android alike (POST v1/routine/act).
import { dateKey } from "./date";
import { elapsedMs, pauseSession, resumeSession, startSession } from "./session";
import { applyPlan, planById, toCustom } from "./plans";
import { uid } from "./store";
import type { RideSummary } from "./track";
import type { AppData, Entry, Goal, SleepSettings } from "./types";

export type TimerCmd = "start" | "pause" | "resume" | "stop";

/** A goal as the Goals form saves it (no id: a new goal). */
export type GoalDraft = Omit<Goal, "id" | "createdAt"> & { id?: string };

export type Act =
  | { act: "log"; goal: string; amount: number; day?: string; id?: string }
  | { act: "undo"; goal: string; day?: string }
  | { act: "remove"; entry: string }
  | { act: "reset"; goal: string }
  | { act: "timer"; goal: string; cmd: TimerCmd }
  | { act: "ride"; goal: string; ride: RideSummary; at?: number; id?: string }
  | { act: "save_goal"; goal: GoalDraft }
  | { act: "delete_goal"; id: string }
  | { act: "plan"; id: string }
  | { act: "sleep"; wakeBy: string };

const editDay = (d: AppData, day: string, fn: (list: Entry[]) => Entry[]): AppData => ({ ...d, entries: { ...d.entries, [day]: fn(d.entries[day] ?? []) } });

/** `act` applied at `now` (epoch ms); the same data when it changes nothing. */
export function apply(d: AppData, a: Act, now: number = Date.now()): AppData {
  const today = dateKey(new Date(now));
  switch (a.act) {
    case "log": {
      if (!a.amount) return d;
      return editDay(d, a.day ?? today, (list) => [...list, { id: a.id ?? uid(), goalId: a.goal, amount: a.amount, at: now }]);
    }
    case "undo":
      return editDay(d, a.day ?? today, (list) => {
        const i = list.map((e) => e.goalId).lastIndexOf(a.goal);
        return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
      });
    case "remove": {
      for (const [day, list] of Object.entries(d.entries)) {
        if (list?.some((e) => e.id === a.entry)) return { ...d, entries: { ...d.entries, [day]: list.filter((e) => e.id !== a.entry) } };
      }
      return d;
    }
    case "reset": {
      const { [a.goal]: _t, ...timers } = d.timers;
      return { ...d, timers, entries: { ...d.entries, [today]: (d.entries[today] ?? []).filter((e) => e.goalId !== a.goal) } };
    }
    case "timer": {
      const s = d.timers[a.goal];
      if (a.cmd === "start") return { ...d, timers: { ...d.timers, [a.goal]: startSession(now) } };
      if (!s) return d;
      if (a.cmd === "pause") return { ...d, timers: { ...d.timers, [a.goal]: pauseSession(s, now) } };
      if (a.cmd === "resume") return { ...d, timers: { ...d.timers, [a.goal]: resumeSession(s, now) } };
      const { [a.goal]: _t, ...timers } = d.timers;
      const secs = Math.round(elapsedMs(s, now) / 1000);
      if (secs < 1) return { ...d, timers };
      return { ...d, timers, entries: { ...d.entries, [today]: [...(d.entries[today] ?? []), { id: uid(), goalId: a.goal, amount: secs, at: now }] } };
    }
    case "ride": {
      const at = a.at ?? now;
      const day = dateKey(new Date(at));
      return { ...d, entries: { ...d.entries, [day]: [...(d.entries[day] ?? []), { id: a.id ?? uid(), goalId: a.goal, amount: a.ride.durationSec, at, ride: a.ride }] } };
    }
    case "save_goal": {
      const g = a.goal;
      const old = g.id ? d.goals.find((x) => x.id === g.id) : undefined;
      if (old) {
        const next: Goal = { ...old, ...g, id: old.id };
        if (!g.kind) delete next.kind;
        if (!g.days) delete next.days;
        if (!g.bonusDays) delete next.bonusDays;
        if (JSON.stringify(next) === JSON.stringify(old)) return d; // saved without changes: the plan stays as it is
        return { ...d, plan: toCustom(d.plan), goals: d.goals.map((x) => (x.id === old.id ? next : x)) };
      }
      const { id: _id, ...rest } = g;
      return { ...d, plan: toCustom(d.plan), goals: [...d.goals, { ...rest, id: uid(), createdAt: today }] };
    }
    case "delete_goal": {
      // "Delete" hides the goal (archived): its history stays, and a plan that includes it brings it back.
      const { [a.id]: _t, ...timers } = d.timers;
      return { ...d, timers, plan: toCustom(d.plan), goals: d.goals.map((g) => (g.id === a.id ? { ...g, archived: true } : g)) };
    }
    case "plan": {
      const plan = planById(a.id) ?? null;
      return { ...d, goals: applyPlan(d.goals, plan, { today }), plan: plan ? { id: plan.id } : { id: "custom" } };
    }
    case "sleep": {
      const patch: Partial<SleepSettings> = /^\d{2}:\d{2}$/.test(a.wakeBy) ? { wakeBy: a.wakeBy } : {};
      return { ...d, sleep: { ...d.sleep, ...patch } };
    }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);

/** A call's body as an Act, or why not. */
export function parseAct(b: unknown): Act | string {
  if (!b || typeof b !== "object") return "no act";
  const o = b as Record<string, unknown>;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str(o.day)) ? { day: str(o.day) } : {};
  switch (o.act) {
    case "log": {
      const amount = num(o.amount);
      if (!str(o.goal) || !Number.isFinite(amount)) return "log needs goal and amount";
      return { act: "log", goal: str(o.goal), amount: Math.round(amount), ...day, ...(str(o.id) ? { id: str(o.id) } : {}) };
    }
    case "undo":
      return str(o.goal) ? { act: "undo", goal: str(o.goal), ...day } : "undo needs goal";
    case "remove":
      return str(o.entry) ? { act: "remove", entry: str(o.entry) } : "remove needs entry";
    case "reset":
      return str(o.goal) ? { act: "reset", goal: str(o.goal) } : "reset needs goal";
    case "timer": {
      const cmd = str(o.cmd) as TimerCmd;
      return str(o.goal) && ["start", "pause", "resume", "stop"].includes(cmd) ? { act: "timer", goal: str(o.goal), cmd } : "timer needs goal and cmd";
    }
    case "ride": {
      const r = o.ride as Record<string, unknown> | null;
      if (!str(o.goal) || !r || typeof r !== "object") return "ride needs goal and ride";
      const ride: RideSummary = { km: num(r.km) || 0, gainM: num(r.gainM) || 0, durationSec: Math.max(0, Math.round(num(r.durationSec) || 0)), avgKmh: num(r.avgKmh) || 0 };
      if (Array.isArray(r.thumb)) ride.thumb = (r.thumb as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"));
      return { act: "ride", goal: str(o.goal), ride, ...(Number.isFinite(num(o.at)) ? { at: num(o.at) } : {}), ...(str(o.id) ? { id: str(o.id) } : {}) };
    }
    case "save_goal": {
      const g = o.goal as Record<string, unknown> | null;
      if (!g || typeof g !== "object" || !str(g.name).trim()) return "save_goal needs a goal with a name";
      const target = Math.max(1, Math.round(num(g.target) || 1));
      const days = Array.isArray(g.days) ? (g.days as unknown[]).filter((n): n is number => Number.isInteger(n)) : undefined;
      const bonusDays = Array.isArray(g.bonusDays) ? (g.bonusDays as unknown[]).filter((n): n is number => Number.isInteger(n)) : undefined;
      const draft: GoalDraft = {
        name: str(g.name).trim(),
        target,
        unit: str(g.unit).trim() || "reps",
        icon: (str(g.icon) || "activity") as Goal["icon"],
        color: str(g.color) || "#f97316",
        ...(str(g.id) ? { id: str(g.id) } : {}),
        ...(g.kind === "ride" ? { kind: "ride" as const } : {}),
        ...(days && days.length > 0 && days.length < 7 ? { days } : {}),
        ...(bonusDays && bonusDays.length > 0 ? { bonusDays } : {}),
      };
      return { act: "save_goal", goal: draft };
    }
    case "delete_goal":
      return str(o.id) ? { act: "delete_goal", id: str(o.id) } : "delete_goal needs id";
    case "plan":
      return str(o.id) ? { act: "plan", id: str(o.id) } : "plan needs id";
    case "sleep":
      return /^\d{2}:\d{2}$/.test(str(o.wakeBy)) ? { act: "sleep", wakeBy: str(o.wakeBy) } : "sleep needs wakeBy HH:MM";
    default:
      return `unknown act ${str(o.act)}`;
  }
}
