// Desktop notifications where Harbor shows them itself: macOS, from inside Harbor.app (UNUserNotificationCenter),
// and Windows (toasts). Linux's go through notify-send (net/src/notify.ts).
import { platform } from "./platform.ts";

export type { Post } from "./darwin-notify.ts";

type Lib = Pick<typeof import("./darwin-notify.ts"), "post" | "remove">;
let lib: Lib | undefined;
const native = (): Lib | undefined => {
  if (!available()) return undefined;
  return (lib ??=
    platform() === "win32"
      ? (require("./win32/notify.ts") as typeof import("./win32/notify.ts"))
      : (require("./darwin-notify.ts") as typeof import("./darwin-notify.ts")));
};

/** Running from an app bundle (…/Harbor.app/Contents/MacOS/harbor): macOS's notifications need one. */
export function inAppBundle(exe: string = process.execPath): boolean {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(exe);
}

/** Whether this module shows notifications here. */
export function available(): boolean {
  const p = platform();
  return (p === "darwin" && inAppBundle()) || p === "win32";
}

export function post(p: import("./darwin-notify.ts").Post): void {
  native()?.post(p);
}

export function remove(id: string): void {
  native()?.remove(id);
}
