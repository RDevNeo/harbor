// Windows' notification area: Harbor's icon by the clock (Shell_NotifyIconW), a click opens Harbor and a
// right click shows its menu. Loaded only on Windows; its messages come to Harbor's hidden window.
import { type Pointer, ptr } from "bun:ffi";
import { hiddenWindow, onMessage, shell32, user32, wide, WM_USER } from "./gui.ts";
import type { TrayItem, TrayOptions } from "../tray.ts";

const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const CALLBACK = WM_USER + 1;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;
const SM_CXSMICON = 49;
const MF_SEPARATOR = 0x800;
const TPM_RETURNCMD = 0x100;
const TPM_NONOTIFY = 0x80;
const TPM_RIGHTBUTTON = 0x2;
const TPM_BOTTOMALIGN = 0x20;

/** NOTIFYICONDATAW (x64, 976 bytes): the fields Harbor sets. */
export function notifyIconData(hwnd: number, icon: number, tip: string): Buffer {
  const d = Buffer.alloc(976);
  d.writeUInt32LE(976, 0);
  d.writeBigUInt64LE(BigInt(hwnd), 8);
  d.writeUInt32LE(1, 16); // uID
  d.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20);
  d.writeUInt32LE(CALLBACK, 24);
  d.writeBigUInt64LE(BigInt(icon), 32);
  // szTip: 128 UTF-16 units, the last one 0.
  Buffer.from(tip.slice(0, 127), "utf16le").copy(d, 40);
  return d;
}

/** A menu label as Windows reads it: "&" marks a shortcut letter, "&&" is an "&". */
export const menuLabel = (s: string): string => s.replaceAll("&", "&&");

export function start(o: TrayOptions): () => void {
  const hwnd = hiddenWindow();
  const png = o.colorPng ?? o.iconPng;
  const size = user32().GetSystemMetrics(SM_CXSMICON) || 16;
  // Windows reads a PNG icon image as it is (CreateIconFromResourceEx, version 3.0 icon resources).
  const icon = user32().CreateIconFromResourceEx(ptr(png), png.length, 1, 0x00030000, size, size, 0);
  const data = notifyIconData(Number(hwnd), Number(icon ?? 0), o.tooltip);
  if (shell32().Shell_NotifyIconW(NIM_ADD, ptr(data)) === 0) {
    if (icon !== null) user32().DestroyIcon(icon);
    throw new Error("Windows didn't take the icon (no taskbar?)");
  }
  const taskbarCreated = user32().RegisterWindowMessageW(ptr(wide("TaskbarCreated")));
  const items = o.items;
  const later = (f: () => void): void => void setTimeout(f, 0);
  const off = onMessage((msg, _wparam, lparam) => {
    if (msg === taskbarCreated) {
      // Explorer restarted: its new taskbar has no icons until each app adds its own again.
      shell32().Shell_NotifyIconW(NIM_ADD, ptr(data));
      return undefined;
    }
    if (msg !== CALLBACK) return undefined;
    const event = lparam & 0xffff;
    if (event === WM_LBUTTONUP) {
      const open = o.onActivate ?? firstAction(items);
      if (open) later(open);
      return 0;
    }
    if (event === WM_RBUTTONUP || event === WM_CONTEXTMENU) {
      const chosen = showMenu(hwnd, items);
      if (chosen) later(chosen);
      return 0;
    }
    return 0;
  });
  return () => {
    off();
    shell32().Shell_NotifyIconW(NIM_DELETE, ptr(data));
    if (icon !== null) user32().DestroyIcon(icon);
  };
}

function firstAction(items: readonly TrayItem[]): (() => void) | undefined {
  for (const i of items) if (i !== "separator") return i.onClick;
  return undefined;
}

/** Shows the menu at the pointer and waits for a choice (Windows runs the menu's own loop meanwhile). */
function showMenu(hwnd: Pointer, items: readonly TrayItem[]): (() => void) | undefined {
  const menu = user32().CreatePopupMenu();
  if (menu === null) return undefined;
  try {
    items.forEach((it, i) => {
      if (it === "separator") user32().AppendMenuW(menu, MF_SEPARATOR, null, null);
      else user32().AppendMenuW(menu, 0, (i + 1) as unknown as Pointer, ptr(wide(menuLabel(it.label))));
    });
    const at = new Int32Array(2);
    user32().GetCursorPos(ptr(at));
    // Without this the menu stays up after a click elsewhere (Windows' documented quirk).
    user32().SetForegroundWindow(hwnd);
    const id = user32().TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, at[0] ?? 0, at[1] ?? 0, 0, hwnd, null);
    user32().PostMessageW(hwnd, 0, null, null);
    const it = id > 0 ? items[id - 1] : undefined;
    return it === undefined || it === "separator" ? undefined : it.onClick;
  } finally {
    user32().DestroyMenu(menu);
  }
}
