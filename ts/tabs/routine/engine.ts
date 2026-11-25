// Routine (Schedule Fixer, moved into Hub), engine side: its data lives here, in <data dir>/routine/store.json, as the
// key-value map Schedule Fixer kept (`schedule-fixer:data`, `:walking`, `:ride:<id>`…), so its exports import 1:1.
// The PC window (packages/ui/src/tabs/routine) and Hub for Android call the same routes:
//   GET  v1/routine                 {rev, data, walking, ride}            everything the screens draw
//   POST v1/routine/act             {act, …} (lib/actions.ts)             a change; answers like GET
//   POST v1/routine/walking         {days, from, to}                      the phone's Health Connect read (km per day)
//   POST v1/routine/ride            {active: {goalId, session, distM, gainM} | null}   the phone's ride being recorded
//   POST v1/routine/import          {text} | {code}                       a Schedule Fixer export (JSON, SFX1:, or its code)
//   GET  v1/routine/export          the export bundle (Schedule Fixer's format)
//   GET  v1/routine/coach           {messages, running, ready}            the Coach chat (a Hub chat "Coach" in "creators")
//   POST v1/routine/coach           {text}                                says it to the Coach (today's stats attached)
//   POST v1/routine/coach/undo      {key}                                 undoes what one of the Coach's actions logged
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Call, type Json, type Reply } from "../../packages/net/src/index.ts";
import type { TabEngine, TabEngineCtx } from "../api.ts";
import { apply, parseAct } from "./lib/actions.ts";
import { coachSummary } from "./lib/coach.ts";
import { actionLabel, blockKey, checkAction, extractActions, type TimerState } from "./lib/coachActions.ts";
import { dateKey } from "./lib/date.ts";
import { activeGoals } from "./lib/plans.ts";
import { isPaused } from "./lib/session.ts";
import { DATA_KEY, defaultData, migrate, totalsFrom, uid } from "./lib/store.ts";
import { EXPORT_APP, ImportError, readByCode, readExport, restore, ROUTINE_PREFIX, type ExportBundle } from "./lib/transfer.ts";
import type { AppData } from "./lib/types.ts";
import { mergeWalk, type WalkDays } from "./lib/walking.ts";

const WALK_KEY = `${ROUTINE_PREFIX}walking`;
const COACH_KEY = `${ROUTINE_PREFIX}coach-hub`;
const ACTIONS_KEY = `${ROUTINE_PREFIX}coach-actions`;
export const COACH_TITLE = "Coach";
export const COACH_PROJECT = "creators";
const CTX_OPEN = "\n\n<routine-stats>\n";
const CTX_CLOSE = "\n</routine-stats>";
const KEEP_ACTIONS = 400;
const TIMER_MAX_AGE_MS = 10 * 60_000;

export const withContext = (text: string, context?: string): string => (context ? `${text}${CTX_OPEN}${context}${CTX_CLOSE}` : text);
export const stripContext = (text: string): string => text.replace(/\s*<routine-stats>[\s\S]*?<\/routine-stats>\s*/g, "").trim();

interface CoachSaved {
  /** The Coach chat (this PC's id), once found or made. */
  chat: number | null;
  /** Today's stats go along once a day, or again when they changed. */
  sent: { day: string; hash: string } | null;
}
interface ActionRecord {
  ok: boolean;
  label: string;
  old?: boolean;
  entryId?: string;
  undone?: boolean;
}
interface ActionsSaved {
  baselined: boolean;
  done: Record<string, ActionRecord>;
}

export interface CoachMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
  done: boolean;
  chips: { key: string; ok: boolean; label: string; canUndo: boolean; undone: boolean }[];
}

const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The engine's state: the key-value map, written whole through a temporary file. */
export class RoutineStore {
  items: Record<string, string> = {};
  rev = 1;
  /** The ride the phone is recording (not kept: it's on the phone until it ends). */
  ride: Json = null;

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (v && typeof v === "object") for (const [k, s] of Object.entries(v)) if (typeof s === "string") this.items[k] = s;
      } catch {
        // a damaged file: start over (the next write replaces it)
      }
    }
  }

  save(): void {
    this.rev++;
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  data(): AppData {
    const v = this.items[DATA_KEY];
    if (!v) return defaultData();
    try {
      return migrate(JSON.parse(v));
    } catch {
      return defaultData();
    }
  }

  setData(d: AppData): void {
    this.items[DATA_KEY] = JSON.stringify(d);
  }

  json<T>(key: string, fallback: T): T {
    try {
      const v = this.items[key];
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  walking(): WalkDays {
    const v = obj(this.json<unknown>(WALK_KEY, {}));
    return obj(v.days) as WalkDays;
  }

  state(): Json {
    return asJson({ rev: this.rev, data: this.data(), walking: this.walking(), ride: this.ride });
  }
}

/** A chat card of the hub's items: who wrote it and its text. */
interface Card {
  seq: number;
  kind: string;
  text?: string;
  markdown?: string;
  at?: number;
}

/** The hub's cards as Coach messages: each user card a message, the text cards after it one reply. */
export function cardsToMessages(cards: Card[], running: boolean): Omit<CoachMessage, "chips">[] {
  const out: Omit<CoachMessage, "chips">[] = [];
  let reply: Omit<CoachMessage, "chips"> | null = null;
  for (const c of cards) {
    const at = typeof c.at === "number" ? c.at * 1000 : 0;
    if (c.kind === "user") {
      reply = null;
      out.push({ id: String(c.seq), role: "user", text: stripContext(c.markdown ?? c.text ?? ""), at, done: true });
    } else if (c.kind === "text") {
      const text = c.markdown ?? c.text ?? "";
      if (!reply) {
        reply = { id: String(c.seq), role: "agent", text, at, done: true };
        out.push(reply);
      } else reply.text = [reply.text, text].filter(Boolean).join("\n\n");
    }
  }
  const last = out[out.length - 1];
  if (running && last?.role === "agent") last.done = false;
  return out;
}

export function createRoutineEngine(): TabEngine & { store(): RoutineStore } {
  let s = new RoutineStore(null);
  let ctx: TabEngineCtx | null = null;

  const changed = (): void => {
    s.save();
    ctx?.changed();
  };

  // ---------- the Coach ----------

  const coachSaved = (): CoachSaved => {
    const v = obj(s.json<unknown>(COACH_KEY, {}));
    const sent = obj(v.sent);
    return { chat: typeof v.chat === "number" ? v.chat : null, sent: typeof sent.day === "string" && typeof sent.hash === "string" ? { day: sent.day, hash: sent.hash } : null };
  };
  const setCoach = (c: CoachSaved): void => {
    s.items[COACH_KEY] = JSON.stringify(c);
  };
  const actions = (): ActionsSaved => {
    const v = obj(s.json<unknown>(ACTIONS_KEY, {}));
    return { baselined: v.baselined === true, done: obj(v.done) as Record<string, ActionRecord> };
  };
  const setActions = (a: ActionsSaved): void => {
    const keys = Object.keys(a.done);
    const done = keys.length > KEEP_ACTIONS ? Object.fromEntries(keys.slice(-KEEP_ACTIONS).map((k) => [k, a.done[k]])) : a.done;
    s.items[ACTIONS_KEY] = JSON.stringify({ ...a, done });
  };

  /** The "creators" project and its "Coach" chat (this PC's ids), from the hub's state. */
  const findCoach = async (): Promise<{ project: number | null; chat: number | null }> => {
    if (!ctx) return { project: null, chat: null };
    const r = await ctx.call("GET", "v1/state");
    const st = obj(r.body);
    const projects = (Array.isArray(st.projects) ? st.projects : []).map(obj).filter((p) => {
      const name = String(p.name ?? "").trim().toLowerCase();
      const tail = String(p.path ?? "").replace(/\/+$/, "").split("/").pop()?.toLowerCase();
      return name === COACH_PROJECT || tail === COACH_PROJECT;
    });
    const ids = new Set(projects.map((p) => String(p.id)));
    const chat = (Array.isArray(st.chats) ? st.chats : [])
      .map(obj)
      .filter((c) => String(c.title ?? "").trim().toLowerCase() === COACH_TITLE.toLowerCase() && c.role !== "sub" && !c.retired && ids.has(String(c.project_id)))
      .sort((a, b) => Number(b.updated_ms ?? 0) - Number(a.updated_ms ?? 0))[0];
    const first = projects[0];
    return { project: first && typeof first.id === "number" ? first.id : null, chat: chat && typeof chat.id === "number" ? chat.id : null };
  };

  const timerState = (d: AppData) => (g: { id: string }): TimerState => {
    const t = d.timers[g.id];
    return t ? (isPaused(t) ? "paused" : "running") : "idle";
  };

  /** Runs the Coach's new action blocks once each; what was there at the first look is only marked seen. */
  const runActions = (msgs: Omit<CoachMessage, "chips">[]): boolean => {
    const a = actions();
    const baseline = !a.baselined;
    let d = s.data();
    let touched = baseline;
    let dataChanged = false;
    for (const m of msgs) {
      if (m.role !== "agent" || !m.done) continue;
      extractActions(m.text).blocks.forEach((b, i) => {
        const key = blockKey(m.id, i, b.raw);
        if (a.done[key]) return;
        touched = true;
        if (baseline) {
          a.done[key] = { ok: true, label: "", old: true };
          return;
        }
        if (!b.ok) {
          a.done[key] = { ok: false, label: `Couldn't log: ${b.error}` };
          return;
        }
        const checked = checkAction(b.action, activeGoals(d.goals), timerState(d));
        if ("error" in checked) {
          a.done[key] = { ok: false, label: `Couldn't log: ${checked.error}` };
          return;
        }
        const { goal } = checked;
        const act = b.action;
        const day = dateKey(new Date(m.at || Date.now()));
        if (act.type === "log") {
          const id = uid();
          d = apply(d, { act: "log", goal: goal.id, amount: act.amount, day, id });
          a.done[key] = { ok: true, label: actionLabel(act, goal), entryId: id };
        } else if (act.type === "undo") {
          d = apply(d, { act: "undo", goal: goal.id, day });
          a.done[key] = { ok: true, label: actionLabel(act, goal) };
        } else if (Date.now() - m.at > TIMER_MAX_AGE_MS) a.done[key] = { ok: false, label: `Couldn't log: ${goal.name} stopwatch (too late)` };
        else {
          d = apply(d, { act: "timer", goal: goal.id, cmd: act.cmd });
          a.done[key] = { ok: true, label: actionLabel(act, goal) };
        }
        dataChanged = true;
      });
    }
    a.baselined = true;
    if (dataChanged) s.setData(d);
    if (touched) setActions(a);
    return touched;
  };

  const coach = async (): Promise<Reply> => {
    if (!ctx) return err(503, "Routine is starting");
    let c = coachSaved();
    const found = await findCoach();
    if (found.chat !== null && found.chat !== c.chat) {
      c = { ...c, chat: found.chat };
      setCoach(c);
    }
    if (c.chat === null) return ok(asJson({ messages: [], running: false, ready: found.project !== null, project: COACH_PROJECT }));
    const r = await ctx.call("GET", `v1/chats/${c.chat}/items`);
    if (r.status >= 300) return ok(asJson({ messages: [], running: false, ready: found.project !== null, project: COACH_PROJECT }));
    const body = obj(r.body);
    const running = body.running === true || Number(body.queued ?? 0) > 0;
    const cards = (Array.isArray(body.items) ? body.items : []).map((x) => obj(x) as unknown as Card);
    const msgs = cardsToMessages(cards, running);
    if (runActions(msgs)) changed();
    const a = actions();
    const messages: CoachMessage[] = msgs.slice(-80).map((m) => ({
      ...m,
      text: m.role === "agent" ? extractActions(m.text).text : m.text,
      chips:
        m.role === "agent" && m.done
          ? extractActions(m.text).blocks.flatMap((b, i) => {
              const key = blockKey(m.id, i, b.raw);
              const rec = a.done[key];
              if (!rec || rec.old) return [];
              return [{ key, ok: rec.ok, label: rec.label, canUndo: !!rec.entryId && !rec.undone, undone: !!rec.undone }];
            })
          : [],
    }));
    return ok(asJson({ messages, running, ready: true, project: COACH_PROJECT }));
  };

  const coachSend = async (text: string): Promise<Reply> => {
    if (!ctx) return err(503, "Routine is starting");
    const t = text.trim();
    if (t === "") return err(400, "nothing to send");
    const d = s.data();
    const goals = activeGoals(d.goals);
    const now = new Date();
    const summary = coachSummary({ now, plan: d.plan, goals, totals: totalsFrom(d.entries), entries: d.entries, walk: s.walking() });
    let c = coachSaved();
    const day = dateKey(now);
    const context = !c.sent || c.sent.day !== day || c.sent.hash !== hash(summary) ? summary : undefined;
    const found = await findCoach();
    if (found.chat !== null) c = { ...c, chat: found.chat };
    let r: Reply;
    if (c.chat !== null) r = await ctx.call("POST", `v1/chats/${c.chat}/send`, {}, { text: withContext(t, context) });
    else {
      if (found.project === null) return err(404, `No Hub project named “${COACH_PROJECT}”: add it in Projects first`);
      r = await ctx.call("POST", "v1/chats", {}, { project_id: found.project, text: withContext(t, context), title: COACH_TITLE });
      const id = obj(r.body).id;
      if (r.status < 300 && typeof id === "number") c = { ...c, chat: id };
    }
    if (r.status >= 300) return r;
    setCoach({ ...c, sent: context ? { day, hash: hash(context) } : c.sent });
    changed();
    return ok({ ok: true });
  };

  const coachUndo = (key: string): Reply => {
    const a = actions();
    const rec = a.done[key];
    if (!rec?.entryId || rec.undone) return err(404, "nothing to undo");
    s.setData(apply(s.data(), { act: "remove", entry: rec.entryId }));
    a.done[key] = { ...rec, undone: true };
    setActions(a);
    changed();
    return ok({ ok: true });
  };

  // ---------- routes ----------

  const route = async (call: Call): Promise<Reply | null> => {
    const p = call.path;
    if (p[0] !== "v1" || p[1] !== "routine") return null;
    const at = `${call.method} ${p.slice(2).join("/")}`;
    const b = obj(call.body);
    try {
      switch (at) {
        case "GET ":
          return ok(s.state());
        case "POST act": {
          const a = parseAct(call.body);
          if (typeof a === "string") return err(400, a);
          const before = s.items[DATA_KEY];
          s.setData(apply(s.data(), a));
          if (s.items[DATA_KEY] !== before) changed();
          return ok(s.state());
        }
        case "POST walking": {
          const days = obj(b.days) as WalkDays;
          const from = typeof b.from === "string" ? b.from : "";
          const to = typeof b.to === "string" ? b.to : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return err(400, "walking needs from and to (YYYY-MM-DD)");
          const saved = obj(s.json<unknown>(WALK_KEY, {}));
          s.items[WALK_KEY] = JSON.stringify({ ...saved, days: mergeWalk(s.walking(), days, from, to) });
          changed();
          return ok(s.state());
        }
        case "POST ride": {
          s.ride = b.active === null || b.active === undefined ? null : asJson(b.active);
          s.rev++;
          ctx?.changed();
          return ok(s.state());
        }
        case "POST import": {
          const read = typeof b.code === "string" && b.code.trim() !== "" ? await readByCode(b.code) : await readExport(typeof b.text === "string" ? b.text : "");
          if (b.confirm !== true) return ok(asJson({ summary: read.summary }));
          restore(read.bundle, s.items);
          changed();
          return ok(asJson({ summary: read.summary, state: s.state() }));
        }
        case "GET export": {
          const items: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.items)) if (k.startsWith(ROUTINE_PREFIX)) items[k] = v;
          const bundle: ExportBundle = { app: EXPORT_APP, kind: "export", v: 1, exportedAt: new Date().toISOString(), items };
          return ok(asJson(bundle));
        }
        case "GET coach":
          return await coach();
        case "POST coach":
          return await coachSend(typeof b.text === "string" ? b.text : "");
        case "POST coach/undo":
          return coachUndo(typeof b.key === "string" ? b.key : "");
        default:
          return err(404, `no route ${call.method} v1/routine/${p.slice(2).join("/")}`);
      }
    } catch (e) {
      if (e instanceof ImportError) return err(400, e.message);
      return err(500, e instanceof Error ? e.message : String(e));
    }
  };

  return {
    id: "routine",
    start: (c) => {
      ctx = c;
      s = new RoutineStore(join(c.dir, "store.json"));
    },
    route,
    store: () => s,
  };
}

export const routineEngine = createRoutineEngine();
