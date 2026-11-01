# @harbor/update

Phase 6. Rewritten for the plan's Architecture (runtime + app bundle), not ported line by line.

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| update.rs | done, redesigned: minisign check, manifest, runtime-then-bundle install, long-poll + GitHub + mesh delivery, rollback, browser/video/phone-app extras, `--update`, `--restore-previous` | 10 of 11 |
| reload.rs | done as `reload.ts`: snapshot, restart through the runtime, file watcher. The idle wait is gone by design | 0 of 1 |
| preview.rs | done as `preview.ts` + `previewmeta.ts`; previews are bundles, not binaries | 7 of 7 |
| notices.rs | done as a UI-free model (`notices.ts`): toast texts, dismissals, the phone banner; the drawing belongs to `ui` | 0 of 0 (12 new) |
| (new) | `launcher.ts` (the runtime's program), `startup.ts` (clean start, watchdog), `lane.ts` + `release-cli.ts` (lane choice, manifest), `worker/src/release.js`, `.github/workflows/ts-release.yml`, `ts/scripts/build.ts`, `ts/runtime.ts`, `ts/app.ts` | n/a |

Tests: 161 in 15 files (`bun test packages/update`), all passing; Rust `#[test]`s of these modules: 19, ported 17, 2 no longer apply (last section).

## What runs

- `bun test` in `packages/update/test` against local fake servers and temp folders only. Real signatures are checked with the real
  public key against the one signature the Rust test carries; everything else is signed by a throwaway key pair made in the tests.
- The compiled runtime (`scripts/build.ts runtime`) and the real bundle (`scripts/build.ts app`) run together in a temp
  folder: `runtime-version`, `smoke-bundle`, `--version`, `preview status`, `--restore-previous`, a bundle that needs a newer runtime refused.
- A bundle that crashes on start is rolled back by a real watchdog process (`launcher.test.ts`): the previous bundle starts, the
  version is skipped on this PC and `rolled-back.json` says why.
- A composer draft survives a swap: the snapshot goes into a real `harbor.db` (`@harbor/store`), the next `Store` reads it back.

## Design

- **Install folder** (marker `.managed`, as install.sh makes it): `harbor` (the runtime), `harbor-app.js` (the bundle), `VERSION`
  (the bundle's), `RUNTIME` (the runtime's), `manifest.json` (the installed release's), `.previous/` (hard links of what the last
  update replaced), `.skip` (a version this PC gave up on), `starting.json` (the start being tried), `rolled-back.json`.
- **Release assets**: `harbor-app.js`, `harbor-app.json`, `harbor-runtime-{x86_64,aarch64}` (runtime lane), each with `.minisig`
  whose trusted comment is `harbor v<release> <asset name>` (checked, so an old signed file can't pass as a newer one).
  `harbor-app.json` = `{version, minRuntime, runtime, browser?, video?, apk?}`: `runtime` is the release whose assets hold the
  newest runtime, so a bundle release needs no runtime asset; the extras say which release carries them.
- **Bundle contract**: `harbor-app.js` exports `meta = {version, minRuntime}` and `main(argv)`; loading it starts nothing. The
  runtime refuses a bundle whose `minRuntime` is newer than itself (also in `smoke-bundle`, which the installer runs on the new
  bundle with the new runtime before anything is swapped).
- **Delivery**: `Updater.start()` checks GitHub (`/releases/latest` redirect, no API limit) 2 s after start, holds
  `GET /v1/release/wait?have=` open (75 s client timeout; 204 reconnects at once; errors back off 5 s, 10 s… 5 min with jitter and
  look at GitHub at most every 5 min meanwhile), and `peerNews(update)` asks GitHub when a peer reports a newer version. `have` is the
  newest version already handled, so a failed install does not make the worker answer in a loop; a failed install retries on the
  Rust app's schedule (5 min, doubling to 6 h).
- **Swap**: after install the `swap` hook runs at once (the app passes `Reloader.now`). There is no idle wait and no "ask me"
  setting: `auto` is always true in `info()`. `Reloader.now` saves the snapshot to kv `reload_state` (the Rust app's shape, so a
  restart between the two apps keeps the screen), starts the runtime again with `HARBOR_RELOADED_PID` set and leaves.
- **Clean start / rollback**: a window launch writes `starting.json` and arms a watchdog (`harbor start-watch <pid>`). The bundle
  calls `confirmStart()` after its first frame (2 s alive). Pid dead or 30 s without confirmation: the watchdog restores `.previous`
  (bundle, and runtime if that update replaced it), writes `.skip` and `rolled-back.json`, and starts Harbor again. Where the
  watchdog dies with the app (a systemd unit) the next start finds the unconfirmed attempt and does the same. With nothing to go
  back to it only records the failure: started again, the same build would fail and arm another watchdog. Until the start is
  confirmed, a start whose stderr is not a terminal writes it to `start.log` in the install folder; a failed start keeps it as
  `failed-start.log`, named by `rolled-back.json`'s `log`. `info()` carries
  `skipped` and `rolled_back` for the mesh; `notices.rollbackToast` is the user's notice.
- **Previews** are unsigned bundles (`harbor-preview.js`, `preview.json`, opt-in file `.preview`), same watchdog; they are
  announced with `preview_kind: "bundle"` and a Rust sender's binary offer (no `kind`) is refused, so mixed meshes can't hand a
  Rust binary to a TypeScript PC.
- **Worker**: `worker/src/release.js` (`ReleaseHub` Durable Object, `POST /v1/release`, `GET /v1/release/wait`), wired in
  `worker/src/index.js` and `wrangler.toml` (binding `RELEASES`, migration `v1-release-hub`). It never believes the ping: it
  re-reads GitHub, and announces a release only once `harbor-app.json.minisig` exists, so an old Rust-only release is never announced
  to TypeScript PCs. Not deployed, no secrets touched.
- **Workflow** `.github/workflows/ts-release.yml`: `workflow_dispatch` only (a test fails if any other trigger appears). Lane
  from the changed files (`lane.ts`: Bun's version, `slint-ui`, `sherpa-onnx-node`, `video/`, `packaging/`, and the files the runtime
  entry imports; a test keeps that list equal to the real import graph). Publishes as a draft, signs, verifies against
  `packaging/minisign.pub`, undrafts, then pings the worker, then attests.

## Decisions

- Runtime and bundle are separate signed assets; `runtime` in the manifest points at the release that carries the newest runtime.
  In the runtime lane `minRuntime` = the release itself (every PC takes the new runtime); in the bundle lane both are copied from the
  previous release's manifest.
- The worker is told, not trusted, and GitHub stays the only source of files: nothing comes from the worker but a version number.
- The runtime is a raw executable (126.7 MB with Slint), not a tarball. A gzip would make updates smaller; the plan names the assets
  `harbor-runtime-{arch}`, so that is what is published.
- The bundle gets Slint from the runtime (`globalThis.__harbor`, plugin in `scripts/build.ts`, as Phase 0 found). `sherpa-onnx-node` is
  not wired the same way yet: `media` and the runtime entry have to agree (libs on `LD_LIBRARY_PATH`).
- `HARBOR_UPDATE_WORKER` overrides the worker's address (`off`: GitHub only), for tests and rigs.
- Extras (browser engine, video player, phone app) that a release changes are fetched before the swap, as in the Rust app, so on
  those rare releases the swap waits for the download; a failed extra never holds the update back and is retried in the background.
- A second Harbor started while one runs, and a restart's replacement, are told apart for the start check: only the first, or
  the process started with `HARBOR_RELOADED_PID` of the one it replaces, writes `starting.json`.
- A restart is a new process, not an exec (Bun has none): `single.acquire` now waits up to 5 s for the lock whenever
  `HARBOR_RELOADED_PID` is set (it was equal-pid only, which a new process never has) and removes the variable afterwards.
- Watchdog and fallback exist only for window launches (`isWindowLaunch`): a helper such as `harbor turn` never writes an attempt.
- aarch64 runtimes are compiled on `ubuntu-24.04-arm` rather than cross-compiled, because the Slint addon is per architecture.

## In-place switch on one PC: one executable and `install-one.sh` (done, run only in rigs)

- **One executable**: `scripts/build.ts single OUT --version V --sha S` compiles `ts/single.ts`: the runtime with the bundle inside
  (182 MB on x86_64). It sits where the Rust `harbor` sits (`~/.local/lib/harbor/harbor`, `.managed` beside it) and needs no Rust
  change. It runs the bundle it carries, unless an update put a newer `harbor-app.js` (by `VERSION`) beside it (`useEmbedded`).
  `--version`, `runtime-version`, `--check-native` (sharp and sherpa), `turn`, `mcp`, `app`, `nc`, `mesh` work from it; the browser engine,
  libmpv, the APK and its version file are read from the install folder as before.
- **Version**: this build is `0.109.1-ts`, above Rust 0.109.0 for both apps. To peers, phones, the account directory and discovery it
  says `0.109.0.ts` (`advertised`, `RUST_PARITY`): Rust's `parse`, the phone's `Update.code` and this app all read it as 0.109.0, so a
  Rust PC hears no news (`peer_news`), shows no "is out" or Update for any PC, and a phone offers nothing. `harbor --version` and the
  updater keep the real version.
- **Rust releases**: a release without `harbor-app.json` (every Rust release) is `NoBuild`: the updater stays "up to date", logs nothing,
  doesn't ask again for an hour and never swaps; it takes that release's signed phone app when it is newer than the one beside it.
  `harbor --update` says "has no build of this app yet" and exits 0.
- **Back to Rust**: a restart into another program releases the instance lock before it starts it (Rust waits for the lock only when it
  replaced its own pid). The TS watchdog's rollback, "Restore previous version" and `harbor --restore-previous` restore `.previous/harbor`.
- **`ts/scripts/install-one.sh`**: `install BINARY`, `undo [--restore-db]`, `restart`, `status`. Checks the folder (`.managed`, Rust
  `0.109.0`, `VERSION` agreeing, no `.staging`, no live preview, schema 8, owner), backs up `harbor.db` by `VACUUM INTO` (checked), `identity.pem`,
  `secrets.json`, `account.json`, the kv key names and `.previous` into `~/.local/state/harbor-switch/<time>/` (0700), keeps Rust in
  `.previous/harbor` as Rust's `replace` does, writes `VERSION`, renames the binary over `harbor` last and waits for the Rust app to exec
  into it. It presses Update itself: once Rust's file watcher has seen the change (about 3 s) it sends the phone's Update
  (`POST /v1/hub/update`) over loopback with a pairing token from before accounts, read from the PC's own kv, and Rust restarts in
  place with its screen and queue (`reload_now`), about 5 s after the swap. Without such a token (`status` says so) it waits for the
  Update button, a phone's Update or Rust's quiet moment. `restart` stops it and starts the new one with its environment.
  `undo` puts Rust back and the original `.previous`; the db only with `--restore-db`, once per backup.
  Before it changes anything, `install` runs `harbor --check-window 5` from the new binary on the PC's own display, on a temp data
  folder, offline, and wants it up for 5 s and, where `hyprctl` or `swaymsg` can say so, the compositor showing its window. Without
  `WAYLAND_DISPLAY` it takes the session's from the user's running programs, else the newest socket in the runtime folder. On a
  failure it prints the app's error and stops.
- **Rig** `ts/rig/install-one/switch.sh` (inside `unshare -Urnm`): Rust 0.109.0 from its signed release archive installed by its own
  `install.sh` in a fake home, a scrambled harbor.db (319 chats, 74,706 items), throwaway identities, a fake `claude` and a fake `curl`. The gap
  before Rust restarts: a turn Rust starts then runs on the TypeScript runner and Rust follows it to its reply; `harbor mcp`
  (initialize, tools/list, tools/call) and `harbor app gmail` from the TypeScript binary are answered by the old Rust app. Each PC has
  its own headless sway for the preflight; a binary whose window can't load Slint (`BAD_TS_BIN`) and a PC with no Wayland session are
  refused with nothing changed.
- **Window rig** `ts/rig/window.sh` (in `check.sh`): the built single executable and runtime + `harbor-app.js` must open and draw the
  window. Only `--version` and `--check-native` had been run on the build from cd91a8c, which exited at start on the owner's PC.

## Wiring other packages must do

- `ui`/app start: build an `Updater` from `defaultConfig()` with `swap: () => reloader.now()`, call `start()`, call `confirmStart(cfg)`
  after the first frame, `takeSnapshot(store)` at start, `watchFiles([harbor, harbor-app.js], reloader.now)`; toasts from `notices`.
- `net`: put `updater.info()` in the mesh hello and chat polls and call `updater.peerNews(peer.update)`; `/v1/hub/update` →
  `updater.checkAndInstall()` / `installNow()`, `/v1/hub/check` → `check()`; `/v1/app` `hub` = `info()`; `hub_update` =
  `notices.hubUpdate(...)`; `/mesh/v1/preview` → `preview.refuses` + `fetchOffer`, `/mesh/v1/preview/file` → `offeredFile`.
- `mcp` control socket: its `previewReceived` hook is synchronous; `preview.pushed(cfg, v, hooks)` is async (it smoke-tests the
  build), so the hook has to become async.
- `cli`: merge `updateCommands` (`--version`, `preview`) into the bundle's command table (`ts/app.ts` has only those for now);
  `--update`, `--restore-previous`, `runtime-version`, `smoke-bundle`, `start-watch` live in the launcher (they work when a bundle won't start).

## Not done / blockers

- The `ts/app.ts` bundle has no window or other commands yet; they arrive with `cli` and `ui`.
- No aarch64 run of any of this (this PC is x86_64); the workflow compiles and smoke-tests it on an arm runner, never run.
- The workflow, the worker and the legacy archive were never run or deployed (by rule). The workflow YAML parses and its triggers are tested.
- Real-network behaviour of the long-poll through Cloudflare (idle limits, Durable Object duration cost) is untested.
- Screen sharing is not restored after a swap (by design, as in the plan).

## Rust tests that no longer apply

- `update::schedule`: the 5-minute scheduler is replaced by the long-poll; its backoff is tested instead (`delivery.test.ts`).
- `reload::swaps_only_when_nobody_sees_it`: the plan removes the idle wait, so `quiet`/`Moment`/`Swap` don't exist.

## One entry for every command (bundle item)

`ts/app.ts` is the bundle's entry (`harbor.ts` is a two-line launcher of it for `bun harbor.ts`): `--version`, `turn`, `mcp`, `app`,
`net`, `nc`, `mesh`, `account`, `preview`, `--speech-worker`, `--background` and, with no argument, the window. Each command loads only its
own modules (a bundle that imported everything at start died on `sharp`'s native addon in `--version`). `run.ts` is the app itself:
instance lock, `ui`'s `Data` (its `Engine`) and `startHub` sharing that Engine and the store, the control socket (tool calls go to
`Engine.tool`; `harbor preview push/back`), the `Updater` and `Reloader`, `confirmStart`, and `ui`'s shell (`runShell`) or, with
`--background`, nothing. `hub.ts` takes an `Updater`, a `store` and an `engine`: update info goes in the mesh hello/chat polls and `/v1/app`,
`hub_update` in the state, `/v1/hub/update|check|auto` are answered, the phone app comes from the install folder, peers' update info goes
to `peerNews`. `ui`'s `Shell` got `snapshot()`/`restore()` and `run(data, hooks)` so a swap brings back the open chat and every draft.

Built artifacts (`scripts/build.ts app|runtime`, a temp folder, `rig/bundle.sh`; no network except the turn):
- `--version`: `harbor 0.109.0 (abcdef0)`; an unknown command exits 2 with the list.
- `--background`: takes the lock, opens `h.sock`, stops on SIGTERM; `harbor mcp --chat 1` initializes and a `tools/call` is answered by
  the `Engine` over the socket (`unknown agent` for a chat that doesn't exist: a real answer).
- `harbor turn <dir>` with a real Haiku call in a scratch folder: `"result":"bundle ok"`, exit 0, 2.5 s.
- The window on a private headless sway: `ui`'s shell at 1400x900 with a scrambled copy of a real db: sidebar, a clicked chat's transcript
  (markdown, code, tool cards), team panel, composer with the model picker and the provider logo.
- A swap on the compositor (`rig/bundle.sh swap`): a half-typed message in a chat, `harbor-app.js` replaced by a new file, the old process
  exits, the new one (same runtime, new pid) takes the lock and shows the same chat with the draft back in the composer.
- `bun test` (`real-runtime.test.ts`) builds the same artifacts and checks version, unknown command, `turn` with a fake program and `mcp`
  against a socket server of its own.

What does not work yet:
- Not exercised on screen: sending from the composer (typing works), the model picker's choices, settings pages, search, terminal, panes, tray.
- In window mode the `Engine`'s host is `ui`'s `Data` (it has no `isForeign`/`chatLink`/`hostname` of the hub's host), so mixed-mesh chats
  are not told apart from this PC's own in the engine; `--background` keeps the hub's host.
- Webhooks and the hook listener are not started; `provider_updates` is null; a preview is not announced to other PCs.
- Native addons (audit item): the runtime (179 MB, was 127 MB) carries sharp's `.node` and libvips and sherpa's `.node` and libraries
  as embedded files (`harbor:native`, listed per architecture by `scripts/build.ts`). `packages/update/src/native.ts` writes them once,
  side by side, to `$XDG_CACHE_HOME/harbor/native-<hash>/` (about 50 MB; an older folder is removed) and `process.dlopen`s the addons by
  path; their `$ORIGIN` rpaths find libvips and onnxruntime there, so no `LD_LIBRARY_PATH` is needed for `harbor --speech-worker`. The
  bundle holds the JavaScript of `sharp` and `sherpa-onnx-node` and asks the runtime for the addon (a patch of `sharp/dist/sharp.mjs`
  and a redirect of sherpa's `require`, both in `scripts/build.ts`). Built and run: `harbor --check-native` (sharp decodes a png and an
  svg, sherpa loads), and a real Parakeet transcription through `harbor --speech-worker` ("Ask not what your country can do for you…",
  3.6 s with load). The aarch64 files come from the arm runner's own `bun install`; not run here. libmpv (audit item 3) is not covered.
- Assets (`.slint`, fonts, logos) are in the bundle and written once to `$XDG_RUNTIME_DIR/harbor-embedded-<hash>/` at start.
- `ui`'s `blankStatus()` has an 8-digit colour (`#00000000`) that Slint's JS binding refuses for a brush.
