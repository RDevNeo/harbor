import { afterEach, expect, test } from "bun:test";
import { type AccountInfo, type Block, Limits, type LimitsHost, fromText, nextBlock, windowLabel } from "../src/limits.ts";
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
