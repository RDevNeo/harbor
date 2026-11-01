import { expect, test } from "bun:test";
import { ACTIONS, GROUPS, Keys, comboName, isChar, label, parseCombo } from "../src/logic/keys.ts";

test("combos_round_trip_and_defaults_parse", () => {
  for (const s of ["Ctrl+N", "Ctrl+Shift+Backtick", "Shift+Enter", "Alt+F4", "Escape"]) {
    const c = parseCombo(s);
    expect(c === undefined ? undefined : comboName(c)).toBe(s);
  }
  expect(label("Ctrl+Backslash")).toBe("Ctrl+\\");
  expect(ACTIONS.filter((a) => !a.fixed).every((a) => parseCombo(a.default) !== undefined)).toBe(true);
  expect(ACTIONS.every((a) => GROUPS.includes(a.group))).toBe(true);
  const keys = new Keys();
  expect(keys.conflicts("new_thread")).toEqual([]);
  expect(keys.conflicts("stop_turn")).toEqual([]);
  expect(isChar("K") && isChar("5") && isChar("Space") && !isChar("F5") && !isChar("Enter") && !isChar("Escape")).toBe(true);
});
