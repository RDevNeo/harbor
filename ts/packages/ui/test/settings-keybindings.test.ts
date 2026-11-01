import { expect, test } from "bun:test";
import { ACTIONS, GROUPS, Keys } from "../src/logic/keys.ts";
import { caps, keysAct, keysKey, keysView } from "../src/logic/settings-keybindings.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const row = (keys: Keys, id: string) => keysView(keys).groups.flatMap((g) => g.rows).find((r) => r.id === id);

test("keybindings list every action under its group, with its default keys", () => {
  const v = keysView(new Keys());
  expect(v.groups.map((g) => g.title)).toEqual([...GROUPS]);
  expect(v.groups.reduce((n, g) => n + g.rows.length, 0)).toBe(ACTIONS.length);
  expect(row(new Keys(), "new_thread")).toMatchObject({ label: "New thread", when: "", caps: ["Ctrl", "N"], custom: false, fixed: false, capturing: false, note: "", back_tip: "Back to Ctrl+N" });
  expect(row(new Keys(), "send")?.when).toBe("composerFocus");
  expect(row(new Keys(), "shortcuts_q")).toMatchObject({ caps: ["?"], fixed: true });
  expect(row(new Keys(), "palette")?.caps).toEqual(["Ctrl", "K"]);
  expect(v.footer.startsWith("Click a shortcut, then press the new keys")).toBe(true);
  expect([v.has_custom, v.empty, v.capture]).toEqual([false, "", ""]);
});

test("keybindings search matches the label, the condition, the group and the keys, in any case", () => {
  const k = new Keys();
  k.search = "  COMPOSERFOCUS ";
  expect(keysView(k).groups.map((g) => g.title)).toEqual(["Composer"]);
  k.search = "image viewer";
  expect(keysView(k).groups.map((g) => g.title)).toEqual(["Image viewer"]);
  k.search = "ctrl+shift+k";
  expect(keysView(k).groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["pr_copy_number"]);
  k.search = "zzz ";
  const v = keysView(k);
  expect(v.groups).toEqual([]);
  expect(v.empty).toBe("No shortcut matches \u{201c}zzz\u{201d}.");
});

test("keybindings warn when keys are bound twice, except for fixed actions", () => {
  const kv = new Kv();
  const k = new Keys();
  k.set(kv, "new_thread", { ctrl: true, shift: false, alt: false, key: "B" });
  expect(row(k, "new_thread")).toMatchObject({ custom: true, caps: ["Ctrl", "B"], note_kind: "conflict", note: "Also bound to \u{201c}Show or hide the sidebar\u{201d}" });
  expect(row(k, "toggle_sidebar")?.note).toBe("Also bound to \u{201c}New thread\u{201d}");
  expect(row(k, "close_drawer")?.note).toBe("");
  expect(keysView(k).has_custom).toBe(true);
  expect(JSON.parse(kv.get("keybindings") ?? "")).toEqual({ new_thread: "Ctrl+B" });
});

test("keybindings capture: a click waits for keys, a plain character is refused, Ctrl+Shift+K is taken", () => {
  const kv = new Kv();
  const k = new Keys();
  expect(keysAct(k, kv, "capture", "pr_copy_link")).toBe(true);
  expect(keysView(k).capture).toBe("pr_copy_link");
  expect(row(k, "pr_copy_link")).toMatchObject({ capturing: true, note_kind: "hint", note: "Press the new keys \u{b7} Esc cancels \u{b7} Backspace resets" });
  expect(keysKey(k, kv, "A", false, false, false)).toBe(true);
  expect(row(k, "pr_copy_link")).toMatchObject({ capturing: true, note_kind: "refused", note: "A would type instead \u{b7} add Ctrl or Alt" });
  expect(keysKey(k, kv, "K", true, true, false)).toBe(true);
  expect(keysView(k).capture).toBe("");
  expect(row(k, "pr_copy_link")).toMatchObject({ custom: true, caps: ["Ctrl", "Shift", "K"] });
  expect(kv.get("keybindings")).toBe('{"pr_copy_link":"Ctrl+Shift+K"}');
});

test("keybindings capture: Esc cancels, Backspace goes back to the default, a modifier alone waits on", () => {
  const kv = new Kv();
  const k = new Keys();
  keysAct(k, kv, "capture", "new_thread");
  expect(keysKey(k, kv, "\u{12}", true, false, false)).toBe(true);
  expect(keysView(k).capture).toBe("new_thread");
  keysKey(k, kv, "Escape", false, false, false);
  expect(keysView(k).capture).toBe("");
  expect(k.hasCustom()).toBe(false);
  k.set(kv, "new_thread", { ctrl: true, shift: false, alt: true, key: "N" });
  keysAct(k, kv, "capture", "new_thread");
  keysKey(k, kv, "Backspace", false, false, false);
  expect(row(k, "new_thread")).toMatchObject({ custom: false, caps: ["Ctrl", "N"], capturing: false });
  expect(keysKey(k, kv, "A", true, false, false)).toBe(false);
});

test("keybindings reset one action or all, and a cancel or a reset all ends a capture", () => {
  const kv = new Kv();
  const k = new Keys();
  k.set(kv, "new_thread", { ctrl: true, shift: false, alt: false, key: "J" });
  k.set(kv, "palette", { ctrl: true, shift: false, alt: false, key: "P" });
  keysAct(k, kv, "reset", "palette");
  expect(row(k, "palette")?.custom).toBe(false);
  expect(row(k, "new_thread")?.custom).toBe(true);
  keysAct(k, kv, "capture", "send");
  keysAct(k, kv, "cancel", "send");
  expect(keysView(k).capture).toBe("");
  keysAct(k, kv, "capture", "send");
  keysAct(k, kv, "reset-all", "");
  expect([keysView(k).capture, keysView(k).has_custom]).toEqual(["", false]);
  expect(kv.get("keybindings")).toBe("{}");
  expect(keysAct(k, kv, "other", "")).toBe(false);
  expect(keysAct(k, kv, "search", "send")).toBe(true);
  expect(keysView(k).search).toBe("send");
});

test("key caps split a combo on +, a + key staying a cap", () => {
  expect(caps("Ctrl+Shift+F")).toEqual(["Ctrl", "Shift", "F"]);
  expect(caps("Ctrl++")).toEqual(["Ctrl", "+"]);
  expect(caps("+")).toEqual(["+"]);
  expect(caps("Ctrl+1\u{2026}9")).toEqual(["Ctrl", "1\u{2026}9"]);
});
