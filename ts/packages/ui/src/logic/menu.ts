// Esc closes a menu only until the cursor leaves the word it opened for.
import type { KeyPress } from "./keys.ts";

export const ROW_H = 32;
export const MENU_MAX_H = 288;

export interface MenuState {
  /** The composer whose menu showed last frame. */
  open: number | null;
  sel: number;
  query: string;
  /** The keyboard moved the highlight: scroll it into view. */
  scroll: boolean;
  /** Esc closed the menu for the word starting here. */
  dismissed: { key: number; start: number } | null;
}

export function newMenu(): MenuState {
  return { open: null, sel: 0, query: "", scroll: false, dismissed: null };
}

/** The word composer `key`'s menu is for this frame (null: closed). */
export function menuWord<W extends { start: number; query: string }>(m: MenuState, key: number, w: W | null): W | null {
  if (m.dismissed !== null && m.dismissed.key === key && w?.start !== m.dismissed.start) m.dismissed = null;
  if (w === null || (m.dismissed !== null && m.dismissed.key === key && m.dismissed.start === w.start)) {
    m.open = null;
    return null;
  }
  if (m.open !== key || m.query !== w.query) {
    m.query = w.query;
    m.sel = 0;
  }
  return w;
}

/** After `menuWord`: shows the menu with `rows` rows (or a placeholder row); false closes it. */
export function menuShown(m: MenuState, key: number, rows: number, placeholder = false): boolean {
  if (rows === 0 && !placeholder) {
    m.open = null;
    return false;
  }
  m.sel = Math.min(m.sel, Math.max(rows - 1, 0));
  m.open = key;
  return true;
}

/** Whether the scroll to the highlighted row is due; it happens once. */
export function takeScroll(m: MenuState): boolean {
  const s = m.scroll;
  m.scroll = false;
  return s;
}

/** The pointer moved over row `i`. */
export function menuHover(m: MenuState, i: number): void {
  m.sel = i;
}

/** A row picked: the menu closes. */
export function menuPicked(m: MenuState): void {
  m.open = null;
}

export type MenuKey = "up" | "down" | "accept" | "close";

/** What a press does to an open menu (none: it goes to the text field). Ctrl keeps it out. */
export function menuKeyOf(p: KeyPress): MenuKey | null {
  if (p.ctrl) return null;
  switch (p.key) {
    case "ArrowUp":
    case "Up":
      return "up";
    case "ArrowDown":
    case "Down":
      return "down";
    case "Enter":
    case "Tab":
      return "accept";
    case "Escape":
    case "Esc":
      return "close";
    default:
      return null;
  }
}

/** Before the composer's text field: a press while composer `key`'s menu shows `rows` rows for the word at `start`. */
export function menuKey(m: MenuState, key: number, start: number, rows: number, p: KeyPress): { taken: boolean; pick: number | null } {
  const k = m.open === key && rows > 0 ? menuKeyOf(p) : null;
  if (k === null) return { taken: false, pick: null };
  if (k === "up" || k === "down") {
    m.sel = k === "down" ? (m.sel + 1) % rows : (m.sel + rows - 1) % rows;
    m.scroll = true;
    return { taken: true, pick: null };
  }
  if (k === "close") {
    m.dismissed = { key, start };
    m.open = null;
    return { taken: true, pick: null };
  }
  return { taken: true, pick: Math.min(m.sel, rows - 1) };
}

/** The menu's height at most: above the composer, as tall as the window leaves room for. */
export function menuMaxHeight(composerTop: number, contentTop: number): number {
  return Math.max(Math.min(MENU_MAX_H, composerTop - contentTop - 24), ROW_H * 3);
}
