// What has the keyboard focus on macOS, for computer use's refusal to type secrets: the Accessibility API's focused
// element (subrole AXSecureTextField) and the process that owns it (SecurityAgent, coreautha). Uses the
// Accessibility permission computer use already needs; each call is bounded by a short messaging timeout so a
// hung app can't hold Harbor. Loaded only on macOS.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { jsString, nsString, pool } from "./darwin-objc.ts";
import { macFocus, type SecureFocus } from "./screen/secure.ts";

const P = FFIType.ptr;
const AX = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

let libs: ReturnType<typeof open> | undefined;
function open() {
  const ax = dlopen(AX, {
    AXUIElementCreateSystemWide: { args: [], returns: P },
    AXUIElementSetMessagingTimeout: { args: [P, FFIType.f32], returns: FFIType.i32 },
    AXUIElementCopyAttributeValue: { args: [P, P, P], returns: FFIType.i32 },
    AXUIElementGetPid: { args: [P, P], returns: FFIType.i32 },
  }).symbols;
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [P], returns: FFIType.void },
    CFGetTypeID: { args: [P], returns: FFIType.u64 },
    CFStringGetTypeID: { args: [], returns: FFIType.u64 },
  }).symbols;
  const sys = dlopen("/usr/lib/libSystem.B.dylib", { proc_name: { args: [FFIType.i32, P, FFIType.u32], returns: FFIType.i32 } }).symbols;
  return { ax, cf, sys };
}
const lib = () => (libs ??= open());

/** Seconds an Accessibility call may wait on an app. */
const TIMEOUT_S = 0.2;

/** An attribute of `el` (a CF object, the caller releases it), or null. */
function attr(el: Pointer, name: string): Pointer | null {
  const out = new BigUint64Array(1);
  const err = lib().ax.AXUIElementCopyAttributeValue(el, nsString(name), ptr(out));
  return err === 0 && out[0] !== 0n ? (Number(out[0]) as unknown as Pointer) : null;
}

/** A string attribute of `el`, "" when it has none. */
function str(el: Pointer, name: string): string {
  const v = attr(el, name);
  if (v === null) return "";
  try {
    const { cf } = lib();
    return cf.CFGetTypeID(v) === cf.CFStringGetTypeID() ? jsString(v) : "";
  } finally {
    lib().cf.CFRelease(v);
  }
}

function procName(pid: number): string {
  const buf = new Uint8Array(64);
  const n = lib().sys.proc_name(pid, ptr(buf), buf.length);
  return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "";
}

/** What has the keyboard focus now; "unknown" when macOS won't say (never throws). */
export async function secureFocus(): Promise<SecureFocus> {
  try {
    return pool((): SecureFocus => {
      const { ax, cf } = lib();
      const sys = ax.AXUIElementCreateSystemWide() as Pointer | null;
      if (sys === null) return { state: "unknown", why: "no system-wide Accessibility element" };
      try {
        ax.AXUIElementSetMessagingTimeout(sys, TIMEOUT_S);
        const el = attr(sys, "AXFocusedUIElement");
        if (el === null) return { state: "unknown", why: "Accessibility gave no focused element (permission, or nothing focused)" };
        try {
          ax.AXUIElementSetMessagingTimeout(el, TIMEOUT_S);
          const pid = new Int32Array(1);
          const proc = ax.AXUIElementGetPid(el, ptr(pid)) === 0 ? procName(pid[0] ?? 0) : "";
          return macFocus(str(el, "AXRole"), str(el, "AXSubrole"), proc);
        } finally {
          cf.CFRelease(el);
        }
      } finally {
        cf.CFRelease(sys);
      }
    });
  } catch (e) {
    return { state: "unknown", why: e instanceof Error ? e.message : String(e) };
  }
}

