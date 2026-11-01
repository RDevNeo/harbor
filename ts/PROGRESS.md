# TypeScript rewrite: progress

The owner lifted the Phase 0 gate on 2026-10-31 ("when I wake up I wanna see the full app"), so the later
phases are running. The go/no-go item below stays unchecked: the owner has not read the table yet.

## Phase 0

- [ ] `slint-ui` opens a window under Bun on x86_64 and aarch64 (x86_64 done, aarch64 not yet run)
- [x] Mutual TLS with a pinned client certificate works in Bun, TLS 1.3 and 1.2
- [x] `Bun.spawn` with `terminal` drives a shell; `@xterm/headless` parses its output
- [ ] `sherpa-onnx-node` transcribes a sample on both architectures (x86_64 done, aarch64 not yet run)
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
Debian 12 and Arch are fine, anything older is not. The aarch64 files are read from their ELF headers only;
whether they load is in the aarch64 section.

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

## Next

aarch64 (Lima VM on the owner's arm64 laptop: Slint window and sherpa), then Phase 1 onwards.

## Blockers

None for Phase 0 itself. aarch64: see its section once run.
