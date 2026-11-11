// Key names are stored as the Rust app stores them (kv `keybindings`), so existing bindings still load.

/** A key press; `ctrl` is Ctrl or Cmd. `key` is a key name ("Enter", "ArrowUp", "a", "?"). */
export interface KeyPress {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** A key press as an input frame lists it: `repeat` when the key is held down. */
export interface KeyEvent extends KeyPress {
  repeat?: boolean;
}

export interface Action {
  id: string;
  label: string;
  group: string;
  /** Default combo, in `parseCombo` form ("Ctrl+Backtick"). */
  default: string;
  /** When it applies, as T3 Code writes it ("!terminalFocus"); "" = always. */
  when: string;
  /** Listed for reference only (clipboard, image viewer, ranges). */
  fixed: boolean;
}

/** The kv store the overrides live in. */
export interface KvStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

const a = (id: string, label: string, group: string, def: string, when: string): Action => ({ id, label, group, default: def, when, fixed: false });
const fixed = (id: string, label: string, group: string, def: string, when: string): Action => ({ id, label, group, default: def, when, fixed: true });

export const GROUPS: readonly string[] = ["Navigation", "Composer", "Thread", "Panels", "Lists", "Editing", "Image viewer"];

export const ACTIONS: readonly Action[] = [
  a("new_thread", "New thread", "Navigation", "Ctrl+N", ""),
  a("palette", "Search everything (command palette)", "Navigation", "Ctrl+K", ""),
  a("settings", "Open settings", "Navigation", "Ctrl+Comma", ""),
  a("shortcuts", "Show the keyboard shortcuts", "Navigation", "Ctrl+Slash", ""),
  fixed("shortcuts_q", "Show the keyboard shortcuts (outside a text field)", "Navigation", "Shift+Questionmark", "!textFocus"),
  a("toggle_sidebar", "Show or hide the sidebar", "Navigation", "Ctrl+B", ""),
  a("chat_prev", "Previous chat in the sidebar", "Navigation", "Alt+Up", ""),
  a("chat_next", "Next chat in the sidebar", "Navigation", "Alt+Down", ""),
  fixed("zoom_in", "Zoom in (also Ctrl+Plus)", "Navigation", "Ctrl+Equals", ""),
  fixed("zoom_out", "Zoom out", "Navigation", "Ctrl+Minus", ""),
  fixed("zoom_reset", "Zoom back to 100%", "Navigation", "Ctrl+0", ""),
  fixed("pick_model", "Pick model 1–9", "Navigation", "Ctrl+1…9", "!terminalFocus && !dialog"),
  a("send", "Send", "Composer", "Enter", "composerFocus"),
  a("send_now", "Send the other way while the agent works (Steer or Queue)", "Composer", "Ctrl+Enter", "composerFocus"),
  a("steer_queued", "Steer with the oldest queued message", "Composer", "Ctrl+Shift+Enter", "composerFocus"),
  a("edit_queued", "Edit the latest queued message (caret at the start)", "Composer", "Alt+ArrowUp", "composerFocus"),
  a("newline", "New line", "Composer", "Shift+Enter", "composerFocus"),
  a("voice", "Dictate (start or stop the mic)", "Composer", "Ctrl+Shift+Space", ""),
  a("stop_turn", "Stop the turn (or take back the last send)", "Thread", "Escape", "chatOpen && !terminalFocus && !popup"),
  fixed("close_drawer", "Close the sidebar or team drawer", "Thread", "Escape", "drawerOpen"),
  a("toggle_terminal", "Open or close the terminal", "Panels", "Ctrl+Backtick", ""),
  a("toggle_team", "Show or hide the team panel (agents, wake-ups, webhooks)", "Panels", "Ctrl+D", "leadChatOpen && !terminalFocus"),
  a("toggle_browser", "Open or close the browser", "Panels", "Ctrl+Shift+B", "!browserFocus"),
  fixed("pane_focus", "Give the split panes the keyboard, in reading order", "Panels", "Ctrl+1…4", "splitPanes && !terminalFocus && !popup"),
  fixed("pane_close", "Close the focused split pane (its chat keeps running)", "Panels", "Ctrl+W", "splitPanes && !terminalFocus"),
  a("list_search", "Search the list", "Lists", "Ctrl+F", "listOpen"),
  a("list_toggle_panel", "Show or hide the side panel", "Lists", "Ctrl+Alt+B", "listOpen"),
  a("list_close_tab", "Close the panel's tab", "Lists", "Ctrl+W", "listPanelOpen"),
  a("pr_copy_link", "Copy the pull request's link", "Lists", "Ctrl+Shift+C", "pullRequestOpen && !terminalFocus"),
  a("pr_copy_number", "Copy the pull request's number", "Lists", "Ctrl+Shift+K", "pullRequestOpen"),
  fixed("list_back", "Leave the page", "Lists", "Escape", "listOpen && !menuOpen"),
  fixed("copy", "Copy (Ctrl+Shift+C in a terminal)", "Editing", "Ctrl+C", ""),
  fixed("cut", "Cut", "Editing", "Ctrl+X", ""),
  fixed("paste", "Paste text, images or files (also Shift+Insert)", "Editing", "Ctrl+V", ""),
  fixed("lightbox_close", "Close", "Image viewer", "Escape", "imageOpen"),
  fixed("lightbox_prev", "Previous image", "Image viewer", "Left", "imageOpen"),
  fixed("lightbox_next", "Next image", "Image viewer", "Right", "imageOpen"),
];

export function action(id: string): Action | undefined {
  return ACTIONS.find((x) => x.id === id);
}

// Key names as the Rust app stores them (egui's), each with the other names it is known by.
const KEY_ALIASES: readonly (readonly [string, ...string[]])[] = [
  ["Down", "ArrowDown", "⏷"],
  ["Left", "ArrowLeft", "⏴"],
  ["Right", "ArrowRight", "⏵"],
  ["Up", "ArrowUp", "⏶"],
  ["Escape", "Esc"],
  ["Tab"],
  ["Backspace"],
  ["Enter", "Return"],
  ["Insert", "Help"],
  ["Delete"],
  ["Home"],
  ["End"],
  ["PageUp"],
  ["PageDown"],
  ["Copy"],
  ["Cut"],
  ["Paste"],
  ["Space", " "],
  ["Colon", ":"],
  ["Comma", ","],
  ["Minus", "-", "Subtract", "NumpadSubtract"],
  ["Period", ".", "NumpadDecimal"],
  ["Plus", "+", "Add", "NumpadAdd"],
  ["Equals", "=", "Equal", "NumpadEqual"],
  ["Semicolon", ";"],
  ["Backslash", "\\"],
  ["Slash", "/", "NumpadDivide"],
  ["Pipe", "|"],
  ["Questionmark", "?"],
  ["Exclamationmark", "!"],
  ["OpenBracket", "["],
  ["CloseBracket", "]"],
  ["OpenCurlyBracket", "{"],
  ["CloseCurlyBracket", "}"],
  ["Backtick", "`", "Backquote", "Grave"],
  ["Quote", "'"],
  ["BrowserBack"],
];

const KEYS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [name, ...aliases] of KEY_ALIASES) {
    m.set(name, name);
    for (const x of aliases) m.set(x, name);
  }
  for (let d = 0; d <= 9; d++) for (const x of [`${d}`, `Digit${d}`, `Numpad${d}`]) m.set(x, `${d}`);
  for (let c = 65; c <= 90; c++) {
    const up = String.fromCharCode(c);
    m.set(up, up);
    m.set(up.toLowerCase(), up);
  }
  for (let f = 1; f <= 35; f++) m.set(`F${f}`, `F${f}`);
  return m;
})();

/** A key's stored name for any name it goes by ("ArrowUp" → "Up", "a" → "A"); undefined if unknown. */
export function keyFromName(name: string): string | undefined {
  return KEYS.get(name);
}

/** A key with exact modifiers (Ctrl is Cmd on macOS); `key` is its stored name. */
export interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** A combo from its stored form ("Ctrl+Shift+Backtick"); undefined for anything else. */
export function parseCombo(s: string): Combo | undefined {
  const cut = s.lastIndexOf("+");
  const mods = cut < 0 ? "" : s.slice(0, cut);
  const c: Combo = { ctrl: false, shift: false, alt: false, key: "Escape" };
  for (const m of mods.split("+").filter((x) => x !== "")) {
    if (m === "Ctrl" || m === "Cmd") c.ctrl = true;
    else if (m === "Shift") c.shift = true;
    else if (m === "Alt") c.alt = true;
    else return undefined;
  }
  const key = keyFromName(cut < 0 ? s : s.slice(cut + 1));
  if (key === undefined) return undefined;
  c.key = key;
  return c;
}

/** The combo a key press is; undefined for keys without a name (a modifier alone). */
export function comboOf(p: KeyPress): Combo | undefined {
  const key = keyFromName(p.key);
  return key === undefined ? undefined : { ctrl: p.ctrl, shift: p.shift, alt: p.alt, key };
}

export function sameCombo(x: Combo | undefined, y: Combo | undefined): boolean {
  return x !== undefined && y !== undefined && x.ctrl === y.ctrl && x.shift === y.shift && x.alt === y.alt && x.key === y.key;
}

function mods(c: Combo): string {
  return (c.ctrl ? "Ctrl+" : "") + (c.shift ? "Shift+" : "") + (c.alt ? "Alt+" : "");
}

/** Stored form: modifiers and the key's name ("Ctrl+Backtick"). */
export function comboName(c: Combo): string {
  return mods(c) + c.key;
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Backtick: "`",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Questionmark: "?",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equals: "=",
  OpenBracket: "[",
  CloseBracket: "]",
  Plus: "Plus",
};

/** Shown form, key caps split on '+' ("Ctrl+`"). */
export function comboLabel(c: Combo): string {
  // "?" is Shift plus a key on most layouts: shown as the one character it types.
  if (c.key === "Questionmark" && c.shift && !c.ctrl && !c.alt) return "?";
  return mods(c) + (KEY_LABELS[c.key] ?? c.key);
}

/** Shown form of a stored combo string; ranges like "Ctrl+1…9" pass through. */
export function label(s: string): string {
  const c = parseCombo(s);
  return c === undefined ? s : comboLabel(c);
}

const CHAR_KEYS: ReadonlySet<string> = new Set([
  "Space", "Backtick", "Backslash", "Comma", "Period", "Slash", "Semicolon", "Quote", "Minus", "Equals", "OpenBracket", "CloseBracket",
  "Plus", "Colon", "Pipe", "Questionmark", "Exclamationmark", "OpenCurlyBracket", "CloseCurlyBracket",
]);

/** Keys that type a character: bound without Ctrl or Alt they'd steal typing. */
export function isChar(key: string): boolean {
  return key.length === 1 || key.startsWith("Num") || CHAR_KEYS.has(key);
}

const ESC_ACTIONS: readonly string[] = ["stop_turn", "close_drawer", "lightbox_close", "list_back"];

// Alt+Up edits the latest queued message when there is one and the caret is at the composer's start, else moves up a chat.
const SHARED: readonly (readonly [string, string])[] = [["edit_queued", "chat_prev"]];

// Esc stops a turn, closes a drawer or the image viewer, or leaves a list page: Harbor picks by context.
function sameOnPurpose(x: string, y: string): boolean {
  if (SHARED.some(([a, b]) => (a === x && b === y) || (a === y && b === x))) return true;
  return x !== y && ESC_ACTIONS.includes(x) && ESC_ACTIONS.includes(y);
}

/** The user's bindings over the defaults, and Settings → Keybindings' capture state. */
export class Keys {
  private over: Map<string, string>;
  /** The action waiting for its new keys (Settings → Keybindings). */
  capture: string | null = null;
  /** The last keys refused while capturing (a plain character), to explain why. */
  refused: string | null = null;
  search = "";

  constructor(over: ReadonlyMap<string, string> = new Map()) {
    this.over = new Map(over);
  }

  static load(store: KvStore): Keys {
    const over = new Map<string, string>();
    const raw = store.get("keybindings");
    if (raw) {
      try {
        const v: unknown = JSON.parse(raw);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          const entries = Object.entries(v);
          if (entries.every(([, x]) => typeof x === "string")) for (const [k, x] of entries) over.set(k, String(x));
        }
      } catch {
        // Unreadable: the defaults.
      }
    }
    return new Keys(over);
  }

  private save(store: KvStore): void {
    const sorted = [...this.over.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    store.set("keybindings", JSON.stringify(Object.fromEntries(sorted)));
  }

  /** The action's combo as stored: the user's, else the default. */
  get(id: string): string {
    return this.over.get(id) ?? action(id)?.default ?? "";
  }

  combo(id: string): Combo | undefined {
    return parseCombo(this.get(id));
  }

  isCustom(id: string): boolean {
    return this.over.has(id);
  }

  hasCustom(): boolean {
    return this.over.size > 0;
  }

  set(store: KvStore, id: string, c: Combo): void {
    const def = action(id);
    if (def !== undefined && sameCombo(parseCombo(def.default), c)) this.over.delete(id);
    else this.over.set(id, comboName(c));
    this.save(store);
  }

  reset(store: KvStore, id: string): void {
    this.over.delete(id);
    this.save(store);
  }

  resetAll(store: KvStore): void {
    this.over.clear();
    this.save(store);
  }

  /** Other actions on the same keys as `id`. */
  conflicts(id: string): Action[] {
    const c = this.combo(id);
    if (c === undefined) return [];
    const digit = c.ctrl && !c.shift && !c.alt && /^[1-9]$/.test(c.key);
    return ACTIONS.filter((x) => x.id !== id && (sameCombo(this.combo(x.id), c) || (digit && x.id === "pick_model"))).filter((x) => !sameOnPurpose(id, x.id));
  }

  /** Whether the press is the action's keys. */
  matches(id: string, p: KeyPress): boolean {
    return sameCombo(this.combo(id), comboOf(p));
  }

  /** Consumes the presses of the action's keys from `events`; true if there was one. */
  take(events: KeyPress[], id: string): boolean {
    let hit = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e !== undefined && this.matches(id, e)) {
        events.splice(i, 1);
        hit = true;
      }
    }
    return hit;
  }

  /** Whether the action's keys went down (not a repeat), leaving the events for others. */
  pressed(events: readonly KeyEvent[], id: string): boolean {
    return events.some((e) => !e.repeat && this.matches(id, e));
  }

  /** While capturing, the first key press with its modifiers (Ctrl+Shift+K) becomes the binding. */
  captureKey(store: KvStore, p: KeyPress): boolean {
    const id = this.capture;
    if (id === null) return false;
    const c = comboOf(p);
    if (c === undefined) return true;
    const bare = !c.ctrl && !c.shift && !c.alt;
    const typed = !c.ctrl && !c.alt && isChar(c.key);
    if (typed) {
      this.refused = comboLabel(c);
      return true;
    }
    this.refused = null;
    if (bare && c.key === "Backspace") this.reset(store, id);
    else if (!(bare && c.key === "Escape")) this.set(store, id, c);
    this.capture = null;
    return true;
  }
}
