// Browser-style zoom of the whole window, on Chrome's steps. Slint lays the UI out in logical pixels and draws it
// at `scale` physical pixels each, so zooming is a larger scale than the display's: text, icons and images are
// drawn again at the new size (nothing is stretched), and the layout reflows into the window's logical size.

/** Chrome's zoom levels, without its 25%, 33% and 400–500% (too small or too large for a window like this). */
export const STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The kv key of this PC's level; it isn't synced to the account (each screen wants its own). */
export const KEY = "ui_zoom";

/** The level a stored value names; anything else is 100%. */
export function parseZoom(v: string | null | undefined): number {
  const n = Number(v ?? "");
  return STEPS.find((s) => Math.abs(s - n) < 0.001) ?? 1;
}

/** The level after a zoom key: `1` the next step in, `-1` out, `0` back to 100%. Between steps it goes to the next. */
export function stepZoom(level: number, step: number): number {
  if (step === 0) return 1;
  if (step > 0) return STEPS.find((s) => s > level + 0.001) ?? (STEPS.at(-1) ?? 1);
  return STEPS.findLast((s) => s < level - 0.001) ?? (STEPS[0] ?? 1);
}

/** What the zoom needs of the window. */
export interface Zoomable {
  /** The window's scale now (physical pixels per logical pixel). */
  scale(): number;
  /** Sets the scale and lays the window out again in its new logical size. */
  setScale(scale: number): void;
  /** The level, for the window's minimum size. */
  level(level: number): void;
  /** The level was saved: images are decoded again for the new size. */
  changed(): void;
}

/** The window's zoom: the display's own scale times this PC's level. */
export class Zoom {
  private current: number;
  /** The display's scale; null until the window is shown. */
  private display: number | null = null;
  /** The scale Harbor set last, to tell the display's own changes from it. */
  private applied = 0;

  constructor(
    private win: Zoomable,
    private store: { get(key: string): string | null | undefined; set(key: string, value: string): void },
  ) {
    this.current = parseZoom(store.get(KEY));
    win.level(this.current);
  }

  get level(): number {
    return this.current;
  }

  /** The window is on the screen: its scale is the display's until the level is applied. */
  shown(): void {
    this.display = this.win.scale();
    this.apply();
  }

  /** The window's scale changed. Not to the one Harbor set: the display set its own (another screen, a new setting). */
  scaleChanged(scale: number): void {
    if (this.display === null || Math.abs(scale - this.applied) < 0.001) return;
    this.display = scale;
    this.apply();
  }

  /** A zoom key: 1 in, -1 out, 0 back to 100%. */
  key(step: number): void {
    const next = stepZoom(this.current, step);
    if (next === this.current) return;
    this.current = next;
    this.store.set(KEY, String(next));
    this.win.level(next);
    this.apply();
    this.win.changed();
  }

  private apply(): void {
    if (this.display === null) return;
    const target = this.display * this.current;
    this.applied = target;
    if (Math.abs(this.win.scale() - target) >= 0.001) this.win.setScale(target);
  }

}
