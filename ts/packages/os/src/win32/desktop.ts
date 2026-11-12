// desktop.ts's answers on Windows: opening links and files with their default app, raising Harbor's window.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { basename } from "node:path";
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
  GetWindowLongPtrW: { args: [H, FFIType.i32], returns: FFIType.i64_fast },
  GetWindowRect: { args: [H, FFIType.ptr], returns: FFIType.i32 },
  MonitorFromWindow: { args: [H, FFIType.u32], returns: H },
  GetMonitorInfoW: { args: [H, FFIType.ptr], returns: FFIType.i32 },
  SetWindowPos: { args: [H, H, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  SendMessageW: { args: [H, FFIType.u32, H, H], returns: H },
} as const;

const SHELL32 = {
  ExtractIconExW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
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
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const SW_RESTORE = 9;
const MONITOR_DEFAULTTONEAREST = 2;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const WM_SETICON = 0x80;
const ICON_SMALL = 0;
const ICON_BIG = 1;

/**
 * The process's visible top-level windows that have no owner and aren't tool windows: its main windows, not
 * dialogs, tooltips or winit's invisible event window (a "visible" transparent tool window).
 */
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
    if (who[0] !== pid || !u.IsWindowVisible(h) || Number(u.GetWindow(h, GW_OWNER))) continue;
    if (Number(u.GetWindowLongPtrW(h, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) continue;
    out.push(h);
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

/** Where a window may go on its screen: the work area (the screen less the taskbar), in physical pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a window of `win` goes in the screen's work area `work`: as it is when it fits, else no bigger than
 * the work area (less a margin) and centred on it. Null: it fits.
 */
export function fitRect(win: Rect, work: Rect, margin = 0.04): Rect | null {
  const ww = win.right - win.left;
  const wh = win.bottom - win.top;
  const aw = work.right - work.left;
  const ah = work.bottom - work.top;
  if (aw <= 0 || ah <= 0) return null;
  if (ww <= aw && wh <= ah && win.left >= work.left && win.top >= work.top && win.right <= work.right && win.bottom <= work.bottom) return null;
  const w = Math.min(ww, Math.round(aw * (1 - margin)));
  const h = Math.min(wh, Math.round(ah * (1 - margin)));
  const left = work.left + Math.round((aw - w) / 2);
  const top = work.top + Math.round((ah - h) / 2);
  return { left, top, right: left + w, bottom: top + h };
}

const rectOf = (b: Int32Array, at = 0): Rect => ({ left: b[at] ?? 0, top: b[at + 1] ?? 0, right: b[at + 2] ?? 0, bottom: b[at + 3] ?? 0 });

let exeIcons: [number, number] | null | undefined;
/** The large and small icons of Harbor's executable (stamped into harbor.exe); null under `bun` itself. */
function icons(): [number, number] | null {
  if (exeIcons !== undefined) return exeIcons;
  exeIcons = null;
  if (/^bun(-debug)?\.exe$/i.test(basename(process.execPath))) return exeIcons;
  try {
    const shell32 = dlopen("shell32.dll", SHELL32).symbols;
    const large = new BigUint64Array(1);
    const small = new BigUint64Array(1);
    const path = Buffer.from(`${process.execPath}\0`, "utf16le");
    if (shell32.ExtractIconExW(ptr(path), 0, ptr(large), ptr(small), 1) > 0 && large[0]) exeIcons = [Number(large[0]), Number(small[0] || large[0])];
  } catch {
    exeIcons = null;
  }
  return exeIcons;
}

/**
 * Settles the process's freshly shown windows: each gets the executable's icon in its title bar (winit's window
 * class has none, so Windows draws a blank one), and one bigger than its screen's work area (Slint's preferred
 * size is logical pixels: 1400x900 at 150 % is 2100x1350) is made to fit and centred. How many windows it saw:
 * 0 means none is up yet.
 */
export function settleWindows(pid: number = process.pid): number {
  const u = lib();
  if (!u) return 0;
  const seen = windowsOf(pid);
  const icon = icons();
  for (const h of seen) {
    if (icon) {
      u.SendMessageW(h, WM_SETICON, ICON_BIG, icon[0]);
      u.SendMessageW(h, WM_SETICON, ICON_SMALL, icon[1]);
    }
    if (u.IsIconic(h)) continue;
    const r = new Int32Array(4);
    const info = new Int32Array(10);
    info[0] = 40; // MONITORINFO.cbSize
    if (!u.GetWindowRect(h, ptr(r))) continue;
    const mon = u.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    if (!mon || !u.GetMonitorInfoW(mon, ptr(info))) continue;
    const to = fitRect(rectOf(r), rectOf(info, 5));
    if (!to) continue;
    u.SetWindowPos(h, 0, to.left, to.top, to.right - to.left, to.bottom - to.top, SWP_NOZORDER | SWP_NOACTIVATE);
    console.error(`harbor: window ${rectOf(r).right - rectOf(r).left}x${rectOf(r).bottom - rectOf(r).top} fitted to ${to.right - to.left}x${to.bottom - to.top} on its screen`);
  }
  return seen.length;
}
