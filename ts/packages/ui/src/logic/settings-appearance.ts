import { parseMode, type Mode } from "../theme.ts";
import type { Kv } from "./settings.ts";

/** What slint/settings-appearance.slint draws (`AppearanceView`). */
export interface AppearanceView {
  modes: string[];
  mode: number;
  densities: string[];
  density: number;
  mode_note: string;
  density_note: string;
}

export const MODES: readonly Mode[] = ["system", "light", "dark"];

/** pages.rs `appearance_tab`: the theme mode and the density, as kv `theme` and `density` hold them. */
export function appearanceView(kv: Kv): AppearanceView {
  return {
    modes: ["Follow Omarchy", "Light", "Dark"],
    mode: MODES.indexOf(parseMode(kv.get("theme") ?? "")),
    densities: ["Comfortable", "Compact"],
    density: kv.get("density") === "compact" ? 1 : 0,
    mode_note: "Colours and type are the rengaf design system (Geist).",
    density_note: "Compact fits more on screen: shorter rows in the sidebar, menus and settings, and less space between messages. On this PC only.",
  };
}

/** What the window applies after a change: the mode (dark or light is resolved against Omarchy) and the density. */
export function appearanceApplied(kv: Kv): { mode: Mode; compact: boolean } {
  return { mode: parseMode(kv.get("theme") ?? ""), compact: kv.get("density") === "compact" };
}

/** A pick on the Appearance tab, written where the Rust app keeps it; false for any other key. */
export function setAppearance(kv: Kv, key: string, value: boolean | number): boolean {
  if (typeof value !== "number") return false;
  if (key === "theme") kv.set("theme", MODES[value] ?? "system");
  else if (key === "density") kv.set("density", value === 1 ? "compact" : "comfortable");
  else return false;
  return true;
}
