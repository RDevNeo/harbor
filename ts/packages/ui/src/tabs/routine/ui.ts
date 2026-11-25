// Routine tab, window side: drives RoutineBus (slint/routine.slint) from the engine's state (GET v1/routine), with the
// same computations Schedule Fixer's screens made (ts/tabs/routine/lib), and sends every change back (v1/routine/act…).
import type { TabCtx, TabUi } from "../api.ts";
import { addDays, dateKey, fmtClock, fmtDuration, parseKey } from "../../../../../tabs/routine/lib/date.ts";
import { fmtKm, fmtProgress, fmtQty, fmtSecs, isRideGoal, isTimerGoal, isTimerUnit, quickLabel } from "../../../../../tabs/routine/lib/format.ts";
import { GOAL_GLYPH, GOAL_ICON_KEYS, goalGlyph, type GoalIconKey } from "../../../../../tabs/routine/lib/goalicons.ts";
import { activeGoals, COLORS, PLANS, planLabel } from "../../../../../tabs/routine/lib/plans.ts";
import { DAY_SHORT, fmtDays, isBonus, isScheduled, isShownOn, normalizeBonusDays, normalizeDays, WEEK_ORDER } from "../../../../../tabs/routine/lib/schedule.ts";
import { elapsedMs, isPaused, type Session } from "../../../../../tabs/routine/lib/session.ts";
import { wakeOptions } from "../../../../../tabs/routine/lib/sleepCycles.ts";
import { amount, bestStreak, bonusDone, dayCompletion, isDone, streak } from "../../../../../tabs/routine/lib/stats.ts";
import { quickAddsFor, totalsFrom } from "../../../../../tabs/routine/lib/store.ts";
import type { AppData, DailyTotals, Entry, Goal } from "../../../../../tabs/routine/lib/types.ts";
import { fmtWalk, HISTORY_DAYS, weekKm, type WalkDays } from "../../../../../tabs/routine/lib/walking.ts";

type Section = "today" | "history" | "sleep" | "goals" | "coach";
const SECTIONS: Section[] = ["today", "history", "sleep", "goals", "coach"];
const WALK = "__walk";
const WEEKS = 8;
type GoalType = 0 | 1 | 2 | 3; // count, water, timer, ride

interface State {
  rev: number;
  data: AppData;
  walking: WalkDays;
  ride: { goalId: string; session: Session; distM: number; gainM: number } | null;
}

interface CoachState {
  messages: { id: string; role: "user" | "agent"; text: string; done: boolean; chips: { key: string; ok: boolean; label: string; canUndo: boolean; undone: boolean }[] }[];
  running: boolean;
  ready: boolean;
  project: string;
}

interface Draft {
  id?: string;
  name: string;
  target: string;
  type: GoalType;
  unit: string;
  icon: GoalIconKey;
  color: number;
  days: number[];
  bonusDays: number[];
}

/** The Slint global, as slint-node shows it (dashes become underscores). */
type Bus = Record<string, unknown> & {
  section: string;
  loading: boolean;
  picking: boolean;
  f_name: string;
  f_target: string;
  f_unit: string;
  imp_text: string;
  coach_text: string;
};

/** An arc from 12 o'clock, clockwise, `frac` of the circle (r 44 in a 100 box): "" for none. */
export function ringPath(frac: number): string {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0) return "";
  if (f >= 0.9999) return "M 50 6 A 44 44 0 1 1 49.99 6";
  const a = f * 2 * Math.PI - Math.PI / 2;
  const x = 50 + 44 * Math.cos(a);
  const y = 50 + 44 * Math.sin(a);
  return `M 50 6 A 44 44 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
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
const typeOf = (g: Pick<Goal, "unit" | "kind">): GoalType => (g.kind === "ride" ? 3 : isTimerUnit(g.unit) ? 2 : g.unit.trim().toLowerCase() === "ml" ? 1 : 0);

export function createRoutineUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let st: State | null = null;
  let totals: DailyTotals = {};
  // Screenshots: HARBOR_ROUTINE_SECTION picks the section shown first.
  let section: Section = SECTIONS.includes(process.env.HARBOR_ROUTINE_SECTION as Section) ? (process.env.HARBOR_ROUTINE_SECTION as Section) : "today";
  let hsel = "all";
  let confirmReset = "";
  let confirmDel = "";
  let sheet = "";
  let draft: Draft | null = null;
  let formError = "";
  let lastAlarm = "";
  let wakeAt: Date[] = [];
  let coach: CoachState | null = null;
  let coachNote = "";
  let importBusy = false;
  let importReady = false;
  let tick: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const set = (k: string, v: unknown): void => {
    if (bus) bus[k] = v;
  };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!ctx) throw new Error("not mounted");
    const r = await ctx.call(method, path, undefined, body);
    if (r.status >= 300) {
      const e = (r.body as { error?: string } | null)?.error;
      throw new Error(e ?? `Hub answered ${r.status}`);
    }
    return r.body;
  };

  const take = (s: State): void => {
    st = s;
    totals = totalsFrom(s.data.entries);
    render();
  };

  const load = async (): Promise<void> => {
    try {
      take((await call("GET", "v1/routine")) as State);
      set("loading", false);
    } catch (e) {
      set("error", e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (body: Record<string, unknown>): Promise<void> => {
    try {
      take((await call("POST", "v1/routine/act", body)) as State);
    } catch (e) {
      ctx?.toast(e instanceof Error ? e.message : String(e));
    }
  };

  // ---------- drawing ----------

  function render(): void {
    if (!bus || !st) return;
    const d = st.data;
    set("picking", d.plan === null);
    set("section", section);
    set("sheet", sheet);
    const goals = activeGoals(d.goals);
    if (section === "today") renderToday(d, goals);
    if (section === "history") renderHistory(d, goals);
    if (section === "sleep") renderSleep(d);
    renderGoals(d, goals);
    renderForm();
    if (section === "coach") renderCoach();
    const running = Object.values(d.timers).some((t) => !isPaused(t)) || (st.ride !== null && !isPaused(st.ride.session));
    if (running && tick === null && section === "today") tick = setInterval(() => ctx?.shown() && render(), 1000);
    if ((!running || section !== "today") && tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  }

  function renderToday(d: AppData, all: Goal[]): void {
    const today = dateKey();
    const now = Date.now();
    const ride = st?.ride ?? null;
    const goals = all
      .filter((g) => isShownOn(g, today) || d.timers[g.id] != null || ride?.goalId === g.id)
      .sort((a, b) => Number(isBonus(a, today)) - Number(isBonus(b, today)));
    const pct = dayCompletion(totals, today, goals) ?? 0;
    set("pct", pct);
    set("pct_ring", ringPath(pct));
    const w = st?.walking ?? {};
    set("walk", Object.keys(w).length > 0 ? fmtWalk(w[today]) : "");
    set("empty", all.length === 0 ? "first" : goals.length === 0 ? "rest" : "");
    set("dense", goals.length >= 5);
    set("confirm_reset", confirmReset);
    const todayEntries = d.entries[today] ?? [];
    set(
      "goals",
      goals.map((g) => {
        const n = amount(totals, today, g.id);
        const prog = fmtProgress(n, g);
        const started = d.timers[g.id];
        const riding = ride?.goalId === g.id;
        const isRide = isRideGoal(g);
        const timer = !isRide && isTimerGoal(g);
        const todayKm = todayEntries.reduce((km, e) => km + (e.goalId === g.id && e.ride ? e.ride.km : 0), 0);
        const session = isRide ? (riding && ride ? (isPaused(ride.session) ? "paused" : "running") : "idle") : timer && started ? (isPaused(started) ? "paused" : "running") : "idle";
        const secs = isRide ? (riding && ride ? elapsedMs(ride.session, now) / 1000 : 0) : started ? elapsedMs(started, now) / 1000 : 0;
        return {
          id: g.id,
          name: g.name,
          color: colorIndex(g.color),
          glyph: goalGlyph(g.icon),
          done: n >= g.target,
          bonus: isBonus(g, today),
          value: prog.value,
          rest: prog.rest,
          frac: g.target > 0 ? n / g.target : 0,
          ring: ringPath(g.target > 0 ? n / g.target : 0),
          streak: streak(totals, g),
          kind: isRide ? "ride" : timer ? "timer" : "count",
          quick: isRide || timer ? [] : quickAddsFor(g.unit).map((k) => ({ label: quickLabel(k, g.unit), amount: k })),
          session,
          clock: isRide || timer ? fmtSecs(secs) : "",
          sub: isRide ? (riding && ride ? `${fmtKm(ride.distM / 1000)} km · ↑${Math.round(ride.gainM)} m` : `${fmtKm(todayKm)} km · recorded on the phone`) : "",
          can_undo: todayEntries.some((e) => e.goalId === g.id),
          can_reset: todayEntries.some((e) => e.goalId === g.id) || started != null,
          // GPS rides are recorded by Hub for Android; the PC shows them.
          disabled: isRide,
        };
      }),
    );
  }

  function renderHistory(d: AppData, goals: Goal[]): void {
    const today = dateKey();
    const walk = st?.walking ?? {};
    const hasWalk = Object.keys(walk).length > 0;
    if (hsel !== "all" && hsel !== WALK && !goals.some((g) => g.id === hsel)) hsel = "all";
    if (hsel === WALK && !hasWalk) hsel = "all";
    set("hsel", hsel);
    set("segs", [{ id: "all", label: "All" }, ...goals.map((g) => ({ id: g.id, label: g.name })), ...(hasWalk ? [{ id: WALK, label: "Walking" }] : [])]);
    set("walk_view", hsel === WALK);
    const t = parseKey(today);
    if (hsel === WALK) {
      const list = Array.from({ length: HISTORY_DAYS }, (_, i) => {
        const dd = addDays(t, i - (HISTORY_DAYS - 1));
        const k = dateKey(dd);
        return { k, dd, w: walk[k] };
      });
      const max = Math.max(1, ...list.map((x) => x.w?.km ?? 0));
      const logged = list.filter((x) => x.w);
      const avg = logged.length ? logged.reduce((s, x) => s + (x.w?.km ?? 0), 0) / logged.length : 0;
      set("walk_totals", [fmtWalk(weekKm(walk, t)), fmtWalk(walk[today]), fmtWalk({ km: avg })]);
      set("walk_bars", list.map(({ k, dd, w }) => ({ frac: (w?.km ?? 0) / max, approx: w?.approx === true, today: k === today, tip: `${ddmm(dd)} — ${fmtWalk(w)}` })));
      set("walk_from", ddmm(list[0]?.dd ?? t));
      set("walk_to", ddmm(t));
      return;
    }
    const goal = goals.find((g) => g.id === hsel);
    const shown = goal ? [goal] : goals;
    set(
      "streaks",
      shown.map((g) => ({
        id: g.id,
        name: g.name,
        color: colorIndex(g.color),
        glyph: goalGlyph(g.icon),
        line: `Best ${days(bestStreak(totals, g))} · ${isDone(totals, today, g) ? "done today" : isScheduled(g, today) ? "not done today" : isBonus(g, today) ? "bonus today" : "rest today"}`,
        streak: streak(totals, g),
      })),
    );
    const mondayOffset = (t.getDay() + 6) % 7;
    const start = addDays(t, -mondayOffset - (WEEKS - 1) * 7);
    const level = (k: string): number => {
      const lv = (v: number): number => (v >= 1 ? 4 : v >= 0.66 ? 3 : v >= 0.33 ? 2 : v > 0 ? 1 : 0);
      if (goal) {
        const v = amount(totals, k, goal.id) / goal.target;
        if (isBonus(goal, k)) return bonusDone(totals, k, goal) ? 4 : 5;
        return !isScheduled(goal, k) && v <= 0 ? 5 : lv(v);
      }
      const v = dayCompletion(totals, k, goals);
      return v == null ? 5 : lv(v);
    };
    const cells: { col: number; row: number; level: number; today: boolean; tip: string }[] = [];
    let full = 0;
    for (let w = 0; w < WEEKS; w++) {
      for (let r = 0; r < 7; r++) {
        const day = addDays(start, w * 7 + r);
        const k = dateKey(day);
        const future = day > t;
        const l = future ? 6 : level(k);
        if (l === 4) full++;
        cells.push({ col: w, row: r, level: l, today: k === today, tip: future ? k : `${k} — ${l === 5 ? "rest day" : l === 4 ? "completed" : "not completed"}` });
      }
    }
    set("cells", cells);
    set("heat", goal ? colorIndex(goal.color) : -1);
    set("full_days", `${full} full ${full === 1 ? "day" : "days"} in the last ${WEEKS} weeks`);
    if (goal && isRideGoal(goal)) {
      const rides = Object.values(d.entries)
        .flat()
        .filter((e): e is Entry & { ride: NonNullable<Entry["ride"]> } => e.goalId === goal.id && e.ride !== undefined)
        .sort((a, b) => b.at - a.at);
      const weekStart = addDays(t, -((t.getDay() + 6) % 7)).getTime();
      const km = (list: typeof rides): number => list.reduce((s, e) => s + e.ride.km, 0);
      set("rides_week", fmtKm(km(rides.filter((e) => e.at >= weekStart))));
      set("rides_total", fmtKm(km(rides)));
      set(
        "rides",
        rides.slice(0, 4).map((e) => {
          const dd = new Date(e.at);
          return { day: `${DAY_SHORT[dd.getDay()]} ${ddmm(dd)}`, km: fmtKm(e.ride.km), time: fmtSecs(e.ride.durationSec), gain: String(e.ride.gainM), thumb: thumbPath(e.ride.thumb) };
        }),
      );
    } else {
      set("rides_total", "");
      set("rides", []);
    }
  }

  function renderSleep(d: AppData): void {
    set("wake_by", d.sleep.wakeBy);
    set("last_alarm", lastAlarm);
  }

  function renderGoals(d: AppData, goals: Goal[]): void {
    set("confirm_del", confirmDel);
    set("plan_label", planLabel(d.plan));
    set(
      "rows",
      goals.map((g) => ({ id: g.id, name: g.name, color: colorIndex(g.color), glyph: goalGlyph(g.icon), line: [fmtQty(g.target, g.unit), fmtDays(g.days, g.bonusDays)].join(" · ") })),
    );
    set("plans", [
      ...PLANS.map((p) => ({ id: p.id, name: p.name, meta: p.goals.map((g) => `${g.name} ${fmtQty(g.target, g.unit)}`).join(" · "), on: d.plan?.id === p.id })),
      { id: "empty", name: "Empty", meta: "No goals: add your own", on: false },
    ]);
  }

  function renderForm(): void {
    if (!draft) return;
    const dr = draft;
    set("f_title", dr.id ? "Edit goal" : "New goal");
    set("f_type", dr.type);
    set("f_days", WEEK_ORDER.map((n) => ({ label: DAY_SHORT[n] ?? "", state: dr.days.includes(n) ? 1 : dr.bonusDays.includes(n) ? 2 : 0 })));
    set("f_icons", GOAL_ICON_KEYS.map((k) => GOAL_GLYPH[k]));
    set("f_icon", Math.max(0, GOAL_ICON_KEYS.indexOf(dr.icon)));
    set("f_color", dr.color);
    set("f_error", formError);
  }

  function renderCoach(): void {
    const c = coach;
    set("coach_note", coachNote !== "" ? coachNote : c && !c.ready ? `Add the “${c.project}” project in Projects: the Coach is a chat there.` : c && c.messages.length === 0 ? "Ask the Coach about your day: today's stats go along with your message." : "");
    set("coach_running", c?.running === true);
    set("msgs", (c?.messages ?? []).map((m) => ({ id: m.id, agent: m.role === "agent", text: m.text, done: m.done, chips: m.chips.map((x) => ({ key: x.key, ok: x.ok, label: x.label, can_undo: x.canUndo, undone: x.undone })) })));
  }

  const loadCoach = async (): Promise<void> => {
    try {
      coach = (await call("GET", "v1/routine/coach")) as CoachState;
      coachNote = "";
    } catch (e) {
      coachNote = e instanceof Error ? e.message : String(e);
    }
    renderCoach();
    // While the Coach writes, its reply comes in as it's written.
    if (coach?.running && !polling && section === "coach") {
      polling = true;
      setTimeout(() => {
        polling = false;
        if (section === "coach" && ctx?.shown()) void loadCoach();
      }, 1200);
    }
  };

  // ---------- the form ----------

  const toDraft = (g?: Goal): Draft =>
    g
      ? { id: g.id, name: g.name, target: String(isTimerUnit(g.unit) ? g.target / 60 : g.target), type: typeOf(g), unit: typeOf(g) === 0 ? g.unit : "reps", icon: g.icon, color: colorIndex(g.color), days: g.days?.length ? [...g.days] : [...WEEK_ORDER], bonusDays: [...(g.bonusDays ?? [])] }
      : { name: "", target: "20", type: 0, unit: "reps", icon: "activity", color: 2, days: [...WEEK_ORDER], bonusDays: [] };

  const openForm = (g?: Goal): void => {
    draft = toDraft(g);
    formError = "";
    set("f_name", draft.name);
    set("f_target", draft.target);
    set("f_unit", draft.unit);
    sheet = "form";
    render();
  };

  const saveForm = (): void => {
    if (!draft || !bus) return;
    draft.name = bus.f_name;
    draft.target = bus.f_target;
    draft.unit = bus.f_unit;
    const minutes = draft.type >= 2;
    const n = Number(draft.target.replace(",", "."));
    if (!draft.name.trim() || !Number.isFinite(n) || n <= 0) {
      formError = !draft.name.trim() ? "Give it a name" : "The target is a number above 0";
      renderForm();
      return;
    }
    const unit = draft.type === 1 ? "ml" : minutes ? "sec" : draft.unit.trim() || "reps";
    const target = Math.max(1, Math.round(minutes ? n * 60 : n));
    const goal = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      target,
      unit,
      ...(draft.type === 3 ? { kind: "ride" } : {}),
      icon: draft.icon,
      color: COLORS[draft.color] ?? COLORS[2],
      ...(normalizeDays(draft.days) ? { days: normalizeDays(draft.days) } : {}),
      ...(normalizeBonusDays(draft.bonusDays, draft.days) ? { bonusDays: normalizeBonusDays(draft.bonusDays, draft.days) } : {}),
    };
    draft = null;
    sheet = "";
    void act({ act: "save_goal", goal });
  };

  // ---------- wiring ----------

  function bind(b: Bus): void {
    const on = (name: string, f: (...a: never[]) => void): void => {
      b[name] = f;
    };
    on("pick_section", (s: string) => {
      if (!SECTIONS.includes(s as Section)) return;
      section = s as Section;
      confirmReset = "";
      confirmDel = "";
      render();
      if (section === "coach") void loadCoach();
    });
    on("quick", (goal: string, n: number) => void act({ act: "log", goal, amount: n }));
    on("undo", (goal: string) => void act({ act: "undo", goal }));
    on("reset_ask", (goal: string) => {
      confirmReset = goal;
      render();
      setTimeout(() => {
        if (confirmReset === goal) {
          confirmReset = "";
          render();
        }
      }, 4000);
    });
    on("reset", (goal: string) => {
      confirmReset = "";
      void act({ act: "reset", goal });
    });
    on("timer", (goal: string, cmd: string) => {
      const g = st?.data.goals.find((x) => x.id === goal);
      if (g && isRideGoal(g)) return ctx?.toast("Rides are recorded by Hub for Android (GPS)");
      void act({ act: "timer", goal, cmd });
    });
    on("pick_history", (id: string) => {
      hsel = id;
      render();
    });
    on("sleep_now", () => {
      const now = new Date();
      const opts = wakeOptions(now, st?.data.sleep.wakeBy ?? "07:00");
      wakeAt = opts.map((o) => o.wakeAt);
      set("wakes", opts.map((o) => ({ time: fmtClock(o.wakeAt), meta: `${o.cycles} cycles · ${fmtDuration(o.sleepMin)}${o.short ? " · short" : ""}`, rec: o.recommended })));
      sheet = "wake";
      render();
    });
    on("pick_wake", (i: number) => {
      const at = wakeAt[i];
      sheet = "";
      if (at) {
        const opts = wakeOptions(new Date(), st?.data.sleep.wakeBy ?? "07:00");
        const o = opts.find((x) => fmtClock(x.wakeAt) === fmtClock(at));
        lastAlarm = `${fmtClock(at)}${o ? ` · ${o.cycles} cycles` : ""}`;
        ctx?.toast(`Wake up at ${fmtClock(at)}: the phone's Hub sets the alarm in its Clock app`);
      }
      render();
    });
    on("wake_by_set", (v: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return;
      void act({ act: "sleep", wakeBy: `${m[1]!.padStart(2, "0")}:${m[2]}` });
    });
    on("close_sheet", () => {
      sheet = "";
      draft = null;
      render();
    });
    on("goal_new", () => {
      if (section !== "goals") section = "goals";
      openForm();
    });
    on("goal_edit", (id: string) => {
      const g = st?.data.goals.find((x) => x.id === id);
      if (g) openForm(g);
    });
    on("del_ask", (id: string) => {
      confirmDel = id;
      render();
    });
    on("del", (id: string) => {
      confirmDel = "";
      void act({ act: "delete_goal", id });
    });
    on("f_pick_type", (i: number) => {
      if (!draft || !bus) return;
      draft.name = bus.f_name;
      draft.target = bus.f_target;
      draft.unit = bus.f_unit;
      draft.type = Math.max(0, Math.min(3, i)) as GoalType;
      renderForm();
    });
    on("f_day", (i: number) => {
      const dr = draft;
      if (!dr) return;
      const n = WEEK_ORDER[i];
      if (n === undefined) return;
      // A click cycles: off → on → bonus (an optional day) → off.
      const onDay = dr.days.includes(n);
      const bonus = !onDay && dr.bonusDays.includes(n);
      const without = (a: number[]): number[] => a.filter((x) => x !== n);
      if (onDay) {
        dr.days = without(dr.days);
        dr.bonusDays = [...dr.bonusDays, n];
      } else if (bonus) dr.bonusDays = without(dr.bonusDays);
      else {
        dr.days = [...dr.days, n];
        dr.bonusDays = without(dr.bonusDays);
      }
      renderForm();
    });
    on("f_pick_icon", (i: number) => {
      const k = GOAL_ICON_KEYS[i];
      if (draft && k) draft.icon = k;
      renderForm();
    });
    on("f_pick_color", (i: number) => {
      if (draft) draft.color = i;
      renderForm();
    });
    on("f_save", () => saveForm());
    on("plans_open", () => {
      sheet = "plans";
      render();
    });
    on("plan_pick", (id: string) => {
      sheet = "";
      void act({ act: "plan", id });
    });
    on("import_open", () => {
      sheet = "import";
      importReady = false;
      set("imp_text", "");
      set("imp_error", "");
      set("imp_summary", "");
      render();
    });
    const importBody = (): Record<string, unknown> => {
      const t = String(bus?.imp_text ?? "").trim();
      return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(t) ? { code: t } : { text: t };
    };
    on("import_read", () => {
      importBusy = true;
      set("imp_busy", true);
      set("imp_error", "");
      void call("POST", "v1/routine/import", importBody())
        .then((r) => {
          const s = (r as { summary: { goals: number; days: number; entries: number; rides: number; walkingDays: number; coachMessages: number } }).summary;
          importReady = true;
          set("imp_summary", `${s.goals} goals, ${s.entries} entries over ${s.days} days, ${s.rides} rides, ${s.walkingDays} walking days, ${s.coachMessages} Coach messages. This replaces Routine's data here and on the phone.`);
        })
        .catch((e: unknown) => set("imp_error", e instanceof Error ? e.message : String(e)))
        .finally(() => {
          importBusy = false;
          set("imp_busy", false);
        });
    });
    on("import_go", () => {
      if (!importReady || importBusy) return;
      importBusy = true;
      set("imp_busy", true);
      void call("POST", "v1/routine/import", { ...importBody(), confirm: true })
        .then((r) => {
          sheet = "";
          take((r as { state: State }).state);
          ctx?.toast("Imported");
        })
        .catch((e: unknown) => set("imp_error", e instanceof Error ? e.message : String(e)))
        .finally(() => {
          importBusy = false;
          set("imp_busy", false);
        });
    });
    on("coach_send", () => {
      const text = String(bus?.coach_text ?? "").trim();
      if (text === "") return;
      set("coach_text", "");
      if (coach) coach = { ...coach, running: true, messages: [...coach.messages, { id: `local-${Date.now()}`, role: "user", text, done: true, chips: [] }] };
      renderCoach();
      void call("POST", "v1/routine/coach", { text })
        .then(() => loadCoach())
        .catch((e: unknown) => {
          coachNote = e instanceof Error ? e.message : String(e);
          void loadCoach();
        });
    });
    on("coach_undo", (key: string) => {
      void call("POST", "v1/routine/coach/undo", { key })
        .then(() => Promise.all([load(), loadCoach()]))
        .catch((e: unknown) => ctx?.toast(e instanceof Error ? e.message : String(e)));
    });
  }

  return {
    id: "routine",
    mount: async (c) => {
      ctx = c;
      const b = Reflect.get(c.win, "RoutineBus") as Bus | undefined;
      if (!b) throw new Error("the window has no RoutineBus");
      bus = b;
      bind(b);
      c.onChanged(() => {
        if (c.shown()) {
          void load();
          if (section === "coach") void loadCoach();
        }
      });
      await load();
    },
    shown: (on) => {
      if (on) {
        void load();
        if (section === "coach") void loadCoach();
      }
    },
  };
}

export const routineUi = createRoutineUi();
