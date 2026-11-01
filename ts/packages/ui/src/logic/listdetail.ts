/** A value computed again only when its key changes; keys compare with `Object.is` part by part, so a replaced list counts as changed. */
export class Memo<V> {
  private key: readonly unknown[] | null = null;
  private val: V | null = null;

  get(key: readonly unknown[], make: () => V): V {
    const same = this.key !== null && this.key.length === key.length && this.key.every((k, i) => Object.is(k, key[i]));
    if (!same || this.val === null) {
      this.val = make();
      this.key = [...key];
    }
    return this.val;
  }
}

/** Below this, list and panel can't share the page: the panel covers the list. */
export const MIN_SIDE = 340;

export type TabAct =
  | { kind: "activate"; i: number }
  | { kind: "close"; i: number }
  | { kind: "close_others"; i: number }
  | { kind: "close_right"; i: number }
  | { kind: "close_all" }
  | { kind: "toggle" }
  | { kind: "maximize" };

/** The list and the detail panel's tabs (a PR's URL, an issue's URL…) beside it (listdetail.rs `Split`). */
export class Split {
  tabs: string[] = [];
  active = 0;
  /** The panel is showing (it can be hidden with tabs still open). */
  open = false;
  /** The panel covers the list. */
  max = false;
  /** The panel's share of the page width. */
  frac = 0.5;

  /** Opens `key` in the panel: switches to its tab, or adds one. */
  select(key: string): void {
    const i = this.tabs.indexOf(key);
    if (i >= 0) this.active = i;
    else {
      this.tabs.push(key);
      this.active = this.tabs.length - 1;
    }
    this.open = true;
  }

  current(): string | null {
    return this.open ? (this.tabs[this.active] ?? null) : null;
  }

  showing(): boolean {
    return this.current() !== null;
  }

  /** Closes tab `i`; the one after it (or before, at the end) takes over. */
  close(i: number): void {
    if (i >= this.tabs.length) return;
    this.tabs.splice(i, 1);
    if (i < this.active || this.active >= this.tabs.length) this.active = Math.max(0, this.active - 1);
    if (this.tabs.length === 0) {
      this.open = false;
      this.max = false;
    }
  }

  toggle(): void {
    if (this.tabs.length === 0) return;
    this.open = !this.open;
    if (!this.open) this.max = false;
  }

  apply(a: TabAct): void {
    switch (a.kind) {
      case "activate":
        this.active = Math.min(a.i, Math.max(0, this.tabs.length - 1));
        break;
      case "close":
        this.close(a.i);
        break;
      case "close_others": {
        const k = this.tabs[a.i];
        if (k !== undefined) {
          this.tabs = [k];
          this.active = 0;
        }
        break;
      }
      case "close_right":
        this.tabs = this.tabs.slice(0, a.i + 1);
        this.active = Math.min(this.active, a.i);
        break;
      case "close_all":
        this.tabs = [];
        this.active = 0;
        this.open = false;
        this.max = false;
        break;
      case "toggle":
        this.toggle();
        break;
      case "maximize":
        this.max = !this.max;
        break;
    }
  }

  /** The list's and the panel's widths in `width` (null: that side isn't shown). */
  areas(width: number): [number | null, number | null] {
    if (!this.showing()) return [width, null];
    if (this.max || width < MIN_SIDE * 2) return [null, width];
    const panel = Math.min(Math.max(width * this.frac, MIN_SIDE), width - MIN_SIDE);
    return [width - panel, panel];
  }

  /** The divider dragged to `x` (from the page's left edge) sets the panel's share. */
  drag(x: number, width: number): void {
    this.frac = Math.min(Math.max((width - x) / width, 0.2), 0.8);
  }
}

/** Esc on a page leaves it unless a text field had focus (it only blurs) or a popover takes it. */
export function escLeaves(esc: boolean, typing: boolean, popover = false): boolean {
  return esc && !typing && !popover;
}

export type MenuKey = { kind: "pick"; i: number } | { kind: "enter"; i: number } | { kind: "leave" } | { kind: "close" };
export type Key = "up" | "down" | "home" | "end" | "enter" | "space" | "right" | "left" | "esc";

/** A dropdown's keyboard (listdetail.rs `MenuKeys`): ↑/↓ and Home/End move the highlight over `n` rows, Enter or Space picks, → enters a submenu, ← leaves it, Esc closes. */
export class MenuKeys {
  hl: number | null = null;

  input(key: Key, n: number): MenuKey | null {
    if (n === 0) return key === "esc" ? { kind: "close" } : null;
    const cur = this.hl === null ? null : Math.min(this.hl, n - 1);
    if (key === "down") this.hl = cur === null ? 0 : (cur + 1) % n;
    if (key === "up") this.hl = cur === null ? n - 1 : (cur + n - 1) % n;
    if (key === "home") this.hl = 0;
    if (key === "end") this.hl = n - 1;
    if (key === "esc") return { kind: "close" };
    if (key === "left") return { kind: "leave" };
    if (this.hl === null) return null;
    if (key === "enter" || key === "space") return { kind: "pick", i: Math.min(this.hl, n - 1) };
    if (key === "right") return { kind: "enter", i: Math.min(this.hl, n - 1) };
    return null;
  }
}
