import { CFunction, CString, dlopen, FFIType, JSCallback, type Pointer, read, toArrayBuffer } from "bun:ffi";
import { libc as osLibc } from "@harbor/os";

export class LibmpvUnavailable extends Error {
  constructor(readonly tried: readonly string[]) {
    super(`no libmpv: tried ${tried.join(", ")}`);
    this.name = "LibmpvUnavailable";
  }
}

export const FORMAT_STRING = 1;
export const FORMAT_FLAG = 3;
export const FORMAT_INT64 = 4;
export const FORMAT_DOUBLE = 5;

export const END_FILE_ERROR = 4;

const EVENT_NONE = 0;
const EVENT_END_FILE = 7;
const EVENT_FILE_LOADED = 8;
const EVENT_IDLE = 11;
const EVENT_PLAYBACK_RESTART = 21;
const EVENT_PROPERTY_CHANGE = 22;

export const RTLD_NOW = 2;
export const RTLD_GLOBAL = 0x100;

const LIBC = {
  calloc: { args: [FFIType.u64, FFIType.u64], returns: FFIType.ptr },
  free: { args: [FFIType.ptr], returns: FFIType.void },
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
} as const;

let libcSyms: ReturnType<typeof dlopen<typeof LIBC>>["symbols"] | undefined;

/** The C library's allocator and loader, opened when the player is first used (importing this starts nothing). */
function libc(): ReturnType<typeof dlopen<typeof LIBC>>["symbols"] {
  const name = osLibc.libcNames()[0];
  if (name === undefined) throw new Error("no C library to load the video player with");
  return (libcSyms ??= dlopen(name, LIBC).symbols);
}

function pointer(v: bigint | Pointer | null): Pointer | null {
  return typeof v === "bigint" ? (Number(v) as Pointer) : v;
}

/** mpv keeps these addresses across calls and a typed array can move under the collector, so this is calloc'd outside the heap. */
export class Native {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  private freed = false;

  private constructor(
    readonly addr: Pointer,
    readonly size: number,
  ) {
    const buffer = toArrayBuffer(addr, 0, size);
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  static alloc(size: number): Native {
    const addr = pointer(libc().calloc(1, Math.max(size, 1)));
    if (!addr) throw new Error(`out of memory (${size} bytes)`);
    return new Native(addr, size);
  }

  static text(s: string): Native {
    const bytes = Buffer.from(s, "utf8");
    const n = Native.alloc(bytes.length + 1);
    n.bytes.set(bytes);
    return n;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    libc().free(this.addr);
  }
}

function addrOf(n: Native, offset = 0): bigint {
  return BigInt(n.addr) + BigInt(offset);
}

export function globalLibrary(name: string): boolean {
  const n = Native.text(name);
  try {
    return pointer(libc().dlopen(n.addr, RTLD_NOW | RTLD_GLOBAL)) !== null;
  } finally {
    n.free();
  }
}

export function hasSymbol(name: string): boolean {
  const n = Native.text(name);
  try {
    return pointer(libc().dlsym(null, n.addr)) !== null;
  } finally {
    n.free();
  }
}

export function pipewireVersion(): string | null {
  const n = Native.text("pw_get_library_version");
  try {
    const f = pointer(libc().dlsym(null, n.addr));
    if (!f) return null;
    const version = pointer(CFunction({ ptr: f, args: [], returns: FFIType.ptr })());
    return version ? new CString(version).toString() : null;
  } finally {
    n.free();
  }
}

const SYMBOLS = {
  mpv_create: { args: [], returns: FFIType.ptr },
  mpv_initialize: { args: [FFIType.ptr], returns: FFIType.i32 },
  mpv_terminate_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  mpv_set_option_string: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_set_property_string: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_get_property_string: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  mpv_free: { args: [FFIType.ptr], returns: FFIType.void },
  mpv_command: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_observe_property: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mpv_wait_event: { args: [FFIType.ptr, FFIType.f64], returns: FFIType.ptr },
  mpv_set_wakeup_callback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  mpv_error_string: { args: [FFIType.i32], returns: FFIType.ptr },
  mpv_render_context_create: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_set_update_callback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  mpv_render_context_update: { args: [FFIType.ptr], returns: FFIType.u64 },
  mpv_render_context_render: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

export type MpvLib = ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"];

export function loadMpv(paths: readonly string[]): { lib: MpvLib; path: string } {
  for (const path of paths) {
    try {
      return { lib: dlopen(path, SYMBOLS).symbols, path };
    } catch {
      // not there, or too old to have the render API: the next one
    }
  }
  throw new LibmpvUnavailable(paths);
}

export type PropertyValue = number | string | boolean | null;

export type MpvEvent =
  | { kind: "none" }
  | { kind: "fileLoaded" }
  | { kind: "playbackRestart" }
  | { kind: "idle" }
  | { kind: "endFile"; reason: number; error: number }
  | { kind: "property"; id: number; name: string; format: number; value: PropertyValue }
  | { kind: "other"; id: number };

export class Mpv {
  private wakeup: JSCallback | null = null;
  private alive = true;

  private constructor(
    private readonly lib: MpvLib,
    readonly handle: Pointer,
  ) {}

  static create(lib: MpvLib, options: readonly (readonly [string, string])[]): Mpv {
    const handle = pointer(lib.mpv_create());
    if (!handle) throw new Error("mpv didn't start");
    const mpv = new Mpv(lib, handle);
    for (const [name, value] of options) mpv.setOption(name, value);
    if (lib.mpv_initialize(handle) < 0) {
      lib.mpv_terminate_destroy(handle);
      throw new Error("mpv didn't start");
    }
    return mpv;
  }

  private text<T>(args: readonly string[], f: (p: Native[]) => T): T {
    const made = args.map((a) => Native.text(a));
    try {
      return f(made);
    } finally {
      for (const m of made) m.free();
    }
  }

  setOption(name: string, value: string): number {
    return this.text([name, value], ([n, v]) => this.lib.mpv_set_option_string(this.handle, n!.addr, v!.addr));
  }

  setProperty(name: string, value: string): number {
    return this.text([name, value], ([n, v]) => this.lib.mpv_set_property_string(this.handle, n!.addr, v!.addr));
  }

  property(name: string): string {
    return this.text([name], ([n]) => {
      const v = pointer(this.lib.mpv_get_property_string(this.handle, n!.addr));
      if (!v) return "";
      const s = new CString(v).toString();
      this.lib.mpv_free(v);
      return s;
    });
  }

  command(...args: string[]): number {
    return this.text(args, (made) => {
      const argv = Native.alloc(8 * (made.length + 1));
      try {
        made.forEach((m, i) => argv.view.setBigUint64(i * 8, addrOf(m), true));
        return this.lib.mpv_command(this.handle, argv.addr);
      } finally {
        argv.free();
      }
    });
  }

  observe(id: number, name: string, format: number): number {
    return this.text([name], ([n]) => this.lib.mpv_observe_property(this.handle, BigInt(id), n!.addr, format));
  }

  errorString(code: number): string {
    const s = pointer(this.lib.mpv_error_string(code));
    return s ? new CString(s).toString() : `error ${code}`;
  }

  /** `fn` runs on the event loop after mpv's own threads say there is something new. */
  onWakeup(fn: () => void): void {
    this.wakeup?.close();
    this.wakeup = new JSCallback(fn, { args: ["ptr"], returns: "void", threadsafe: true });
    this.lib.mpv_set_wakeup_callback(this.handle, this.wakeup.ptr, null);
  }

  waitEvent(seconds: number): MpvEvent {
    const ev = pointer(this.lib.mpv_wait_event(this.handle, seconds));
    if (!ev) return { kind: "none" };
    const id = read.i32(ev, 0);
    const data = read.ptr(ev, 16);
    switch (id) {
      case EVENT_NONE:
        return { kind: "none" };
      case EVENT_FILE_LOADED:
        return { kind: "fileLoaded" };
      case EVENT_PLAYBACK_RESTART:
        return { kind: "playbackRestart" };
      case EVENT_IDLE:
        return { kind: "idle" };
      case EVENT_END_FILE:
        return data ? { kind: "endFile", reason: read.i32(data, 0), error: read.i32(data, 4) } : { kind: "endFile", reason: 0, error: 0 };
      case EVENT_PROPERTY_CHANGE:
        return data ? propertyEvent(Number(read.u64(ev, 8)), data) : { kind: "other", id };
      default:
        return { kind: "other", id };
    }
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.lib.mpv_set_wakeup_callback(this.handle, null, null);
    this.lib.mpv_terminate_destroy(this.handle);
    this.wakeup?.close();
    this.wakeup = null;
  }
}

function propertyEvent(id: number, p: number): MpvEvent {
  const namePtr = read.ptr(p, 0);
  const name = namePtr ? new CString(namePtr).toString() : "";
  const format = read.i32(p, 8);
  const data = read.ptr(p, 16);
  let value: PropertyValue = null;
  if (data) {
    if (format === FORMAT_DOUBLE) value = read.f64(data, 0);
    else if (format === FORMAT_FLAG) value = read.i32(data, 0) !== 0;
    else if (format === FORMAT_INT64) value = Number(read.i64(data, 0));
    else if (format === FORMAT_STRING) {
      const s = read.ptr(data, 0);
      value = s ? new CString(s).toString() : "";
    }
  }
  return { kind: "property", id, name, format: data ? format : 0, value };
}
