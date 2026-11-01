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
| Compiled `harbor` | builds (runtime + bundle); `--version`, `turn <folder>`, `--speech-worker`, `--check-native` (sharp and sherpa load from inside it), `mesh status` run |

## Fixed in this pass

- `packages/media`: `sharp` is loaded when the first image is decoded (`src/sharplib.ts`), not at import. A compiled `harbor` could not
  load it, and because `hub.ts` imports media, `harbor --version` and `harbor turn` died at start. Now they run; image decoding in a
  compiled build still needs `sharp` shipped (see Packaging).
- `packages/media`: `parakeet.useOwnBinaryForWorker()` makes a compiled build start its speech worker as `harbor --speech-worker`
  (`harbor.ts` has the command; `speech-worker.ts` exports `runSpeechWorker`). `hub.ts` calls it at start.
- `hub.ts`: `dictate.setAccount` is wired to this PC's `claude` account (installed, signed in), through `recap.askWithin`, and is
  refreshed with the account list every minute, as `voice.rs` does each tick. The Rust code also checks the account is not
  blocked by a usage limit; the Engine now holds the limits state and `hub.ts` checks it.
- `packages/store/test/real.test.ts`: no longer skipped when the real-db copy is absent; it builds a synthetic database instead.
- `packages/store/src/store.ts`: a failed transcript save is logged to stderr; it was silent.
- `test/pty.test.ts`: the bash it starts wrote the owner's `~/.bash_history`; it now runs with `HISTFILE=/dev/null`.
- `packages/net/test/api.test.ts`, `remote.test.ts`: a fixture used the name of a real PC (`acer`); now `box`.
- `test/wire.test.ts`: it called `wire()` and left the mcp bridge and agent env registered for every later test file, which broke
  `agents` "a remote turn without the net package says so" in a full run. It restores them in `afterAll`.
- `packages/agents/test/engine.test.ts:353`: "snooze sets a wake-up" failed one run in about ten under load: the reply says "in <1m" when a few ms of the minute have passed. The pattern accepts both now.
- Temp folders: `Store.openTemp()` and about 20 test files left folders in `/tmp` (RAM-backed here): 400 were there. `bunfig.toml` now preloads `test/preload.ts`, which points `TMPDIR` at one `hbt-<pid>-*` folder per run and removes it when the run ends. A run that is killed leaves its folder, and the next run removes folders whose pid is gone. `Store.openTemp()` also removes its folders at exit. Tests that hard-code `/tmp` paths are not covered; none were found.
- Found by `packages/store/rig/dbswap.sh` (the scrambled-copy round trip, see `HARD-RULES.md`) and fixed:
  - `packages/net/src/tls.ts`: `accept()` removed every `close` listener of a plain connection, including the one that gives its slot back, so the hub refused all plain connections after 12 (loopback, legacy tailnet phones). Test `a plain connection keeps the close listener…`.
  - `packages/net/src/phone.ts`: a tool result longer than 16 KiB was cut with `…`; Rust cuts at a character boundary and appends `\n… (N more bytes)`. A mention's `text` on the wire is its first non-empty line (or the chat row's line for a chat mention), not the whole text. A retired agent is not `writable`.
  - `hub.ts`: the phone routes got no `find`/`refs`, so a reply with images came out with different `blocks` and no `media`. Now wired to `@harbor/media` (the chat's project folder, else home).
  - `app.ts`: `harbor --check-video` was ported in media but not in the command table.
- `test/harbor.test.ts`: `harbor` with no command now opens the window (ui), which cannot run headless; the test keeps the unknown
  command half.

## Skipped by design (need a 650 MB model that cannot be committed)

- `packages/media/test/parakeet.test.ts:75`, `dictate.test.ts:288`, `voicectl.test.ts:233`: `describe.skipIf(!model)`. They run on
  this PC (`HARBOR_TEST_PARAKEET_DIR` or `~/.cache/hts/tmp/parakeet`). Owner: media.
- `packages/net/test/remote.test.ts`: the PowerShell script test prints `skipped: no pwsh (set HARBOR_TEST_PWSH)` and returns when `pwsh` is missing, so it passes without running. Owner: net.

## Packaging (compiled build)

1. `sharp` and `sherpa-onnx`: fixed by commit 05be7fe (the runtime carries their native files and loads them by path); `harbor --check-native` on a runtime built from this branch prints "sharp: ok" and "sherpa: ok".
2. `libmpv`: loaded by name at run time; a compiled build needs the system library or Harbor's `libmpv-harbor.so` (not on this PC, never loaded). Owner: media/update.

## Unwired (honest, but not done)

- Phone API: the routes the Rust hub answers and the TS hub does not are listed in `PENDING` in `test/routes.test.ts` (11: Move to PC `move_pc` and `/mesh/v1/adopt`, the worktree bar, `clone`, `run_on`, mesh `preview`); the test fails on any other. Everything else is compared with Rust by `packages/store/rig/chatstate.sh` and `meshexport.sh`. Owner: net (store-port did the comparison).

- Dictation: `dictate.Mesh` is wired in `hub.ts`; `Ask` reaches only `claude`, and not while a usage limit blocks it (the Engine holds store's `Limits` now).
- `packages/media`: Whisper (built-in) never ran against a real model; `voice::builtin_downloads_and_transcribes` is ported up to the
  download. Owner: media.

## Empty `catch {}` blocks

114 in `src/`. All of media, mcp, net, store and ui carry a reason comment and mirror Rust's `let _ = …` best-effort calls (kill a
group, chmod, remove a temp file, parse an optional file). Without a reason comment (review each; most are the same kind):

- agents: none left; each of the 44 now says why its failure can be ignored.
- update (1): `update/src/extras.ts:61`

## Personal data the hook misses

The hook matches the owners' names, one mail domain, an owner's home path, tailnet names, the owners' PC names and LAN/CGNAT
address blocks. It does not match a PC's short name on its own, other usernames, `10.x` or `172.16-31.x` addresses, or other
email domains. A scan for all of those over every tracked `ts/` file found: the `acer` fixtures (a PC's short name, fixed above) and test-only `10.0.0.x`
documentation-style addresses. `omarchy` appears only as the OS name and its theme path, as in the Rust source.
