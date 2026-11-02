import { expect, test } from "bun:test";
import { loadPrefs, MemKv, prefsOn } from "@harbor/net";
import { editNotifications, notificationsSections, notifyPressed, setNotifications } from "../src/logic/settings-notifications.ts";

test("notifications list the seven kinds, sub-agents off, and no quiet range by default", () => {
  const s = notificationsSections(new MemKv());
  expect(s.map((x) => x.title)).toEqual(["Notify me when", "When", "Phones"]);
  expect(s[0]?.rows.map((r) => [r.key, r.title, r.on])).toEqual([
    ["kind:input", "An agent needs you", true],
    ["kind:done", "A lead chat finished", true],
    ["kind:agent", "A sub-agent finished", false],
    ["kind:ci", "CI or PR checks failed", true],
    ["kind:limit", "Usage limit hit or back", true],
    ["kind:pc", "Another PC went offline", true],
    ["kind:discord", "Discord: a captcha, a sign-out, a repair", true],
  ]);
  expect(s[1]?.rows.map((r) => [r.key, r.on])).toEqual([
    ["away_only", false],
    ["quiet", false],
  ]);
  expect(s[2]?.rows[0]).toMatchObject({ kind: "button", key: "notify_test", title: "Harbor for Android", label: "Send a test" });
});

test("notifications show the quiet range, as kv holds it, only while quiet hours are on", () => {
  const kv = new MemKv();
  expect(setNotifications(kv, "quiet", true)).toBe(true);
  const row = notificationsSections(kv)[1]?.rows[2];
  expect(row).toMatchObject({ kind: "range", title: "From \u{2013} to", from: "22:00", to: "07:00" });
  expect(editNotifications(kv, "quiet_from", "23:15")).toBe(true);
  expect(editNotifications(kv, "quiet_to", "6:30")).toBe(true);
  expect(notificationsSections(kv)[1]?.rows[2]).toMatchObject({ from: "23:15", to: "6:30" });
  setNotifications(kv, "quiet", false);
  expect(notificationsSections(kv)[1]?.rows).toHaveLength(2);
});

test("notifications write kv notify with every kind as shown", () => {
  const kv = new MemKv();
  expect(setNotifications(kv, "kind:agent", true)).toBe(true);
  const p = loadPrefs(kv);
  expect(p.kinds).toEqual({ input: true, done: true, agent: true, ci: true, limit: true, pc: true, discord: true });
  expect(setNotifications(kv, "kind:done", false)).toBe(true);
  expect(prefsOn(loadPrefs(kv), "done")).toBe(false);
  expect(prefsOn(loadPrefs(kv), "agent")).toBe(true);
  expect(setNotifications(kv, "away_only", true)).toBe(true);
  expect(loadPrefs(kv).away_only).toBe(true);
  expect(JSON.parse(kv.get("notify") ?? "")).toMatchObject({ away_only: true, quiet: false, quiet_from: "22:00", quiet_to: "07:00" });
});

test("notifications ignore keys that belong to another tab", () => {
  const kv = new MemKv();
  expect(setNotifications(kv, "kind:nothing", true)).toBe(false);
  expect(setNotifications(kv, "fast_mode", true)).toBe(false);
  expect(editNotifications(kv, "follow_up", "x")).toBe(false);
  expect(kv.get("notify")).toBeNull();
});

test("the test button asks the shell to send a test note", () => {
  let sent = 0;
  const env = {
    sendTest: () => {
      sent++;
    },
  };
  expect(notifyPressed("notify_test", env)).toBe(true);
  expect(notifyPressed("quit", env)).toBe(false);
  expect(sent).toBe(1);
});
