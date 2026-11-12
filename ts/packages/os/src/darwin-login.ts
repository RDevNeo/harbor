// Start at login from inside Harbor.app: SMAppService registers the LaunchAgent the bundle carries
// (Contents/Library/LaunchAgents/dev.harbor.Harbor.plist), so System Settings › Login Items lists it as
// Harbor, with its icon. Loaded only on macOS, in an app bundle.
import { call1, callI64, cls, loadFramework, nsString, pool, type Id } from "./darwin-objc.ts";
import { APP_ID } from "./autostart.ts";

loadFramework("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement");

/** SMAppServiceStatus: not registered, enabled, waiting for the user's approval, not found. */
export type Status = "off" | "on" | "approval" | "missing";
const STATUS: Status[] = ["off", "on", "approval", "missing"];

function service(): Id {
  return call1(cls("SMAppService"), "agentServiceWithPlistName:", nsString(`${APP_ID}.plist`));
}

export function status(): Status {
  return pool(() => STATUS[callI64(service(), "status")] ?? "missing");
}

/** Registers or unregisters it; throws with macOS's reason when that fails. */
export function set(on: boolean): void {
  pool(() => {
    const ok = call1(service(), on ? "registerAndReturnError:" : "unregisterAndReturnError:", null);
    // A BOOL in the low byte of the return register.
    if ((Number(ok ?? 0) & 0xff) === 0 && on) throw new Error("macOS didn't take Harbor as a login item (System Settings › General › Login Items)");
  });
}

