// Collector's History: every search run, kept in state.json (`runs`), newest last. A run is recorded when it ends
// (done, stopped, an error, or cut by a restart); runs from before History are rebuilt once from the leads themselves
// (each found lead keeps its search term, platform and capture time; leads brought in from the SpokPay CRM are left
// out). The view groups them by day, newest first, as Headquarters' Timeline does.
import { PLATFORM_LABEL, PLATFORMS, type CollectorData, type CreatorPlatform, type CreatorRecord, type RunState } from "./types.ts";
import { recordId } from "./identity.ts";

/** How a run ended. "exhausted": the term had no more creators before the target; "none": nobody new. */
export type RunOutcome = "done" | "exhausted" | "none" | "stopped" | "failed" | "interrupted";
const OUTCOMES: readonly RunOutcome[] = ["done", "exhausted", "none", "stopped", "failed", "interrupted"];

export interface RunRecord {
  /** "run-<startedAt>". */
  id: string;
  platform: CreatorPlatform;
  query: string;
  /** The Last upload window it ran with (days, 0 any time); null when not known (a rebuilt run). */
  gapDays: number | null;
  /** How many leads it was asked for (0: everything the source gives). */
  target: number;
  startedAt: number;
  endedAt: number;
  /** New leads kept. */
  found: number;
  /** Already collected (or in Persons), passed over. */
  known: number;
  /** The leads it kept (record ids), in the order found. */
  ids: string[];
  outcome: RunOutcome;
  /** The error that stopped it (outcome "failed"). */
  error?: string;
  /** Rebuilt from the leads (a run from before History): no settings, counts of passed-over creators or stop reason. */
  backfilled?: boolean;
}

/** Runs kept in state.json: plenty for months of searching, small enough to rebuild the view every second. */
export const RUNS_KEEP = 1000;
/** Rebuilding: two leads of the same term and platform more than this apart were two runs. */
const BACKFILL_GAP = 60 * 60_000;

export const runId = (startedAt: number): string => `run-${startedAt}`;

/** A finished run's record. */
export function runRecord(r: RunState, outcome: RunOutcome, error = ""): RunRecord {
  return {
    id: runId(r.startedAt),
    platform: r.platform,
    query: r.query,
    gapDays: typeof r.gapDays === "number" ? r.gapDays : null,
    target: r.target,
    startedAt: r.startedAt,
    endedAt: r.endedAt || r.startedAt,
    found: r.ids.length,
    known: r.known ?? 0,
    ids: [...r.ids],
    outcome,
    ...(error ? { error } : {}),
  };
}

/** The outcome a saved run's status line says (the last run of a state.json from before History). */
export function outcomeOfStatus(status: string): RunOutcome {
  if (status.startsWith("Interrupted")) return "interrupted";
  if (status.startsWith("Stopped on an error")) return "failed";
  if (status.startsWith("Stopped")) return "stopped";
  if (status.startsWith("No new leads")) return "none";
  if (status.includes("(no more for this term)")) return "exhausted";
  return "done";
}

/** Adds (or replaces, by id) a finished run; the oldest go past RUNS_KEEP. */
export function keepRun(runs: RunRecord[], rec: RunRecord): RunRecord[] {
  const out = runs.filter((r) => r.id !== rec.id);
  out.push(rec);
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out.length > RUNS_KEEP ? out.slice(out.length - RUNS_KEEP) : out;
}

/** runs as saved, anything malformed dropped. */
export function parseRuns(v: unknown): RunRecord[] {
  if (!Array.isArray(v)) return [];
  const out: RunRecord[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.query !== "string" || typeof r.startedAt !== "number" || !PLATFORMS.includes(r.platform as CreatorPlatform)) continue;
    const num = (k: string): number => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : 0);
    const ids = Array.isArray(r.ids) ? r.ids.filter((i): i is string => typeof i === "string") : [];
    out.push({
      id: r.id,
      platform: r.platform as CreatorPlatform,
      query: r.query,
      gapDays: typeof r.gapDays === "number" ? r.gapDays : null,
      target: num("target"),
      startedAt: r.startedAt,
      endedAt: num("endedAt") || r.startedAt,
      found: typeof r.found === "number" ? r.found : ids.length,
      known: num("known"),
      ids,
      outcome: OUTCOMES.includes(r.outcome as RunOutcome) ? (r.outcome as RunOutcome) : "done",
      ...(typeof r.error === "string" && r.error ? { error: r.error } : {}),
      ...(r.backfilled === true ? { backfilled: true } : {}),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt).slice(-RUNS_KEEP);
}

/**
 * Runs from before History, rebuilt once from what is reliable: the last run as saved (its ids, counts and status),
 * and every other lead a run found (not one brought in from the CRM), grouped by platform and search term, a new run
 * wherever two of them were captured more than an hour apart.
 */
export function backfillRuns(creators: CreatorRecord[], last: RunState | null): RunRecord[] {
  let runs: RunRecord[] = [];
  const inLast = new Set<string>();
  if (last && !last.running && last.startedAt && PLATFORMS.includes(last.platform)) {
    for (const id of last.ids) inLast.add(id);
    runs = keepRun(runs, runRecord(last, outcomeOfStatus(last.status ?? "")));
  }
  const found = creators
    .filter((c) => !c.imported_from && typeof c.discovered_via === "string" && c.discovered_via.trim() && PLATFORMS.includes(c.platform as CreatorPlatform) && !inLast.has(recordId(c)))
    .map((c) => ({ c, at: Date.parse(c.captured_at) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const open = new Map<string, RunRecord>();
  for (const { c, at } of found) {
    const key = `${c.platform}\u0000${c.discovered_via}`;
    let r = open.get(key);
    if (!r || at - r.endedAt > BACKFILL_GAP) {
      r = { id: runId(at), platform: c.platform as CreatorPlatform, query: c.discovered_via, gapDays: null, target: 0, startedAt: at, endedAt: at, found: 0, known: 0, ids: [], outcome: "done", backfilled: true };
      open.set(key, r);
      runs.push(r);
    }
    r.ids.push(recordId(c));
    r.found = r.ids.length;
    r.endedAt = at;
  }
  // Two rebuilt runs that started in the same millisecond would share an id.
  const used = new Set<string>();
  for (const r of runs) {
    let id = r.id;
    for (let i = 1; used.has(id); i++) id = `${r.id}-${i}`;
    r.id = id;
    used.add(id);
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt).slice(-RUNS_KEEP);
}

// ---------- the view ----------

/** "running" (blue), "done" (green), "empty" (nobody new: grey), "stopped" (amber), "failed" (red). */
export type HistoryTone = "running" | "done" | "empty" | "stopped" | "failed";

export interface HistoryEntry {
  id: string;
  /** "14:05" (or "3m" while it runs). */
  time: string;
  query: string;
  /** "YouTube". */
  platform: string;
  /** "youtube": its mark. */
  platformKey: string;
  /** "20 new leads · 7 already collected". */
  line: string;
  /** Why it ended early ("Stopped on an error: HTTP 429", "Stopped before the target (20)"); "" when it didn't. */
  note: string;
  tone: HistoryTone;
  running: boolean;
  /** The leads it kept (record ids), in the order found. */
  ids: string[];
  found: number;
}

export interface HistoryDay {
  /** "2026-11-27". */
  key: string;
  /** "Today", "Yesterday", "Wed, Nov 25". */
  label: string;
  runs: HistoryEntry[];
}

/** Runs shown at most (the newest). */
const HISTORY_MAX = 400;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function entryOf(r: RunRecord | RunState, running: boolean, now: number, clock: (t: number) => string): HistoryEntry {
  const ids = [...r.ids];
  const found = running ? ids.length : "outcome" in r ? r.found : ids.length;
  const known = r.known ?? 0;
  const passed = known ? ` · ${known} already collected` : "";
  let line = "";
  let note = "";
  let tone: HistoryTone = "done";
  if (running) {
    const run = r as RunState;
    tone = "running";
    line = `${run.target > 0 ? `${found} of ${run.target}` : plural(found, "new lead")} so far${passed}`;
    note = run.line;
  } else {
    const rec = r as RunRecord;
    const leads = found === 0 ? "No new leads" : plural(found, "new lead");
    line = `${leads}${passed}`;
    if (rec.outcome === "stopped") {
      tone = "stopped";
      note = rec.target > 0 ? `Stopped before the target (${rec.target}).` : "Stopped.";
    } else if (rec.outcome === "failed") {
      tone = "failed";
      note = `Stopped on an error${rec.error ? `: ${rec.error}` : "."}`;
    } else if (rec.outcome === "interrupted") {
      tone = "stopped";
      note = "Interrupted: Hub restarted.";
    } else if (found === 0) tone = "empty";
  }
  const mins = Math.max(0, Math.floor((now - r.startedAt) / 60_000));
  return {
    id: "id" in r && typeof r.id === "string" ? r.id : runId(r.startedAt),
    time: running ? (mins < 1 ? "now" : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`) : clock(r.startedAt),
    query: r.query,
    platform: PLATFORM_LABEL[r.platform] ?? r.platform,
    platformKey: r.platform,
    line,
    note,
    tone,
    running,
    ids,
    found,
  };
}

/**
 * History as days, newest first: the run going now (if any) on top, then every finished one. `timeZone` is the PC's
 * when absent (tests pass one).
 */
export function historyView(d: Pick<CollectorData, "runs" | "run">, now = Date.now(), timeZone?: string): HistoryDay[] {
  const tz = timeZone ? { timeZone } : {};
  const keyFmt = new Intl.DateTimeFormat("en-CA", { ...tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const labelFmt = new Intl.DateTimeFormat("en-US", { ...tz, weekday: "short", month: "short", day: "numeric" });
  const clockFmt = new Intl.DateTimeFormat("en-GB", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const dayKey = (t: number): string => keyFmt.format(t);
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const label = (key: string, t: number): string => (key === today ? "Today" : key === yesterday ? "Yesterday" : labelFmt.format(t));
  const clock = (t: number): string => clockFmt.format(t);
  const entries: { at: number; e: HistoryEntry }[] = [];
  const live = d.run?.running ? d.run : null;
  if (live) entries.push({ at: live.startedAt, e: entryOf(live, true, now, clock) });
  const liveId = live ? runId(live.startedAt) : "";
  for (const r of d.runs.slice(-HISTORY_MAX)) if (r.id !== liveId) entries.push({ at: r.startedAt, e: entryOf(r, false, now, clock) });
  entries.sort((a, b) => b.at - a.at);
  const days: HistoryDay[] = [];
  for (const { at, e } of entries) {
    const key = dayKey(at);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, label: label(key, at), runs: [] };
      days.push(day);
    }
    day.runs.push(e);
  }
  return days;
}
