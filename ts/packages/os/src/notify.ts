// Desktop notifications where Harbor shows them itself: macOS, from inside Harbor.app (UNUserNotificationCenter).
// Linux's go through notify-send (net/src/notify.ts).
import { platform } from "./platform.ts";

export type { Post } from "./darwin-notify.ts";

let darwinLib: typeof import("./darwin-notify.ts") | undefined;
const mac = (): typeof import("./darwin-notify.ts") | undefined =>
  available() ? (darwinLib ??= require("./darwin-notify.ts") as typeof import("./darwin-notify.ts")) : undefined;

/** Running from an app bundle (…/Harbor.app/Contents/MacOS/harbor): macOS's notifications need one. */
export function inAppBundle(exe: string = process.execPath): boolean {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(exe);
}

/** Whether this module shows notifications here. */
export function available(): boolean {
  return platform() === "darwin" && inAppBundle();
}

export function post(p: import("./darwin-notify.ts").Post): void {
  mac()?.post(p);
}

export function remove(id: string): void {
  mac()?.remove(id);
}
