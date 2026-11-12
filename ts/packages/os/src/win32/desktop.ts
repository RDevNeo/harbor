// desktop.ts's answers on Windows: opening links and files with their default app, raising Harbor's window.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { platform } from "../platform.ts";

const H = FFIType.u64_fast;
const USER32 = {
  FindWindowExW: { args: [H, H, FFIType.ptr, FFIType.ptr], returns: H },
  GetWindowThreadProcessId: { args: [H, FFIType.ptr], returns: FFIType.u32 },
  IsWindowVisible: { args: [H], returns: FFIType.i32 },
  IsIconic: { args: [H], returns: FFIType.i32 },
  GetWindow: { args: [H, FFIType.u32], returns: H },
  ShowWindow: { args: [H, FFIType.i32], returns: FFIType.i32 },
  SetForegroundWindow: { args: [H], returns: FFIType.i32 },
  AllowSetForegroundWindow: { args: [FFIType.u32], returns: FFIType.i32 },
} as const;

let user32: ReturnType<typeof dlopen<typeof USER32>>["symbols"] | null | undefined;
function lib(): typeof user32 {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (platform() !== "win32") return user32;
  try {
    user32 = dlopen("user32.dll", USER32).symbols;
  } catch {
    user32 = null;
  }
  return user32;
}

const GW_OWNER = 4;
const SW_RESTORE = 9;

/** The process's visible top-level windows that have no owner (its main windows, not dialogs or tooltips). */
export function windowsOf(pid: number): number[] {
  const u = lib();
  if (!u) return [];
  const out: number[] = [];
  const who = new Uint32Array(1);
  let h = 0;
  for (let n = 0; n < 100000; n++) {
    h = Number(u.FindWindowExW(0, h, null, null));
    if (!h) break;
    u.GetWindowThreadProcessId(h, ptr(who));
    if (who[0] === pid && u.IsWindowVisible(h) && !Number(u.GetWindow(h, GW_OWNER))) out.push(h);
  }
  return out;
}

/** Brings the process's window to the front (restored when minimized). False when it has none or Windows refused. */
export function raise(pid: number): boolean {
  const u = lib();
  const h = windowsOf(pid)[0];
  if (!u || h === undefined) return false;
  if (u.IsIconic(h)) u.ShowWindow(h, SW_RESTORE);
  return !!u.SetForegroundWindow(h);
}

/**
 * Lets another process take the foreground: Windows gives it only to the app the user is using, so a second
 * Harbor (just started by the user) calls this before it asks the running one to show itself.
 */
export function allowRaise(pid = -1): void {
  lib()?.AllowSetForegroundWindow(pid >>> 0);
}
