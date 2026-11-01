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
