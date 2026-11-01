import { ACTIONS, GROUPS, label, type Keys, type KvStore } from "./keys.ts";
import { pick } from "./text.ts";

/** One shortcut of slint/settings-keybindings.slint (`KeyRow`). */
export interface KeyRowView {
  id: string;
  label: string;
  when: string;
  caps: string[];
  custom: boolean;
  fixed: boolean;
  capturing: boolean;
  note: string;
  note_kind: "" | "hint" | "refused" | "conflict";
  back_tip: string;
}

export interface KeyGroupView {
  title: string;
  rows: KeyRowView[];
}

export interface KeysView {
  search: string;
  groups: KeyGroupView[];
  /** The action waiting for its keys, "" for none. */
  capture: string;
  empty: string;
  has_custom: boolean;
  footer: string;
}

const FOOTER =
  "Click a shortcut, then press the new keys, e.g. Ctrl+Shift+K (Ctrl, Alt and Shift). Esc alone cancels, Backspace alone goes back to the default. Super combos can't be used: Hyprland takes most of them before Harbor sees them.";

/** widgets.rs `kbd_combo`: "Ctrl+Shift+F" as key caps; a "+" key is a cap of its own. */
export function caps(combo: string): string[] {
  const parts = combo.split("+").filter((s) => s !== "");
  if (combo.endsWith("++") || combo === "+") parts.push("+");
  return parts;
}

/** pages.rs `keybindings_tab`: the shortcuts by group, narrowed by the search, with the capture state. */
export function keysView(keys: Keys): KeysView {
  const q = keys.search.trim().toLowerCase();
  const groups: KeyGroupView[] = [];
  for (const g of GROUPS) {
    const rows: KeyRowView[] = [];
    for (const a of ACTIONS) {
      if (a.group !== g) continue;
      const shown = label(keys.get(a.id));
      if (q !== "" && ![a.label, a.when, a.group, shown].some((s) => s.toLowerCase().includes(q))) continue;
      const capturing = keys.capture === a.id;
      const conflicts = keys.conflicts(a.id);
      let note = "";
      let kind: KeyRowView["note_kind"] = "";
      if (capturing) {
        note = keys.refused !== null ? `${keys.refused} would type instead \u{b7} add Ctrl or Alt` : "Press the new keys \u{b7} Esc cancels \u{b7} Backspace resets";
        kind = keys.refused !== null ? "refused" : "hint";
      } else if (conflicts.length > 0 && !a.fixed) {
        note = `Also bound to ${conflicts.map((c) => `\u{201c}${c.label}\u{201d}`).join(", ")}`;
        kind = "conflict";
      }
      rows.push({ id: a.id, label: a.label, when: a.when, caps: caps(shown), custom: keys.isCustom(a.id), fixed: a.fixed, capturing, note, note_kind: kind, back_tip: `Back to ${label(a.default)}` });
    }
    if (rows.length > 0) groups.push({ title: g, rows });
  }
  return {
    search: keys.search,
    groups,
    capture: keys.capture ?? "",
    empty: groups.length === 0 ? `No shortcut matches \u{201c}${keys.search.trim()}\u{201d}.` : "",
    has_custom: keys.hasCustom(),
    footer: FOOTER,
  };
}

const KEYS_ACTS = ["capture", "cancel", "reset", "reset-all", "search"] as const;

/** A click or an edit on the tab; `arg` is an action id for "capture" and "reset", the text for "search". False for an unknown `what`. */
export function keysAct(keys: Keys, store: KvStore, what: string, arg: string): boolean {
  const act = pick(what, KEYS_ACTS);
  if (act === "capture") {
    keys.capture = arg;
    keys.refused = null;
  } else if (act === "cancel") keys.capture = null;
  else if (act === "reset") keys.reset(store, arg);
  else if (act === "reset-all") {
    keys.resetAll(store);
    keys.capture = null;
  } else if (act === "search") keys.search = arg;
  else return false;
  return true;
}

/** A key pressed while an action waits for its keys; false when none does (the press is not for the tab). */
export function keysKey(keys: Keys, store: KvStore, key: string, ctrl: boolean, shift: boolean, alt: boolean): boolean {
  return keys.captureKey(store, { key, ctrl, shift, alt });
}
