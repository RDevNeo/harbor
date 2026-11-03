import { expect, test } from "bun:test";
import { CALL_WAIT, CAPTCHA_WAIT, DAY, FREEZE_AFTER, MAX_LOGINS, MAX_QUIT_LOGINS, Policy, QUIT_AFTER, callWait, mayRetire, pace, paceKind, readTest, swapIn } from "../src/discordhost.ts";

const POLICY = new Policy(FREEZE_AFTER, MAX_LOGINS, QUIT_AFTER, MAX_QUIT_LOGINS);
const many = (at: number, n: number): number[] => Array.from({ length: n }, () => at);

test("with_swap_it_freezes_after_idle_unless_busy_or_past_the_days_logins: with swap it freezes after idle unless busy or past the day's logins", () => {
  const p = POLICY;
  const now = 1_000_000;
  expect(p.rest(now, now - 119, 0, [], true)).toBeUndefined();
  expect(p.rest(now, now - 120, 0, [], true)).toBe("freeze");
  expect(p.rest(now, now - 9999, 1, [], true)).toBeUndefined();
  expect(p.rest(now, now - 9999, 0, many(now - 10, MAX_LOGINS - 1), true)).toBe("freeze");
  expect(p.rest(now, now - 9999, 0, many(now - 10, MAX_LOGINS), true)).toBeUndefined();
  expect(p.rest(now, now - 9999, 0, many(now - DAY - 1, MAX_LOGINS), true)).toBe("freeze");
});

test("without_swap_it_quits_later_and_never_freezes: without swap it quits later and never freezes", () => {
  const p = POLICY;
  const now = 1_000_000;
  expect(p.rest(now, now - 120, 0, [], false)).toBeUndefined();
  expect(p.rest(now, now - 1799, 0, [], false)).toBeUndefined();
  expect(p.rest(now, now - 1800, 0, [], false)).toBe("quit");
  expect(p.rest(now, now - 9999, 1, [], false)).toBeUndefined();
  expect(p.rest(now, now - 9999, 0, many(now - 10, MAX_QUIT_LOGINS - 1), false)).toBe("quit");
  expect(p.rest(now, now - 9999, 0, many(now - 10, MAX_QUIT_LOGINS), false)).toBeUndefined();
  expect(p.rest(now, now - 9999, 0, many(now - DAY - 1, MAX_QUIT_LOGINS), false)).toBe("quit");
});

test("with_swap_a_frozen_client_quits_after_quit_idle_within_the_days_logins: with swap a frozen client quits after QUIT_AFTER, within the day's logins", () => {
  const p = POLICY;
  const now = 1_000_000;
  expect(p.quitsFrozen(now, now - QUIT_AFTER + 1, 0, [])).toBe(false);
  expect(p.quitsFrozen(now, now - QUIT_AFTER, 0, [])).toBe(true);
  expect(p.quitsFrozen(now, 0, 0, [])).toBe(false);
  expect(p.quitsFrozen(now, now - 9999, 1, [])).toBe(false);
  expect(p.quitsFrozen(now, now - 9999, 0, many(now - 10, MAX_LOGINS - 1))).toBe(true);
  expect(p.quitsFrozen(now, now - 9999, 0, many(now - 10, MAX_LOGINS))).toBe(false);
  expect(p.quitsFrozen(now, now - 9999, 0, many(now - DAY - 1, MAX_LOGINS))).toBe(true);
});

test("reads_swap_from_meminfo: reads swap from meminfo", () => {
  expect(swapIn("MemTotal:  8000 kB\nSwapTotal:  11500 kB\nSwapFree:  1 kB\n")).toBe(true);
  expect(swapIn("MemTotal:  8000 kB\nSwapTotal:  0 kB\nSwapFree:  0 kB\n")).toBe(false);
  expect(swapIn("MemTotal:  8000 kB\n")).toBe(false);
});

test("pace_holds_back_dms_and_bursts_never_joins_or_leaves: pace holds back DMs and bursts, never joins or leaves", () => {
  const log = (k: string, ago: number[], now: number): [string, number][] => ago.map((a) => [k, now - a]);
  const now = 1_000_000;
  // Joins and leaves aren't paced at all, however many and however close.
  expect(pace("join", log("join", [1, 2, 3, 60, 120, 400, 800, 1200], now), now)).toEqual({ go: true });
  expect(pace("leave", log("leave", [1, 2, 3, 60, 120, 400, 800, 1200], now), now)).toEqual({ go: true });
  expect(pace("dm", [], now)).toEqual({ go: true });
  expect(pace("dm", log("dm", [60], now), now)).toHaveProperty("refuse");
  expect(pace("dm", log("dm", [121], now), now)).toEqual({ go: true });
  expect(pace("dm", log("leave", [60], now), now)).toEqual({ go: true });
  expect(pace("dm", log("dm", [121, 500, 900, 1300], now), now)).toHaveProperty("refuse");
  expect(pace("upload", log("upload", [5], now), now)).toHaveProperty("refuse");
  expect(pace("send", log("send", [0], now), now)).toEqual({ wait: 1 });
  expect(pace("other", [], now)).toEqual({ go: true });
  const p = pace("dm", log("dm", [60], now), now);
  expect("refuse" in p ? p.refuse : "").toContain("1 min");
});

test("dry_runs_and_reads_arent_paced: dry runs and reads aren't paced", () => {
  expect(paceKind("discord_join", { invite: "x" })).toBeUndefined();
  expect(paceKind("discord_join", { apply: true })).toBeUndefined();
  expect(paceKind("discord_leave", { apply: true })).toBeUndefined();
  expect(paceKind("discord_leave", {})).toBeUndefined();
  expect(paceKind("discord_send", { content: "hi" })).toBe("send");
  expect(paceKind("discord_send", { files: [{}] })).toBe("upload");
  expect(paceKind("discord_history", {})).toBeUndefined();
});

test("the_self_test_answer_carries_only_known_names_and_statuses: the self-test answer carries only known names and statuses", () => {
  const base = 'GuildStore: { x },\n"source:a": { y },\ndiscord_view: { z },';
  const r = {
    vencord: true,
    build: "abc123 and a message",
    needs: { GuildStore: "missing", "source:a": "ok", "someone said hello": "ok", ChannelStore: "secret text" },
    tools: { discord_view: ["GuildStore", "leak"], discord_leak: ["GuildStore"] },
  };
  const t = readTest(r, base);
  expect(t.missing).toEqual(["GuildStore"]);
  expect(t.tools.size).toBe(1);
  expect(t.tools.get("discord_view")).toEqual(["GuildStore"]);
  expect(t.build).toBe("abc123andamessage");
  expect(JSON.stringify(t.report)).not.toContain("hello");
  expect(JSON.stringify(t.report)).not.toContain("secret");
  expect(readTest({}, base).missing).toEqual(["Vencord"]);
});

test("waits_get_the_time_they_ask_for: waits get the time they ask for", () => {
  expect(callWait("discord_waitForMessage", { timeoutMs: 600_000 })).toBe(605_000);
  expect(callWait("discord_waitForMessage", {})).toBe(65_000);
  expect(callWait("discord_history", {})).toBe(CALL_WAIT);
  expect(callWait("discord_onboarding", {})).toBe(125_000);
  expect(callWait("discord_send", { typing: true })).toBe(68_000);
  expect(callWait("discord_send", { typingMs: 1000 })).toBe(63_000);
  expect(callWait("discord_send", {})).toBe(62_000);
});

test("an update never retires a host while a captcha waits for a person, unless it's stuck past its time limit", () => {
  const at = 1_000_000;
  const waiting = { since: at - 60 };
  for (const phase of ["ready", "frozen", "stopped"]) expect(mayRetire(phase, 0, false, waiting, at)).toBe(false);
  expect(mayRetire("ready", 1, false, waiting, at)).toBe(false);
  expect(mayRetire("ready", 1, false, { since: at - CAPTCHA_WAIT - 61 }, at)).toBe(true);
  expect(mayRetire("ready", 0, false, null, at)).toBe(true);
  expect(mayRetire("ready", 1, false, null, at)).toBe(false);
  expect(mayRetire("frozen", 0, false, null, at)).toBe(true);
  expect(mayRetire("stopped", 0, true, null, at)).toBe(false);
});
