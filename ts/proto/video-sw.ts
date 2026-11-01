// Phase 0 probe: Slint's JS API has no GL hook and no window handle, so libmpv can only reach a Slint
// window as pixels: its software renderer into a buffer, copied into an image property each frame.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { readFileSync } from "node:fs";
import * as slint from "slint-ui";
import { runLoop } from "./loop.ts";

const [clip, secondsArg, wArg, hArg] = process.argv.slice(2);
if (!clip) throw new Error("video-sw CLIP [SECONDS] [WIDTH] [HEIGHT]");
const seconds = Number(secondsArg ?? 10);
const W = Number(wArg ?? 1400);
const H = Number(hArg ?? 788);

const mpv = dlopen(process.env.HTS_LIBMPV ?? "libmpv.so.2", {
  mpv_create: { args: [], returns: FFIType.ptr },
  mpv_set_option_string: { args: [FFIType.ptr, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
  mpv_initialize: { args: [FFIType.ptr], returns: FFIType.i32 },
  mpv_command: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_get_property_string: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.cstring },
  mpv_render_context_create: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_update: { args: [FFIType.ptr], returns: FFIType.u64 },
  mpv_render_context_render: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mpv_render_context_free: { args: [FFIType.ptr], returns: FFIType.void },
  mpv_terminate_destroy: { args: [FFIType.ptr], returns: FFIType.void },
});
const f = mpv.symbols;

const cstr = (s: string) => Buffer.from(`${s}\0`);
const keep: Buffer[] = [];
function c(s: string): Pointer {
  const b = cstr(s);
  keep.push(b);
  return ptr(b);
}

/** mpv_render_param[]: {int type; void *data}, 16 bytes each on 64-bit, ended by type 0. */
function params(list: [number, Pointer][]): Buffer {
  const b = Buffer.alloc((list.length + 1) * 16);
  list.forEach(([type, data], i) => {
    b.writeInt32LE(type, i * 16);
    b.writeBigUInt64LE(BigInt(data), i * 16 + 8);
  });
  return b;
}

const handle = f.mpv_create();
if (!handle) throw new Error("mpv_create");
for (const [k, v] of [["vo", "libmpv"], ["hwdec", process.env.HTS_HWDEC ?? "auto-copy"], ["ao", "null"], ["loop-file", "inf"], ["terminal", "no"]] as const) {
  f.mpv_set_option_string(handle, cstr(k), cstr(v));
}
if (f.mpv_initialize(handle) < 0) throw new Error("mpv_initialize");

const ctxOut = new BigUint64Array(1);
if (f.mpv_render_context_create(ptr(ctxOut), handle, ptr(params([[1, c("sw")]]))) < 0) throw new Error("render context");
const ctx = Number(ctxOut[0]) as Pointer;

const argv = new BigUint64Array([BigInt(c("loadfile")), BigInt(c(clip)), 0n]);
f.mpv_command(handle, ptr(argv));

const ui = slint.loadSource(
  `export component V inherits Window { title: "hts-video"; width: ${W}px; height: ${H}px; background: black;
     in property <image> frame; Image { source: frame; width: parent.width; height: parent.height; } }`,
  "v.slint",
) as unknown as { V: new () => slint.ComponentHandle & { frame: { width: number; height: number; data: Uint8Array } } };
const win = new ui.V();
win.show();

const pixels = Buffer.alloc(W * H * 4);
const words = new Uint32Array(pixels.buffer, pixels.byteOffset, W * H);
const size = new Int32Array([W, H]);
const stride = new BigUint64Array([BigInt(W * 4)]);
const render = params([
  [17, ptr(size)],
  [18, c("rgb0")],
  [19, ptr(stride)],
  [20, ptr(pixels)],
]);

let frames = 0;
let copyMs = 0;
const cpu = () => {
  const s = readFileSync("/proc/self/stat", "utf8").split(") ")[1]?.split(" ") ?? [];
  return Number(s[11] ?? 0) + Number(s[12] ?? 0);
};
const tick = setInterval(() => {
  if ((f.mpv_render_context_update(ctx) & 1n) === 0n) return;
  f.mpv_render_context_render(ctx, ptr(render));
  const t = performance.now();
  // rgb0's fourth byte is 0, which Slint would draw as transparent.
  for (let i = 0; i < words.length; i++) words[i] = (words[i] ?? 0) | 0xff000000;
  win.frame = { width: W, height: H, data: pixels };
  copyMs += performance.now() - t;
  frames++;
}, 4);

setTimeout(() => {
  const t0 = performance.now();
  const c0 = cpu();
  const f0 = frames;
  const d0 = Number(f.mpv_get_property_string(handle, cstr("frame-drop-count")) ?? 0);
  setTimeout(() => {
    const secs = (performance.now() - t0) / 1000;
    const ticks = cpu() - c0;
    const drops = Number(f.mpv_get_property_string(handle, cstr("frame-drop-count")) ?? 0) - d0;
    console.log(
      `${W}x${H} rgb0 hwdec=${process.env.HTS_HWDEC ?? "auto-copy"}: ${((frames - f0) / secs).toFixed(1)} frames/s shown, ` +
        `${drops} dropped, CPU ${((ticks / 100 / secs) * 100).toFixed(0)}% of one core, ` +
        `JS alpha fix + image copy ${(copyMs / frames).toFixed(2)} ms/frame`,
    );
    clearInterval(tick);
    f.mpv_render_context_free(ctx);
    f.mpv_terminate_destroy(handle);
    win.hide();
    process.exit(0);
  }, seconds * 1000);
}, 2000);

await runLoop();
