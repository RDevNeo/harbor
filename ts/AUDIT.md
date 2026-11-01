# Audit of ts/ (store-port, 2026-11-01)

Scope: `origin/ts-rewrite` at the time of the audit. Method: grep scans over every `ts/` source and test file; the whole suite run
under `unshare -Urn` (no network) with a throwaway `HOME` and no `XDG_*` set; every test file also run alone against an empty
`HOME` to see what it writes; `bun proto/build.ts harbor.ts` compile and run of the result.

## Result in one table

| Check | Result |
| --- | --- |
| `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` | none (3 grep hits are the English word "any" in comments and a test title) |
| `.skip`, `.todo`, `.only`, `xit` | none |
| `skipIf` | 5 uses; store's two are fixed, media's three need the model (below); one silent early return in net |
| "not implemented", TODO, FIXME, stub bodies | none in `src/` |
| Fake success | none found; places that answer honestly "not in this build" are listed under Unwired |
| Whole suite, no network, empty HOME | 1,193 tests, 0 failures after the two fixes below; `tsc` clean |
| Reaches a real service, the real mesh, `harbor.db`, `identity.pem` or an install | no: nothing needed the network, and no test file wrote under `HOME` except the two below (both fixed or harmless) |
| Compiled `harbor` | builds; `--version`, `turn <folder>`, `--speech-worker`, `mesh status` run; images could not load in it (fixed so only images fail, see below) |

## Fixed in this pass

- `packages/media`: `sharp` is loaded when the first image is decoded (`src/sharplib.ts`), not at import. A compiled `harbor` could not
  load it, and because `hub.ts` imports media, `harbor --version` and `harbor turn` died at start. Now they run; image decoding in a
  compiled build still needs `sharp` shipped (see Packaging).
- `packages/media`: `parakeet.useOwnBinaryForWorker()` makes a compiled build start its speech worker as `harbor --speech-worker`
  (`harbor.ts` has the command; `speech-worker.ts` exports `runSpeechWorker`). `hub.ts` calls it at start.
- `hub.ts`: `dictate.setAccount` is wired to this PC's `claude` account (installed, signed in), through `recap.askWithin`, and is
  refreshed with the account list every minute, as `voice.rs` does each tick. The Rust code also checks the account is not
  blocked by a usage limit; the hub has no limits state yet, so that check is missing.
- `packages/store/test/real.test.ts`: no longer skipped when the real-db copy is absent; it builds a synthetic database instead.
- `packages/store/src/store.ts`: a failed transcript save is logged to stderr; it was silent.
- `test/pty.test.ts`: the bash it starts wrote the owner's `~/.bash_history`; it now runs with `HISTFILE=/dev/null`.
- `packages/net/test/api.test.ts`, `remote.test.ts`: a fixture used the name of a real PC (`acer`); now `box`.
- `test/wire.test.ts`: it called `wire()` and left the mcp bridge and agent env registered for every later test file, which broke
  `agents` "a remote turn without the net package says so" in a full run. It restores them in `afterAll`.
- `packages/agents/test/engine.test.ts:353`: "snooze sets a wake-up" failed one run in about ten under load: the reply says "in <1m" when a few ms of the minute have passed. The pattern accepts both now.
- `test/harbor.test.ts`: `harbor` with no command now opens the window (ui), which cannot run headless; the test keeps the unknown
  command half.

## Skipped by design (need a 650 MB model that cannot be committed)

- `packages/media/test/parakeet.test.ts:75`, `dictate.test.ts:288`, `voicectl.test.ts:233`: `describe.skipIf(!model)`. They run on
  this PC (`HARBOR_TEST_PARAKEET_DIR` or `~/.cache/hts/tmp/parakeet`). Owner: media.
- `packages/net/test/remote.test.ts`: the PowerShell script test prints `skipped: no pwsh (set HARBOR_TEST_PWSH)` and returns when `pwsh` is missing, so it passes without running. Owner: net.

## Packaging (compiled build)

1. `sharp`: the `.node` and `libvips` are found through a path built at run time, so `bun build --compile` does not embed them and
   `$ORIGIN` rpaths break if they are extracted. Images, SVG, clipboard conversion and favicons fail in a compiled `harbor` until the
   runtime ships `@img/sharp-linux-*` beside the binary and loads it by path. Owner: update (runtime), media.
2. `sherpa-onnx-node`: needs `libonnxruntime.so` and `libsherpa-onnx-c-api.so` on `LD_LIBRARY_PATH` for the worker process
   (already in `ts/PROGRESS.md`); `parakeet` passes the parent's environment, so the launcher must set it. Owner: update.
3. `libmpv`: loaded by name at run time; a compiled build needs the system library or Harbor's `libmpv-harbor.so` (not on this PC,
   never loaded). Owner: media/update.

## Unwired (honest, but not done)

- Dictation: `dictate.Mesh` is wired in `hub.ts`, but `Ask` only reaches `claude`; a usage-limit block is not checked (above). The hub's Engine does not hold a `Limits` state yet (`store.limits.Limits` needs an `EngineHost`).
- `packages/media`: Whisper (built-in) never ran against a real model; `voice::builtin_downloads_and_transcribes` is ported up to the
  download. Owner: media.

## Empty `catch {}` blocks

114 in `src/`. All of media, mcp, net, store and ui carry a reason comment and mirror Rust's `let _ = …` best-effort calls (kill a
group, chmod, remove a temp file, parse an optional file). Without a reason comment (review each; most are the same kind):

- agents (44): `agents/src/agent.ts:171`, `agents/src/detach.ts:184`, `agents/src/detach.ts:209`, `agents/src/detach.ts:277`, `agents/src/detach.ts:342`, `agents/src/detach.ts:372`, `agents/src/detach.ts:386`, `agents/src/detach.ts:419`, `agents/src/detach.ts:456`, `agents/src/detach.ts:476`, `agents/src/detach.ts:517`, `agents/src/detach.ts:636`, `agents/src/detach.ts:647`, `agents/src/detach.ts:726`, `agents/src/detach.ts:743`, `agents/src/detach.ts:771`, `agents/src/detach.ts:787`, `agents/src/detach.ts:793`, `agents/src/engine.ts:334`, `agents/src/engine.ts:683`, `agents/src/engine.ts:778`, `agents/src/engine.ts:785`, `agents/src/engine.ts:853`, `agents/src/engine.ts:860`, `agents/src/engine.ts:914`, `agents/src/flock.ts:16`, `agents/src/fork.ts:89`, `agents/src/git.ts:125`, `agents/src/movechat.ts:12`, `agents/src/movechat.ts:57`, `agents/src/movechat.ts:83`, `agents/src/oauth.ts:52`, `agents/src/oauth.ts:113`, `agents/src/oauth.ts:136`, `agents/src/procfs.ts:119`, `agents/src/procs.ts:58`, `agents/src/procs.ts:116`, `agents/src/providers.ts:204`, `agents/src/providers.ts:282`, `agents/src/providers.ts:355`, `agents/src/recap.ts:259`, `agents/src/work.ts:22`, `agents/src/worktree.ts:245`, `agents/src/worktree.ts:548`
- update (1): `update/src/extras.ts:61`

## Personal data the hook misses

The hook matches the owners' names, one mail domain, an owner's home path, tailnet names, the owners' PC names and LAN/CGNAT
address blocks. It does not match a PC's short name on its own, other usernames, `10.x` or `172.16-31.x` addresses, or other
email domains. A scan for all of those over every tracked `ts/` file found: the `acer` fixtures (a PC's short name, fixed above) and test-only `10.0.0.x`
documentation-style addresses. `omarchy` appears only as the OS name and its theme path, as in the Rust source.
