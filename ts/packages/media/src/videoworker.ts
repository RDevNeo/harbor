// The video player's renderer (video.ts), in a Worker of its own: libmpv's software render API draws each frame here,
// so the window's thread only copies a finished picture. The pixel buffers belong to the window's thread; a frame goes
// into a buffer it has handed back, and with none free the frame waits and the newest one is drawn later: frames are
// dropped, never queued. Loaded as text (a compiled executable has no file beside it): nothing but bun:ffi.
import { dlopen, FFIType, JSCallback, type Pointer, toArrayBuffer } from "bun:ffi";

declare const self: Worker;

type In =
  | { t: "init"; lib: string; mpv: number }
  | { t: "target"; gen: number; width: number; height: number; bufs: number[] }
  | { t: "free"; gen: number; i: number }
  | { t: "force" }
  | { t: "quit" };

const RENDER_API_TYPE = 1;
const BLOCK_FOR_TARGET_TIME = 12;
const SW_SIZE = 17;
const SW_FORMAT = 18;
const SW_STRIDE = 19;
const SW_POINTER = 20;
const UPDATE_FRAME = 1n;
const PARAMS = 160;

const libc = dlopen("libc.so.6", {
  calloc: { args: [FFIType.u64, FFIType.u64], returns: FFIType.ptr },
  free: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols;

const SYMBOLS = {
  mpv_render_context_create: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_set_update_callback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  mpv_render_context_update: { args: [FFIType.ptr], returns: FFIType.u64 },
  mpv_render_context_render: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type Lib = ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"];

function alloc(size: number): { addr: Pointer; view: DataView } {
  const p = libc.calloc(1, size);
  const addr = (typeof p === "bigint" ? Number(p) : p) as Pointer | null;
  if (!addr) throw new Error("out of memory");
  return { addr, view: new DataView(toArrayBuffer(addr, 0, size)) };
}

let lib: Lib | null = null;
let ctx: Pointer | null = null;
let callback: JSCallback | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
/**
 * mpv's VO thread can wait for this thread to answer (its dispatch queue runs inside an update), and a wake-up from
 * another thread into an idle worker was seen lost once: the player then hung. A cheap update this often answers it.
 */
const TICK_MS = 20;
let gen = -1;
let params: Pointer[] = [];
let free: boolean[] = [];
let pending = false;
let force = false;
let frames = 0;
let total = 0;
let most = 0;

function post(m: Record<string, unknown>): void {
  self.postMessage(m);
}

function init(path: string, mpv: number): void {
  const l = dlopen(path, SYMBOLS).symbols;
  const block = alloc(64);
  try {
    // "sw\0" at 48, the parameter list at 0.
    block.view.setUint8(48, 0x73);
    block.view.setUint8(49, 0x77);
    block.view.setInt32(0, RENDER_API_TYPE, true);
    block.view.setBigUint64(8, BigInt(block.addr) + 48n, true);
    const code = l.mpv_render_context_create((block.addr + 32) as Pointer, mpv as Pointer, block.addr);
    if (code < 0) throw new Error(`mpv can't draw here (${code})`);
    ctx = Number(block.view.getBigUint64(32, true)) as Pointer;
  } finally {
    libc.free(block.addr);
  }
  lib = l;
  callback = new JSCallback(due, { args: ["ptr"], returns: "void", threadsafe: true });
  l.mpv_render_context_set_update_callback(ctx, callback.ptr, null);
  tick = setInterval(due, TICK_MS);
}

function target(m: { gen: number; width: number; height: number; bufs: number[] }): void {
  for (const p of params) libc.free(p);
  params = m.bufs.map((buf) => {
    const { addr, view } = alloc(PARAMS);
    const base = BigInt(addr);
    view.setInt32(128, m.width, true);
    view.setInt32(132, m.height, true);
    view.setBigUint64(136, BigInt(m.width * 4), true);
    view.setInt32(144, 0, true);
    for (const [i, c] of [..."rgba"].entries()) view.setUint8(148 + i, c.charCodeAt(0));
    const entries: [number, bigint][] = [
      [SW_SIZE, base + 128n],
      [SW_FORMAT, base + 148n],
      [SW_STRIDE, base + 136n],
      [SW_POINTER, BigInt(buf)],
      [BLOCK_FOR_TARGET_TIME, base + 144n],
      [0, 0n],
    ];
    entries.forEach(([kind, data], i) => {
      view.setInt32(i * 16, kind, true);
      view.setBigUint64(i * 16 + 8, data, true);
    });
    return addr;
  });
  gen = m.gen;
  free = m.bufs.map(() => true);
  force = true;
  post({ t: "using", gen });
  draw();
}

/** mpv's update callback: each one must be answered with an update; a frame is drawn once a buffer is free. */
function due(): void {
  if (lib === null || ctx === null) return;
  if ((lib.mpv_render_context_update(ctx) & UPDATE_FRAME) !== 0n) pending = true;
  draw();
}

function draw(): void {
  if (lib === null || ctx === null || !(pending || force)) return;
  const i = free.indexOf(true);
  if (i < 0) return;
  pending = false;
  force = false;
  const t = performance.now();
  const code = lib.mpv_render_context_render(ctx, params[i]!);
  const ms = performance.now() - t;
  frames += 1;
  total += ms;
  most = Math.max(most, ms);
  if (code < 0) return;
  free[i] = false;
  post({ t: "frame", gen, i });
}

function quit(): void {
  if (tick !== null) clearInterval(tick);
  tick = null;
  if (lib !== null && ctx !== null) {
    lib.mpv_render_context_set_update_callback(ctx, null, null);
    lib.mpv_render_context_free(ctx);
  }
  ctx = null;
  callback?.close();
  callback = null;
  for (const p of params) libc.free(p);
  params = [];
  post({ t: "freed", frames, avg: total / Math.max(frames, 1), max: most });
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    switch (m.t) {
      case "init":
        init(m.lib, m.mpv);
        post({ t: "ready" });
        break;
      case "target":
        target(m);
        break;
      case "free":
        if (m.gen === gen && m.i < free.length) free[m.i] = true;
        draw();
        break;
      case "force":
        force = true;
        draw();
        break;
      case "quit":
        quit();
        break;
    }
  } catch (err) {
    post({ t: "failed", why: err instanceof Error ? err.message : String(err) });
  }
};
