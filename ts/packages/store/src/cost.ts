import type { Item } from "./item.ts";

/** Turn results added up. */
export interface Usage {
  turns: number;
  /** Input tokens, cached ones included. */
  input: number;
  output: number;
  /** Of `input`: read from or written to the prompt cache. */
  cached: number;
  cost: number;
}

export const emptyUsage = (): Usage => ({ turns: 0, input: 0, output: 0, cached: 0, cost: 0 });

export function addResult(u: Usage, it: Item): void {
  if (it.kind !== "result") return;
  u.turns += 1;
  u.input += it.input_tokens;
  u.output += it.output_tokens;
  u.cached += it.cached;
  u.cost += it.cost_usd;
}

export const tokens = (u: Usage): number => u.input + u.output;

export const isEmpty = (u: Usage): boolean => u.turns === 0;

export function ofItems(items: readonly Item[]): Usage {
  const u = emptyUsage();
  for (const it of items) addResult(u, it);
  return u;
}

/** `x` with `d` decimals the way Rust's `{:.d}` writes it: exact ties go to the even digit (JS's toFixed takes the larger). */
export function fixed(x: number, d: number): string {
  const exact = Math.abs(x).toFixed(80);
  const dot = exact.indexOf(".");
  const rest = exact.slice(dot + 1 + d);
  const tie = rest.startsWith("5") && /^50*$/.test(rest);
  if (!tie) return x.toFixed(d);
  const kept = exact.slice(0, dot + 1 + d).replace(".", "");
  const down = BigInt(kept) % 2n === 0n;
  const n = down ? BigInt(kept) : BigInt(kept) + 1n;
  const digits = n.toString().padStart(d + 1, "0");
  const body = d === 0 ? digits : `${digits.slice(0, -d)}.${digits.slice(-d)}`;
  return x < 0 ? `-${body}` : body;
}

/** A token count in few characters: 950, 12.4k, 189k, 1.2M. */
export function short(n: number): string {
  const trim = (s: string): string => s.replace(".0k", "k").replace(".0M", "M");
  if (n < 1_000) return String(n);
  if (n < 100_000) return trim(`${fixed(n / 1_000, 1)}k`);
  if (n < 1_000_000) return `${Math.floor(n / 1_000)}k`;
  return trim(`${fixed(n / 1_000_000, 1)}M`);
}

/** "$0.18", "$12.40", "<$0.01"; "" for nothing. */
export function money(c: number): string {
  if (c <= 0) return "";
  if (c < 0.005) return "<$0.01";
  return `$${fixed(c, 2)}`;
}

/** "12.4k tok · $0.18" (no cost when none was reported). */
export function compact(u: Usage): string {
  const cost = money(u.cost);
  return cost === "" ? `${short(tokens(u))} tok` : `${short(tokens(u))} tok · ${cost}`;
}

/** The whole split, for a hover or a details line. */
export function detail(u: Usage): string {
  let s = `${short(u.input)} in`;
  if (u.cached > 0) s += ` (${short(u.cached)} cached)`;
  s += ` · ${short(u.output)} out`;
  const cost = money(u.cost);
  if (cost !== "") s += ` · ${cost}`;
  return `${s} · ${u.turns === 1 ? "1 turn" : `${u.turns} turns`}`;
}

export interface UsageJson {
  turns: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
  label: string;
  detail: string;
}

/** As the phone gets it (PROTOCOL.md `usage`). */
export function usageJson(u: Usage): UsageJson {
  return {
    turns: u.turns,
    input: u.input,
    output: u.output,
    cached: u.cached,
    cost: Math.round(u.cost * 10_000) / 10_000,
    label: compact(u),
    detail: detail(u),
  };
}

const WEEKDAYS = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Civil date from days since the epoch (Howard Hinnant's algorithm): [month 1-12, day]. */
export function civil(day: number): [number, number] {
  const z = day + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  return [mp < 10 ? mp + 3 : mp - 9, d];
}

/** A day (days since the epoch) as the Usage page names it: "Mon 24 Oct". */
export function dayLabel(day: number): string {
  const [m, d] = civil(day);
  return `${WEEKDAYS[((day % 7) + 7) % 7]} ${d} ${MONTHS[m - 1]}`;
}

/** What Settings › Usage shows. */
export interface Totals {
  byAccount: Map<string, { turns: number; input: number; output: number; cost: number }>;
  byDay: Map<number, number>;
  /** The last 14 days. */
  days: Map<number, Usage>;
  /** By project name ("" for chats without one). */
  byProject: Map<string, Usage>;
  byChat: Map<number, Usage>;
}

export const emptyTotals = (): Totals => ({ byAccount: new Map(), byDay: new Map(), days: new Map(), byProject: new Map(), byChat: new Map() });

function entry<K>(m: Map<K, Usage>, k: K): Usage {
  let u = m.get(k);
  if (!u) {
    u = emptyUsage();
    m.set(k, u);
  }
  return u;
}

/** Sums turn results; `chats` is each chat's [account, project name]: the account for results saved without one. */
export function sumResults(results: readonly (readonly [number, Item])[], chats: ReadonlyMap<number, readonly [string, string]>, today: number): Totals {
  const t = emptyTotals();
  for (const [chat, it] of results) {
    if (it.kind !== "result") continue;
    const [acc, project] = chats.get(chat) ?? ["", ""];
    const a = it.account === "" ? acc : it.account;
    let e = t.byAccount.get(a);
    if (!e) {
      e = { turns: 0, input: 0, output: 0, cost: 0 };
      t.byAccount.set(a, e);
    }
    e.turns += 1;
    e.input += it.input_tokens;
    e.output += it.output_tokens;
    e.cost += it.cost_usd;
    if (it.at > 0 && today - Math.floor(it.at / 86400) < 14) {
      const day = Math.floor(it.at / 86400);
      t.byDay.set(day, (t.byDay.get(day) ?? 0) + it.input_tokens + it.output_tokens);
      addResult(entry(t.days, day), it);
    }
    addResult(entry(t.byProject, project), it);
    addResult(entry(t.byChat, chat), it);
  }
  return t;
}

interface UsageRow {
  name: string;
  label: string;
  detail: string;
  usage: UsageJson;
}

const row = (name: string, u: Usage): UsageRow => ({ name, label: compact(u), detail: detail(u), usage: usageJson(u) });

/** `GET /v1/usage` (PROTOCOL.md): per project (costliest first), per day (the last 14, newest first) and per account. `accountName` names an account id. */
export function apiUsage(t: Totals, today: number, accountName: (id: string) => string): { projects: UsageRow[]; days: UsageRow[]; accounts: UsageRow[] } {
  const projects = [...t.byProject]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .map(([p, u]): [string, Usage] => [p === "" ? "No project" : p, u]);
  projects.sort((a, b) => b[1].cost - a[1].cost || tokens(b[1]) - tokens(a[1]));
  const days: UsageRow[] = [];
  for (let i = 0; i < 14; i++) {
    const d = today - i;
    const u = t.days.get(d);
    if (u) days.push(row(i === 0 ? "Today" : i === 1 ? "Yesterday" : dayLabel(d), u));
  }
  const accounts = [...t.byAccount]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .map(([a, e]) => row(accountName(a), { turns: e.turns, input: e.input, output: e.output, cached: 0, cost: e.cost }));
  return { projects: projects.map(([n, u]) => row(n, u)), days, accounts };
}
