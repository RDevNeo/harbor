import { token } from "../theme.ts";

/**
 * Pasted text as the shell may see it: no ESC or other control characters but tab
 * and line breaks (as xterm does), so a hidden `ESC[201~` can't end a bracketed paste early.
 */
export function pasteText(s: string): string {
  return s.replace(/[\p{Cc}]/gu, (c) => (c === "\t" || c === "\n" || c === "\r" ? c : ""));
}

/** ANSI 16 from the rengaf scales, so terminal output matches the app. */
export function ansiPalette(dark: boolean): string[] {
  const [magenta, cyan] = dark ? ["#c084fc", "#4fd1e0"] : ["#8b3fd6", "#0e7f90"];
  const t = (n: string) => token(n, dark);
  return [
    t("gray-500"), t("red-900"), t("green-900"), t("amber-900"), t("blue-900"), magenta, cyan, t("gray-1000"),
    t("gray-700"), t("red-700"), t("green-700"), t("amber-700"), t("blue-700"), magenta, cyan, t("gray-1000"),
  ];
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
export const rgb = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** A 256-colour index: the ANSI 16, the 6×6×6 cube, then the grey ramp. */
export function idxColor(i: number, ansi: readonly string[]): string {
  if (i < 16) return ansi[i] ?? ansi[7] ?? "#ffffff";
  if (i < 232) {
    const j = i - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return rgb(v(Math.floor(j / 36)), v(Math.floor(j / 6) % 6), v(j % 6));
  }
  const g = 8 + (i - 232) * 10;
  return rgb(g, g, g);
}

/** Keys the view names; anything else arrives as the text it typed. */
export type TermKey = "enter" | "backspace" | "tab" | "backtab" | "esc" | "up" | "down" | "right" | "left" | "home" | "end" | "pageup" | "pagedown" | "delete" | "insert";

export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** The bytes a key sends to the shell (terminal.rs `handle_input`); empty: nothing. */
export function keyBytes(key: TermKey | { text: string }, m: Mods, appCursor: boolean): string {
  const arrow = (c: string) => (appCursor ? `\x1bO${c}` : `\x1b[${c}`);
  if (typeof key === "object") {
    const t = key.text;
    if (!m.ctrl) return t;
    if (m.shift) return "";
    if (/^[a-zA-Z]$/.test(t)) return String.fromCharCode(t.toUpperCase().charCodeAt(0) - 64);
    return t === "[" ? "\x1b" : t === "\\" ? "\x1c" : t === "]" ? "\x1d" : "";
  }
  switch (key) {
    case "enter":
      return "\r";
    case "backspace":
      return m.alt ? "\x1b\x7f" : "\x7f";
    case "tab":
      return m.shift ? "\x1b[Z" : "\t";
    case "backtab":
      return "\x1b[Z";
    case "esc":
      return "\x1b";
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
    case "home":
      return arrow("H");
    case "end":
      return arrow("F");
    case "pageup":
      return "\x1b[5~";
    case "pagedown":
      return "\x1b[6~";
    case "delete":
      return "\x1b[3~";
    case "insert":
      return "\x1b[2~";
  }
}

/** A paste as sent: wrapped in the bracketed-paste markers when the program asked for them. */
export function pasteBytes(s: string, bracketed: boolean): string {
  const t = pasteText(s);
  return bracketed ? `\x1b[200~${t}\x1b[201~` : t;
}

/** `c` at `alpha` over `over`, as one opaque colour (egui's `gamma_multiply` drawn on the cell). */
export function fade(c: string, alpha: number, over: string): string {
  const ch = (h: string, i: number) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(ch(c, i) * alpha + ch(over, i) * (1 - alpha));
  return rgb(mix(0), mix(1), mix(2));
}

/** Rows and columns that fit in a `w`×`h` area with cells of `cw`×`rh` (4 px side and 2 px top margins). */
export function gridSize(w: number, h: number, cw: number, rh: number): [number, number] {
  return [Math.max(2, Math.floor((h - 4) / rh)), Math.max(4, Math.floor((w - 8) / cw))];
}
