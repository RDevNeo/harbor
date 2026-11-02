import { usageCtl } from "@harbor/store";
import { ago } from "./app.ts";

/** A row of the sidebar's Claude usage popover, in the window's `PopItem` form. */
export interface UsageRow {
  kind: "label" | "separator" | "usage-account" | "usage-window" | "usage-note";
  label: string;
  /** usage-account: when its numbers were read; usage-window: "81%  ·  resets in 1d 15h". */
  desc: string;
  /** usage-account: the plan. */
  badge: string;
  value: number;
}

const row = (kind: UsageRow["kind"], label = "", extra: Partial<UsageRow> = {}): UsageRow => ({ kind, label, desc: "", badge: "", value: 0, ...extra });

/** "just now", "3m ago". */
export function seenText(seen: number, now: number): string {
  const a = ago(seen, now);
  return a === "now" ? "just now" : `${a} ago`;
}

/** The popover: a title, then per account its name, plan and age, and a line and a bar per window. */
export function usageRows(readings: readonly usageCtl.Reading[], now: number): UsageRow[] {
  const out = [row("label", "Claude usage")];
  if (readings.length === 0) out.push(row("usage-note", "No Claude account on this PC."));
  readings.forEach((r, i) => {
    if (i > 0) out.push(row("separator"));
    out.push(row("usage-account", r.label, { badge: r.plan, desc: r.seen === null ? "" : seenText(r.seen, now) }));
    if (!r.signedIn) out.push(row("usage-note", "Signed out on this PC."));
    else if (r.windows.length === 0) out.push(row("usage-note", "No usage data yet."));
    else for (const w of r.windows) out.push(row("usage-window", w.label, { desc: usageCtl.readingText(w, now), value: w.used ?? 0 }));
  });
  return out;
}

/** Esc after the press that closed a popover: true while that press repeats, so a held Esc reaches nothing behind it
 *  (a running turn's stop). */
export class EscHold {
  private held = false;

  closed(): void {
    this.held = true;
  }

  swallow(repeat: boolean): boolean {
    if (!this.held) return false;
    if (repeat) return true;
    this.held = false;
    return false;
  }
}
