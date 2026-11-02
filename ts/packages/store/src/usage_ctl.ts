import { fixed } from "./cost.ts";
import { accountName, type Limits, type Quota, type UsageWindow, when } from "./limits.ts";

/** How often caps are checked against usage (seconds). */
const CHECK_EVERY = 5;
/** Presets offered under each bar; 100 means no cap. */
export const PRESETS = [50, 80, 100] as const;
/** The lowest cap a user can set. */
export const MIN_CAP = 5;

/** One usage window of an account. */
export interface Win {
  /** Stable key: "5h", "week", "week:opus", or the monitor's label in lowercase. */
  key: string;
  label: string;
  /** Fraction used (0–1); null when there's no data since the window reset. */
  used: number | null;
  resetsAt: number | null;
}

/** Key and label of a window, from a Claude rate-limit kind or a monitor label. */
export function keyLabel(name: string): [string, string] {
  const l = name.toLowerCase();
  if (["five_hour", "5-hour", "5 hour", "session"].includes(l)) return ["5h", "5-hour"];
  if (["seven_day", "weekly", "week"].includes(l)) return ["week", "Weekly"];
  if (l.startsWith("seven_day_")) {
    const model = name.slice("seven_day_".length);
    const m = model.slice(0, 1).toUpperCase() + model.slice(1);
    return [`week:${model.toLowerCase()}`, `Weekly · ${m}`];
  }
  return [l, name];
}

/** The limit kind limits.ts understands, for a window key ("seven_day" for weekly). */
export function kindOf(key: string): string {
  if (key === "5h") return "five_hour";
  if (key === "week") return "seven_day";
  if (key.startsWith("week:")) return `seven_day_${key.slice(5)}`;
  return key;
}

/** "3h 12m", "2d 4h", "12m". */
export function span(secs: number): string {
  const s = Math.max(secs, 0);
  if (s < 3600) return `${Math.max(Math.floor(s / 60), 1)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** "81%", of a fraction used. */
export function percentText(used: number): string {
  return `${fixed(Math.min(Math.max(used * 100, 0), 100), 0)}%`;
}

/** "resets in 3h 12m"; null when unknown or already past. */
export function resetsIn(at: number | null, now: number): string | null {
  return at !== null && at > now ? `resets in ${span(at - now)}` : null;
}

/** "81%  ·  resets in 2d 3h", or why there's no number. */
export function readingText(w: Win, now: number): string {
  const used = w.used === null ? "no data since the reset" : percentText(w.used);
  const r = resetsIn(w.resetsAt, now);
  return r === null ? used : `${used}  ·  ${r}`;
}

/** One account as the usage read-out shows it. */
export interface Reading {
  id: string;
  label: string;
  plan: string;
  signedIn: boolean;
  /** When its numbers were last seen, from the monitor or a turn (Unix time). */
  seen: number | null;
  windows: Win[];
}

/** An account of this PC, as the read-out needs it. */
export interface ReadingAccount {
  id: string;
  kind: string;
  /** "Claude · FS" */
  short: string;
  email: string;
  plan: string;
  installed: boolean;
  loggedIn: boolean | null;
}

/** One account for the phone (PROTOCOL.md, `limits` of `GET /v1/usage`). */
export function readingJson(r: Reading, now: number): { id: string; label: string; plan: string; signed_in: boolean; seen_ms: number | null; windows: { label: string; percent: number | null; text: string }[] } {
  return {
    id: r.id,
    label: r.label,
    plan: r.plan,
    signed_in: r.signedIn,
    seen_ms: r.seen === null ? null : r.seen * 1000,
    windows: r.windows.map((w) => ({ label: w.label, percent: w.used === null ? null : Math.round(w.used * 1000) / 10, text: readingText(w, now) })),
  };
}

/** The monitor's windows and what turns reported, the newer source winning a window both have; 5-hour first. */
export function mergeWindows(monitor: readonly UsageWindow[], live: readonly Quota[], monitorNewer: boolean, now: number): Win[] {
  const fromMonitor = monitor.map((w): [string, number, number | null] => [w.label, w.percent, w.resetsAt]);
  const fromTurns = live.map(([k, u, r]): [string, number, number | null] => [k, u, r > 0 ? r : null]);
  const v: Win[] = [];
  for (const [name, used, resets] of monitorNewer ? [...fromTurns, ...fromMonitor] : [...fromMonitor, ...fromTurns]) {
    const [key, label] = keyLabel(name);
    // A window that has reset since: its number is stale.
    const u = resets !== null && resets <= now ? null : used;
    const x = v.find((w) => w.key === key);
    if (x) {
      x.used = u;
      x.resetsAt = resets ?? x.resetsAt;
    } else {
      v.push({ key, label, used: u, resetsAt: resets });
    }
  }
  return [...v.filter((w) => w.key === "5h"), ...v.filter((w) => w.key !== "5h")];
}

type Caps = Record<string, Record<string, number>>;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** How much of each account's quota Harbor may use: caps per window (kv `usage_caps`, a percentage of the provider's own limit; 100 is none) and a warning threshold per account (kv `usage_warn`). */
export class UsageCtl {
  /** Set while chats continue because a cap block was lifted (for their notice). */
  lifting = false;
  lastCheck = 0;
  /** Warnings already sent: account, window, reset time. */
  private readonly warned = new Set<string>();

  constructor(private readonly limits: Limits) {}

  /** The account's usage windows, merging the usage monitor's cache with what turns reported live. A report with no
   *  time (saved by an older Harbor) counts as the newer one. */
  windows(account: string): Win[] {
    const a = this.limits.host.account(account);
    const monitorAt = a?.usageAt ?? null;
    const quotaAt = this.limits.quotaAt.get(account);
    const monitorNewer = monitorAt !== null && quotaAt !== undefined && monitorAt > quotaAt;
    return mergeWindows(a?.usage ?? [], this.limits.quota.get(account) ?? [], monitorNewer, this.limits.now());
  }

  /** Every Claude account on this PC, for the usage read-out. */
  readings(accounts: readonly ReadingAccount[]): Reading[] {
    return accounts
      .filter((a) => a.kind.toLowerCase() === "claude" && a.installed)
      .map((a) => {
        const info = this.limits.host.account(a.id);
        const monitor = info && info.usage.length > 0 ? (info.usageAt ?? null) : null;
        const turns = this.limits.quotaAt.get(a.id) ?? null;
        // Accounts can share a badge: the email tells those apart.
        const twin = accounts.some((x) => x.id !== a.id && x.short === a.short);
        return {
          id: a.id,
          label: twin && a.email !== "" ? a.email : a.short,
          plan: a.plan,
          signedIn: a.loggedIn !== false,
          seen: monitor === null ? turns : turns === null ? monitor : Math.max(monitor, turns),
          windows: this.windows(a.id),
        };
      });
  }

  private caps(): Caps {
    try {
      const v: unknown = JSON.parse(this.limits.host.store.get("usage_caps") ?? "{}");
      if (!isRec(v)) return {};
      const out: Caps = {};
      for (const [a, m] of Object.entries(v)) {
        if (!isRec(m)) return {};
        const inner: Record<string, number> = {};
        for (const [k, n] of Object.entries(m)) {
          if (typeof n !== "number") return {};
          inner[k] = n;
        }
        out[a] = inner;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** The cap on a window, in percent (100: none). */
  cap(account: string, key: string): number {
    return this.caps()[account]?.[key] ?? 100;
  }

  setCap(account: string, key: string, pct: number): void {
    const all = this.caps();
    const m = all[account] ?? {};
    all[account] = m;
    if (pct >= 100) delete m[key];
    else m[key] = Math.max(pct, MIN_CAP);
    for (const a of Object.keys(all)) if (Object.keys(all[a] ?? {}).length === 0) delete all[a];
    this.limits.host.store.set("usage_caps", JSON.stringify(all));
    this.lastCheck = 0; // re-check at once
  }

  /** The warning threshold for the account, in percent (0: off). */
  warnAt(account: string): number {
    try {
      const v: unknown = JSON.parse(this.limits.host.store.get("usage_warn") ?? "{}");
      const n = isRec(v) ? v[account] : undefined;
      return typeof n === "number" ? n : 0;
    } catch {
      return 0;
    }
  }

  setWarn(account: string, pct: number): void {
    let m: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(this.limits.host.store.get("usage_warn") ?? "{}");
      if (isRec(v)) m = v;
    } catch {
      // starts over
    }
    if (pct === 0) delete m[account];
    else m[account] = pct;
    this.limits.host.store.set("usage_warn", JSON.stringify(m));
  }

  /** The first window the account has reached its cap on: [window, cap]. */
  overCap(account: string): [Win, number] | undefined {
    for (const w of this.windows(account)) {
      const cap = this.cap(account, w.key);
      if (cap < 100 && w.used !== null && w.used * 100 >= cap) return [w, cap];
    }
    return undefined;
  }

  /** Every few seconds: blocks accounts that reached a cap (like a limit), lifts cap blocks that no longer apply and continues what waited on them, and sends warnings. */
  checkCaps(): void {
    const clock = performance.now() / 1000 + 1;
    if (clock - this.lastCheck < CHECK_EVERY && this.lastCheck > 0) return;
    this.lastCheck = clock;
    const { host } = this.limits;
    const at = this.limits.now();
    for (const a of host.accounts()) {
      const id = a.id;
      const over = this.overCap(id);
      const block = this.limits.blocked(id);
      if (over && !block) {
        const [w, cap] = over;
        const until = w.resetsAt !== null && w.resetsAt > at ? w.resetsAt : at + 30 * 60;
        this.limits.capBlock(id, kindOf(w.key), cap, until, w.resetsAt !== null);
        host.notify("limit", `limit:${id}`, "Usage cap reached", `Harbor paused ${accountName(a)} at your ${cap}% cap of the ${w.label.toLowerCase()} limit, until ${when(until, at)}.`);
      } else if (!over && block && block.cap !== null) {
        this.limits.liftBlock(id);
      }
      const warn = this.warnAt(id);
      if (warn <= 0) continue;
      for (const w of this.windows(id)) {
        if (w.used === null) continue;
        const mark = `${id}\0${w.key}\0${w.resetsAt ?? 0}`;
        if (w.used * 100 >= warn && !this.warned.has(mark)) {
          this.warned.add(mark);
          host.notify("limit", `warn:${id}`, "Usage warning", `${accountName(a)} has used ${fixed(w.used * 100, 0)}% of its ${w.label.toLowerCase()} limit.`);
        }
      }
    }
  }

  /** One-line summary of a block for cards: "Paused at 80% · until 6:00 PM" or "Limit reached · until …". */
  blockBadge(account: string): string | undefined {
    const b = this.limits.blocked(account);
    if (!b) return undefined;
    const at = this.limits.now();
    return b.cap !== null ? `Paused at ${b.cap}% · until ${when(b.until, at)}` : `Limit reached · until ${when(b.until, at)}`;
  }
}
