// Computer use on macOS: the main display with `screencapture` (Screen Recording permission), the pointer,
// buttons, wheel and keyboard as CoreGraphics events posted to the HID tap (Accessibility permission). A
// CGPoint goes by value as its two doubles (both ABIs pass a struct of two doubles in two FP registers).
// Screen pixels are the screenshot's (Retina: twice the points); events take points. Loaded only on macOS.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Button, Direction, Probe } from "./screen/backend.ts";
import { decode, type Image } from "./screen/image.ts";
import { type Combo, macFlags, macKeycode } from "./screen/keys.ts";

const P = FFIType.ptr;
const F = "/System/Library/Frameworks";

let libs: ReturnType<typeof open> | undefined;
function open() {
  const cg = dlopen(`${F}/CoreGraphics.framework/CoreGraphics`, {
    CGMainDisplayID: { args: [], returns: FFIType.u32 },
    CGDisplayCopyDisplayMode: { args: [FFIType.u32], returns: P },
    CGDisplayModeGetWidth: { args: [P], returns: FFIType.u64 },
    CGDisplayModeGetHeight: { args: [P], returns: FFIType.u64 },
    CGDisplayModeGetPixelWidth: { args: [P], returns: FFIType.u64 },
    CGDisplayModeRelease: { args: [P], returns: FFIType.void },
    CGEventCreateMouseEvent: { args: [P, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32], returns: P },
    CGEventCreateKeyboardEvent: { args: [P, FFIType.u16, FFIType.bool], returns: P },
    CGEventCreateScrollWheelEvent2: { args: [P, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32], returns: P },
    CGEventKeyboardSetUnicodeString: { args: [P, FFIType.u64, P], returns: FFIType.void },
    CGEventSetFlags: { args: [P, FFIType.u64], returns: FFIType.void },
    CGEventSetIntegerValueField: { args: [P, FFIType.u32, FFIType.i64], returns: FFIType.void },
    CGEventPost: { args: [FFIType.u32, P], returns: FFIType.void },
    CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
  }).symbols;
  const cf = dlopen(`${F}/CoreFoundation.framework/CoreFoundation`, { CFRelease: { args: [P], returns: FFIType.void } }).symbols;
  const ax = dlopen(`${F}/ApplicationServices.framework/ApplicationServices`, { AXIsProcessTrusted: { args: [], returns: FFIType.bool } }).symbols;
  return { cg, cf, ax };
}
const lib = () => (libs ??= open());

const EV = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6, rightDragged: 7, otherDown: 25, otherUp: 26, otherDragged: 27 };
const HID_TAP = 0;
const CLICK_STATE = 1;
const LINE_UNITS = 1;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The main display in points, and its pixels per point (2 on Retina). */
function display(): { w: number; h: number; scale: number } {
  const { cg } = lib();
  const mode = cg.CGDisplayCopyDisplayMode(cg.CGMainDisplayID());
  if (mode === null) throw new Error("macOS gave no display mode for the main display");
  try {
    const w = Number(cg.CGDisplayModeGetWidth(mode));
    const px = Number(cg.CGDisplayModeGetPixelWidth(mode));
    return { w, h: Number(cg.CGDisplayModeGetHeight(mode)), scale: w > 0 && px > 0 ? px / w : 1 };
  } finally {
    cg.CGDisplayModeRelease(mode);
  }
}

function post(made: unknown): void {
  const ev = made as Pointer | null;
  if (ev === null) throw new Error("macOS couldn't make the input event");
  lib().cg.CGEventPost(HID_TAP, ev);
  lib().cf.CFRelease(ev);
}

/** What's missing; `ask`: macOS shows its Screen Recording prompt when that permission isn't given yet. */
export function probe(ask = false): Probe {
  const { cg, ax } = lib();
  const missing: string[] = [];
  if (!cg.CGPreflightScreenCaptureAccess()) {
    // Asked when an agent wants the screen (not when Settings looks): macOS's own prompt, then the switch in System Settings.
    if (ask) cg.CGRequestScreenCaptureAccess();
    missing.push("Screen Recording permission for Harbor (System Settings › Privacy & Security › Screen Recording)");
  }
  if (!ax.AXIsProcessTrusted()) missing.push("Accessibility permission for Harbor, to move the pointer and type (System Settings › Privacy & Security › Accessibility)");
  return { ok: missing.length === 0, kind: "macos", name: "macOS (screencapture, CoreGraphics events)", missing, limits: ["cursor_position is where Harbor last moved the pointer"] };
}

export function backend(): Backend {
  // Screen pixels per point (2 on Retina): the display mode's until a screenshot says otherwise.
  let scale = 0;
  const ratio = (): number => (scale > 0 ? scale : (scale = display().scale));
  let last: { x: number; y: number } | null = null;
  const held = new Set<Button>();
  const shoot = async (): Promise<Image> => {
    const dir = mkdtempSync(join(tmpdir(), "harbor-shot-"));
    const file = join(dir, "screen.png");
    try {
      const p = Bun.spawn(["screencapture", "-x", "-m", "-t", "png", file], { stdout: "ignore", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) throw new Error(`screencapture failed (exit ${code}): ${(await new Response(p.stderr).text()).trim()}`);
      const img = decode(new Uint8Array(readFileSync(file)));
      if (img === null) throw new Error("couldn't read screencapture's PNG");
      scale = img.w / display().w;
      return img;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const at = (): [number, number] => [(last?.x ?? 0) / ratio(), (last?.y ?? 0) / ratio()];
  const mouse = (type: number, b: number, clicks = 0): void => {
    const [x, y] = at();
    const ev = lib().cg.CGEventCreateMouseEvent(null, type, x, y, b);
    if (ev !== null && clicks > 0) lib().cg.CGEventSetIntegerValueField(ev, CLICK_STATE, clicks);
    post(ev);
  };
  const codes = (b: Button): [down: number, up: number, n: number] => (b === "left" ? [EV.leftDown, EV.leftUp, 0] : b === "right" ? [EV.rightDown, EV.rightUp, 1] : [EV.otherDown, EV.otherUp, 2]);
  const keyEv = (code: number, down: boolean, flags: number): void => {
    const ev = lib().cg.CGEventCreateKeyboardEvent(null, code, down);
    if (ev !== null) lib().cg.CGEventSetFlags(ev, flags);
    post(ev);
  };
  return {
    name: "macOS (screencapture, CoreGraphics events)",
    secureFocus: () => (require("./darwin-secure.ts") as typeof import("./darwin-secure.ts")).secureFocus(),
    size: async () => {
      const d = display();
      return { w: Math.round(d.w * ratio()), h: Math.round(d.h * ratio()) };
    },
    capture: async () => shoot(),
    move: async (x, y) => {
      last = { x: Math.round(x), y: Math.round(y) };
      const type = held.has("left") ? EV.leftDragged : held.has("right") ? EV.rightDragged : held.has("middle") ? EV.otherDragged : EV.moved;
      mouse(type, held.has("right") ? 1 : held.has("middle") ? 2 : 0);
    },
    button: async (b, how, count = 1) => {
      const [down, up, n] = codes(b);
      if (how === "down") {
        held.add(b);
        return mouse(down, n, 1);
      }
      if (how === "up") {
        held.delete(b);
        return mouse(up, n, 1);
      }
      for (let i = 1; i <= count; i++) {
        mouse(down, n, i);
        mouse(up, n, i);
        if (i < count) await pause(60);
      }
    },
    scroll: async (dir: Direction, amount) => {
      // Positive is up (wheel 1) and left (wheel 2).
      const v = dir === "up" ? 1 : dir === "down" ? -1 : 0;
      const h = dir === "left" ? 1 : dir === "right" ? -1 : 0;
      for (let i = 0; i < amount; i++) {
        post(lib().cg.CGEventCreateScrollWheelEvent2(null, LINE_UNITS, 2, v * 3, h * 3, 0));
        await pause(15);
      }
    },
    key: async (c: Combo, how = "press") => {
      const flags = macFlags(c.mods);
      const mods = c.mods.map((m) => macKeycode(m));
      if (how !== "up") {
        for (const m of mods) keyEv(m, true, flags);
        if (c.key !== "") keyEv(macKeycode(c.key), true, flags);
      }
      if (how === "press") await pause(20);
      if (how !== "down") {
        if (c.key !== "") keyEv(macKeycode(c.key), false, flags);
        for (const m of [...mods].reverse()) keyEv(m, false, 0);
      }
    },
    type: async (t) => {
      const lines = t.replace(/\r\n?/g, "\n").split("\n");
      for (const [i, line] of lines.entries()) {
        if (i > 0) {
          keyEv(macKeycode("return"), true, 0);
          keyEv(macKeycode("return"), false, 0);
        }
        // Up to 20 UTF-16 units an event (what the event carries).
        for (let o = 0; o < line.length; o += 20) {
          const chunk = Buffer.from(line.slice(o, o + 20), "utf16le");
          for (const down of [true, false]) {
            const ev = lib().cg.CGEventCreateKeyboardEvent(null, 0, down);
            if (ev !== null) lib().cg.CGEventKeyboardSetUnicodeString(ev, chunk.length / 2, ptr(chunk));
            post(ev);
          }
          await pause(12);
        }
      }
    },
    cursor: async () => last,
  };
}
