import { expect, test } from "bun:test";
import { loadPrefs, MemKv, prefsOn } from "@harbor/net";
import { notificationsSections, setNotifications } from "../src/logic/settings-notifications.ts";

test("Notifications only lists event kinds, with sub-agent notifications off by default", () => {
  const sections = notificationsSections(new MemKv());
  expect(sections.map((s) => s.title)).toEqual(["Notify me when"]);
  expect(sections[0]?.rows).toHaveLength(7);
  expect(sections[0]?.rows.find((r) => r.key === "kind:agent")?.on).toBe(false);
});

test("event toggles remain configurable while old quiet and away settings use defaults", () => {
  const kv = new MemKv();
  kv.set("notify", JSON.stringify({ quiet: true, away_only: true, kinds: { done: false } }));
  expect(loadPrefs(kv)).toMatchObject({ quiet: false, away_only: false });
  expect(prefsOn(loadPrefs(kv), "done")).toBe(false);
  expect(setNotifications(kv, "kind:agent", true)).toBe(true);
  expect(prefsOn(loadPrefs(kv), "agent")).toBe(true);
  expect(setNotifications(kv, "kind:missing", true)).toBe(false);
  expect(setNotifications(kv, "quiet", true)).toBe(false);
});
