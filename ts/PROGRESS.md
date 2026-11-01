# TypeScript rewrite: progress

The owner lifted the Phase 0 gate on 2026-10-31 ("when I wake up I wanna see the full app"), so the later
phases are running. The go/no-go item below stays unchecked: the owner has not read the table yet.

## Phase 0

- [x] `slint-ui` opens a window under Bun on x86_64 and aarch64 (aarch64: real arm64 CPU, virtual display, software GL)
- [x] Mutual TLS with a pinned client certificate works in Bun, TLS 1.3 and 1.2
- [x] `Bun.spawn` with `terminal` drives a shell; `@xterm/headless` parses its output
- [x] `sherpa-onnx-node` transcribes a sample on both architectures
- [x] Video: a written finding on how libmpv frames reach a Slint window (below)
- [x] A table comparing the prototype with Rust Harbor on the same PC (below)
- [ ] The owner reads the table and decides go or no-go

## Done

- The window: `proto/main.ts` with `proto/app.slint`. A Bun + Slint window with the sidebar and one
  chat, reading a read-only copy of harbor.db. A message typed into the composer ran a real Claude
  Code turn (Haiku, a scratch folder, no session saved) and the reply streamed into the transcript.
  It shows messages as plain text: no markdown, no tools, no images.

- Mutual TLS: `proto/tls.ts`, `test/tls.test.ts`, `proto/tls-interop.ts`. On the desk PC, in a network
  namespace, against Harbor 0.108.0 with a throwaway identity:
  - The same `identity.pem` gives the same fingerprint in Rust (`harbor mesh status`), Bun and openssl.
  - An identity generated in TypeScript is read by Rust with the same fingerprint.
  - Bun server, openssl client certificate: TLS 1.3 (TLS_AES_256_GCM_SHA384) and TLS 1.2
    (ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-ECDSA-CHACHA20-POLY1305); Bun saw the right fingerprint.
  - Bun server, real Rust client (`harbor mesh join`, TLS 1.3): Bun saw the Rust fingerprint.
  - Bun client, real Rust server: TLS 1.3 and 1.2 both reached the API (`401`). A wrong pin is refused.
  - Also passing in `bun test`: TLS running over another TLS stream (relay), plain and TLS on one port
    by the first byte, no session resumption (needs `SSL_OP_NO_TICKET`; on by default Bun resumes).

- Terminal: `proto/pty.ts`, `test/pty.test.ts`. bash in Bun's terminal, parsed by `@xterm/headless`: output,
  real tty and size, resize, colours, cursor moves, title, alternate screen, Ctrl+C, wide characters, a
  20,000-line burst, exit code.

- Voice on x86_64: `proto/voice.ts`, `proto/voice-check.ts`. The model Harbor uses (Parakeet TDT 0.6B v3
  int8, hashes checked against `parakeet.rs`) under Bun: 3.1 s to load, about 1 GB RSS, 0.4 s for a 3.8 s
  English sample, German and Spanish right too, language detected by the model.
- `bun build --compile`: `proto/build.ts`. The Slint addon and the `.slint` source work from inside the
  executable, and so does the plan's split: a compiled runtime loading a separate `harbor-app.js`
  (`proto/runtime.ts`; 126.7 MB runtime, 14 KB bundle). The sherpa addon works from inside it too, once
  `libonnxruntime.so` and `libsherpa-onnx-c-api.so` are on `LD_LIBRARY_PATH`.

Environment of `proto/main.ts`, for the rigs: `HTS_DB` (the copy, required), `HTS_CWD` (scratch folder
for turns), `HTS_CLAUDE`, `HTS_MODEL`, `HTS_OPEN` (open that many chats), `HTS_OPEN_AT` (from this one), `HTS_PROMPT` (send at start).

## The table: prototype against Rust Harbor, same PC

Measured on the desk PC (Intel i5-10210U, 8 threads, 7.7 GB RAM that other agents also use), on
a private headless sway with a 1400x900 output, no network (`unshare -Urn`), one scrambled copy of the
owner's harbor.db (105 settled chats), a fake `claude` that streams 40 text deltas a second.
Rust is the 0.108.0 release binary (`harbor 0.108.0 (325cce6)`, sha256 identical to the one in the release
archive). The prototype is `proto/main.ts` compiled by Bun 1.4.3 with slint-ui 1.18.1. Rig: `ts/rig/`.
Every reading holds `~/.cache/hts/check.lock` (no `tsc` or `bun test` of the other agents runs meanwhile);
the load average in the last column is the 1-minute figure at the end of each reading. Two full runs, a
fresh instance for every stage; both are shown as "run 1 / run 2".

| Measure | Rust 0.108.0 | Prototype (Bun + Slint) | Ratio | How measured |
| --- | --- | --- | --- | --- |
| Download, compressed | 24.2 MB (the release `harbor-x86_64-linux.tar.gz`, 24,243,279 bytes) | 56.6 MB runtime alone; 67.1 MB with the bundle and sherpa's two libraries | 2.3x / 2.8x | `tar -I gzip` as release.yml packs it; the Rust figure is the real release asset |
| Download, unpacked | 66.7 MB binary | 126.7 MB runtime; 158.6 MB with the bundle and libraries | 1.9x / 2.4x | file sizes |
| Startup to first frame | 223 / 211 ms | 341 / 361 ms | 1.6x | median of 7 starts: time from launching the process to sway's `window new` event |
| Startup to settled content | 246 / 234 ms | 736 / 744 ms | 3.1x | same starts: first screenshot (grim) equal to the last one taken 2.5 s later |
| Idle RAM (one chat open) | 124.3 / 123.9 MB RSS (30 MB anonymous) | 178.1 + 19.2 swapped = 197 / 181.1 + 19.8 swapped = 201 MB (53 MB anonymous + 19 swapped) | 1.6x | `/proc/PID/smaps_rollup` 30 s after start; this PC swaps, so the swapped part is added |
| RAM after 20 chats opened in a row | 123.4 / 124.9 MB RSS | 232.9 + 19.6 = 252 / 235.1 + 19.0 = 254 MB | 2.0x | 20 chats opened one after another (Rust: pointer clicks 1 s apart, 22 distinct screens seen; prototype: 150 ms apart), 15 s settle. Rust holds one chat at a time and does not grow; the prototype keeps every parsed transcript |
| Idle CPU | 0.00 / 0.00 % of one core, 0.9 wakeups/s | 0.82 / 0.82 %, 81 wakeups/s | not comparable (0.0 against 0.8) | 60 s of `utime+stime` from `/proc/PID/stat`; wakeups are voluntary context switches summed over all threads |
| CPU while a reply streams | 1.27 / 1.23 % (the turn runner adds 0.03-0.07 %) | 24.6 / 23.3 % (one process, 24 % on its main thread) | 19x | 30 s of a 40 deltas/s reply in the open chat |
| Load average during the readings | 0.4 - 1.7 | 0.4 - 1.7 | | `/proc/loadavg` at the end of each reading |

Facts that change how to read it:
- The prototype draws plain text. Rust Harbor renders markdown, tool cards and the right panel, so the
  streaming and RAM rows favour the prototype, not Rust.
- Slint renders on the JavaScript thread (`processEvents`), so a streaming reply costs 24 % of that thread.
  Each text delta replaces one card's whole text, a growing paragraph, 40 times a second. Not profiled yet.
- The prototype's idle CPU is the 16 ms tick (see Bun against Node): 62 wakeups/s on the main thread.
- `--trim` does nothing on Bun 1.4.3 (below), so 126.7 MB is what the runtime weighs today.
- The model (641 MB) is downloaded on demand by both and not counted.
- An earlier run on the same PC (before the isolated compositor, with other agents' windows mapped in it
  and a heavily loaded PC) gave the same shape: Rust 208 ms to first frame, 124 MB, 0.02 %, 1.2 % streaming;
  prototype 333 ms, 158 MB (+20 swapped), 1.1 %, 36 % streaming at load 5. That run is not used.

### Bun against Node, idle, the same Slint window

`proto/idle-window.ts`: the same `.slint` window with 21 rows and 300 cards, no Bun API, run by
`bun` 1.4.3 and by `node` v26.7.0 (`--experimental-strip-types`), on the private sway. Bun runs a manual
16 ms `processEvents()` loop (`proto/loop.ts`); Node calls `slint.runEventLoop()`, which uses Slint's libuv
integration. "Hidden" means `window.hide()` after 3 s, process still running. 15 s settle, then 60 s read;
wakeups are voluntary context switches per second from `/proc/PID/task/*/status` summed over threads, and for
the main thread alone in brackets. Two full runs: run 1 / run 2.

| | CPU % of one core | wakeups/s (main thread) | RSS |
| --- | --- | --- | --- |
| Bun, window shown | 0.88 / 0.83 | 83.6 / 84.1 (65.3 / 64.5) | 160 MB |
| Bun, window hidden | 0.42 / 0.40 | 79.0 / 78.9 (64.7 / 64.9) | 160 MB |
| Node, window shown | 0.47 / 0.45 | 11.2 / 11.4 (5.0 / 5.4) | 192 / 194 MB |
| Node, window hidden | 0.00 / 0.00 | 4.3 / 4.3 (2.1 / 2.1) | 194 / 198 MB |

Slint's post is right in direction and not in absolute terms: Node has 7 times fewer wakeups with the window
shown and 18 times fewer hidden, and half the CPU shown; but it is not zero (11 and 4 a second). Bun keeps
ticking at 16 ms even when no window is shown (the loop does not know). Node uses 32 MB more RSS in this
test. For Harbor: Bun's cost is about 0.4-0.9 % of one core all day and 80 wakeups a second, which matters
on a laptop on battery. A smarter loop (tick only while Slint has timers, animations or input) is a task for
the `ui` package; `slint.runEventLoop()` itself cannot run under Bun (Findings).

## Running cost of the real app (2026-11-01)

`rig/cost.py`: `ts/run.sh` on a scrambled db (`strip.py`) inside `unshare -Urnm`, on its own headless sway at
1400x900, the fake `claude` streaming 40 text deltas a second; every stage holds `~/.cache/hts/check.lock`.
CPU is `utime+stime` of every thread over 25 s, wakeups are voluntary context switches of every thread per
second, RAM is `smaps_rollup` Rss + Swap. Same PC as the table above (i5-10210U, other agents' programs
running, load 0.5-1.5). Idle is the start screen (new thread, composer focused, its cursor blinking) 20 s after
start; "chat" opens the last chat. The stream is a 40 s reply sent with HARBOR_POINTER, sampled for 25 s from
4 s in; "end of reply" is its last 3 s. Before is a1121e3, after is e8f4c11, two runs each unless noted.

| | Before | After | Target | Rust 0.108.0 (table above) |
| --- | --- | --- | --- | --- |
| Idle CPU, start screen | 1.04 % | 1.16 / 0.72 % (the first run at load 1.5) | under 0.3 % | 0.00 % |
| Idle CPU, a chat open | 1.08 % | 0.80 / 0.80 % | under 0.3 % | 0.00 % |
| Idle wakeups/s (window's thread) | 86 (68) | 48 / 46 (20 / 20) | under 10 | 0.9 |
| CPU while a reply streams | 42.8 % | 10.9 / 11.1 % | under 10 % | 1.25 % |
| CPU near the end of a 40 s reply | 79.3 % | 10.7 / 12.0 % | | |
| RAM idle / streaming | 368 / 408 MB | 372-376 / 405-410 MB | under 250 MB | 124 MB |
| Key press to frame, median / worst | 15.4 / 26.9 ms | 11.7 / 28.4 ms (one of 15; the other 14 at most 13.2 ms) | not slower | |
| `harbor --version` / `mcp` / `turn`, compiled, peak RSS | 83 / 87 / 87 MB | 51 / 57 / 56 MB | | `mcp` 22 MB |

Key press to frame: 15 key presses with `wtype` (the time includes wtype's own start, about 8 ms), to the
app's next `wl_surface.commit` in its WAYLAND_DEBUG log (`cost.py keys`).

### Where the time went, and what each lever gave

Profiled with Bun's `--cpu-prof`, `rig/loopstats.ts` (CPU inside Slint's `processEvents`, inside `setProperty`
and the rest, per 5 s), `rig/stacks.py` (eu-stack samples of the window's thread, Slint and Skia frames by
name) and per-refresh timers. Bun's profiler charges wall time to native calls, so its native numbers were
not used; the CPU split comes from `process.cpuUsage()` around each call.

- The renderer is not the cost and the rig is not software rendering: Slint draws with Skia on OpenGL on the
  Intel GPU (`renderD129`, i915, no llvmpipe threads). Rendering was 25-30 % of the window thread's samples;
  the rest was Slint's interpreter. A real desktop will be about the same.
- 1. Slint's layout (the big one, 092fa44). 85-90 % of the streaming CPU was in
  `processEvents`, and grew with the reply (20 % → 70 % of a core over 40 s). Slint's interpreter measures
  every element holding wrapping text again, at every level of the layouts above it, each time any of them
  changes (`box_layout_info_ortho_with_measure` → `layout_item_info_at_cross_width`, uncached), and a
  `preferred-height` forwarded upwards is rewritten into the same measuring call. Each transcript row and
  each block of a reply is now sized from a property that holds its own `preferred-height` (Slint caches
  those), and the streaming reply's blocks live in one model across updates, so one changed block is
  measured, not the whole transcript. `rig/layoutbench.ts` compares the constructs. 42.8 % → 19.4 %, and
  flat: the end of the reply costs what its start does.
- 2. Reparse and relay only the streaming block: the relay part is the live model above. The JavaScript
  parse of the growing reply costs about 0.5 % of a core; not worth more.
- 3. Coalescing (321a56f, then e8f4c11): the shell already flushed every 50 ms, but each flush also redrew the header, composer,
  team panel and the whole sidebar (3-4 % of a core for the sidebar alone). Now a flush redraws the transcript
  every 80 ms; the rest of the window and the sidebar follow at most every 250 ms, with a last refresh when
  the reply ends. 19.9 % → 11.9 % (the split), then 14.9 % → 11.3 % (50 → 80 ms, three runs each).
- 4. The loop (321a56f). A Worker blocks in `poll(2)` (bun:ffi) on winit's epoll fd, found as the new
  epoll fd that watches a socket, and wakes the loop when the compositor sends something or Slint asks for a
  frame; every change JavaScript makes to a window (properties, models, calls) asks for a turn; Slint's
  timers get one every 100 ms. Window-thread wakeups 68 → 19 a second. Key to frame got faster, not slower
  (median 15.4 → 12.3 ms, worst 26.9 → 12.7 ms on that commit). The idle CPU hardly moved: the empty 16 ms
  turns were cheap. `HARBOR_FIXED_TICK=1` keeps the old loop.
- 5. Partial rendering (e8f4c11; Skia, `SLINT_SKIA_PARTIAL_RENDERING`, set through libc's `setenv` because Bun's
  `process.env` doesn't reach native code): the cursor's blink repainted the whole window twice a second for
  about 3 ms each. Idle 0.88-1.0 % → 0.72 %, streaming 11.3-12.8 % → 11.1 %. The final frame is identical.
- Moving Engine and parsing into a Worker: rejected. With the above, the JavaScript part of a stream is
  about 4-5 % of a core, most of it the per-flush refreshes and the Engine reading the provider's output. A
  Worker moves that to another core rather than removing it, adds a second JavaScript heap (about 20-30 MB
  against a RAM target already missed), and every Engine call the window makes would become a message.

### What is left, and why

- Idle CPU: 0.72-1.16 %, not under 0.3 %. What remains is the composer's blinking cursor (Slint repaints
  for it twice a second; partial rendering made each repaint cheap, not free), the 1 s JavaScript ticks
  (shell, Engine, theme check) and the 100 ms timer turns. An unfocused or hidden window doesn't blink. Rust
  0.108.0 doesn't blink its cursor, so its 0.00 % is not the same screen.
- Wakeups: about 45 a second in all, 19 on the window's thread; Bun's own threads (`mi-scavenger` about 11,
  JSC's GC helpers, a `pump_events` monitor 4) add the rest, so under 10 is out of reach under Bun even with a
  silent window.
- RAM: 372-376 MB idle, not 250 MB. The JavaScript heap is about 20-25 MB. Compiling `app.slint` in Slint's
  interpreter adds 198 MB before the window shows (the glibc heap: 168 MB in use after compiling, not freed
  by GC or `malloc_trim`; about 13 KB per line of `.slint`, 17,000 lines); showing the window adds about
  80 MB (GL driver, the NVIDIA EGL libraries that libglvnd loads on this hybrid laptop, fonts, Skia). The bare
  window with no Harbor logic is 320 MB. Evicting transcripts or loading chats lazily can't reach the target:
  the transcript data is a few MB. Below 250 MB needs the UI compiled to native code instead of interpreted,
  or a much smaller UI.
- `harbor mcp` 57 MB and `harbor turn` 56 MB against Rust's 22 MB: a compiled hello-world is 16 MB; the rest
  is mostly the executable's own pages (the whole app bundle is one file) and the modules each entry pulls in
  through package indexes (`wire.ts` loads all of `@harbor/mcp`). A separate small entry would mean another
  release artifact.

### On the desk PC (0.109.1-ts, 2026-11-01)

Read from `/proc` of the installed app on the owner's desk PC (1920x1080 at scale 1.25, Intel GPU through
Mesa, 322 chats, two paired PCs), then reproduced with `rig/cost.py` on a scrambled copy of a 323-chat db
whose projects have real folders and icons.

- RAM 614-634 MB against 370-380 MB in the rig. The glibc heap was the same (195 MB); the difference was
  Bun's mimalloc arena, 239 MB against 46 MB. Both peers pull every chat's items at start, and the hub
  answered through `engine.transcript()`, which keeps what it reads: every transcript of the PC ended up in
  the JavaScript heap. Loading all 77,000 items of the copy takes the heap from 1 to 157 MB and RSS up
  227 MB. A peer's pull now reads the store without keeping it (`itemsOf`), and the window lets an idle
  chat's transcript go when another chat is shown (cdbe9d1). Peers fetch a chat's items only when its rev
  changes, so the extra reads are rare. Expected on the desk PC: about 400 MB.
- CPU 9-12 % of a core with one chat working. Not the display scale (1.25 measured the same as 1.0 in the
  rig) and not the icons: a long chat open while its turn runs, even a quiet one, cost 8-9.3 %. A short
  chat costs 1.8 %. Every frame walked every card of the transcript (eu-stack: the partial renderer's
  item visit and the interpreter's property reads, nearly all of the busy samples), and three spinners and
  the cursor each drew frames of their own, about six a second. Spinners now step together on one tick the
  shell drives while turns run, with the Working timers in the same frame, and transcript rows more than a
  screen away aren't drawn (a67932d). 9.3 / 8.0 % → 4.6 % at scale 1, 7.4 % → 4.1 % at 1.25; the
  transcript draws the same after paging up eight screens.
- Still on the desk PC: a turn that streams in a chat that isn't shown makes the hub answer both peers'
  event polls and refresh the sidebar up to four times a second (97 wakeups a second on the window's
  thread there, 40-50 in the rig). Not measured offline.
- Rust 0.109.0 on the other PC, same `/proc` reading, 22 h up, window shown at 1920x1080, 323 chats, chats of
  the desk PC working: 1.2 % CPU, 82 MB RSS but 962 MB in swap, so about 1 GB in all on a PC short of RAM.

### Bun against Node, the real window

The Phase 0 table above used a small proto window. `rig/runtimes.ts` runs the real `app.slint` with a reply
streaming into it (no Harbor package, no Bun API) under Bun 1.4.3 with the new loop and under Node v26.7.0
with Slint's libuv integration; two runs each.

| | Idle CPU | Idle wakeups/s | Streaming CPU | RSS |
| --- | --- | --- | --- | --- |
| Bun, new loop | 0.79 / 0.79 % | 173 / 201 | 7.3 / 7.5 % | 310-323 MB |
| Node, `runEventLoop()` | 0.32 / 0.31 % | 11 / 12 | 7.0 % | 347-355 MB |

Streaming costs the same: the cost is Slint's, not the runtime's. Node idles at less than half the CPU and a
fifteenth of the wakeups, because Slint's own loop sleeps exactly until its next timer; Bun has no such hook,
so the loop here turns every 100 ms for timers, and Bun's own threads wake on their own. Node uses about
35 MB more. The full app can't run on Node at all today (`bun:sqlite`, `Bun.serve`, `bun:ffi`, `Bun.spawn`
in 53 files). Switching would buy about 0.4 % of a core at idle and nothing while streaming: not worth a
port. The same idle saving under Bun needs a small native piece instead: slint-node exposing the time until
Slint's next timer (or Bun gaining `uv_backend_fd`), which would let the loop sleep exactly. It belongs in
the runtime lane and would change only with Slint upgrades.

### Found on the way

- When the compositor goes away, the app doesn't exit: winit's `pump_events` thread spins at 50 % of a core,
  or `processEvents` throws "The Slint platform does not provide an event loop".
- Each paragraph draws its text twice (the styled text and a near-transparent `TextInput` over it for
  selection); where the two wrap differently, a faint word shows at the end of the line. It was there before
  these changes.
- Each `setRowData` of a struct holding a JavaScript `Model` adds a hidden `__slint_model#N` property on the
  window that keeps that model alive (slint-node's `js_into_rust_model`).
- `model-logo` and other image properties are new images on every set, so Slint can't skip them as equal;
  now they are set at most four times a second.
- Rigs that stop sway or Bun by name kill other agents' runs; `cost.py` starts both through links in its own
  folder.

## glibc: the newest `GLIBC_` symbol each piece needs (plan's Hard rule: 2.35)

Read with `objdump -T` (x86_64) and `readelf --dyn-syms` (aarch64 files, which are the npm tarballs and
Bun's release zip, not run on arm here) on every ELF the runtime needs.

| File | x86_64 | aarch64 | Other hard requirements |
| --- | --- | --- | --- |
| Bun 1.4.3 (`bun`, and the compiled `harbor-runtime`) | 2.17 | 2.17 | libc, libm, libpthread, libdl only |
| `slint-ui.linux-*-gnu.node` 1.18.1 | **2.35** | **2.35** | `GLIBCXX_3.4.26`; links libxkbcommon.so.0, libudev.so.1, libinput.so.10, libgbm.so.1, libfontconfig.so.1, libfreetype.so.6, libstdc++, libgcc_s: the window does not start if one is missing |
| `sherpa-onnx.node` 2.0.1 | 2.32 | 2.17 | `GLIBCXX_3.4.29` (x86_64), `3.4.9` (aarch64) |
| `libsherpa-onnx-c-api.so`, `libonnxruntime.so` | 2.16 | 2.17 | `GLIBCXX_3.4.19` |
| Rust Harbor 0.108.0 for comparison | 2.35 | (not read) | `GLIBCXX_3.4.30`; links only libc, libm, libstdc++, libgcc_s |

The 2.35 in Slint's addon comes from `hypot` and `hypotf` (new versions in 2.35); the rest of its symbols are
2.34 (`dlopen`, `pthread_create`, ...) and 2.33 (`stat64`). So the rule holds with zero margin: Ubuntu 22.04,
Debian 12 and Arch are fine, anything older is not. The aarch64 files were read from their ELF headers and then
run on a real Ubuntu 22.04 (glibc 2.35.0ubuntu3.15): they load (next section).

## Video: how libmpv frames reach a Slint window

Rust today (`src/video.rs`, `video/`): libmpv's OpenGL render API draws into a texture of the window's own
GL context (eframe's glow) at the window's size, and egui paints it; a frame never comes back to the CPU.
Hardware decoding is VA-API through a DRM render node found with `eglQueryDeviceStringEXT` on the window's
EGL context (`video/vaapi-render-node.patch`, `MPV_RENDER_PARAM_DRM_DISPLAY_V2`). It needs the GL context.

Slint from JavaScript cannot give libmpv that context. slint-ui 1.18.1's `Window` has `show`, `hide`, size,
position, fullscreen, `requestRedraw` and `dispatchEvent`; the package's Rust source (`node_modules/slint-ui/rust`)
has no rendering notifier, no GL or wgpu texture import and no window handle. Slint's Rust and C++ APIs have
`set_rendering_notifier` (the `opengl_underlay` example); the Node binding does not expose it. So the Rust
design cannot be ported through `bun:ffi` alone.

What works, and runs (`proto/video-sw.ts`; the `media` package's `libmpv.ts` does the same): libmpv's
software render API (`MPV_RENDER_API_TYPE_SW`, `rgb0`) into a buffer owned by Bun, alpha forced to 255, then
`window.frame = { width, height, data }` on an `image` property. Slint copies it again into its own buffer and
uploads it as a texture each frame. Everything runs on the JavaScript thread.

Measured here (1080p60 H.264 clip, 12 s per run, under the lock, the Slint window mapped on the private sway;
CPU is the whole Bun process, including libmpv's decoder threads):

| libmpv | Picture area | Shown | CPU | Copy + alpha pass |
| --- | --- | --- | --- | --- |
| System 0.41, `auto-copy` | 1920x1080 | 60.0 fps, 0 dropped | 132 % | 3.5 ms/frame |
| System 0.41, `auto-copy` | 1400x788 | 60.0 fps, 0 dropped | 146 % | 1.8 ms/frame |
| System 0.41, no hardware decoding | 1920x1080 | 60.0 fps, 0 dropped | 125 % | 2.9 ms/frame |
| Harbor's own `libmpv-harbor.so`, no hardware decoding | 1400x788 | **27.7 fps, 389 dropped** | 152 % | 1.6 ms/frame |

So: it works, and for system libmpv a 1080p60 clip keeps up, at 1.25-1.5 cores. Harbor's own library, the one
that would ship, does not keep up at 1080p60 in software on this CPU (27.7 fps shown); why was not looked
into (its FFmpeg is the small LGPL build, the system one is not). The `media` package measured 30 fps at 1080p
at 66 % of a core. Not measured: the Rust player's own CPU for the same clip, hardware decoding (this PC
has no usable decoder, per the `media` notes), a Wayland subsurface.

Options, in order of cost:
1. Software path, as built: no native code, works to 1080p30 on any PC and 1080p60 with the system library;
   a 4K picture area would take over 10 ms of each frame on the JavaScript thread. Size the picture area to
   the video, or render in a `Worker`. This is what the `media` package ships first.
2. mpv in its own window (the plan's fallback). On Wayland a client cannot place or embed another window
   (`--wid` is X11 only), so it opens as a separate window; `Host.openExternally` already exists for it.
3. A small native addon in the runtime, written in Rust against Slint's `set_rendering_notifier`, taking the
   existing zero-copy path back. It changes the runtime lane (the runtime already carries Slint, so the lane
   exists) but not the "nobody compiles native code for an everyday change" rule, and it is the only route to
   hardware decoding into the window.

## Findings

- `slint.runEventLoop()` crashes under Bun 1.4.3 and slint-ui 1.18.1. Slint's post says a runtime
  without libuv falls back to the 16 ms tick, but Bun exports `uv_backend_fd` as a stub that panics,
  so `hasIntegratedEventLoop()` kills the process before the fallback starts. `proto/loop.ts` calls
  `processEvents()` every 16 ms instead, through `slint-ui/rust-module.cjs` (not the public API).

- node:tls has no verifier hooks. Two behaviours differ from rustls: a pin is checked right after the
  handshake rather than during it, so a client has already shown its certificate to a wrong server
  (certificates are public, nothing secret leaks); and a known-keys server drops a stranger right after
  the handshake instead of failing it, so a stranger completes TLS and sees the connection close before
  any request is read.

- The compiler breaks slint-ui's loader: its stub for the absent `rust-module-dev.cjs` throws without
  `MODULE_NOT_FOUND`, so the executable dies at start. `proto/build.ts` works around it with a plugin, and
  also drops the musl addon that `bun install` fetches on glibc (33 MB of dead weight).
- `--trim` does nothing on Bun 1.4.3: the flag is accepted, the size doesn't change, and `bun compile`
  doesn't exist. It is real only on Bun canary.
- Addons extract to `/tmp/.bun-*.node` at start, so a compiled Harbor needs a `/tmp` that allows exec.
- Other agents' scripts that stop a Rust reference with `pkill -x harbor-ref` kill every reference on the PC,
  including a measuring run's. The Phase 0 rig now runs a renamed copy (`harbor-p0`) in its own compositor
  and stops only what it started, found by its data folder.

- Mesh, a peer's folder used as this PC's (0.109.3-ts): every PC's db holds entries for peers' projects that came with
  adopted chats (their home folder in `path`, by Rust's design). Rust shares only projects whose folder is here; the
  port shared them all, so `list` showed other PCs' folders and a `machines` call in a project with the same name ran in
  a folder missing here instead of home. Fixed with the same class elsewhere: a copy's project learns its home's
  remote, a chat's published `cwd` is its worktree, global project ids in Issues and PRs are the home path, commit pills
  skip device chats and use the worktree, and a phone's call on a copy goes home with this PC's context and the
  phone's files and comes back with this PC's ids. `rig/machines.sh` tests it TS to TS and TS to Rust.

### Where the plan's claims were wrong or need a number

- "A download 40-90 MB larger": measured +32 MB (runtime) to +43 MB (with the bundle and sherpa's libraries)
  over a 24 MB release, so 2.3x to 2.8x the download, not a small addition; `--trim` does not shrink it.
- "Roughly 1.5-3x the idle RAM": 1.6x at idle and 2.0x after 20 chats opened, and the prototype draws only
  text. Rust does not grow with chats opened; the prototype does.
- "Slint through `slint-ui`": `runEventLoop()` is unusable under Bun, so the app depends on an internal module
  of the package (`slint-ui/rust-module.cjs`), which its releases may change.
- "Node has no idle wakeups": 11 a second shown, 4 hidden. Much better than Bun, still not zero.
- "glibc 2.35+": met, with zero margin (Slint's addon needs exactly 2.35), and the addon hard-links seven
  system libraries the Rust build does not.
- "Video: drawing into a Slint window is unproven": proven for software frames; the GL path is impossible
  from JavaScript (above), and the shipped library is slower than the system one in software.
- CPU while a reply streams is 19x Rust's, not on the plan's list; it will grow once markdown is rendered.

## aarch64

Real arm64 CPU (the owner's Apple M5 laptop), Ubuntu 22.04.5 arm64 in a Lima 2.2.1 VM (`harbor-arm`, vz, 4 CPUs,
4 GB, 20 GB disk; glibc 2.35), a virtual display (Xvfb) with Mesa's software GL (llvmpipe, 4.5), no GPU. Bun 1.4.3
aarch64, `slint-ui` 1.18.1 and `sherpa-onnx-linux-arm64` 2.0.1 from `bun install` of this branch's lockfile. Do not
compare these numbers with the x86_64 table: different CPU, virtual display, a VM.

- Slint window: `proto/idle-window.ts` and the real prototype `proto/main.ts` (a scrambled harbor.db copy,
  sidebar and chat drawn) open at 1400x900 and draw correctly. The libraries the addon hard-links had to be
  installed first: libxkbcommon0, libudev1, libinput10, libgbm1, libfontconfig1, libfreetype6 (and the X11
  client libraries for the virtual display). No Claude turn was run there (no Claude Code in the VM).
- Idle, `idle-window.ts`, window shown, 20 s: the default renderer (femtovg on llvmpipe) uses 14.7 % of one core,
  170 wakeups/s, 183 MB RSS. With `SLINT_BACKEND=winit-skia-software` it uses 1.7 %, 90 wakeups/s, 83 MB RSS.
  `SLINT_BACKEND=winit-software` behaves like the default (14.6 %): the addon is built without the software
  renderer, only femtovg and skia. On a PC with no GPU the Skia software renderer is the one to pick.
- sherpa: Harbor's model (Parakeet TDT 0.6B v3 int8, the three files checked against the hashes in `parakeet.rs`):
  loads in 1.06 s at 842 MB RSS; the English, German and Spanish samples each take 0.14 to 0.19 s and come out
  right, the same sentences as on x86_64.
- Trap: in the VM `bun install` with the default 48 concurrent requests hung with most connections in SYN-SENT;
  `--network-concurrency=6` finished in 2 s. Curl to the same registry worked.
- Not run on arm64: the compiled runtime (`bun build --compile` for aarch64), mutual TLS, the terminal, video.
  They use no architecture-specific code, but they were not run there.
- Left on the laptop: Lima (brew, 79 MB), the VM stopped (3.5 GB on disk, a 20 GiB sparse file) and Lima's
  download cache (2.4 GB). `limactl delete harbor-arm` and `brew uninstall lima` remove them.

## Next

Phase 1 onwards. Open for Phase 0: the owner reads the table.

Running cost, for the owner to decide (Running cost above): RAM under 250 MB needs the UI compiled to native
code or made much smaller; idle near Node's needs slint-node to say when Slint's next timer is due (a runtime
lane piece that changes with Slint upgrades only). Not started: exit when the compositor goes away instead of
spinning; one text per paragraph instead of two.

## Blockers

None for Phase 0.
