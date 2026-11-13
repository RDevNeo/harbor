// Computer use on Windows (bun:ffi): the primary monitor through GDI (BitBlt, or StretchBlt with HALFTONE when a
// smaller picture is asked for, so the scaling happens natively), the pointer with SetCursorPos and the buttons,
// wheel and keyboard with SendInput. Every call runs per-monitor DPI aware on this thread only (Harbor's window
// keeps its own awareness), so coordinates are the monitor's physical pixels whatever its scale.
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import type { Backend, Button, Direction } from "../screen/backend.ts";
import { bgraToRgba, clampRect, type Image, type Rect } from "../screen/image.ts";
import { type Combo, winVk } from "../screen/keys.ts";

const P = FFIType.ptr;
const I32 = FFIType.i32;
const U32 = FFIType.u32;

let libs: ReturnType<typeof open> | undefined;
function open() {
  const user32 = dlopen("user32.dll", {
    GetDC: { args: [P], returns: P },
    ReleaseDC: { args: [P, P], returns: I32 },
    GetSystemMetrics: { args: [I32], returns: I32 },
    SetThreadDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i64 },
    SetCursorPos: { args: [I32, I32], returns: I32 },
    GetCursorPos: { args: [P], returns: I32 },
    SendInput: { args: [U32, P, I32], returns: U32 },
    GetDoubleClickTime: { args: [], returns: U32 },
  }).symbols;
  const gdi32 = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: [P], returns: P },
    CreateDIBSection: { args: [P, P, U32, P, P, U32], returns: P },
    SelectObject: { args: [P, P], returns: P },
    BitBlt: { args: [P, I32, I32, I32, I32, P, I32, I32, U32], returns: I32 },
    StretchBlt: { args: [P, I32, I32, I32, I32, P, I32, I32, I32, I32, U32], returns: I32 },
    SetStretchBltMode: { args: [P, I32], returns: I32 },
    SetBrushOrgEx: { args: [P, I32, I32, P], returns: I32 },
    DeleteObject: { args: [P], returns: I32 },
    DeleteDC: { args: [P], returns: I32 },
  }).symbols;
  return { user32, gdi32 };
}
const lib = () => (libs ??= open());

/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: ((DPI_AWARENESS_CONTEXT)-4). */
const PER_MONITOR_V2 = -4;

/** `f` with this thread per-monitor DPI aware, then the thread's own awareness back. */
function aware<T>(f: () => T): T {
  const u = lib().user32;
  const before = u.SetThreadDpiAwarenessContext(PER_MONITOR_V2);
  try {
    return f();
  } finally {
    // 0: the call failed (Windows before 10 1607), nothing to put back.
    if (before !== 0n) u.SetThreadDpiAwarenessContext(before);
  }
}

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const HALFTONE = 4;

function screenSize(): { w: number; h: number } {
  return aware(() => ({ w: lib().user32.GetSystemMetrics(SM_CXSCREEN), h: lib().user32.GetSystemMetrics(SM_CYSCREEN) }));
}

function grab(region: Rect | undefined, out: { w: number; h: number } | undefined): Image {
  const { user32: u, gdi32: g } = lib();
  return aware(() => {
    const full = { w: u.GetSystemMetrics(SM_CXSCREEN), h: u.GetSystemMetrics(SM_CYSCREEN) };
    const r = clampRect(full, region ?? { x: 0, y: 0, ...full });
    const ow = Math.max(1, Math.round(out?.w ?? r.w));
    const oh = Math.max(1, Math.round(out?.h ?? r.h));
    const screen = u.GetDC(null);
    if (screen === null) throw new Error("Windows gave no screen to read (GetDC failed)");
    const mem = g.CreateCompatibleDC(screen);
    const info = new Uint8Array(44);
    const v = new DataView(info.buffer);
    v.setUint32(0, 40, true);
    v.setInt32(4, ow, true);
    // Negative: rows top first.
    v.setInt32(8, -oh, true);
    v.setUint16(12, 1, true);
    v.setUint16(14, 32, true);
    const bitsOut = new BigUint64Array(1);
    const bmp = g.CreateDIBSection(screen, ptr(info), 0, ptr(bitsOut), null, 0);
    try {
      if (mem === null || bmp === null) throw new Error("Windows couldn't make a bitmap for the screenshot");
      const old = g.SelectObject(mem, bmp);
      const ok =
        ow === r.w && oh === r.h
          ? g.BitBlt(mem, 0, 0, ow, oh, screen, r.x, r.y, SRCCOPY | CAPTUREBLT)
          : (g.SetStretchBltMode(mem, HALFTONE), g.SetBrushOrgEx(mem, 0, 0, null), g.StretchBlt(mem, 0, 0, ow, oh, screen, r.x, r.y, r.w, r.h, SRCCOPY | CAPTUREBLT));
      g.SelectObject(mem, old);
      if (ok === 0) throw new Error("Windows refused to copy the screen (BitBlt failed: a secure desktop, or a locked session?)");
      const bits = Number(bitsOut[0]) as Pointer;
      const px = new Uint8Array(toArrayBuffer(bits, 0, ow * oh * 4)).slice();
      return { w: ow, h: oh, rgba: bgraToRgba(px) };
    } finally {
      if (bmp !== null) g.DeleteObject(bmp);
      if (mem !== null) g.DeleteDC(mem);
      u.ReleaseDC(null, screen);
    }
  });
}

// --- SendInput: INPUT is 40 bytes on 64-bit Windows (type, then the union at 8) ---

const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSE = { leftdown: 0x2, leftup: 0x4, rightdown: 0x8, rightup: 0x10, middledown: 0x20, middleup: 0x40, wheel: 0x800, hwheel: 0x1000 };
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
const WHEEL_DELTA = 120;

type In = { kind: "mouse"; flags: number; data?: number } | { kind: "key"; vk: number; scan?: number; flags: number };

function send(inputs: In[]): void {
  if (inputs.length === 0) return;
  const buf = new Uint8Array(INPUT_SIZE * inputs.length);
  const v = new DataView(buf.buffer);
  inputs.forEach((x, i) => {
    const o = i * INPUT_SIZE;
    if (x.kind === "mouse") {
      v.setUint32(o, INPUT_MOUSE, true);
      v.setInt32(o + 16, x.data ?? 0, true);
      v.setUint32(o + 20, x.flags, true);
    } else {
      v.setUint32(o, INPUT_KEYBOARD, true);
      v.setUint16(o + 8, x.vk, true);
      v.setUint16(o + 10, x.scan ?? 0, true);
      v.setUint32(o + 12, x.flags, true);
    }
  });
  const sent = lib().user32.SendInput(inputs.length, ptr(buf), INPUT_SIZE);
  // UIPI: a window of an elevated (administrator) program takes no input from a normal one.
  if (sent !== inputs.length) throw new Error(`Windows took ${sent} of ${inputs.length} input events (the focused window may be an administrator's, which a normal program can't send input to)`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buttonFlags(b: Button): [number, number] {
  return b === "left" ? [MOUSE.leftdown, MOUSE.leftup] : b === "right" ? [MOUSE.rightdown, MOUSE.rightup] : [MOUSE.middledown, MOUSE.middleup];
}

function keyIns(k: string, up: boolean): In {
  const [vk, ext] = winVk(k);
  return { kind: "key", vk, flags: (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0) };
}

export function backend(): Backend {
  return {
    name: "Windows (GDI screenshots, SendInput)",
    size: async () => screenSize(),
    capture: async (region, out) => grab(region, out),
    move: async (x, y) => {
      const ok = aware(() => lib().user32.SetCursorPos(Math.round(x), Math.round(y)));
      if (ok === 0) throw new Error("Windows refused to move the pointer (SetCursorPos failed)");
    },
    button: async (b, how, count = 1) => {
      const [down, up] = buttonFlags(b);
      if (how === "down") return send([{ kind: "mouse", flags: down }]);
      if (how === "up") return send([{ kind: "mouse", flags: up }]);
      // Within the double-click time, so double and triple clicks count as one gesture.
      const gap = Math.min(60, Math.floor(lib().user32.GetDoubleClickTime() / 4));
      for (let i = 0; i < count; i++) {
        if (i > 0) await pause(gap);
        send([
          { kind: "mouse", flags: down },
          { kind: "mouse", flags: up },
        ]);
      }
    },
    scroll: async (dir: Direction, amount) => {
      const horizontal = dir === "left" || dir === "right";
      // Positive wheel data scrolls up (away from the user), a positive hwheel right.
      const sign = dir === "up" || dir === "right" ? 1 : -1;
      for (let i = 0; i < amount; i++) {
        send([{ kind: "mouse", flags: horizontal ? MOUSE.hwheel : MOUSE.wheel, data: sign * WHEEL_DELTA }]);
        await pause(15);
      }
    },
    key: async (c: Combo, how = "press") => {
      const keys = [...c.mods, ...(c.key === "" ? [] : [c.key])];
      const downs = keys.map((k) => keyIns(k, false));
      const ups = [...keys].reverse().map((k) => keyIns(k, true));
      if (how === "down") return send(downs);
      if (how === "up") return send(ups);
      send(downs);
      await pause(20);
      send(ups);
    },
    type: async (text) => {
      // Each UTF-16 unit as a Unicode keystroke (layout-independent); new lines and tabs as their keys.
      const units = [...text.replace(/\r\n?/g, "\n")];
      for (let i = 0; i < units.length; i += 50) {
        const batch: In[] = [];
        for (const ch of units.slice(i, i + 50)) {
          if (ch === "\n" || ch === "\t") {
            batch.push(keyIns(ch === "\n" ? "return" : "tab", false), keyIns(ch === "\n" ? "return" : "tab", true));
            continue;
          }
          for (let j = 0; j < ch.length; j++) {
            const unit = ch.charCodeAt(j);
            batch.push({ kind: "key", vk: 0, scan: unit, flags: KEYEVENTF_UNICODE }, { kind: "key", vk: 0, scan: unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
          }
        }
        send(batch);
        await pause(12);
      }
    },
    cursor: async () => {
      const p = new Int32Array(2);
      const ok = aware(() => lib().user32.GetCursorPos(ptr(p)));
      return ok === 0 ? null : { x: p[0] ?? 0, y: p[1] ?? 0 };
    },
  };
}
