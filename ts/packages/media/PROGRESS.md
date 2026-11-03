# @harbor/media

## images, media, clipboard, picker, favicon

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| media.rs | done: markdown refs/strip/parts (mdast offsets), resolve, find, sniff, check, kept copies, https downloads (curl), posters (ffmpeg), SVG (sharp/librsvg) | 6 of 6 |
| images.rs | done except egui drawing (thumbnail, strip, attachment, lightbox, inline, video card, cant_load): `Images` holds the cache, decode workers, viewer state, gallery, `widen`, remote sources; the `ui` package draws `Slot`s | 4 of 4 |
| favicon.rs | done: local candidates, HTML/manifest/desktop icons, website lookup, pinned curl fetch, 32 px square decode | 5 of 5 (`real_projects` is `#[ignore]` in Rust: a manual print of the owner's projects, not ported) |
| clipboard.rs | done except the egui plugin and `raw_input_hook`: wl-clipboard/xclip backends, copy/read/paste, notices, `shortcut()` key mapping | 2 of 2 |
| picker.rs | done except the egui toast drawing: `toast()` gives the message and time left | 1 of 1 |

Decisions
- Decoding uses `sharp` 0.35.5 (prebuilt libvips for glibc x86_64 and arm64 as optional packages, nothing compiled): PNG, JPEG, WebP, GIF first frame, EXIF rotation, SVG through librsvg, so `rsvg-convert` and ImageMagick are not needed. ICO is decoded by `ico.ts` (embedded PNG or 1/4/8/24/32-bit bitmaps) because libvips has none.
- Images come out as `Decoded`: RGBA, 8 bits, not premultiplied, for the `ui` package to turn into a Slint image.
- Markdown: `mdast-util-from-markdown` with GFM table and strikethrough (pulldown-cmark equivalents); a paragraph's offsets are extended over one trailing line end to match pulldown's ranges.
- Cache file names (kept copies, https downloads, posters, favicons) use the Rust hashes, so both apps share one cache folder.
- Downloads still go through `curl` with the Rust arguments.

## voice, parakeet, dictate, dictwords

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| voice.rs | done except the egui drawing (below): recording, WAV, Whisper (built-in and `HARBOR_WHISPER`), model downloads, the composer's mic and Settings state | 6 of 6 (`builtin_downloads_and_transcribes` without its transcription half: see Not verified) |
| parakeet.rs | done: model files, install check, speech worker process, VAD splitting, Whisper op | 0 in Rust (13 new) |
| dictate.rs | done: settings, routing, scoring, status, cleanup, peer endpoint | 10 of 10 |
| dictwords.rs | done | 3 of 3 |

Files: `voice.ts`, `parakeet.ts`, `dictate.ts`, `dictwords.ts`, plus `voicectl.ts` (the composer's mic and
Settings › Voice state that `voice.rs` kept in `impl App`) and `speech-worker.ts` (the worker's entry point).
Exported from `index.ts` as `voice`, `parakeet`, `dictate`, `dictwords`, `voiceCtl`.

### Left to the `ui` package (egui drawing in `voice.rs`)
- `voice_button`: the mic, stop button, level meter, timer, spinner and "Speech model N%" labels. State comes from
  `VoiceCtl.recordingFor(key)` (level, elapsed), `busyFor(key)`, `waitingForModel()`, `voice.modelProgress()` and
  `voice.cantRecord()`; clicks call `VoiceCtl.toggle(key)`.
- `meter` (five bars) and the progress bar.
- `voice_tab`: the Settings › Voice page layout and texts. Its actions are `VoiceCtl.setMore`, `set`, `setWords`,
  `modelAction`, `parakeetAction`; the rows read `voice.recorder()`, `voice.engine()`, `voice.MODELS`,
  `voice.installed(name)`, `voice.currentModel()`, `voice.downloading()`, `voice.LANGS`, `voiceCtl.KEEPS`,
  `parakeet.installed()/loaded()/size()`, `dictate.engine()/cleanupOn()/commandsOn()`.
- `voice_dictionary`: the form drawing. The form fields and the add, edit, remove logic are `VoiceCtl.dictTerm`,
  `dictSounds`, `dictEdit`, `editEntry`, `saveEntry`, `removeEntry`.
- `voice_insert`: reading and moving the composer's cursor. `voice.insertSpaced(text, at, new)` computes the new text and
  cursor; `Host.insert(key, text)` is where the `ui` package applies it. `VoiceCtl.takeSend()` replaces `voice.send`.
- Calling `VoiceCtl.poll()` on every tick, as `voice_poll` was (it also stops recordings past 10 minutes).

### Wiring the other packages must do
- `dictate.Mesh`: the mesh as dictation needs it (`on`, `me`, `peers`, `http`); `net.http` fits behind `http`.
- `dictate.setAccount(ask)` / `Host.account()`: the cleanup's one-shot question to the PC's Claude account
  (`recap::ask_within` in Rust, not in this package).
- The HTTP routes `GET /v1/voice`, `PUT /v1/voice/settings`, `POST /v1/voice/cleanup`, `POST /v1/transcribe` and the mesh
  routes in `api.rs`/`mesh.rs` call `dictate.status`, `dictate.set`, `dictate.setWords`, `dictate.cleanupText`,
  `dictate.transcribe`, `dictate.servePeer`.
- A compiled build must tell the worker how to start: `parakeet.setWorkerCommand([...])`. The default is
  `process.execPath` on `speech-worker.ts` next to `parakeet.ts`, which is right for `bun` from source.

### Decisions
- The speech engine still runs in a child process (as the Rust app's `--speech-worker`): the ONNX Runtime can abort or run
  out of memory, and ending the process gives all the memory back. The hub never loads `sherpa-onnx-node`. Same wire:
  a JSON line, then the 16-bit samples; the answer is a JSON line. `malloc_trim` is not needed for the same reason.
- Whisper's pieces come back one per line and `voice.whisper` cleans them, so the worker needs no `clean`.
- Errors are exceptions: `Error` for the engine, `voice.Fail` (kind `wait` or `err`) for what a dictation shows.
- Downloads use `fetch` with node:crypto hashes (the Rust used `curl`): the same files, sizes and SHA-256 checks, a retry
  for network errors and 5xx, a `.part` file renamed when complete. `voice.setFetcher` swaps the downloader.
- `VoiceCtl` is a class with a `Host` (store, mesh, insert, toast, wake, account) instead of the `App` methods.
- `dictate.transcribe` takes the mesh and an options object (`cleanup`, `commands`, `localOnly`) instead of `Hub` and three booleans.
- `Part`, `RATE`, `memAvailableMb` live where the dependency order needs them (`voice.Part`, `parakeet.RATE`,
  `parakeet.memAvailableMb`); `voice.RATE` and `dictate.memAvailableMb` re-export them.
- The `#[ignore]` tests of the Rust are ported with stand-ins where they needed the network, a second Harbor or Claude: the
  routing test uses a fake mesh and the real model; the three Claude tests use a stand-in `Ask`; the Parakeet test uses the
  real model and checks the worker process is gone after the unload (the Rust checked RSS in-process).

### Not verified
- Built-in Whisper transcription has no test against a real model: no Whisper model is on this PC and tests may not
  download one. The config shape follows sherpa-onnx-node's documented `whisper` block and the Rust settings.
- Recording uses `pw-record`/`parecord` and is tested with a stand-in recorder on PATH, not a microphone.
- Speech tests use the model already on this PC (`HARBOR_TEST_PARAKEET_DIR`, else a folder under the home cache) and say
  so when it is absent.
## video

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| video.rs | done; `ui` draws it (`slint/video.slint`, `src/videopane.ts`: controls bar, spinner, error text, the "Open in your video player" button, the full-window picture): `libmpv.ts` binds libmpv over `bun:ffi` and `video.ts` holds every state, command, key and file rule; the `ui` package draws `Viewer.snapshot()` and puts `Host.frame()` pictures into a Slint image | 7 of 7, plus 16 more that run the real libmpv 0.41 on this PC |

What `ui` calls: `new Viewer({ host, source? })` implements `images.VideoHooks` (`open`, `close`), plus `resize(w, h)` (size of the picture area in pixels), `snapshot()` (stage, position, duration, paused, ended, muted, volume, drag, picture), `seen()` each time the controls are drawn, `pointerMoved()`, `controlsVisible(overBar)`, `toggle()`, `toggleMute()`, `holdVolume(percent)`, `holdSeek(seconds)` / `releaseSeek()`, `clickPicture(double)`, `takeKeys(keys)` (returns what is left for the lightbox: previous, next, close), `restoreVolume(store)` / `persistVolume(store)` for the kv `video_volume`, `shutdown()`. `Host` is what the viewer calls back: `frame()` (RGBA, straight alpha, valid until the next frame), `repaint()`, `fullscreen()`/`setFullscreen()`, `openExternally()` and `toast()` when there is no libmpv, `shut()`. `checkVideo(files)` is `harbor --check-video` (lines and exit code). `clock()` formats the times.

Decisions
- libmpv is bound lazily (`loadEngine`): Harbor's own `libmpv-harbor.so` when `PlayerSource.library()` gives its path (the `update` package knows where the install is), else `libmpv.so.2`, then `.so.1`. None found: `LibmpvUnavailable`, and the viewer opens the file in the system's player with the Rust toast. Loading takes about 65 ms here and blocks the event loop once.
- Frames come from libmpv's software renderer (`MPV_RENDER_API_TYPE_SW`, format `rgba`), drawn on a `Worker` of its own (`videoworker.ts`, loaded as text; `videorender.ts` is the window's side): the window's thread only copies a finished frame into the Slint image. Two buffers per size, allocated by the window's side and freed only after the worker said it moved on, so no frame allocates; a frame that finds no free buffer waits and the newest one is drawn later (dropped, never queued). Frames are the picture's size on screen (`pictureSize`: fitted into the area, never above the picture's own size or 1920x1080 pixels, and within `MAX_PIXEL_RATE`, 720p at 60 fps, because the copy and upload on the window's thread cost about 0.6 % of a core per million pixels a second), and the Slint image scales them with `image-fit: contain`; the scaler only shrinks, so it is `bilinear` instead of mpv's Lanczos. mpv's software renderer can't turn a picture, yet its VO says it can, so mpv's own autorotate stays off: a quarter-turned phone clip drawn into a buffer of its shown size overran it (Bun aborted). So `video-rotate=no` draws the file's orientation (`drawSize`), `video-dec-params/rotate` gives the turn, and `video.slint` turns the image (`transform-rotation`). Inside the video the alpha is 255; the letterbox bars are 0, so the Slint window needs a black background behind the image.
- Everything libmpv reads or keeps a pointer to (render parameters, the frame buffer, command arguments) lives in `calloc` memory. Small typed arrays passed with `ptr()` move under the collector: libmpv then read a 1 by 1 target size and aborted in `mp_image_crop` in about one run out of three. With native memory 5 runs out of 5 were clean.
- `BLOCK_FOR_TARGET_TIME` is 0 as in the Rust player. The wakeup callback is a `threadsafe` `JSCallback` that only schedules work with `setImmediate`; libmpv is never called from it. The render API lives on the worker's thread only (create, update, render, free), the core's API on the window's: libmpv's rule. Closing frees the render context on the worker first, then the core.
- The Rust control thread becomes the event loop: commands are queued (`push` keeps only the last seek), run in order when the core exists, and mpv's events are read right after. mpv commands are the synchronous ones; `stop` returns fast with the software renderer.
- `idle-active` is observed instead of `MPV_EVENT_IDLE` (newer libmpv no longer sends the event), and tells when the video is released so the renderer can be freed, with the Rust 1 s limit.
- Hardware decoding is `auto-copy-safe` (a software render needs the frame back in memory) and off for Harbor's own library, which gets its VA-API render node from a GL context a software render does not have. This PC has no usable decoder, so hardware decoding is untested.
- The Rust code reads the viewer's play state from statics; here one `Viewer` owns it.
- Not ported because the Rust code has none: ffprobe (poster extraction with ffmpeg is `media.poster`, done by media.ts).

Not done / not tested
- Harbor's own `libmpv-harbor.so` (video/build.sh builds it with a container) is not on this PC: the optional-library probing (`optional`, `audioOutputs`, PipeWire version) is written and its pure parts are tested, but loading that library was never run.
- Hardware decoding, audio output devices (no sound device in the rigs), fullscreen on a real compositor (headless sway only flips the state) are untested. A hidden or minimized window stops calling `seen()`, so the video pauses as in Rust; a window merely covered by another one still counts as seen (Wayland does not say). In the window, 720p at 30 fps into a 1400x900 picture takes 54 to 62 % of one core over 10 s (4 runs, either loop; Rust 0.109.0 on its GPU path: 4 %), measured on headless sway with software GL. Since the renderer moved to a worker (0.134.0), 1080p at 60 fps in a 1400x900 window: the window's thread 99 % → 39 % (the copy into the Slint image and its upload, ~6 ms per frame, are what's left), 222 → 1 frames dropped in 11 s.

Video finding (Phase 0 left it open)
- It works: libmpv 0.41 under Bun, `bun:ffi`, software render into an RGBA buffer, copied into a Slint image (`win.frame = { width, height, data }`), shown in a Slint window on a private sway. 1080p source, 3.5 s: 30.1 fps delivered, no dropped frame seen; the window was mapped.
- Measured on an i5-10210U (8 threads), 1080p H.264 at 30 fps: `mpv_render_context_render` into 1920x1080 takes 3.0 ms on average (max 10.6 ms), into 1280x720 2.5 ms; the copy into a Slint image is 0.5 ms median at 1080p (0.17 ms at 720p), so the copy path costs about 3.5 ms per frame, 10 percent of a core. The whole Bun process (decode, render, copy, Slint draw) uses 66 percent of one core at a 1920x1080 picture and 57 percent at 1280x720; libmpv alone without a window, 35 percent.
- Cost: the Rust player draws on the GPU with no copy back, so this is more CPU, and every frame crosses the JS thread (render and copy run on it, so a 4K picture area would take over 10 ms of each 33 ms). Mitigations: size the picture area to the video's own size, or render in a `Worker` into a shared buffer.
- Recommended: keep libmpv over `bun:ffi` with the software path (what is here). If a machine cannot keep up, the fallback is mpv in its own window (`mpv --wid` is not available on Wayland, so a plain window) opened by `Host.openExternally`, which already exists for the no-libmpv case.
