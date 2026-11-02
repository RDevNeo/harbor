import { expect, test } from "bun:test";
import { EscHold, seenText, usageRows } from "../src/logic/usagepop.ts";

const at = 1_000_000;

test("the usage popover: an account's name, plan and age, then a line and a bar per window", () => {
  const rows = usageRows(
    [
      { id: "claude", label: "Claude · FS", plan: "Max 20x", signedIn: true, seen: at - 180, windows: [{ key: "5h", label: "5-hour", used: 0.12, resetsAt: at + 3600 }, { key: "week:opus", label: "Weekly · Opus", used: null, resetsAt: null }] },
      { id: "claude2", label: "Claude · IG", plan: "", signedIn: true, seen: null, windows: [] },
      { id: "claude3", label: "Claude · C3", plan: "", signedIn: false, seen: null, windows: [{ key: "5h", label: "5-hour", used: 0.5, resetsAt: null }] },
    ],
    at,
  );
  expect(rows.map((r) => [r.kind, r.label, r.desc, r.badge, r.value])).toEqual([
    ["label", "Claude usage", "", "", 0],
    ["usage-account", "Claude · FS", "3m ago", "Max 20x", 0],
    ["usage-window", "5-hour", "12%  ·  resets in 1h 0m", "", 0.12],
    ["usage-window", "Weekly · Opus", "no data since the reset", "", 0],
    ["separator", "", "", "", 0],
    ["usage-account", "Claude · IG", "", "", 0],
    ["usage-note", "No usage data yet.", "", "", 0],
    ["separator", "", "", "", 0],
    ["usage-account", "Claude · C3", "", "", 0],
    ["usage-note", "Signed out on this PC.", "", "", 0],
  ]);
  expect(usageRows([], at).map((r) => r.label)).toEqual(["Claude usage", "No Claude account on this PC."]);
  expect([seenText(at - 5, at), seenText(at - 2 * 3600, at)]).toEqual(["just now", "2h ago"]);
});

test("a held Esc that closed a popover reaches nothing behind it", () => {
  const esc = new EscHold();
  expect(esc.swallow(false)).toBe(false);
  esc.closed();
  expect(esc.swallow(true)).toBe(true);
  expect(esc.swallow(true)).toBe(true);
  // Released and pressed again: a new press, for whatever is behind.
  expect(esc.swallow(false)).toBe(false);
  expect(esc.swallow(true)).toBe(false);
});
