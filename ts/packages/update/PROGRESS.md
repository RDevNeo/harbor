# @harbor/update

Phase 6. Rewritten for the plan's Architecture (runtime + app bundle), not ported line by line.

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| update.rs | done, redesigned: minisign check, manifest, runtime-then-bundle install, long-poll + GitHub + mesh delivery, rollback, browser/video/phone-app extras, `--update`, `--restore-previous` | 10 of 11 |
| reload.rs | done as `reload.ts`: snapshot, restart through the runtime, file watcher. The idle wait is gone by design | 0 of 1 |
| preview.rs | done as `preview.ts` + `previewmeta.ts`; previews are bundles, not binaries | 7 of 7 |
| notices.rs | done as a UI-free model (`notices.ts`): toast texts, dismissals, the phone banner; the drawing belongs to `ui` | 0 of 0 (12 new) |
| (new) | `launcher.ts` (the runtime's program), `startup.ts` (clean start, watchdog), `lane.ts` + `release-cli.ts` (lane choice, manifest), `worker/src/release.js`, `.github/workflows/ts-release.yml`, `ts/scripts/build.ts`, `ts/runtime.ts`, `ts/app.ts` | n/a |

Tests: 146 in 13 files (`bun test packages/update`), all passing; Rust `#[test]`s of these modules: 19, ported 17, 2 no longer apply (last section).

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
  watchdog dies with the app (a systemd unit) the next start finds the unconfirmed attempt and does the same. `info()` carries
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

## In-place upgrade from the Rust app (Hard rule, not done)

A last Rust release can install the TypeScript runtime with little change, because the Rust updater already replaces `harbor` in the
install folder and execs into it with `HARBOR_RELOADED_PID` set. It needs:

1. **One Rust change** (src/update.rs `install`, on `main`, in a last Rust release): also move `harbor-app.js` (and `RUNTIME`) from the
   unpacked archive into the install folder, before the final `replace(harbor)`. Nothing else in `install` needs to change: it
   keeps `.previous/harbor` (the Rust binary), `VERSION` and `.managed`, so "Restore previous version" goes back to Rust.
2. **A bridging TypeScript release** that also publishes the legacy archive name that Rust fetches (`harbor-<arch>-linux.tar.gz` with a
   `.minisig`, trusted comment `harbor v<ver> harbor-<arch>-linux.tar.gz`), holding the runtime as `harbor`, `harbor-app.js`,
   `RUNTIME`, `VERSION`, `browser.id`, `video.id` and `licenses/`. That asset is not built by `ts-release.yml` yet.
3. The TypeScript side already accepts the handover: it opens the same `harbor.db`, takes the instance lock for the old pid, and
   restores the Rust app's `reload_state` snapshot.

Until step 1 is in a shipped Rust release, a Rust PC cannot reach the runtime by itself; a person would run an installer.

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
