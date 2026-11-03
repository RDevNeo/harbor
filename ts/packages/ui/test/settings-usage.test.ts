import { expect, test } from "bun:test";
import { providers } from "@harbor/agents";
import { cost, type Item, limits, Store } from "@harbor/store";
import { sumResults } from "../src/logic/pages.ts";
import { accountInfo, setUsage, usageData } from "../src/logic/settings-usage.ts";

const logo = () => ({ width: 1, height: 1, data: new Uint8Array(4) });
const NOW = 1_800_000_000;
const TODAY = Math.floor(NOW / 86400);

const claude = (id: string, over: Partial<providers.Account> = {}): providers.Account => ({ id, kind: "Claude", name: id === "claude" ? "Sam" : "Lee", email: `${id}@example.test`, badge: id === "claude" ? "SA" : "LE", plan: "Max", configDir: null, bin: "/bin/claude", loggedIn: true, usage: [], ...over });

function rig(accounts: providers.Account[]) {
  const store = Store.openTemp();
  const lim = new limits.Limits({
    store,
    chat: () => undefined,
    chats: () => [],
    account: (id) => accounts.map(accountInfo).find((a) => a.id === id),
    accounts: () => accounts.map(accountInfo),
    pending: new Map(),
    turnRunning: () => false,
    runningSubs: () => 0,
    startTurn: () => {},
    notice: () => {},
    noteLimit: () => {},
    noteResumed: () => {},
    notify: () => {},
    persist: () => {},
    setAccount: () => {},
    sessionFile: () => null,
    now: () => NOW,
  });
  return { store, lim };
}

const empty = sumResults([], new Map(), TODAY);
const input = (accounts: providers.Account[], lim: limits.Limits) => ({ accounts, limits: lim, totals: empty, today: TODAY, logo });

test("usage with no signed-in account says so and lists no cards", () => {
  const { lim } = rig([claude("claude", { loggedIn: false })]);
  const v = usageData(input([claude("claude", { loggedIn: false })], lim));
  expect(v.accounts_note).toBe("No provider accounts are signed in on this computer.");
  expect(v.groups).toEqual([]);
});

test("usage reads Rust's defaults for what happens after a limit", () => {
  const { lim } = rig([]);
  const v = usageData(input([], lim));
  expect([v.auto, v.weekly, v.notify, v.switch_on]).toEqual([true, true, false, false]);
  expect([v.hours, v.hours_options[v.hours]]).toEqual([3, "12 h"]);
  expect(v.switch_note).toBe('0 chosen, with "Use for auto-switch" on the account cards above.');
});

test("usage shows a window's number, its reset and the summary of a cap", () => {
  const accounts = [claude("claude", { usage: [{ label: "5h", percent: 0.424, resetsAt: NOW + 3 * 3600 + 12 * 60 }, { label: "Week", percent: 0.73, resetsAt: null }] }), claude("claude2")];
  const { lim } = rig(accounts);
  lim.ctl.setCap("claude", "5h", 50);
  lim.ctl.setCap("claude", "week", 65);
  const v = usageData(input(accounts, lim));
  const card = v.groups[0]?.cards[0];
  expect(card?.name).toBe("Sam");
  expect(card?.sub).toBe("Claude \u{b7} SA \u{b7} claude@example.test");
  expect(card?.switchable).toBe(true);
  expect(card?.summary).toBe("Harbor will stop using this account at 50% of the 5h limit (now 42%) and at 65% of the weekly limit (now 73%).");
  expect(card?.windows.map((w) => [w.label, w.numbers, w.cap])).toEqual([
    ["5h", "42% used  \u{b7}  resets in 3h 12m", 50],
    ["Weekly", "73% used", 65],
  ]);
  expect(card?.windows[1]?.capped_note).toBe("cap 65%");
  expect(v.groups[0]?.cards[1]?.summary).toBe("No caps: Harbor uses this account up to the provider's own limits.");
});

test("usage offers no 5-hour row or cap for an Ultra account", () => {
  const usage = [{ label: "5-hour", percent: 0, resetsAt: null }, { label: "Weekly", percent: 0.08, resetsAt: null }];
  const accounts = [claude("claude", { plan: "Ultra", usage }), claude("claude2", { usage })];
  const { lim } = rig(accounts);
  lim.ctl.setCap("claude", "5h", 50);
  const cards = usageData(input(accounts, lim)).groups[0]?.cards ?? [];
  expect(cards.map((c) => c.windows.map((w) => w.label))).toEqual([["Weekly"], ["5-hour", "Weekly"]]);
  expect(cards[0]?.summary).toBe("No caps: Harbor uses this account up to the provider's own limits.");
});

test("usage names a window with no data since its reset", () => {
  const accounts = [claude("claude", { usage: [{ label: "5h", percent: 0.9, resetsAt: NOW - 60 }] })];
  const { lim } = rig(accounts);
  const w = usageData(input(accounts, lim)).groups[0]?.cards[0]?.windows[0];
  expect([w?.numbers, w?.has_used]).toEqual(["no data since the reset", false]);
});

test("usage says what an account without windows waits for", () => {
  const accounts = [claude("claude")];
  const { lim } = rig(accounts);
  const c = usageData(input(accounts, lim)).groups[0]?.cards[0];
  expect(c?.empty).toBe("No usage data yet. It shows up after this account's next turn, or from the usage monitor.");
  expect(c?.switchable).toBe(false);
});

test("usage marks a cap block as paused and a provider limit as red", () => {
  const accounts = [claude("claude"), claude("claude2")];
  const { lim } = rig(accounts);
  lim.capBlock("claude", "five_hour", 80, NOW + 3600, true);
  lim.blocks.set("claude2", { until: NOW + 7200, kind: "seven_day", known: true, tries: 1, cap: null });
  const cards = usageData(input(accounts, lim)).groups[0]?.cards ?? [];
  expect(cards.map((c) => [c.block.startsWith("Paused at 80%"), c.block_red])).toEqual([
    [true, false],
    [false, true],
  ]);
  expect(cards[1]?.block.startsWith("Limit reached")).toBe(true);
});

test("usage sums per project, day and account the way pages.rs lists them", () => {
  const accounts = [claude("claude")];
  const { lim } = rig(accounts);
  const at = TODAY * 86400;
  const result = (account: string, tin: number, tout: number, usd: number, when: number): Item => ({ kind: "result", cost_usd: usd, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached: 0, at: when, account, model: "" });
  const chats = new Map<number, [string, string]>([
    [1, ["claude", "alpha"]],
    [2, ["claude", ""]],
  ]);
  const totals = sumResults(
    [
      [1, result("", 1000, 100, 0.5, at)],
      [2, result("", 5000, 500, 0.25, at - 86400)],
      [2, result("codex", 2000, 0, 0, at - 2 * 86400)],
    ],
    chats,
    TODAY,
  );
  const v = usageData({ ...input(accounts, lim), totals });
  expect(v.projects.map((r) => [r.name, r.value])).toEqual([
    ["alpha", "1.1k tok \u{b7} $0.50"],
    ["No project", "7.5k tok \u{b7} $0.25"],
  ]);
  expect(v.days.slice(0, 2).map((r) => r.name)).toEqual(["Today", "Yesterday"]);
  expect(v.days[2]?.name).toBe(cost.dayLabel(TODAY - 2));
  expect(v.by_account.map((r) => [r.name, r.has_logo])).toEqual([
    ["Sam", true],
    ["codex", true],
  ]);
  expect(v.bars).toHaveLength(14);
  expect(v.bars[13]).toEqual({ frac: 1100 / 5500, label: "today", today: true });
  expect(v.bars[12]?.frac).toBe(1);
  expect(v.bars.map((b) => b.label).filter((l) => l !== "")).toEqual(["-12d", "-10d", "-8d", "-6d", "-4d", "-2d", "today"]);
});

test("usage writes the limit settings where the Rust app keeps them, all four at once", () => {
  const { store, lim } = rig([]);
  expect(setUsage(lim, store, "auto", "", 0)).toBe(true);
  expect(["limit_auto", "limit_weekly", "limit_wait_max", "limit_notify"].map((k) => store.get(k))).toEqual(["0", "1", "12", "0"]);
  expect(setUsage(lim, store, "hours", "", 5)).toBe(true);
  expect(store.get("limit_wait_max")).toBe("48");
  expect(setUsage(lim, store, "notify", "", 1)).toBe(true);
  expect(setUsage(lim, store, "weekly", "", 0)).toBe(true);
  expect(lim.limitSettings()).toEqual({ auto: false, weekly: false, hours: 48, notify: true });
  expect(setUsage(lim, store, "nope", "", 0)).toBe(false);
});

test("usage writes caps, warnings and the accounts to switch to", () => {
  const { store, lim } = rig([]);
  setUsage(lim, store, "cap", "claude\n5h", 50);
  setUsage(lim, store, "cap", "claude\nweek", 3);
  expect(store.get("usage_caps")).toBe('{"claude":{"5h":50,"week":5}}');
  setUsage(lim, store, "cap", "claude\n5h", 100);
  expect(store.get("usage_caps")).toBe('{"claude":{"week":5}}');
  setUsage(lim, store, "warn", "claude", 3);
  expect(store.get("usage_warn")).toBe('{"claude":70}');
  setUsage(lim, store, "warn", "claude", 0);
  expect(store.get("usage_warn")).toBe("{}");
  setUsage(lim, store, "switch", "", 1);
  setUsage(lim, store, "use", "claude2", 1);
  setUsage(lim, store, "use", "claude3", 1);
  setUsage(lim, store, "use", "claude2", 0);
  expect([store.get("limit_switch"), store.get("limit_switch_accounts")]).toEqual(["1", '["claude3"]']);
});
