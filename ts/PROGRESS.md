# TypeScript rewrite: progress

Phase 0 only (prototype and measure). The gate stays closed until the owner decides.

## Phase 0

- [ ] `slint-ui` opens a window under Bun on x86_64 and aarch64 (x86_64 done, aarch64 not yet run)
- [ ] Mutual TLS with a pinned client certificate works in Bun, TLS 1.3 and 1.2
- [ ] `Bun.spawn` with `terminal` drives a shell; `@xterm/headless` parses its output
- [ ] `sherpa-onnx-node` transcribes a sample on both architectures
- [ ] Video: a written finding on how libmpv frames reach a Slint window
- [ ] A table comparing the prototype with Rust Harbor on the same PC
- [ ] The owner reads the table and decides go or no-go

## Done

- The window: `proto/main.ts` with `proto/app.slint`. A Bun + Slint window with the sidebar and one
  chat, reading a read-only copy of harbor.db. A message typed into the composer ran a real Claude
  Code turn (Haiku, a scratch folder, no session saved) and the reply streamed into the transcript.

Environment of `proto/main.ts`, for the rigs: `HTS_DB` (the copy, required), `HTS_CWD` (scratch folder
for turns), `HTS_CLAUDE`, `HTS_MODEL`, `HTS_OPEN` (open that many chats), `HTS_PROMPT` (send at start).

## Findings

- `slint.runEventLoop()` crashes under Bun 1.4.3 and slint-ui 1.18.1. Slint's post says a runtime
  without libuv falls back to the 16 ms tick, but Bun exports `uv_backend_fd` as a stub that panics,
  so `hasIntegratedEventLoop()` kills the process before the fallback starts. `proto/loop.ts` calls
  `processEvents()` every 16 ms instead, through `slint-ui/rust-module.cjs` (not the public API).

## Next

Mutual TLS.

## Blockers

None yet.
