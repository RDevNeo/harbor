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
import { colorIndex, goalsView, historyView, todayView } from "../../../../../tabs/routine/view.ts";
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

export { colorIndex, ringPath, thumbPath } from "../../../../../tabs/routine/view.ts";

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
    if (section === "today") renderToday(d);
    if (section === "history") renderHistory(d);
    if (section === "sleep") renderSleep(d);
    renderGoals(d);
    renderForm();
    if (section === "coach") renderCoach();
    const running = Object.values(d.timers).some((t) => !isPaused(t)) || (st.ride !== null && !isPaused(st.ride.session));
    if (running && tick === null && section === "today") tick = setInterval(() => ctx?.shown() && render(), 1000);
    if ((!running || section !== "today") && tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  }

  function renderToday(d: AppData): void {
    const v = todayView(d, st?.walking ?? {}, st?.ride ?? null);
    set("pct", v.pct);
    set("pct_ring", v.ring);
    set("walk", v.walk);
    set("empty", v.empty);
    set("dense", v.dense);
    set("confirm_reset", confirmReset);
    set(
      "goals",
      v.goals.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        glyph: g.glyph,
        done: g.done,
        bonus: g.bonus,
        value: g.value,
        rest: g.rest,
        frac: g.frac,
        ring: g.ring,
        streak: g.streak,
        kind: g.kind,
        quick: g.quick,
        session: g.session,
        clock: g.kind === "count" ? "" : fmtSecs(g.secs),
        sub: g.kind === "ride" ? (g.session === "idle" ? `${g.sub} · recorded on the phone` : g.sub) : "",
        can_undo: g.canUndo,
        can_reset: g.canReset,
        // GPS rides are recorded by Hub for Android; the PC shows them.
        disabled: g.kind === "ride",
      })),
    );
  }

  function renderHistory(d: AppData): void {
    const v = historyView(d, st?.walking ?? {}, hsel);
    hsel = v.sel;
    set("hsel", v.sel);
    set("segs", v.segs);
    set("walk_view", v.walkView);
    set("walk_totals", v.walkTotals);
    set("walk_bars", v.walkBars);
    set("walk_from", v.walkFrom);
    set("walk_to", v.walkTo);
    set("streaks", v.streaks.map((x) => ({ id: x.id, name: x.name, color: x.color, glyph: x.glyph, line: x.line, streak: x.streak })));
    set("cells", v.cells);
    set("heat", v.heat);
    set("full_days", v.fullDays);
    set("rides_week", v.ridesWeek);
    set("rides_total", v.ridesTotal);
    set("rides", v.rides);
  }

  function renderSleep(d: AppData): void {
    set("wake_by", d.sleep.wakeBy);
    set("last_alarm", lastAlarm);
  }

  function renderGoals(d: AppData): void {
    const v = goalsView(d);
    set("confirm_del", confirmDel);
    set("plan_label", v.planLabel);
    set("rows", v.rows.map((r) => ({ id: r.id, name: r.name, color: r.color, glyph: r.glyph, line: r.line })));
    set("plans", v.plans);
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
