// Paused chats keep a continuation timer (table `timers`, kind 'limit') after the reset;
// blocks, paused chats and queued prompts are stored in kv `limits`.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { f64Json } from "./item.ts";
import { home, now as unixNow } from "./paths.ts";
import type { Chat, Store } from "./store.ts";
import { UsageCtl } from "./usage_ctl.ts";

export const RESUME = "[harbor] Your usage limit reset. Continue the task from where you stopped.";
/** Hits with the same reset time before Harbor stops trying and asks. */
const MAX_TRIES = 3;
/** Sub-agents running at once under one lead. */
export const MAX_RUNNING_SUBS = 6;
/** Above this utilization an account doesn't count as having quota left. */
const FULL = 0.95;

export interface Block {
  /** When it should be usable again (Unix time). */
  until: number;
  /** "five_hour", "seven_day", … ("" when unknown). */
  kind: string;
  /** Whether `until` came from the provider (else it's a backoff guess). */
  known: boolean;
  /** Hits in a row with the same `until`. */
  tries: number;
  /** Set when it's the user's own cap rather than the provider's limit: the cap in percent. */
  cap: number | null;
}

export interface Paused {
  account: string;
  /** Its turn was cut off: it continues with `RESUME`. */
  resume: boolean;
  /** When it continues (with a timer), or null when it waits for the user. */
  at: number | null;
  timer: number | null;
}

/** The last quota seen in a turn: window, utilization (0–1), resets at. */
export type Quota = [string, number, number];

export interface UsageWindow {
  label: string;
  /** Fraction used, 0–1. */
  percent: number;
  resetsAt: number | null;
}

export interface AccountInfo {
  id: string;
  kind: string;
  name: string;
  /** One line for menus: "Claude · IG" or "Codex". */
  short: string;
  loggedIn: boolean | null;
  configDir: string | null;
  usage: UsageWindow[];
  usageAt?: number | null;
}

/** How notices name an account: a Claude account by its own name, others by provider. */
export function accountName(a: AccountInfo): string {
  return a.kind === "claude" && a.name !== "" ? a.name : a.short;
}

export type LimitEvent =
  | { type: "quota"; windows: Quota[] }
  | { type: "limit"; kind: string; resetsAt: number | null; text: string }
  | { type: "error"; text: string }
  | { type: "other" };

/** What the limits need from the app around them. */
export interface LimitsHost {
  store: Store;
  chat(id: number): Chat | undefined;
  chats(): readonly Chat[];
  account(id: string): AccountInfo | undefined;
  accounts(): readonly AccountInfo[];
  /** Prompts queued for chats, by chat id. */
  pending: Map<number, string[]>;
  turnRunning(chatId: number): boolean;
  /** Sub-agents of a lead with a turn running. */
  runningSubs(lead: number): number;
  startTurn(chatId: number, prompt: string): void;
  notice(chatId: number, icon: string, text: string, detail: string): void;
  noteLimit(chatId: number, account: string, waits: boolean, note: string): void;
  noteResumed(chatId: number, account: string, text: string): void;
  /** A desktop notification about a cap or its warning. */
  notify(kind: string, key: string, title: string, body: string): void;
  persist(chatId: number): void;
  /** Moves the chat to another account: in memory and in the store. */
  setAccount(chatId: number, account: string): void;
  /** The session file of a Claude session under an account's config folder. */
  sessionFile(configDir: string | null, sessionId: string): string | null;
  now?(): number;
}

export function windowLabel(kind: string): string {
  if (kind === "five_hour") return "5-hour";
  if (kind.startsWith("seven_day")) return "weekly";
  if (kind === "daily") return "daily";
  return "usage";
}

export const isWeekly = (kind: string): boolean => kind.startsWith("seven_day");

let offsetCache: number | undefined;

/** The local UTC offset in seconds, read once. */
function utcOffset(): number {
  offsetCache ??= -new Date().getTimezoneOffset() * 60;
  return offsetCache;
}

/** "11:40 AM" in local time. */
export function clock(ts: number): string {
  const secs = (((ts + utcOffset()) % 86400) + 86400) % 86400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6:00 PM" today, or "Oct 9, 6:00 PM" further out. */
export function when(ts: number, at: number = unixNow()): string {
  const hm = clock(ts);
  if (ts - at < 20 * 3600) return hm;
  const days = Math.floor((ts + utcOffset()) / 86400);
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return `${MONTHS[m - 1]} ${d}, ${hm}`;
}

/** "<1m", "12m", "2h 5m". */
export function minutesText(secs: number): string {
  if (secs < 60) return "<1m";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** Unix time for a date(1) expression, in the given zone (undefined: local). */
function date(expr: string, tz?: string): number | null {
  const env = tz === undefined ? process.env : { ...process.env, TZ: tz };
  const r = spawnSync("date", ["-d", expr, "+%s"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) return null;
  const n = Number(r.stdout.trim());
  return r.stdout.trim() !== "" && Number.isInteger(n) ? n : null;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** An error that reads like a usage limit, from providers without structured limit events: [window, reset time if it says]. */
export function fromText(text: string, at: number = unixNow()): [string, number | null] | null {
  const l = asciiLower(text);
  const limit =
    ["rate limit", "rate-limit", "rate_limit", "ratelimit", "usage limit", "quota", "resource_exhausted", "hit your limit", " 429"].some((k) => l.includes(k)) ||
    (l.includes("hit your ") && l.includes(" limit"));
  if (!limit) return null;
  const i = l.indexOf("try again at ");
  if (i >= 0) {
    const rest = text.slice(i + "try again at ".length);
    const w = (rest.trimEnd().replace(/\.+$/, "").split(". ")[0] ?? "").replaceAll("st,", ",").replaceAll("nd,", ",").replaceAll("rd,", ",").replaceAll("th,", ",");
    let t = date(w);
    if (t !== null) {
      if (t < at) t += 24 * 3600;
      return ["", t];
    }
  }
  const reset = claudeReset(text, l, at);
  if (reset !== null) {
    const kind = l.includes("weekly") ? "seven_day" : l.includes("5-hour") || l.includes("session limit") ? "five_hour" : "";
    return [kind, reset];
  }
  if (l.includes("daily quota") || l.includes("per day")) return ["daily", date("tomorrow 00:00", "America/Los_Angeles")];
  return ["", null];
}

/** The reset time in Claude's "resets 12am (America/Sao_Paulo)" wording. A bare time already past today means tomorrow. */
function claudeReset(text: string, l: string, at: number): number | null {
  const k = l.indexOf("resets ");
  if (k < 0) return null;
  const rest = text.slice(k + "resets ".length);
  const j = rest.indexOf(" (");
  let w: string;
  let tz: string | undefined;
  if (j >= 0) {
    tz = rest.slice(j + 2).split(")")[0] ?? "";
    w = rest.slice(0, j);
  } else {
    w = rest.split(/[.\n]/)[0] ?? "";
  }
  if (tz !== undefined && !(tz !== "" && tz.length < 64 && /^[A-Za-z0-9/_+-]*$/.test(tz))) tz = undefined;
  w = w.trim().replaceAll(", ", " ").replaceAll(" at ", " ");
  if (w === "" || Buffer.byteLength(w) > 40 || !/[0-9]/.test(w)) return null;
  let t = date(w, tz);
  if (t === null) return null;
  if (t < at) t += 24 * 3600;
  return t;
}

/** The account's block after a limit hit, given the one it had. */
export function nextBlock(prev: Block | undefined, kind: string, resetsAt: number | null, at: number): Block {
  const reset = resetsAt !== null && resetsAt > at ? resetsAt : null;
  // An unknown reset never replaces a known one still ahead (one turn reports the limit twice).
  if (reset === null && prev && prev.known && prev.until > at && prev.cap === null) return { ...prev };
  if (reset !== null) {
    const tries = prev && prev.until === reset ? prev.tries + 1 : 0;
    return { until: reset, kind, known: true, tries, cap: null };
  }
  const tries = prev && !prev.known && prev.until > at - 3 * 3600 ? prev.tries + 1 : 0;
  const mins = [15, 30, 60][tries] ?? 60;
  return { until: at + mins * 60, kind, known: false, tries, cap: null };
}

export function notify(title: string, body: string): void {
  try {
    const p = spawn("notify-send", ["-a", "Harbor", title, body], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no notifier here
  }
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Limits {
  blocks = new Map<string, Block>();
  paused = new Map<number, Paused>();
  /** Prompts queued for paused chats, stored so a restart keeps them. */
  stored = new Map<number, string[]>();
  /** Per account: the last quota seen in a turn. */
  quota = new Map<string, Quota[]>();
  /** Per account: when that quota was seen (Unix time). */
  quotaAt = new Map<string, number>();
  /** Chats whose running turn hit a limit (until it exits). */
  readonly hit = new Set<number>();
  /** Chats to move to another account once their limited turn has exited. */
  readonly switch = new Map<number, string>();
  readonly ctl: UsageCtl;

  constructor(readonly host: LimitsHost) {
    this.ctl = new UsageCtl(this);
  }

  now(): number {
    return this.host.now?.() ?? unixNow();
  }

  /** The state as the Rust app writes it into kv `limits`. */
  toJson(): string {
    const blocks = [...this.blocks].map(([k, b]) => `${JSON.stringify(k)}:{"until":${b.until},"kind":${JSON.stringify(b.kind)},"known":${b.known},"tries":${b.tries},"cap":${b.cap === null ? "null" : b.cap}}`);
    const paused = [...this.paused].map(([id, p]) => `"${id}":{"account":${JSON.stringify(p.account)},"resume":${p.resume},"at":${p.at === null ? "null" : p.at},"timer":${p.timer === null ? "null" : p.timer}}`);
    const pending = [...this.stored].map(([id, q]) => `"${id}":${JSON.stringify(q)}`);
    const quota = [...this.quota].map(([a, w]) => `${JSON.stringify(a)}:[${w.map(([k, u, r]) => `[${JSON.stringify(k)},${f64Json(u)},${r}]`).join(",")}]`);
    const quotaAt = [...this.quotaAt].map(([a, t]) => `${JSON.stringify(a)}:${t}`);
    return `{"blocks":{${blocks.join(",")}},"paused":{${paused.join(",")}},"pending":{${pending.join(",")}},"quota":{${quota.join(",")}},"quota_at":{${quotaAt.join(",")}}}`;
  }

  private save(): void {
    this.host.store.set("limits", this.toJson());
  }

  private parse(raw: string): { blocks: Map<string, Block>; paused: Map<number, Paused>; pending: Map<number, string[]>; quota: Map<string, Quota[]>; quotaAt: Map<string, number> } | null {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!rec(v) || !rec(v.blocks) || !rec(v.paused)) return null;
    const blocks = new Map<string, Block>();
    for (const [k, b] of Object.entries(v.blocks)) {
      if (!rec(b) || typeof b.until !== "number" || typeof b.kind !== "string" || typeof b.known !== "boolean" || typeof b.tries !== "number") return null;
      const cap = b.cap === undefined || b.cap === null ? null : b.cap;
      if (cap !== null && typeof cap !== "number") return null;
      blocks.set(k, { until: b.until, kind: b.kind, known: b.known, tries: b.tries, cap });
    }
    const paused = new Map<number, Paused>();
    for (const [k, p] of Object.entries(v.paused)) {
      if (!rec(p) || typeof p.account !== "string" || typeof p.resume !== "boolean" || !/^-?\d+$/.test(k)) return null;
      const at = p.at === undefined || p.at === null ? null : p.at;
      const timer = p.timer === undefined || p.timer === null ? null : p.timer;
      if ((at !== null && typeof at !== "number") || (timer !== null && typeof timer !== "number")) return null;
      paused.set(Number(k), { account: p.account, resume: p.resume, at, timer });
    }
    const pending = new Map<number, string[]>();
    if (rec(v.pending)) {
      for (const [k, q] of Object.entries(v.pending)) {
        if (!Array.isArray(q) || !q.every((x): x is string => typeof x === "string") || !/^-?\d+$/.test(k)) return null;
        pending.set(Number(k), q);
      }
    }
    const quota = new Map<string, Quota[]>();
    if (rec(v.quota)) {
      for (const [k, ws] of Object.entries(v.quota)) {
        if (!Array.isArray(ws)) return null;
        const list: Quota[] = [];
        for (const w of ws) {
          if (!Array.isArray(w) || typeof w[0] !== "string" || typeof w[1] !== "number" || typeof w[2] !== "number") return null;
          list.push([w[0], w[1], w[2]]);
        }
        quota.set(k, list);
      }
    }
    const quotaAt = new Map<string, number>();
    if (rec(v.quota_at)) {
      for (const [k, t] of Object.entries(v.quota_at)) {
        if (typeof t !== "number") return null;
        quotaAt.set(k, t);
      }
    }
    return { blocks, paused, pending, quota, quotaAt };
  }

    load(): void {
    const raw = this.host.store.get("limits");
    const s = raw === null ? null : this.parse(raw);
    if (s) {
      this.blocks = s.blocks;
      this.paused = s.paused;
      this.stored = s.pending;
      this.quota = s.quota;
      this.quotaAt = s.quotaAt;
    }
    const at = this.now();
    for (const [k, b] of this.blocks) if (b.until <= at - 24 * 3600) this.blocks.delete(k);
    for (const t of this.host.store.limitTimers()) {
      const account = this.host.chat(t.chatId)?.account ?? "";
      let p = this.paused.get(t.chatId);
      if (!p) {
        p = { account, resume: true, at: null, timer: null };
        this.paused.set(t.chatId, p);
      }
      p.at = t.at;
      p.timer = t.id;
    }
    const ids = new Set(this.host.chats().map((c) => c.id));
    for (const id of [...this.paused.keys()]) if (!ids.has(id)) this.paused.delete(id);
    for (const [id, q] of this.stored) if (this.paused.has(id) && !this.host.pending.has(id)) this.host.pending.set(id, q);
    this.stored = new Map();
    this.syncPending();
  }

  /** Keeps the stored copy of paused chats' queued prompts current. */
  syncPending(): void {
    this.stored = new Map();
    for (const id of this.paused.keys()) {
      const q = this.host.pending.get(id);
      if (q && q.length > 0) this.stored.set(id, [...q]);
    }
    this.save();
  }

    blocked(account: string): Block | undefined {
    const b = this.blocks.get(account);
    return b && b.until > this.now() ? b : undefined;
  }

  /** The account reached the user's cap on a window: blocked like at a limit, until the window resets. */
  capBlock(account: string, kind: string, cap: number, until: number, known: boolean): void {
    this.blocks.set(account, { until, kind, known, tries: 0, cap });
    this.save();
  }

  /** A cap block that no longer applies: it goes, and the chats waiting on it continue now. */
  liftBlock(account: string): void {
    this.blocks.delete(account);
    this.save();
    const waiting = [...this.paused].filter(([, p]) => p.account === account).map(([id]) => id);
    this.ctl.lifting = true;
    for (const id of waiting) this.continueChat(id, false);
    this.ctl.lifting = false;
  }

  /** "Paused at your 80% cap of the weekly limit" or "Hit the weekly limit". */
  static blockReason(b: Block): string {
    return b.cap !== null ? `Paused at your ${b.cap}% cap of the ${windowLabel(b.kind)} limit` : `Hit the ${windowLabel(b.kind)} limit`;
  }

  /** The chat's running turn ended on a usage limit (so it isn't "finished"). */
  hitLimit(chatId: number): boolean {
    return this.hit.has(chatId);
  }

  /** Agent events about limits. True when consumed here. */
  limitEvent(chatId: number, ev: LimitEvent): boolean {
    const account = this.host.chat(chatId)?.account ?? "";
    switch (ev.type) {
      case "quota":
        this.quota.set(account, ev.windows);
        this.quotaAt.set(account, this.now());
        this.save();
        return true;
      case "limit": {
        let { kind, resetsAt } = ev;
        // Newer CLIs leave quotaLimits out of the synthetic message: read its text.
        if (resetsAt === null) {
          const parsed = fromText(ev.text, this.now());
          if (parsed && parsed[1] !== null) {
            kind = kind === "" ? parsed[0] : kind;
            resetsAt = parsed[1];
          }
        }
        this.limitHit(chatId, kind, resetsAt, ev.text);
        return true;
      }
      case "error": {
        if (!this.hit.has(chatId)) {
          const parsed = fromText(ev.text, this.now());
          if (parsed) this.limitHit(chatId, parsed[0], parsed[1], ev.text);
        }
        return false;
      }
      default:
        return false;
    }
  }

  /** After the turn's exit was handled. */
  limitExited(chatId: number): void {
    this.hit.delete(chatId);
    const to = this.switch.get(chatId);
    if (to === undefined) return;
    this.switch.delete(chatId);
    const chat = this.host.chat(chatId);
    const b = chat ? this.blocks.get(chat.account) : undefined;
    const why = b ? `hit its ${windowLabel(b.kind)} limit` : "";
    // If it can't move, it waits for the reset like any other.
    if (!this.continueOn(chatId, to, why)) this.pause(chatId, true);
  }

  private limitHit(chatId: number, kind: string, resetsAt: number | null, said: string): void {
    const chat = this.host.chat(chatId);
    if (!chat) return;
    const at = this.now();
    const first = !this.hit.has(chatId);
    this.hit.add(chatId);
    const prev = this.blocks.get(chat.account);
    const block = nextBlock(prev, kind, resetsAt, at);
    if (!first && prev && prev.until === block.until) return; // the same hit, seen twice
    this.blocks.set(chat.account, block);
    const label = windowLabel(block.kind);
    // Auto-switch: it moves to another account once this turn has exited.
    const to = this.autoTarget(chatId);
    if (to !== undefined) {
      const a = this.host.account(to);
      this.host.notice(chatId, "clock", `Hit the ${label} limit · moving to ${a ? accountName(a) : to}`, said);
      this.switch.set(chatId, to);
      this.save();
      return;
    }
    this.pause(chatId, true);
    const pausedAt = this.paused.get(chatId)?.at ?? null;
    const text =
      pausedAt !== null
        ? `Hit the ${label} limit · continuing at ${when(pausedAt, at)}`
        : block.tries >= MAX_TRIES
          ? `Still at the ${label} limit after ${MAX_TRIES} tries · continue it yourself`
          : `Hit the ${label} limit · resets ${when(block.until, at)} · waiting for you`;
    this.host.notice(chatId, "clock", text, said);
    const waits = this.paused.get(chatId)?.at === null;
    const first2 = this.switchTargets(chatId, false)[0];
    const target = first2 === undefined ? undefined : this.host.account(first2);
    const note = first2 === undefined ? text : `${text} · Continue on ${target ? accountName(target) : first2} available`;
    this.host.noteLimit(chatId, chat.account, waits, note);
    // Other chats already waiting on this account move to the new time.
    const others = [...this.paused].filter(([id, p]) => id !== chatId && p.account === chat.account);
    for (const [id, p] of others) this.pause(id, p.resume);
  }

  /** Settings: continue automatically, also weekly, wait at most (hours), notify. */
  limitSettings(): { auto: boolean; weekly: boolean; hours: number; notify: boolean } {
    const on = (k: string, d: boolean): boolean => {
      const v = this.host.store.get(k);
      return v === null ? d : v === "1";
    };
    const h = Number.parseInt(this.host.store.get("limit_wait_max") ?? "", 10);
    return { auto: on("limit_auto", true), weekly: on("limit_weekly", true), hours: Number.isInteger(h) ? h : 12, notify: on("limit_notify", false) };
  }

  /** Pauses the chat until its account's block ends (sub-agents first, the lead half a minute after them), or until the user decides. */
  private pause(chatId: number, resume: boolean): void {
    const chat = this.host.chat(chatId);
    if (!chat) return;
    const block = this.blocks.get(chat.account);
    if (!block) return;
    const { auto, weekly, hours } = this.limitSettings();
    const ok = auto && (weekly || !isWeekly(block.kind)) && block.until - this.now() <= hours * 3600 && block.tries < MAX_TRIES;
    const keep = resume || (this.paused.get(chatId)?.resume ?? false);
    const old = this.paused.get(chatId)?.timer ?? null;
    if (old !== null) this.host.store.deleteTimer(old);
    let at: number | null = null;
    if (ok) {
      const n = [...this.paused].filter(([id, p]) => id !== chatId && p.account === chat.account).length;
      const lead = chat.role === "lead" ? 30 : 0;
      at = block.until + 60 + ((((chatId * 7919) % 45) + 45) % 45) + n * 8 + lead;
    }
    const timer = at === null ? null : this.host.store.addLimitTimer(chatId, at, chat.account);
    this.paused.set(chatId, { account: chat.account, resume: keep, at, timer });
    this.syncPending();
  }

    limitGuard(chatId: number, prompt: string, files: readonly string[]): boolean {
    const chat = this.host.chat(chatId);
    if (!chat) return false;
    const account = chat.account;
    if (!this.blocked(account)) return false;
    // Auto-switch: the turn starts on another account instead.
    const to = this.autoTarget(chatId);
    if (to !== undefined && this.bringSession(chatId, to) === null) {
      const from = this.host.account(account);
      const target = this.host.account(to);
      this.host.setAccount(chatId, to);
      const cap = this.blocks.get(account)?.cap ?? null;
      const why = cap !== null ? `is at your ${cap}% cap` : "is at its usage limit";
      this.host.notice(chatId, "clock", `Switched to ${target ? accountName(target) : to} (${from ? accountName(from) : ""} ${why})`, "");
      return false;
    }
    let p = prompt;
    for (const f of files) p += `\n(attached: ${f})`;
    const q = this.host.pending.get(chatId) ?? [];
    q.push(p);
    this.host.pending.set(chatId, q);
    // The message is in the transcript already: keep it there.
    this.host.persist(chatId);
    if (!this.paused.has(chatId)) {
      this.pause(chatId, false);
      const b = this.blocks.get(account);
      if (b && b.cap !== null) {
        const at = this.paused.get(chatId)?.at ?? null;
        const then = at === null ? "" : ` · continuing at ${when(at, this.now())}`;
        this.host.notice(chatId, "clock", `${Limits.blockReason(b)}${then}`, "");
      }
    } else {
      this.syncPending();
    }
    return true;
  }

  /** Continues the chats whose time has come. Returns the seconds until the next one. */
  fireLimitTimers(): number | null {
    this.ctl.checkCaps();
    const at = this.now();
    const due = [...this.paused].filter(([, p]) => p.at !== null && p.at <= at).map(([id]) => id);
    for (const id of due) this.continueChat(id, false);
    const ats = [...this.paused.values()].map((p) => p.at).filter((a): a is number => a !== null);
    const next = ats.length === 0 ? null : Math.max(Math.min(...ats) - at, 1);
    // A cap can lift any moment (the user raises it, usage drops): look again soon.
    if ([...this.blocks.values()].some((b) => b.cap !== null && b.until > at)) return next === null ? 5 : Math.min(next, 5);
    return next;
  }

  /** Continues a paused chat: at its time, or now (`force`, "Continue now"). */
  continueChat(chatId: number, force: boolean): void {
    const p = this.paused.get(chatId);
    if (!p) return;
    const chat = this.host.chat(chatId);
    if (!chat) {
      this.paused.delete(chatId);
      return;
    }
    if (this.host.turnRunning(chatId)) return;
    if (force) {
      this.blocks.delete(p.account);
    } else if (this.blocked(p.account)) {
      // Pushed out meanwhile (a later hit): wait for the new time.
      this.pause(chatId, p.resume);
      return;
    }
    // Sub-agents keep to the per-lead limit; a full team waits half a minute.
    if (chat.role === "sub" && !force) {
      const busy = chat.parent === null ? 0 : this.host.runningSubs(chat.parent);
      if (busy >= MAX_RUNNING_SUBS) {
        if (p.timer !== null) this.host.store.deleteTimer(p.timer);
        const at = this.now() + 30;
        const timer = this.host.store.addLimitTimer(chatId, at, p.account);
        this.paused.set(chatId, { ...p, at, timer });
        this.save();
        return;
      }
    }
    if (p.timer !== null) this.host.store.deleteTimer(p.timer);
    this.paused.delete(chatId);
    const parts: string[] = [];
    if (p.resume) parts.push(RESUME);
    parts.push(...(this.host.pending.get(chatId) ?? []));
    this.host.pending.delete(chatId);
    this.syncPending();
    if (parts.length === 0) return;
    const text = this.ctl.lifting ? "Under your cap again · continuing" : "Usage limit reset · continuing";
    this.host.notice(chatId, "clock", text, "");
    this.host.noteResumed(chatId, p.account, text);
    this.host.startTurn(chatId, parts.join("\n\n---\n\n"));
  }

  /** "Cancel": the chat stops waiting; what it queued stays queued. */
  cancelLimit(chatId: number): void {
    const p = this.paused.get(chatId);
    if (!p) return;
    this.paused.delete(chatId);
    if (p.timer !== null) this.host.store.deleteTimer(p.timer);
    this.host.notice(chatId, "clock", "Won't continue after the usage limit", "");
    this.syncPending();
  }

  /** The usage-limit line under a paused chat, and whether it has a continue time to cancel. */
  limitText(chatId: number): [string, boolean] | null {
    const p = this.paused.get(chatId);
    if (!p) return null;
    if (this.host.turnRunning(chatId)) return null;
    const block = this.blocks.get(p.account);
    const at = this.now();
    const what = block && block.cap !== null ? `Paused at your ${block.cap}% cap · resets ${when(block.until, at)}` : "Usage limit";
    let text: string;
    if (p.at !== null) text = `${what} · continuing at ${when(p.at, at)} (in ${minutesText(Math.max(p.at - at, 0))})`;
    else if (block && block.until > at && block.cap === null) text = `${what} · resets ${when(block.until, at)} · waiting for you`;
    else text = `${what} · waiting for you`;
    return [text, p.at !== null];
  }

  /** Auto-switch: on, and the opted-in account ids. */
  switchSettings(): { on: boolean; ids: string[] } {
    const on = this.host.store.get("limit_switch") === "1";
    let ids: string[] = [];
    try {
      const v: unknown = JSON.parse(this.host.store.get("limit_switch_accounts") ?? "[]");
      if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) ids = v;
    } catch {
      // none chosen
    }
    return { on, ids };
  }

  /** Highest utilization seen for the account (0–1), per window: weekly, 5-hour. */
  usageOf(account: string): [number, number] {
    let weekly = 0;
    let five = 0;
    for (const [k, u] of this.quota.get(account) ?? []) {
      if (isWeekly(k)) weekly = Math.max(weekly, u);
      else five = Math.max(five, u);
    }
    for (const w of this.host.account(account)?.usage ?? []) {
      if (w.label.toLowerCase().includes("week")) weekly = Math.max(weekly, w.percent);
      else five = Math.max(five, w.percent);
    }
    return [weekly, five];
  }

  /** Accounts the chat could continue on: the same provider, signed in, not blocked, not the current one. `opted` limits it to the auto-switch list and to accounts with quota left. */
  switchTargets(chatId: number, opted: boolean): string[] {
    const chat = this.host.chat(chatId);
    if (!chat) return [];
    const kind = this.host.account(chat.account)?.kind;
    if (kind === undefined) return [];
    const { ids } = this.switchSettings();
    const v = this.host
      .accounts()
      .filter((a) => a.kind === kind && a.id !== chat.account && a.loggedIn !== false && !this.blocked(a.id) && !this.ctl.overCap(a.id))
      .filter((a) => !opted || ids.includes(a.id))
      .map((a): [string, [number, number]] => [a.id, this.usageOf(a.id)])
      .filter(([, [w, f]]) => !opted || (w < FULL && f < FULL));
    v.sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]);
    return v.map(([id]) => id);
  }

  /** Makes the chat's Claude session available to `to` (same project folder name), unless both accounts already share their projects folder. Null when done, else why not. */
  bringSession(chatId: number, to: string): string | null {
    const chat = this.host.chat(chatId);
    if (!chat) return "no chat";
    const from = this.host.account(chat.account);
    if (!from) return "no account";
    const target = this.host.account(to);
    if (!target) return "no account";
    if (from.kind !== "claude" || !chat.started || chat.sessionId === "") return null; // nothing to carry
    // A chat on another device keeps its session there.
    if (chat.device !== "") return null;
    const dir = (a: AccountInfo): string => join(a.configDir ?? join(home(), ".claude"), "projects");
    const [srcRoot, dstRoot] = [dir(from), dir(target)];
    const canon = (p: string): string | null => {
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    };
    const [x, y] = [canon(srcRoot), canon(dstRoot)];
    if (x !== null && x === y) return null;
    const src = this.host.sessionFile(from.configDir, chat.sessionId);
    if (!src) return "the session file wasn't found";
    const slug = basename(dirname(src));
    // A second copy in another folder of the target would make --resume fail.
    const existing = this.host.sessionFile(target.configDir, chat.sessionId);
    if (existing && basename(dirname(existing)) !== slug) return "the target account has this session in another project folder";
    const dstDir = join(dstRoot, slug);
    try {
      mkdirSync(dstDir, { recursive: true });
      const dst = join(dstDir, basename(src));
      if (!existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs) copyFileSync(src, dst);
      // Sidecar folder (sub-agent transcripts, tool output overflow), if any.
      const side = src.replace(/\.[^./]*$/, "");
      if (existsSync(side) && statSync(side).isDirectory()) cpSync(side, join(dstDir, basename(side)), { recursive: true });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return null;
  }

  /** Moves the chat to `to` and continues it there now. False if it couldn't move. */
  continueOn(chatId: number, to: string, why: string): boolean {
    if (this.host.turnRunning(chatId)) return false;
    const err = this.bringSession(chatId, to);
    if (err !== null) {
      this.host.notice(chatId, "alert", `Couldn't move to another account: ${err}`, "");
      return false;
    }
    const chat = this.host.chat(chatId);
    const from = chat ? this.host.account(chat.account) : undefined;
    const target = this.host.account(to);
    this.host.setAccount(chatId, to);
    this.host.notice(chatId, "clock", `Switched to ${target ? accountName(target) : to} (${from ? accountName(from) : ""} ${why})`, "");
    const p = this.paused.get(chatId);
    this.paused.delete(chatId);
    if (p && p.timer !== null) this.host.store.deleteTimer(p.timer);
    const parts: string[] = [];
    if (!p || p.resume) parts.push(RESUME.replace("Your usage limit reset", "You're on another account now"));
    parts.push(...(this.host.pending.get(chatId) ?? []));
    this.host.pending.delete(chatId);
    this.syncPending();
    this.host.startTurn(chatId, parts.join("\n\n---\n\n"));
    return true;
  }

    autoTarget(chatId: number): string | undefined {
    return this.switchSettings().on ? this.switchTargets(chatId, true)[0] : undefined;
  }
}
