// The Win32 calls Harbor's Windows pieces share (bun:ffi): the system DLLs, opened on first use, UTF-16
// strings, the registry under HKEY_CURRENT_USER, and one hidden window that receives the tray's clicks and
// owns the clipboard. Loaded only on Windows.
import { CFunction, dlopen, FFIType, JSCallback, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";

const P = FFIType.ptr;
const U32 = FFIType.u32;
const I32 = FFIType.i32;

function lib<T extends Parameters<typeof dlopen>[1]>(name: string, symbols: T) {
  let opened: ReturnType<typeof dlopen<T>>["symbols"] | undefined;
  return (): ReturnType<typeof dlopen<T>>["symbols"] => (opened ??= dlopen(name, symbols).symbols);
}

export const kernel32 = lib("kernel32.dll", {
  GlobalAlloc: { args: [U32, FFIType.u64], returns: P },
  GlobalLock: { args: [P], returns: P },
  GlobalUnlock: { args: [P], returns: I32 },
  GlobalSize: { args: [P], returns: FFIType.u64_fast },
  GlobalFree: { args: [P], returns: P },
  GetModuleHandleW: { args: [P], returns: P },
  GetLastError: { args: [], returns: U32 },
  VirtualAlloc: { args: [P, FFIType.u64, U32, U32], returns: P },
});

export const user32 = lib("user32.dll", {
  OpenClipboard: { args: [P], returns: I32 },
  CloseClipboard: { args: [], returns: I32 },
  EmptyClipboard: { args: [], returns: I32 },
  GetClipboardData: { args: [U32], returns: P },
  SetClipboardData: { args: [U32, P], returns: P },
  EnumClipboardFormats: { args: [U32], returns: U32 },
  RegisterClipboardFormatW: { args: [P], returns: U32 },
  GetClipboardSequenceNumber: { args: [], returns: U32 },
  RegisterClassExW: { args: [P], returns: FFIType.u16 },
  CreateWindowExW: { args: [U32, P, P, U32, I32, I32, I32, I32, P, P, P, P], returns: P },
  DestroyWindow: { args: [P], returns: I32 },
  DefWindowProcW: { args: [P, U32, P, P], returns: P },
  PeekMessageW: { args: [P, P, U32, U32, U32], returns: I32 },
  TranslateMessage: { args: [P], returns: I32 },
  DispatchMessageW: { args: [P], returns: P },
  RegisterWindowMessageW: { args: [P], returns: U32 },
  CreatePopupMenu: { args: [], returns: P },
  AppendMenuW: { args: [P, U32, P, P], returns: I32 },
  TrackPopupMenu: { args: [P, U32, I32, I32, I32, P, P], returns: I32 },
  DestroyMenu: { args: [P], returns: I32 },
  GetCursorPos: { args: [P], returns: I32 },
  SetForegroundWindow: { args: [P], returns: I32 },
  PostMessageW: { args: [P, U32, P, P], returns: I32 },
  CreateIconFromResourceEx: { args: [P, U32, I32, U32, I32, I32, U32], returns: P },
  DestroyIcon: { args: [P], returns: I32 },
  GetSystemMetrics: { args: [I32], returns: I32 },
});

export const shell32 = lib("shell32.dll", {
  Shell_NotifyIconW: { args: [U32, P], returns: I32 },
});

// HKEY_CURRENT_USER is ((HKEY)(LONG)0x80000001): sign-extended, more than a double holds exactly.
const HKCU = 0xffffffff80000001n;
export const advapi32 = lib("advapi32.dll", {
  RegGetValueW: { args: [FFIType.u64, P, P, U32, P, P, P], returns: I32 },
  RegCreateKeyExW: { args: [FFIType.u64, P, U32, P, U32, U32, P, P, P], returns: I32 },
  RegSetValueExW: { args: [P, P, U32, U32, P, U32], returns: I32 },
  RegDeleteKeyValueW: { args: [FFIType.u64, P, P], returns: I32 },
  RegCloseKey: { args: [P], returns: I32 },
});

/** A string as Windows takes it: UTF-16, ending in a 0. */
export function wide(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf16le");
}

/** A UTF-16 string up to its 0 (or `max` units). */
export function fromWide(p: Pointer, max = 32768): string {
  const units: number[] = [];
  for (let i = 0; i < max; i++) {
    const u = read.u16(p, i * 2);
    if (u === 0) break;
    units.push(u);
  }
  return String.fromCharCode(...units);
}

/** `len` bytes of native memory, copied out. */
export function bytesAt(p: Pointer, len: number): Uint8Array {
  return len <= 0 ? new Uint8Array() : new Uint8Array(toArrayBuffer(p, 0, len)).slice();
}

/** A GUID's 16 bytes from its text form ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"). */
export function guid(text: string): Uint8Array {
  const h = text.replace(/[{}-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new Error(`not a GUID: ${text}`);
  const b = Buffer.alloc(16);
  b.writeUInt32LE(Number.parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(Number.parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(Number.parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), "hex").copy(b, 8);
  return new Uint8Array(b);
}

/** A function pointer called through FFI, made once per address. */
const fns = new Map<string, (...a: unknown[]) => unknown>();
export function fn(at: Pointer, args: FFIType[], returns: FFIType): (...a: unknown[]) => unknown {
  const key = `${at}:${args.join(",")}:${returns}`;
  let f = fns.get(key);
  if (f === undefined) {
    f = CFunction({ ptr: at, args, returns }) as unknown as (...a: unknown[]) => unknown;
    fns.set(key, f);
  }
  return f;
}

// --- The registry (HKEY_CURRENT_USER only) ---

const REG_SZ = 1;
const RRF_RT_REG_SZ = 0x2;
const RRF_RT_REG_BINARY = 0x8;
const KEY_SET_VALUE = 0x2;
const ERROR_FILE_NOT_FOUND = 2;

/** A string value under HKCU; null when there's none. */
export function regString(key: string, name: string): string | null {
  const size = new Uint32Array([0]);
  const k = wide(key);
  const n = wide(name);
  if (advapi32().RegGetValueW(HKCU, ptr(k), ptr(n), RRF_RT_REG_SZ, null, null, ptr(size)) !== 0) return null;
  const buf = new Uint8Array(new ArrayBuffer((size[0] ?? 0) + 2));
  if (advapi32().RegGetValueW(HKCU, ptr(k), ptr(n), RRF_RT_REG_SZ, null, ptr(buf), ptr(size)) !== 0) return null;
  return Buffer.from(buf.subarray(0, size[0])).toString("utf16le").replace(/\0+$/, "");
}

/** A binary value under HKCU; null when there's none. */
export function regBinary(key: string, name: string): Uint8Array | null {
  const size = new Uint32Array([0]);
  const k = wide(key);
  const n = wide(name);
  if (advapi32().RegGetValueW(HKCU, ptr(k), ptr(n), RRF_RT_REG_BINARY, null, null, ptr(size)) !== 0) return null;
  const buf = new Uint8Array(new ArrayBuffer(Math.max(1, size[0] ?? 0)));
  if (advapi32().RegGetValueW(HKCU, ptr(k), ptr(n), RRF_RT_REG_BINARY, null, ptr(buf), ptr(size)) !== 0) return null;
  return buf.slice(0, size[0]);
}

/** Sets a string value under HKCU, making the key when it isn't there. Throws when Windows refuses. */
export function setRegString(key: string, name: string, value: string): void {
  const out = new BigUint64Array(1);
  const k = wide(key);
  const made = advapi32().RegCreateKeyExW(HKCU, ptr(k), 0, null, 0, KEY_SET_VALUE, null, ptr(out), null);
  if (made !== 0) throw new Error(`the registry refused HKCU\\${key} (${made})`);
  const h = Number(out[0]) as Pointer;
  try {
    const data = wide(value);
    const n = wide(name);
    const set = advapi32().RegSetValueExW(h, ptr(n), 0, REG_SZ, ptr(data), data.length);
    if (set !== 0) throw new Error(`the registry refused HKCU\\${key}\\${name} (${set})`);
  } finally {
    advapi32().RegCloseKey(h);
  }
}

/** Deletes a value under HKCU (fine when it isn't there). */
export function deleteRegValue(key: string, name: string): void {
  const k = wide(key);
  const n = wide(name);
  const r = advapi32().RegDeleteKeyValueW(HKCU, ptr(k), ptr(n));
  if (r !== 0 && r !== ERROR_FILE_NOT_FOUND) throw new Error(`the registry refused to delete HKCU\\${key}\\${name} (${r})`);
}

// --- Harbor's hidden window ---

export const WM_DESTROY = 0x0002;
export const WM_USER = 0x0400;
const PM_REMOVE = 1;
const MSG_BYTES = 48;

type Handler = (msg: number, wparam: number, lparam: number) => number | undefined;
const handlers: Handler[] = [];
let window: Pointer | null = null;
let proc: JSCallback | null = null;
let pumping: ReturnType<typeof setInterval> | null = null;

const num = (p: Pointer | number | null | bigint): number => (p === null ? 0 : Number(p));

/** An FFI result as a pointer (Bun types some as bigint too). */
export const pointer = (v: unknown): Pointer | null => (v === null || v === undefined || v === 0 || v === 0n ? null : (Number(v) as Pointer));

/**
 * Harbor's own hidden window (never shown): Windows sends it the tray's clicks and taskbar restarts, and
 * the clipboard needs a window to own what Harbor copies. Made on first use, on Bun's thread; its messages
 * are dispatched there by Slint's loop and by `pump`.
 */
export function hiddenWindow(): Pointer {
  if (window !== null) return window;
  const hInstance = kernel32().GetModuleHandleW(null);
  proc = new JSCallback(
    (hwnd: Pointer, msg: number, wparam: Pointer | null, lparam: Pointer | null): Pointer | null => {
      for (const h of handlers) {
        const r = h(msg, num(wparam), num(lparam));
        if (r !== undefined) return r as unknown as Pointer;
      }
      return pointer(user32().DefWindowProcW(hwnd, msg, wparam, lparam));
    },
    { args: [P, U32, P, P], returns: P },
  );
  const className = wide("HarborHidden");
  // WNDCLASSEXW (x64): cbSize, style, lpfnWndProc @8, …, hInstance @24, …, lpszClassName @64; 80 bytes.
  const wc = Buffer.alloc(80);
  wc.writeUInt32LE(80, 0);
  wc.writeBigUInt64LE(BigInt(num(proc.ptr)), 8);
  wc.writeBigUInt64LE(BigInt(num(hInstance)), 24);
  wc.writeBigUInt64LE(BigInt(num(ptr(className))), 64);
  user32().RegisterClassExW(ptr(wc));
  const title = wide("Harbor");
  // A top-level window that's never shown (not a message-only one: those don't hear that the taskbar restarted).
  window = pointer(user32().CreateWindowExW(0, ptr(className), ptr(title), 0, 0, 0, 0, 0, null, null, hInstance, null));
  if (window === null) throw new Error(`Windows made no window (${kernel32().GetLastError()})`);
  pump();
  return window;
}

/** Hears the hidden window's messages; a handler that returns a number answers the message. */
export function onMessage(h: Handler): () => void {
  hiddenWindow();
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/**
 * Dispatches the hidden window's waiting messages every 100 ms for as long as it lives: Slint's loop dispatches
 * them too while it runs, this keeps tray clicks working while it waits, and answers the clipboard's messages
 * (another app's copy waits for the owner of the last one to answer).
 */
function pump(): void {
  if (pumping !== null) return;
  const msg = new Uint8Array(new ArrayBuffer(MSG_BYTES));
  pumping = setInterval(() => {
    const w = window;
    if (w === null) return;
    for (let i = 0; i < 64 && user32().PeekMessageW(ptr(msg), w, 0, 0, PM_REMOVE) !== 0; i++) {
      user32().TranslateMessage(ptr(msg));
      user32().DispatchMessageW(ptr(msg));
    }
  }, 100);
  (pumping as { unref?: () => void }).unref?.();
}

/** Machine code in executable memory (x64): for the few COM methods that run on Windows' own threads. */
export function code(bytes: readonly number[]): Pointer {
  const MEM_COMMIT_RESERVE = 0x3000;
  const PAGE_EXECUTE_READWRITE = 0x40;
  const at = pointer(kernel32().VirtualAlloc(null, 4096, MEM_COMMIT_RESERVE, PAGE_EXECUTE_READWRITE));
  if (at === null) throw new Error("Windows gave no executable memory");
  new Uint8Array(toArrayBuffer(at, 0, bytes.length)).set(bytes);
  return at;
}
