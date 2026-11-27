// Desktop notifications where Harbor shows them itself: macOS, from inside Harbor.app (UNUserNotificationCenter),
// and Windows (toasts). Linux's go through notify-send (net/src/notify.ts).
import { spawn } from "node:child_process";
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

/** Linux (and other freedesktop desktops): takes notification `id` (what `notify-send -p` printed) away through the
 *  notification server's CloseNotification. Quiet when there's no session bus or no server. */
export function closeFreedesktop(id: number): void {
  if (platform() === "win32" || platform() === "darwin" || !Number.isInteger(id) || id <= 0) return;
  try {
    const c = spawn("dbus-send", ["--session", "--type=method_call", "--dest=org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications.CloseNotification", `uint32:${id}`], { stdio: "ignore" });
    c.on("error", () => {});
  } catch {
    // no dbus-send: the notification times out by itself
  }
}
