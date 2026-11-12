import { afterEach, expect, test } from "bun:test";
import { type AccountInfo, type Block, Limits, type LimitsHost, fromText, nextBlock, windowLabel } from "../src/limits.ts";
import { keyLabel, mergeWindows, percentText, quotaText, readingJson, readingText, type ReadingAccount, resetsIn } from "../src/usage_ctl.ts";
import { type Chat, Store, blankChat, now } from "../src/index.ts";

test("from_text_survives_case_changing_chars", () => {
  expect(fromText("İ rate limit try again at ")).not.toBeNull();
  expect(fromText("Kİrate limit, try again at é")).not.toBeNull();
  expect(fromText("İ no limit words here")).toBeNull();
});

test("claude_reset_wording", () => {
  const at = now();
  const parsed = fromText("You've hit your weekly limit · resets 12am (America/Sao_Paulo)");
  expect(parsed?.[0]).toBe("seven_day");
  const t = parsed?.[1] ?? 0;
  expect(t > at && t <= at + 24 * 3600 + 60).toBe(true);
  // Midnight in São Paulo is 03:00 UTC (no DST there since 2019).
  expect(((t % 86400) + 86400) % 86400).toBe(3 * 3600);
  const london = fromText("You've hit your limit · resets 3:30pm (Europe/London)")?.[1] ?? 0;
  expect(london > at && london <= at + 24 * 3600 + 60).toBe(true);
  expect(fromText("Claude usage limit reached · resets Oct 30, 5pm (UTC)")?.[1]).not.toBeNull();
  expect(fromText("You've hit your usage limit · resets soon")?.[1]).toBeNull();
  expect(fromText("resets 12am (UTC) but no limit words")).toBeNull();
});

test("unknown_reset_keeps_known_block", () => {
  const at = 1_000_000;
  const known = nextBlock(undefined, "seven_day", at + 6 * 3600, at);
  expect([known.known, known.until]).toEqual([true, at + 6 * 3600]);
  const again = nextBlock(known, "", null, at);
  expect([again.known, again.until]).toEqual([true, known.until]);
  expect(windowLabel(again.kind)).toBe("weekly");
  const later = nextBlock(known, "", null, at + 7 * 3600);
  expect([later.known, later.until]).toEqual([false, at + 7 * 3600 + 15 * 60]);
  const cap: Block = { ...known, cap: 80 };
  expect(nextBlock(cap, "", null, at).known).toBe(false);
  const a = nextBlock(undefined, "", null, at);
  const b = nextBlock(a, "", null, at + 60);
  expect([a.until - at, b.until - at - 60]).toEqual([15 * 60, 30 * 60]);
});

class Host implements LimitsHost {
  store = Store.openTemp();
  pending = new Map<number, string[]>();
  turns = new Set<number>();
  started: [number, string][] = [];
  notices: string[] = [];
  clock = 1_000_000;
  accountsList: AccountInfo[] = [acct("claude"), acct("claude2")];
  chatList: Chat[] = [];

  now = (): number => this.clock;
  chat = (id: number): Chat | undefined => this.chatList.find((c) => c.id === id);
  chats = (): readonly Chat[] => this.chatList;
  account = (id: string): AccountInfo | undefined => this.accountsList.find((a) => a.id === id);
  accounts = (): readonly AccountInfo[] => this.accountsList;
  turnRunning = (id: number): boolean => this.turns.has(id);
  runningSubs = (): number => 0;
  startTurn = (id: number, p: string): void => void this.started.push([id, p]);
  notice = (_id: number, _icon: string, text: string): void => void this.notices.push(text);
  noteLimit = (): void => {};
  noteResumed = (): void => {};
  notify = (_k: string, _key: string, title: string): void => void this.notices.push(title);
  persist = (): void => {};
  setAccount = (id: number, account: string): void => {
    const c = this.chat(id);
    if (c) c.account = account;
  };
  sessionFile = (): string | null => null;

  addChat(over: Partial<Chat> = {}): Chat {
    const c = this.store.createChat(blankChat({ title: "t", ...over }));
    this.chatList.push(c);
    return c;
  }
}

function acct(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return { id, kind: "claude", name: id, short: `Claude · ${id}`, loggedIn: true, configDir: null, usage: [], ...over };
}

const hosts: Host[] = [];
const setup = (): [Host, Limits] => {
  const h = new Host();
  hosts.push(h);
  return [h, new Limits(h)];
};
afterEach(() => {
  for (const h of hosts.splice(0)) h.store.close();
});

test("a limit hit pauses the chat, queues prompts and continues at the reset", () => {
  const [h, l] = setup();
  const c = h.addChat();
  const reset = h.clock + 3600;
  expect(l.limitEvent(c.id, { type: "limit", kind: "five_hour", resetsAt: reset, text: "hit" })).toBe(true);
  expect(l.blocked("claude")?.until).toBe(reset);
  const p = l.paused.get(c.id);
  expect(p?.at).toBeGreaterThanOrEqual(reset + 60);
  expect(h.store.limitTimers().length).toBe(1);
  expect(l.limitGuard(c.id, "next", [])).toBe(true);
  expect(h.pending.get(c.id)).toEqual(["next"]);
  expect(h.store.get("limits")).toContain('"pending":{"' + c.id + '":["next"]}');
  // Not yet.
  l.fireLimitTimers();
  expect(h.started).toEqual([]);
  h.clock = (p?.at ?? 0) + 1;
  l.fireLimitTimers();
  expect(h.started.length).toBe(1);
  expect(h.started[0]?.[1]).toContain("Continue the task from where you stopped.");
  expect(h.started[0]?.[1]).toContain("next");
  expect(l.paused.size).toBe(0);
  expect(h.store.limitTimers()).toEqual([]);
});

test("the stored state comes back after a restart", () => {
  const [h, l] = setup();
  const c = h.addChat();
  l.limitEvent(c.id, { type: "limit", kind: "five_hour", resetsAt: h.clock + 3600, text: "" });
  l.limitEvent(c.id, { type: "quota", windows: [["five_hour", 1, h.clock + 10]] });
  h.pending.set(c.id, ["queued"]);
  l.syncPending();
  const again = new Limits(h);
  h.pending = new Map();
  again.load();
  expect(again.blocked("claude")?.kind).toBe("five_hour");
  expect(again.paused.get(c.id)?.timer).toBe(l.paused.get(c.id)?.timer ?? -1);
  expect(h.pending.get(c.id)).toEqual(["queued"]);
  expect(again.quota.get("claude")).toEqual([["five_hour", 1, h.clock + 10]]);
  expect(h.store.get("limits")).toContain('"quota":{"claude":[["five_hour",1.0,');
});

test("a cap blocks the account and lifting it continues the chats", () => {
  const [h, l] = setup();
  const c = h.addChat();
  l.ctl.setCap("claude", "5h", 80);
  l.limitEvent(c.id, { type: "quota", windows: [["five_hour", 0.9, h.clock + 1000]] });
  l.ctl.checkCaps();
  const b = l.blocked("claude");
  expect([b?.cap, b?.kind, b?.until]).toEqual([80, "five_hour", h.clock + 1000]);
  expect(l.limitGuard(c.id, "go", [])).toBe(true);
  l.ctl.setCap("claude", "5h", 100);
  l.ctl.checkCaps();
  expect(l.blocked("claude")).toBeUndefined();
  expect(h.started.length).toBe(1);
  expect(h.started[0]?.[1]).toContain("go");
  expect(h.notices.some((n) => n.includes("Under your cap"))).toBe(true);
});

test("auto-switch moves a chat to an opted-in account with quota left", () => {
  const [h, l] = setup();
  const c = h.addChat();
  h.store.setQuiet("limit_switch", "1");
  h.store.setQuiet("limit_switch_accounts", '["claude2"]');
  expect(l.switchTargets(c.id, true)).toEqual(["claude2"]);
  l.limitEvent(c.id, { type: "limit", kind: "five_hour", resetsAt: h.clock + 3600, text: "" });
  expect(l.switch.get(c.id)).toBe("claude2");
  l.limitExited(c.id);
  expect(h.chat(c.id)?.account).toBe("claude2");
  expect(h.started[0]?.[1]).toContain("You're on another account now");
});

test("warnings are sent once per window", () => {
  const [h, l] = setup();
  l.ctl.setWarn("claude", 50);
  l.quota.set("claude", [["five_hour", 0.6, h.clock + 100]]);
  l.ctl.checkCaps();
  l.ctl.lastCheck = 0;
  l.ctl.checkCaps();
  expect(h.notices.filter((n) => n === "Usage warning").length).toBe(1);
  expect(l.ctl.warnAt("claude")).toBe(50);
});

test("the usage read-out: percents, reset times and the line that joins them", () => {
  expect([0, 0.814, 0.996, 1.2, -0.1].map(percentText)).toEqual(["0%", "81%", "100%", "100%", "0%"]);
  const at = 1_000_000;
  expect(resetsIn(at + 3 * 3600 + 12 * 60, at)).toBe("resets in 3h 12m");
  expect(resetsIn(at + 86400 + 15 * 3600, at)).toBe("resets in 1d 15h");
  expect(resetsIn(at + 30, at)).toBe("resets in 1m");
  expect(resetsIn(at, at)).toBeNull();
  expect(resetsIn(null, at)).toBeNull();
  const win = (used: number | null, resetsAt: number | null) => ({ key: "week", label: "Weekly", used, resetsAt });
  expect(readingText(win(0.81, at + 7200), at)).toBe("81%  ·  resets in 2h 0m");
  expect(readingText(win(0, null), at)).toBe("0%");
  expect(readingText(win(null, null), at)).toBe("no data since the reset");
});

test("the phone gets percents and the same line", () => {
  const at = 1_000_000;
  const r = { id: "claude", label: "Claude · FS", plan: "Max 20x", signedIn: true, seen: at - 60, windows: [{ key: "week", label: "Weekly", used: 0.814, resetsAt: at + 7200 }, { key: "5h", label: "5-hour", used: null, resetsAt: null }] };
  expect(JSON.parse(JSON.stringify(readingJson(r, at)))).toEqual({
    id: "claude",
    label: "Claude · FS",
    plan: "Max 20x",
    signed_in: true,
    seen_ms: (at - 60) * 1000,
    windows: [
      { label: "Weekly", percent: 81.4, text: "81%  ·  resets in 2h 0m" },
      { label: "5-hour", percent: null, text: "no data since the reset" },
    ],
  });
  expect(readingJson({ ...r, seen: null }, at).seen_ms).toBeNull();
});

test("the newer source wins a window; extra windows stay; 5-hour comes first", () => {
  const at = 1_000_000;
  const monitor = [
    { label: "Weekly", percent: 0.81, resetsAt: at + 3600 },
    { label: "5-hour", percent: 0, resetsAt: null },
  ];
  const live: [string, number, number][] = [
    ["seven_day", 0.4, at + 3600],
    ["seven_day_opus", 0.2, at + 3600],
  ];
  const turnsWin = mergeWindows(monitor, live, false, at);
  expect(turnsWin.map((w) => [w.key, w.label, w.used])).toEqual([
    ["5h", "5-hour", 0],
    ["week", "Weekly", 0.4],
    ["week:opus", "Weekly · Opus", 0.2],
  ]);
  expect(mergeWindows(monitor, live, true, at).find((w) => w.key === "week")?.used).toBe(0.81);
  // A window that has reset since has no number, whichever source says it.
  expect(mergeWindows(monitor, [], false, at + 7200).find((w) => w.key === "week")?.used).toBeNull();
});

test("a turn's report wins only while it is newer than the monitor's file, and its time is stored", () => {
  const [h, l] = setup();
  const c = h.addChat();
  h.accountsList = [acct("claude", { usage: [{ label: "Weekly", percent: 0.81, resetsAt: h.clock + 86400 }], usageAt: h.clock - 600 }), acct("claude2")];
  l.limitEvent(c.id, { type: "quota", windows: [["seven_day", 0.4, h.clock + 86400]] });
  expect(l.quotaAt.get("claude")).toBe(h.clock);
  expect(l.ctl.windows("claude")[0]?.used).toBe(0.4);
  h.accountsList[0] = { ...(h.accountsList[0] as AccountInfo), usageAt: h.clock + 60 };
  expect(l.ctl.windows("claude")[0]?.used).toBe(0.81);
  // A report saved without its time counts as the newer one.
  l.quotaAt.delete("claude");
  expect(l.ctl.windows("claude")[0]?.used).toBe(0.4);
  l.limitEvent(c.id, { type: "quota", windows: [["seven_day", 0.4, h.clock + 86400]] });
  const again = new Limits(h);
  again.load();
  expect(again.quotaAt.get("claude")).toBe(h.clock);
  expect(h.store.get("limits")).toContain(`"quota_at":{"claude":${h.clock}}`);
});

test("the read-out lists Claude accounts with when their numbers were seen", () => {
  const [h, l] = setup();
  const c = h.addChat();
  h.accountsList = [acct("claude", { usage: [{ label: "Weekly", percent: 0.5, resetsAt: null }], usageAt: h.clock - 600 }), acct("claude2", { loggedIn: false }), acct("codex", { kind: "codex" })];
  const ra = (id: string, over: Partial<ReadingAccount> = {}): ReadingAccount => ({ id, kind: "Claude", short: `Claude · ${id}`, email: `${id}@example.com`, plan: "", installed: true, loggedIn: true, ...over });
  const list = [ra("claude", { plan: "Max 20x" }), ra("claude2", { loggedIn: false }), ra("claude3", { installed: false }), ra("codex", { kind: "Codex", short: "Codex" })];
  // claude2 isn't signed in (a profile folder never logged in): it has no usage to show.
  expect(l.ctl.readings(list).map((r) => [r.id, r.label, r.plan, r.signedIn, r.seen])).toEqual([["claude", "Claude · claude", "Max 20x", true, h.clock - 600]]);
  l.limitEvent(c.id, { type: "quota", windows: [["five_hour", 0.1, h.clock + 60]] });
  expect(l.ctl.readings(list)[0]?.seen).toBe(h.clock);
  // Accounts that share a badge are told apart by their email.
  expect(l.ctl.readings([ra("claude"), ra("claude2", { short: "Claude · claude" })]).map((r) => r.label)).toEqual(["claude@example.com", "claude2@example.com"]);
});

test("an Ultra account: no 5-hour window when the newer monitor read has none, weekly first", () => {
  const at = 1_000_000;
  const monitor = [
    { label: "Weekly", percent: 1, resetsAt: at + 86400 },
    { label: "Fable Weekly", percent: 0.12, resetsAt: at + 86400 },
  ];
  // A turn before the monitor's read still told of a 5-hour window.
  const live: [string, number, number][] = [
    ["five_hour", 0.3, at + 3600],
    ["seven_day", 0.98, at + 86400],
  ];
  expect(mergeWindows(monitor, live, true, at).map((w) => [w.key, w.label, w.used])).toEqual([
    ["week", "Weekly", 1],
    ["week:fable", "Weekly · Fable", 0.12],
  ]);
  // A turn newer than the monitor's read is still shown in full.
  expect(mergeWindows(monitor, live, false, at).map((w) => w.key)).toEqual(["5h", "week", "week:fable"]);
  // Without a monitor, what turns told is all there is.
  expect(mergeWindows([], live, true, at).map((w) => w.key)).toEqual(["5h", "week"]);
  expect(keyLabel("Opus Weekly")).toEqual(keyLabel("seven_day_opus"));
  expect(keyLabel("Weekly")).toEqual(["week", "Weekly"]);
});

test("an Ultra plan has no 5-hour window, nor a cap on one, though an older monitor and turns still report it", () => {
  const [h, l] = setup();
  const c = h.addChat();
  // What an older agents-usage-monitor writes for an Ultra account: its "Max 20x" plan and a made-up 5-hour 0%.
  const usage = [{ label: "5-hour", percent: 0, resetsAt: null }, { label: "Weekly", percent: 0.08, resetsAt: h.clock + 86400 }];
  h.accountsList = [acct("claude", { plan: "Ultra", usage, usageAt: h.clock - 60 }), acct("claude2", { plan: "Max", usage, usageAt: h.clock - 60 })];
  l.ctl.setCap("claude", "5h", 50);
  l.limitEvent(c.id, { type: "quota", windows: [["five_hour", 0.6, h.clock + 3600]] });
  expect(l.ctl.windows("claude").map((w) => w.key)).toEqual(["week"]);
  expect(l.ctl.readings([{ id: "claude", kind: "Claude", short: "Claude · FS", email: "", plan: "Ultra", installed: true, loggedIn: true }])[0]?.windows.map((w) => w.label)).toEqual(["Weekly"]);
  expect(l.ctl.overCap("claude")).toBeUndefined();
  expect(l.usageOf("claude")).toEqual([0.08, 0]);
  expect(l.ctl.windows("claude2").map((w) => [w.key, w.used])).toEqual([
    ["5h", 0],
    ["week", 0.08],
  ]);
  h.accountsList[0] = { ...(h.accountsList[0] as AccountInfo), plan: "" };
  expect(l.ctl.windows("claude").map((w) => w.key)).toEqual(["5h", "week"]);
});

test("list_models' line: the plan, then only the windows the account has", () => {
  const at = 1_000_000;
  expect(quotaText("Ultra", [{ key: "week", label: "Weekly", used: 1, resetsAt: at + 86400 * 3 + 3600 }], at)).toBe("Ultra · Weekly 100% used (resets in 3d 1h)");
  expect(quotaText("Max", [{ key: "5h", label: "5-hour", used: 0, resetsAt: null }, { key: "week", label: "Weekly", used: 0.01, resetsAt: null }], at)).toBe("Max · 5-hour 0% used, Weekly 1% used");
  expect(quotaText("", [{ key: "5h", label: "5-hour", used: null, resetsAt: null }], at)).toBe("5-hour no data since the reset");
  expect(quotaText("Pro", [], at)).toBe("Pro");
  expect(quotaText("", [], at)).toBe("");
});

test("spare quota: an account without a 5-hour window counts it as unused, a reset window too", () => {
  const [h, l] = setup();
  h.accountsList = [
    acct("claude", { usage: [{ label: "Weekly", percent: 0.4, resetsAt: h.clock + 86400 }, { label: "Fable Weekly", percent: 0.7, resetsAt: h.clock + 86400 }], usageAt: h.clock }),
    acct("claude3", { usage: [{ label: "5-hour", percent: 0.9, resetsAt: h.clock - 60 }, { label: "Weekly", percent: 0.2, resetsAt: h.clock + 86400 }], usageAt: h.clock }),
  ];
  expect(l.usageOf("claude")).toEqual([0.7, 0]);
  expect(l.usageOf("claude3")).toEqual([0.2, 0]);
});

test("a chat on an account turned off moves to the default one, never to another that's off, else waits with a notice", () => {
  const [h, l] = setup();
  h.accountsList = [acct("claude", { off: true }), acct("claude2", { off: true }), acct("claude3")];
  const c = h.addChat({ account: "claude" });
  expect(l.switchTargets(c.id, false)).toEqual(["claude3"]);
  h.store.set("default_account", "claude3");
  expect(l.limitGuard(c.id, "go", [])).toBe(false);
  expect(c.account).toBe("claude3");
  expect(h.notices.at(-1)).toContain("is turned off in Settings › Providers");
  const d = h.addChat({ account: "claude" });
  h.accountsList = [acct("claude", { off: true }), acct("claude2", { off: true })];
  expect(l.limitGuard(d.id, "go", [])).toBe(true);
  expect(d.account).toBe("claude");
  expect(h.notices.at(-1)).toContain("Turn it back on or pick another account");
  expect(h.pending.get(d.id)).toBeUndefined();
});

test("reset times are read without GNU date (macOS, Windows)", async () => {
  const { parseWhen } = await import("../src/limits.ts");
  const at = Date.UTC(2026, 10, 11, 12, 0) / 1000; // 2026-11-11 12:00 UTC
  expect(parseWhen("12am", "America/Sao_Paulo", at)).toBe(Date.UTC(2026, 10, 11, 3, 0) / 1000);
  expect(parseWhen("3:30pm", "Europe/London", at)).toBe(Date.UTC(2026, 10, 11, 15, 30) / 1000);
  expect(parseWhen("Oct 30 5pm", "UTC", at)).toBe(Date.UTC(2026, 9, 30, 17, 0) / 1000);
  expect(parseWhen("Nov 3rd 2027 9:00 AM", "UTC", at)).toBe(Date.UTC(2027, 10, 3, 9, 0) / 1000);
  expect(parseWhen("tomorrow 00:00", "America/Los_Angeles", at)).toBe(Date.UTC(2026, 10, 12, 8, 0) / 1000);
  // Across a DST change: 2 am in New York on 2026-03-09 is EDT (UTC-4).
  expect(parseWhen("Mar 9 2026 2:00 PM", "America/New_York", at)).toBe(Date.UTC(2026, 2, 9, 18, 0) / 1000);
  expect(parseWhen("soon", "UTC", at)).toBeNull();
  expect(parseWhen("13pm", "UTC", at)).toBeNull();
  expect(parseWhen("5", "UTC", at)).toBeNull();
});
