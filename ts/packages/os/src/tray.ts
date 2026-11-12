// Harbor's icon beside the clock while it runs, where Harbor draws it itself: macOS's menu bar.
// Linux's tray (a D-Bus StatusNotifierItem) is still in ui/src/tray.ts.
import { platform } from "./platform.ts";

export type TrayItem = { label: string; onClick: () => void } | "separator";

export interface TrayOptions {
  /** The icon as a PNG: on macOS a template (black with alpha), drawn in the menu bar's colour. */
  iconPng: Uint8Array;
  /** Its size in points (18 in macOS's menu bar). */
  iconPoints: number;
  tooltip: string;
  items: readonly TrayItem[];
}

let darwinLib: typeof import("./darwin-statusitem.ts") | undefined;
const mac = (): typeof import("./darwin-statusitem.ts") | undefined =>
  platform() === "darwin" ? (darwinLib ??= require("./darwin-statusitem.ts") as typeof import("./darwin-statusitem.ts")) : undefined;

/** Whether this module shows the icon here. */
export function available(): boolean {
  return platform() === "darwin";
}

/** Shows the icon with its menu; the function it returns takes it away. Null where there's none to show. */
export function start(o: TrayOptions): (() => void) | null {
  const m = mac();
  return m === undefined ? null : m.start(o);
}
