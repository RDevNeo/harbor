import { parseMode, type Mode } from "../theme.ts";
import type { Kv } from "./settings.ts";

/** What slint/settings-appearance.slint draws (`AppearanceView`). */
export interface AppearanceView {
  modes: string[];
  mode: number;
  mode_note: string;
}

export const MODES: readonly Mode[] = ["system", "light", "dark"];

/** pages.rs `appearance_tab`: the theme mode, as kv `theme` holds it. (Density was dropped in 0.150: rows are always the
 * Comfortable ones.) */
export function appearanceView(kv: Kv): AppearanceView {
  return {
    modes: ["Follow Omarchy", "Light", "Dark"],
    mode: MODES.indexOf(parseMode(kv.get("theme") ?? "")),
    mode_note: "Colours and type are the rengaf design system (Geist). The sun or moon beside Search at the top of the sidebar switches between light and dark.",
  };
}

/** What the window applies after a change: the mode (dark or light is resolved against Omarchy). */
export function appearanceApplied(kv: Kv): { mode: Mode } {
  return { mode: parseMode(kv.get("theme") ?? "") };
}

/** A pick on the Appearance tab, written where the Rust app keeps it; false for any other key. */
export function setAppearance(kv: Kv, key: string, value: boolean | number): boolean {
  if (typeof value !== "number" || key !== "theme") return false;
  kv.set("theme", MODES[value] ?? "system");
  return true;
}

/** The sidebar's sun/moon: the other of light and dark from what shows now, kept as an explicit choice (until the first
 * press the theme follows Omarchy). */
export function toggledMode(dark: boolean): Mode {
  return dark ? "light" : "dark";
}
