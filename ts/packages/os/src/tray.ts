// Harbor's icon beside the clock while it runs, where Harbor draws it itself: macOS's menu bar and Windows'
// notification area. Linux's tray (a D-Bus StatusNotifierItem) is still in ui/src/tray.ts.
import { platform } from "./platform.ts";

export type TrayItem = { label: string; onClick: () => void } | "separator";

export interface TrayOptions {
  /** The icon as a PNG: on macOS a template (black with alpha), drawn in the menu bar's colour. */
  iconPng: Uint8Array;
  /** Its size in points (18 in macOS's menu bar). */
  iconPoints: number;
  /** The icon in colour, where the system shows it as it is (Windows); `iconPng` when absent. */
  colorPng?: Uint8Array;
  tooltip: string;
  items: readonly TrayItem[];
  /** A click on the icon itself, where that doesn't show the menu (Windows); the first item when absent. */
  onActivate?: () => void;
}

type Lib = typeof import("./darwin-statusitem.ts");
let lib: Lib | null | undefined;
const native = (): Lib | null => {
  if (lib === undefined) {
    const p = platform();
    lib =
      p === "darwin"
        ? (require("./darwin-statusitem.ts") as Lib)
        : p === "win32"
          ? (require("./win32/tray.ts") as typeof import("./win32/tray.ts"))
          : null;
  }
  return lib;
};

/** Whether this module shows the icon here. */
export function available(): boolean {
  const p = platform();
  return p === "darwin" || p === "win32";
}

/** Shows the icon with its menu; the function it returns takes it away. Null where there's none to show. */
export function start(o: TrayOptions): (() => void) | null {
  const m = native();
  return m === null ? null : m.start(o);
}
