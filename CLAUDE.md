# Harbor: notes for agents

Harbor is TypeScript on Bun, with a Slint window (`ts/`; Bun's version is pinned in
`ts/package.json`). The Rust app was retired after 0.109.0; its sources are in git history only.
The phone app is Java (`android/`); the built-in browser's engine is Servo, a Rust crate of its own
(`browser/`); the video player is libmpv (`video/`); Slint's native module is Harbor's own build of
slint-ui's, patched so a compiled UI doesn't keep the compiler's state (`slint/`).

## TypeScript checks run on the PC

`tsc --noEmit`, `bun test` and `bun build` for `ts/` are light and run on the PC, with the pinned
Bun (`cd ts && bun install && bunx tsc --noEmit && bun test`). `scripts/boat/check` runs the same on
a clean sandbox and builds the release executable. Everything else keeps the boat.dev rule below.

## Follow main and soaked releases

A PC with Follow main on (`ts/packages/update/src/followmain.ts`) builds and runs every main commit that
changes the app bundle within seconds, from its own clone, so a push from your worktree goes live there:
keep main working. `harbor follow-main status` says what it's doing. To release only what has run there
for hours without a crash: `bun ts/scripts/soaked.ts status`, then `bun ts/scripts/soaked.ts release`
(`--dry-run`, `--minor`, `--note TEXT`); `gate [COMMIT]` is the check alone. Manual tagging still works.

## Show UI changes

Any change to what the user sees (`ts/packages/ui/**`, `*.slint`, cards, icons, text in the window)
ends with a screenshot of each screen it touches, before you report done:

- `scripts/shot` runs the working tree from source (no build: Bun runs the TS, Slint compiles the
  .slint at start) on a private headless sway, with no network, on a copy of harbor.db (`--empty`
  for no data at all), and prints the PNG paths last (under `~/.cache/harbor-shots/`). About 3 s a
  shot: it shoots as soon as the page is up and still, and fails loudly when the window didn't draw.
  `--view chat|chat:ID|settings:TAB|prs|issues|draft` picks the screen, `--steps` clicks and types
  first (x,y in the PNG's pixels), `--wait 2,6` shots at fixed times, `--size`, `--help`. With
  `--empty`, settings pages come from their own runner (`settingsrun.ts`, checked pixel for pixel
  against the window), a little faster.
- While iterating, `scripts/shot --watch [same options]` (start it with Harbor's start_process, not
  Bash) keeps the rig up and prints a new PNG path on every save under `ts/packages/ui`, 1.5-3 s
  after the save; `scripts/shot --stop` ends it, and it ends by itself after 30 idle minutes (`--idle`).
- Look at the PNG yourself (Read it), then put its zoomed crop (below) in your final reply as
  `![caption](/absolute/path.png)` next to the sentence it illustrates. A subagent puts the paths in its report; the lead puts them
  in its reply to the user: a subagent's images reach the user only that way.
- Previews are zoomed crops of exactly the area that changed (desktop and phone alike, each state
  shown, e.g. dark and light; PIL `crop` then `resize` 3-4x), not full screenshots: a whole window
  or phone screen shrinks in chat and small controls can't be judged from it. Send full screenshots
  only when asked.
- Shots of real chats may be shown in chat but never committed: they hold personal data (even
  `--empty` ones show this PC's home path on some pages).
- To let the user try a change: `scripts/preview --note "what changed"` opens a "Harbor preview · …"
  window beside their own Harbor, which it never restarts: this tree from source, on a copy of their
  data, with no network and a read-only home, on Hyprland's hidden `special:scratchpad` without
  focus, and one quiet "ready" notification. Tell the user Super+S shows and hides it. `--watch`
  restarts it in place on every save under `ts/` (about 2 s), `scripts/preview stop` closes it, and
  it closes by itself after 30 idle minutes; `scripts/preview status` has its log.
- `scripts/preview --swap` restarts the user's own window into this tree instead: only when the user
  asks for exactly that (and where the owner turned previews on; the restart can end your Bash
  call, so it's your last step). `scripts/preview back` returns it to the release.
- Shots and previews run at nice 19 and idle disk priority on the last two cores
  (`HARBOR_RIG_CPUS=2,3` picks others): the PC stays the user's.
- Phone UI (`android/`): `scripts/boat/phoneshot --screen chats,chat,settings` builds a test APK
  from the working tree and shoots it on an Android emulator on boat.dev (nothing runs here),
  against a hub of made-up chats with every card kind (`ts/rig/phonehub.ts`), and prints the PNG
  paths last (under `~/.cache/harbor-shots/phone-*/`, 1080x2400). `--tap X,Y`, `--swipe`, `--text`,
  `--key BACK`, `--shot NAME` step through the app, `--dark`, `--help`. Minutes, not seconds: start
  it with Harbor's start_process, and shoot every screen you need in one run.

## Hot reload (dev)

`harbor hot on DIR` (DIR a checkout; `off`, `status`; or `HARBOR_HOT=DIR` for a rig) makes the
running Harbor follow that checkout's TypeScript with no restart: on a save, the reloadable units it
touches are built from the checkout with `Bun.build` and swapped in (`ts/packages/ui/src/hotdev.ts`,
`ts/packages/store/src/hot.ts`), and the open chat is drawn again. About 35 ms from the save to the
swap, 0.2-0.35 s to the screen. Open chats, running turns and drafts stay. A build or load that
fails keeps the running version and says why in a toast. Units today: `cards` (the transcript's
cards, `ui/src/cards.ts` and what it imports, plus `@harbor/net` files changed since), `tools` (the
team tools, `agents/src/tools.ts`) and `prompts` (the agents' instructions, `agents/src/team.ts`).
A new unit is `hot.unit(name, entry, module)` at its caller, called through `.now`. A file that
holds state is `pin`ned in `hotdev.ts` `shareHost` (fresh builds use the app's instance; a change
to it says it needs a restart). Slint, `.slint` files and everything else still need a restart.

## Compute runs on boat.dev

Every build, test, benchmark or other compute-heavy job runs on a boat.dev sandbox: not on the PCs
and not on GitHub-hosted runners. GitHub Actions only orchestrates: checkout, start the boat job,
then sign, attest and publish. Two exceptions in release.yml, approved by the user: a bundle-only
release tag (plan says `where=runner`) builds its JavaScript on the GitHub runners themselves
(`.github/runner/build.sh`, x86_64 and an arm64 runner) and publishes from `package`; and the
release's unsigned phone app always builds on a runner (`.github/runner/android.sh`, job `android`),
signed in `package` as before. Runtime releases' desktop builds, every other workflow and every
build for development stay on boat (`scripts/boat/android` for the APK).

A PC may well have cargo, rustc or an Android SDK installed: don't use them for Harbor (the APK,
the browser engine, the video player and releases build on boat).

- What a PC needs: the boat CLI (`curl -fsSL https://boat.dev/install | sh`) logged in to the
  account that holds the snapshot `harbor-build` (`boat login`, or `boat login --key-stdin` with an
  API key), plus jq, git and GNU tar. No toolchain. If `boat` is missing or logged out, say so and
  stop; don't fall back to a local build.
- Rigs and anything else that needs the release executable: `scripts/boat/check --out DIR` brings
  it back (`--no-release` can't be combined with it), or `bun ts/scripts/build.ts single OUT` builds
  it here; copy it to the rig and run it as usual.
- Use the premade scripts; don't drive the `boat` CLI by hand.
  - `scripts/boat/check`: the working tree (uncommitted changes included) on a clean sandbox:
    `tsc`, `bun test`, then the release executable; `-- <filter>` picks tests, `--out DIR` brings
    the executable back, `--no-release` skips the build, `-q` keeps the output short. Takes minutes:
    give it the longest timeout, or run it in the background.
  - `scripts/boat/android`: the APK and the Android unit tests from the working tree (`--out DIR`).
  - `scripts/boat/phoneshot`: screenshots of the phone app on an emulator (`.github/boat/phoneshot.sh`),
    from the snapshot `harbor-phone` (emulator installed, phone booted once); `--save-snapshot`
    remakes it from harbor-build, `--rm-snapshot` drops it.
  - `scripts/boat/snapshot`: what a saved snapshot's ~/cache really holds (`--from NAME`), and
    the release's build and save steps on a copy of it (`--build --save NAME`, `--rm NAME`).
  - `.github/actions/boat`: starts a sandbox from a saved snapshot, runs a script there, brings
    the outputs back and deletes the sandbox (also on failure or cancellation, via
    `.github/boat/cleanup.sh`).
  - `.github/boat/build.sh`: the parts it's given, side by side, of Harbor for x86_64, for aarch64
    (Bun under qemu), the licence reports and the unsigned APK (release.yml uses it for a runtime
    release's desktop parts, each target on its own sandbox; the APK builds on a runner). Each
    architecture gives the single executable `harbor` (the archives) and the runtime alone; x86_64
    also the app bundle `harbor-app.js`. Installed copies update from the bundle, the runtime only
    when release.yml's plan job finds it changed (`ts/scripts/release.ts lane`). A bundle-only
    release skips the install tests (package checks the bundle on the runtime PCs have) and, when
    `android/` and `browser/` didn't change, reattaches the latest release's signed APK instead of
    building one; such a release builds on the GitHub runners, not boat (the exception above).
    Servo itself is compiled only when `browser/` changes (browser.yml, by its tree id). A release
    is the `v*` tag alone: a push to main builds nothing, and running release.yml by hand on main
    is the dry run (signs and publishes nothing, saves the snapshot).
  - `.github/boat/browser.sh`: the Servo engine for x86_64, or (`browser.sh aarch64`) cross-compiled
    for aarch64 (browser.yml).
  - `.github/boat/browser-android.sh`: the phone app's Servo engine, arm64-v8a and armeabi-v7a, with
    the NDK (browser.yml).
  - `.github/boat/video.sh`: Harbor's video player, libmpv and FFmpeg as one library for x86_64 and
    aarch64 (video/build.sh, video.yml). `scripts/boat/video` runs it on the working tree.
  - `.github/boat/slint.sh`: Harbor's Slint addon, slint-ui's native module with
    `slint/keep-compiler-state.patch`, for x86_64 and aarch64 (slint/build.sh, slint.yml; the release
    builds it into the executables through `HARBOR_SLINT_ADDON`). `scripts/boat/slint` runs it on the
    working tree (`lock` resolves slint/Cargo.lock). Its id is the tree hash of `slint/`: after a
    change, run slint.yml by hand on main before tagging. `bun install`'s addon (dev runs, shots,
    previews) is still upstream's, which keeps ~100 MB more.
  - `.github/boat/smoke.sh`: the install tests on clean distro images (smoke.yml).
  - `.github/boat/run.sh`: runs a command on a sandbox and follows it; a lost connection to boat
    doesn't fail it.
  - `.github/workflows/prune.yml`: by hand, drops other engines' caches from `harbor-browser`.
- Sandboxes are `large`, start from the saved snapshots (`harbor-build`, `harbor-browser`,
  `harbor-browser-aarch64`, `harbor-browser-android`, `harbor-phone`) and are deleted when the job ends.
- A sandbox's disk loads on first touch, one file at a time: reading ahead in parallel made a run
  30 times slower. `harbor-build` keeps the build images as folders so nothing waits for docker
  (`.github/boat/warm.sh`, `run_in` in `.github/boat/lib.sh`).
- If no script covers the job you need, stop and ask the user before writing one. Don't improvise
  boat CLI commands; the new script should cover the job for every agent after you.
