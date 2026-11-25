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

test("alt_up_down_move_between_chats_and_share_alt_up_with_edit_queued", () => {
  const keys = new Keys();
  expect(keys.matches("chat_prev", { key: "ArrowUp", ctrl: false, shift: false, alt: true })).toBe(true);
  expect(keys.matches("chat_next", { key: "ArrowDown", ctrl: false, shift: false, alt: true })).toBe(true);
  expect(keys.matches("chat_next", { key: "ArrowDown", ctrl: false, shift: false, alt: false })).toBe(false);
  expect(label(keys.get("chat_prev"))).toBe("Alt+Up");
  // Alt+Up edits a queued message only when there is one: on purpose, not a conflict.
  expect(keys.conflicts("chat_prev")).toEqual([]);
  expect(keys.conflicts("chat_next")).toEqual([]);
  expect(keys.conflicts("edit_queued")).toEqual([]);
});

test("ctrl_alt_types_a_layouts_altgr_character_but_stays_a_shortcut_otherwise", async () => {
  const { ctrlAltTyped } = await import("../src/logic/keys.ts");
  const ca = { control: true, alt: true, shift: false, meta: false };
  // ABNT2: Ctrl+Alt+Q is "/", Ctrl+Alt+W is "?"; other AltGr symbols too.
  for (const t of ["/", "?", "°", "@", "€", "\\", "|", "[", "ª", "º", "¹", "²", "£", "¬"]) expect(ctrlAltTyped(t, ca)).toBe(true);
  // Ctrl+Alt+letter or digit stays a shortcut (Ctrl+Alt+B), and so do Slint's special keys and control characters.
  for (const t of ["b", "B", "q", "1", "ç", " ", "", "\n", "\t", "\u{1b}", "\u{f700}", "\u{11}", "ab"]) expect(ctrlAltTyped(t, ca)).toBe(false);
  // Only with both Ctrl and Alt held, and no Super.
  expect(ctrlAltTyped("/", { control: true, alt: false })).toBe(false);
  expect(ctrlAltTyped("/", { control: false, alt: true })).toBe(false);
  expect(ctrlAltTyped("/", { ...ca, meta: true })).toBe(false);
});
