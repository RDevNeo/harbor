// Key combinations as computer-use agents write them (xdotool's names: "Return", "ctrl+s", "alt+Tab", "super"),
// parsed once into canonical names and mapped to each system's codes. Pure code.

export type Mod = "ctrl" | "shift" | "alt" | "super";

/** One chord: modifiers held while `key` is pressed ("" for modifiers alone, like "super"). */
export interface Combo {
  mods: Mod[];
  key: string;
}

const MODS: Record<string, Mod> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctrl_l: "ctrl",
  ctrl_r: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  option: "alt",
  opt: "alt",
  meta: "super",
  super: "super",
  super_l: "super",
  super_r: "super",
  win: "super",
  windows: "super",
  cmd: "super",
  command: "super",
  logo: "super",
};

/** Other names for a key, to its canonical name. */
const ALIASES: Record<string, string> = {
  enter: "return",
  kp_enter: "return",
  esc: "escape",
  back_space: "backspace",
  del: "delete",
  ins: "insert",
  prior: "page_up",
  pageup: "page_up",
  pgup: "page_up",
  next: "page_down",
  pagedown: "page_down",
  pgdn: "page_down",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  spacebar: "space",
  " ": "space",
  capslock: "caps_lock",
  printscreen: "print",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
  "\n": "return",
  "\t": "tab",
};

/** Keys whose canonical name needs shift on a US layout, with the key it is shifted from. */
const SHIFTED: Record<string, string> = {
  plus: "equal",
  "+": "equal",
  underscore: "minus",
  _: "minus",
  question: "slash",
  "?": "slash",
  colon: "semicolon",
  ":": "semicolon",
  quotedbl: "apostrophe",
  '"': "apostrophe",
  less: "comma",
  "<": "comma",
  greater: "period",
  ">": "period",
  braceleft: "bracketleft",
  "{": "bracketleft",
  braceright: "bracketright",
  "}": "bracketright",
  bar: "backslash",
  "|": "backslash",
  asciitilde: "grave",
  "~": "grave",
  exclam: "1",
  "!": "1",
  at: "2",
  "@": "2",
  numbersign: "3",
  "#": "3",
  dollar: "4",
  $: "4",
  percent: "5",
  "%": "5",
  asciicircum: "6",
  "^": "6",
  ampersand: "7",
  "&": "7",
  asterisk: "8",
  "*": "8",
  parenleft: "9",
  "(": "9",
  parenright: "0",
  ")": "0",
};

const NAMED = [
  "return", "tab", "escape", "backspace", "delete", "insert", "home", "end", "page_up", "page_down",
  "up", "down", "left", "right", "space", "caps_lock", "print", "menu",
  "minus", "equal", "comma", "period", "slash", "backslash", "semicolon", "apostrophe", "grave", "bracketleft", "bracketright",
];

/** Whether `k` is a canonical key name. */
export function known(k: string): boolean {
  return NAMED.includes(k) || /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k);
}

/** One chord ("ctrl+shift+t", "Return", "super", "ctrl++"); throws on a name it doesn't know. */
export function parseCombo(text: string): Combo {
  const t = text.trim();
  if (t === "") throw new Error("no key given");
  // "ctrl++" and "+" name the plus key.
  const parts = t === "+" ? ["+"] : t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t.split("+");
  const mods: Mod[] = [];
  let key = "";
  for (const raw of parts) {
    if (raw === "") throw new Error(`can't read the key combination '${text}'`);
    const lower = raw.length === 1 ? raw : raw.toLowerCase();
    const mod = MODS[lower.toLowerCase()];
    if (mod !== undefined) {
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    if (key !== "") throw new Error(`'${text}' presses two keys at once; one key with modifiers only (send several with spaces between)`);
    let k = lower;
    // An upper-case letter: shift and the letter, as xdotool reads it.
    if (/^[A-Z]$/.test(k)) {
      if (!mods.includes("shift")) mods.push("shift");
      k = k.toLowerCase();
    }
    const shifted = SHIFTED[k] ?? SHIFTED[k.toLowerCase()];
    if (shifted !== undefined) {
      if (!mods.includes("shift")) mods.push("shift");
      k = shifted;
    }
    k = ALIASES[k] ?? ALIASES[k.toLowerCase()] ?? k.toLowerCase();
    if (!known(k)) throw new Error(`unknown key '${raw}' (xdotool names: Return, Tab, Escape, BackSpace, Delete, Home, End, Page_Up, Page_Down, Up, Down, Left, Right, space, F1-F24, letters, digits, punctuation; modifiers ctrl, shift, alt, super)`);
    key = k;
  }
  return { mods, key };
}

/** Several chords pressed one after another, separated by spaces ("ctrl+a Delete"). */
export function parseKeys(text: string): Combo[] {
  const list = text.trim().split(/\s+/).filter((s) => s !== "");
  if (list.length === 0) throw new Error("no key given");
  return list.map(parseCombo);
}

// --- Windows: virtual-key codes; `ext` marks the keys that need KEYEVENTF_EXTENDEDKEY ---

const WIN_NAMED: Record<string, [number, boolean]> = {
  return: [0x0d, false],
  tab: [0x09, false],
  escape: [0x1b, false],
  backspace: [0x08, false],
  delete: [0x2e, true],
  insert: [0x2d, true],
  home: [0x24, true],
  end: [0x23, true],
  page_up: [0x21, true],
  page_down: [0x22, true],
  left: [0x25, true],
  up: [0x26, true],
  right: [0x27, true],
  down: [0x28, true],
  space: [0x20, false],
  caps_lock: [0x14, false],
  print: [0x2c, true],
  menu: [0x5d, true],
  minus: [0xbd, false],
  equal: [0xbb, false],
  comma: [0xbc, false],
  period: [0xbe, false],
  slash: [0xbf, false],
  backslash: [0xdc, false],
  semicolon: [0xba, false],
  apostrophe: [0xde, false],
  grave: [0xc0, false],
  bracketleft: [0xdb, false],
  bracketright: [0xdd, false],
  ctrl: [0x11, false],
  shift: [0x10, false],
  alt: [0x12, false],
  super: [0x5b, true],
};

export function winVk(k: string): [vk: number, extended: boolean] {
  const n = WIN_NAMED[k];
  if (n) return n;
  if (/^[a-z]$/.test(k)) return [k.toUpperCase().charCodeAt(0), false];
  if (/^[0-9]$/.test(k)) return [k.charCodeAt(0), false];
  const f = /^f(\d+)$/.exec(k);
  if (f) return [0x70 + Number(f[1]) - 1, false];
  throw new Error(`no Windows key for '${k}'`);
}

// --- macOS: virtual key codes of an ANSI keyboard ---

const MAC: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, equal: 24, "9": 25, "7": 26, minus: 27, "8": 28, "0": 29,
  bracketright: 30, o: 31, u: 32, bracketleft: 33, i: 34, p: 35, return: 36, l: 37, j: 38, apostrophe: 39, k: 40,
  semicolon: 41, backslash: 42, comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, space: 49, grave: 50,
  backspace: 51, escape: 53, super: 55, shift: 56, caps_lock: 57, alt: 58, ctrl: 59,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  insert: 114, home: 115, page_up: 116, delete: 117, end: 119, page_down: 121, left: 123, right: 124, down: 125, up: 126,
};

export function macKeycode(k: string): number {
  const c = MAC[k];
  if (c === undefined) throw new Error(`no macOS key for '${k}'`);
  return c;
}

/** CGEventFlags of the modifiers. */
export function macFlags(mods: readonly Mod[]): number {
  const bits: Record<Mod, number> = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, super: 0x100000 };
  return mods.reduce((f, m) => f | bits[m], 0);
}

// --- Linux: evdev key codes (ydotool) and X keysym names (xdotool, wtype) ---

const EVDEV: Record<string, number> = {
  escape: 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11, minus: 12, equal: 13,
  backspace: 14, tab: 15, q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, bracketleft: 26,
  bracketright: 27, return: 28, ctrl: 29, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, semicolon: 39,
  apostrophe: 40, grave: 41, shift: 42, backslash: 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, comma: 51,
  period: 52, slash: 53, alt: 56, space: 57, caps_lock: 58, f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65,
  f8: 66, f9: 67, f10: 68, f11: 87, f12: 88, print: 99, home: 102, up: 103, page_up: 104, left: 105, right: 106,
  end: 107, down: 108, page_down: 109, insert: 110, delete: 111, super: 125, menu: 127,
};

export function evdevCode(k: string): number {
  const c = EVDEV[k];
  if (c !== undefined) return c;
  const f = /^f(\d+)$/.exec(k);
  if (f && Number(f[1]) >= 13) return 183 + Number(f[1]) - 13;
  throw new Error(`no Linux key code for '${k}'`);
}

const KEYSYM: Record<string, string> = {
  return: "Return", tab: "Tab", escape: "Escape", backspace: "BackSpace", delete: "Delete", insert: "Insert",
  home: "Home", end: "End", page_up: "Prior", page_down: "Next", up: "Up", down: "Down", left: "Left", right: "Right",
  space: "space", caps_lock: "Caps_Lock", print: "Print", menu: "Menu",
  ctrl: "Control_L", shift: "Shift_L", alt: "Alt_L", super: "Super_L",
};

/** The X keysym name of a key (xdotool's and wtype's -k). */
export function keysym(k: string): string {
  const n = KEYSYM[k];
  if (n !== undefined) return n;
  if (/^f\d+$/.test(k)) return k.toUpperCase();
  return k;
}

/** xdotool's spelling of a chord ("ctrl+shift+t"). */
export function xdotoolCombo(c: Combo): string {
  return [...c.mods, ...(c.key === "" ? [] : [keysym(c.key)])].join("+");
}

/** wtype's modifier names. */
export function wtypeMod(m: Mod): string {
  return m === "super" ? "logo" : m;
}
