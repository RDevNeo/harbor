# TypeScript rewrite: progress

Phase 0 only (prototype and measure). The gate stays closed until the owner decides.

## Phase 0

- [ ] `slint-ui` opens a window under Bun on x86_64 and aarch64 (x86_64 done, aarch64 not yet run)
- [x] Mutual TLS with a pinned client certificate works in Bun, TLS 1.3 and 1.2
- [x] `Bun.spawn` with `terminal` drives a shell; `@xterm/headless` parses its output
- [ ] `sherpa-onnx-node` transcribes a sample on both architectures
- [ ] Video: a written finding on how libmpv frames reach a Slint window
- [ ] A table comparing the prototype with Rust Harbor on the same PC
- [ ] The owner reads the table and decides go or no-go

## Done

- The window: `proto/main.ts` with `proto/app.slint`. A Bun + Slint window with the sidebar and one
  chat, reading a read-only copy of harbor.db. A message typed into the composer ran a real Claude
  Code turn (Haiku, a scratch folder, no session saved) and the reply streamed into the transcript.

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
for turns), `HTS_CLAUDE`, `HTS_MODEL`, `HTS_OPEN` (open that many chats), `HTS_PROMPT` (send at start).

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

## Next

Comparison table, Bun vs Node idle, glibc, video finding, then aarch64.

## Blockers

None yet.
