import { providers } from "@harbor/agents";
import { cost, limits, usageCtl } from "@harbor/store";
import type { Pixels } from "../logos.ts";
import type { Totals } from "./pages.ts";
import type { Kv } from "./settings.ts";
import { pick } from "./text.ts";

/** The caps' presets under each bar (100 is no cap), as the Rust app offers them. */
const PRESETS = [50, 80, 100];
const HOURS = [1, 3, 6, 12, 24, 48, 168];
const WARNS = [0, 50, 60, 70, 80, 90];

export interface UsageWin {
  key: string;
  label: string;
  numbers: string;
  has_used: boolean;
  used: number;
  cap: number;
  warn: number;
  capped_note: string;
}

export interface UsageCard {
  id: string;
  logo: Pixels;
  badge: string;
  name: string;
  plan: string;
  sub: string;
  block: string;
  block_red: boolean;
  switchable: boolean;
  switch_on: boolean;
  use_it: boolean;
  summary: string;
  empty: string;
  windows: UsageWin[];
  warn: number;
  warn_options: string[];
}

export interface UsageGroup {
  logo: Pixels;
  name: string;
  cards: UsageCard[];
}

export interface UsageBar {
  frac: number;
  label: string;
  today: boolean;
}

export interface UsageRow {
  name: string;
  logo: Pixels;
  badge: string;
  has_logo: boolean;
  value: string;
  tip: string;
}

/** What slint/settings-usage.slint draws (`UsageData`). */
export interface UsageData {
  accounts_note: string;
  groups: UsageGroup[];
  auto: boolean;
  weekly: boolean;
  hours: number;
  hours_options: string[];
  notify: boolean;
  switch_on: boolean;
  switch_note: string;
  bars: UsageBar[];
  projects: UsageRow[];
  days: UsageRow[];
  by_account: UsageRow[];
  presets: number[];
}

/** Everything the page reads: the accounts, the limits state (caps, blocks, settings) and the turn totals. */
export interface UsageInput {
  accounts: readonly providers.Account[];
  limits: limits.Limits;
  totals: Totals;
  /** Days since the epoch. */
  today: number;
  logo(kind: providers.Kind): Pixels;
}

/** An account as limits.ts names it. */
export function accountInfo(a: providers.Account): limits.AccountInfo {
  return { id: a.id, kind: a.kind.toLowerCase(), name: a.name, short: providers.short(a), loggedIn: a.loggedIn, configDir: a.configDir, usage: a.usage, usageAt: a.usageAt ?? null, plan: a.plan };
}

const warnText = (p: number): string => (p === 0 ? "Off" : `${p}%`);
const percent = (x: number): string => cost.fixed(x * 100, 0);

/** The options of a list of numbers, with the current one added when it isn't among them. */
function listed(values: readonly number[], current: number): number[] {
  return values.includes(current) ? [...values] : [...values, current];
}

function windowRows(input: UsageInput, a: providers.Account, now: number): { wins: UsageWin[]; summary: string } {
  const { ctl } = input.limits;
  const warn = ctl.warnAt(a.id);
  const windows = ctl.windows(a.id);
  const wins = windows.map((w): UsageWin => {
    const cap = ctl.cap(a.id, w.key);
    const used = w.used === null ? "no data since the reset" : `${percent(w.used)}% used`;
    const resets = w.resetsAt !== null && w.resetsAt > now ? `resets in ${usageCtl.span(w.resetsAt - now)}` : "";
    return {
      key: w.key,
      label: w.label,
      numbers: resets === "" ? used : `${used}  \u{b7}  ${resets}`,
      has_used: w.used !== null,
      used: w.used ?? 0,
      cap,
      warn,
      capped_note: cap < 100 && !PRESETS.includes(cap) ? `cap ${cap}%` : "",
    };
  });
  const capped = windows.filter((w) => ctl.cap(a.id, w.key) < 100);
  let summary = "No caps: Harbor uses this account up to the provider's own limits.";
  if (capped.length > 0) {
    const parts = capped.map((w) => {
      const c = ctl.cap(a.id, w.key);
      return w.used === null ? `${c}% of the ${w.label.toLowerCase()} limit` : `${c}% of the ${w.label.toLowerCase()} limit (now ${percent(w.used)}%)`;
    });
    summary = `Harbor will stop using this account at ${parts.join(" and at ")}.`;
  }
  return { wins, summary };
}

/** pages.rs `usage_tab` with usage_ctl.rs `usage_controller` and limits.rs `limits_settings`. */
export function usageData(input: UsageInput): UsageData {
  const { limits: lim, totals, today } = input;
  const now = lim.now();
  const blank: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };
  const shown = input.accounts.filter((a) => providers.installed(a) && a.loggedIn !== false);
  const settings = lim.limitSettings();
  const sw = lim.switchSettings();
  const claudes = shown.filter((a) => a.kind === "Claude").length;
  const groups: UsageGroup[] = [];
  for (const kind of providers.KINDS) {
    const cards = shown
      .filter((a) => a.kind === kind)
      .map((a): UsageCard => {
        const w = windowRows(input, a, now);
        const block = lim.ctl.blockBadge(a.id);
        const warn = lim.ctl.warnAt(a.id);
        const short = providers.short(a);
        return {
          id: a.id,
          logo: input.logo(a.kind),
          badge: a.badge,
          name: a.kind === "Claude" ? a.name : a.kind,
          plan: a.plan,
          sub: a.email === "" ? short : `${short} \u{b7} ${a.email}`,
          block: block ?? "",
          block_red: block !== undefined && lim.blocked(a.id)?.cap === null,
          switchable: kind === "Claude" && claudes > 1,
          switch_on: sw.on,
          use_it: sw.ids.includes(a.id),
          summary: w.summary,
          empty: w.wins.length === 0 ? "No usage data yet. It shows up after this account's next turn, or from the usage monitor." : "",
          windows: w.wins,
          warn: listed(WARNS, warn).indexOf(warn),
          warn_options: listed(WARNS, warn).map(warnText),
        };
      });
    if (cards.length > 0) groups.push({ logo: input.logo(kind), name: kind, cards });
  }
  const max = Math.max(1, ...totals.byDay.values());
  const bars = Array.from({ length: 14 }, (_, i): UsageBar => ({ frac: (totals.byDay.get(today - 13 + i) ?? 0) / max, label: i === 13 ? "today" : i % 2 === 1 ? `-${13 - i}d` : "", today: i === 13 }));
  const row = (name: string, u: cost.Usage): UsageRow => ({ name, logo: blank, badge: "", has_logo: false, value: cost.compact(u), tip: cost.detail(u) });
  const projects = [...totals.byProject]
    .map(([p, u]): [string, cost.Usage] => [p === "" ? "No project" : p, u])
    .sort((a, b) => b[1].cost - a[1].cost || cost.tokens(b[1]) - cost.tokens(a[1]))
    .map(([p, u]) => row(p, u));
  const days: UsageRow[] = [];
  for (let i = 0; i < 14; i++) {
    const u = totals.days.get(today - i);
    if (u) days.push(row(i === 0 ? "Today" : i === 1 ? "Yesterday" : cost.dayLabel(today - i), u));
  }
  const byAccount = [...totals.byAccount].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, [turns, input_, output, usd]]): UsageRow => {
    const a = input.accounts.find((x) => x.id === id);
    const u: cost.Usage = { turns, input: input_, output, cached: 0, cost: usd };
    return { ...row(a ? limits.accountName(accountInfo(a)) : id, u), logo: input.logo(a?.kind ?? "Claude"), badge: a?.badge ?? "", has_logo: true };
  });
  return {
    accounts_note: shown.length === 0 ? "No provider accounts are signed in on this computer." : "",
    groups,
    auto: settings.auto,
    weekly: settings.weekly,
    hours: listed(HOURS, settings.hours).indexOf(settings.hours),
    hours_options: listed(HOURS, settings.hours).map((h) => `${h} h`),
    notify: settings.notify,
    switch_on: sw.on,
    switch_note: `${sw.ids.length} chosen, with "Use for auto-switch" on the account cards above.`,
    bars,
    projects,
    days,
    by_account: byAccount,
    presets: PRESETS,
  };
}

const ACTS = ["cap", "warn", "use", "auto", "weekly", "notify", "switch", "hours"] as const;

/** One control of the page, written where the Rust app keeps it; false for a control it doesn't know. `a` is an account id ("cap": id, newline, window); `n` the value or option. */
export function setUsage(lim: limits.Limits, kv: Kv, what: string, a: string, n: number): boolean {
  const b = (v: boolean) => (v ? "1" : "0");
  const cur = lim.limitSettings();
  const next = { ...cur };
  const act = pick(what, ACTS);
  if (act === "cap") {
    const [account = "", window = ""] = a.split("\n");
    lim.ctl.setCap(account, window, n);
    return true;
  }
  if (act === "warn") {
    lim.ctl.setWarn(a, listed(WARNS, lim.ctl.warnAt(a))[n] ?? 0);
    return true;
  }
  if (act === "use") {
    const ids = lim.switchSettings().ids.filter((x) => x !== a);
    if (n === 1) ids.push(a);
    kv.set("limit_switch_accounts", JSON.stringify(ids));
    return true;
  }
  if (act === "switch") {
    kv.set("limit_switch", b(n === 1));
    return true;
  }
  if (act === "auto") next.auto = n === 1;
  else if (act === "weekly") next.weekly = n === 1;
  else if (act === "notify") next.notify = n === 1;
  else if (act === "hours") next.hours = listed(HOURS, cur.hours)[n] ?? cur.hours;
  else return false;
  kv.set("limit_auto", b(next.auto));
  kv.set("limit_weekly", b(next.weekly));
  kv.set("limit_wait_max", String(next.hours));
  kv.set("limit_notify", b(next.notify));
  return true;
}
