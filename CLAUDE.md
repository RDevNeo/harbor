# Harbor: notes for agents

Harbor is TypeScript on Bun, with a Slint window (`ts/`; Bun's version is pinned in
`ts/package.json`). The Rust app was retired after 0.109.0; its sources are in git history only.
The phone app is Java (`android/`); the built-in browser's engine is Servo, a Rust crate of its own
(`browser/`); the video player is libmpv (`video/`).

## TypeScript checks run on the PC

`tsc --noEmit`, `bun test` and `bun build` for `ts/` are light and run on the PC, with the pinned
Bun (`cd ts && bun install && bunx tsc --noEmit && bun test`). `scripts/boat/check` runs the same on
a clean sandbox and builds the release executable. Everything else keeps the boat.dev rule below.

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
- Look at the PNG yourself (Read it), then put it in your final reply as `![caption](/absolute/path.png)`
  next to the sentence it illustrates. A subagent puts the paths in its report; the lead puts them
  in its reply to the user: a subagent's images reach the user only that way.
- Shots of real chats may be shown in chat but never committed: they hold personal data (even
  `--empty` ones show this PC's home path on some pages).
- To try it live on the user's own window: `scripts/preview --note "what changed"` builds the app
  bundle here and switches this PC's Harbor to it (only where the owner turned previews on, which
  isn't yours to do; the restart can end your Bash call, so it's your last step);
  `scripts/preview back` returns to the release.
- Phone UI (`android/`) isn't covered yet: the APK comes from `scripts/boat/android --out DIR`;
  say the change is unseen rather than describing it as shown.

## Compute runs on boat.dev

Every build, test, benchmark or other compute-heavy job runs on a boat.dev sandbox: not on the PCs
and not on GitHub-hosted runners. GitHub Actions only orchestrates: checkout, start the boat job,
then sign, attest and publish.

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
  - `scripts/boat/snapshot`: what a saved snapshot's ~/cache really holds (`--from NAME`), and
    the release's build and save steps on a copy of it (`--build --save NAME`, `--rm NAME`).
  - `.github/actions/boat`: starts a sandbox from a saved snapshot, runs a script there, brings
    the outputs back and deletes the sandbox (also on failure or cancellation, via
    `.github/boat/cleanup.sh`).
  - `.github/boat/build.sh`: the parts it's given, side by side, of Harbor for x86_64, for aarch64
    (Bun under qemu), the licence reports and the unsigned APK (release.yml, each target on its own
    sandbox). Each architecture gives the single executable `harbor` (the archives) and the runtime
    alone; x86_64 also the app bundle `harbor-app.js`. Installed copies update from the bundle, the
    runtime only when release.yml's plan job finds it changed (`ts/scripts/release.ts lane`). A bundle-only
    release skips the install tests (package checks the bundle on the runtime PCs have) and, when
    `android/` and `browser/` didn't change, reattaches the latest release's signed APK instead of
    building one. Servo itself is compiled only when `browser/` changes (browser.yml, by its tree id). A
    release is the `v*` tag alone: a push to main builds nothing, and running release.yml by hand
    on main is the dry run (signs and publishes nothing, saves the snapshot).
  - `.github/boat/browser.sh`: the Servo engine for x86_64, or (`browser.sh aarch64`) cross-compiled
    for aarch64 (browser.yml).
  - `.github/boat/browser-android.sh`: the phone app's Servo engine, arm64-v8a and armeabi-v7a, with
    the NDK (browser.yml).
  - `.github/boat/video.sh`: Harbor's video player, libmpv and FFmpeg as one library for x86_64 and
    aarch64 (video/build.sh, video.yml). `scripts/boat/video` runs it on the working tree.
  - `.github/boat/smoke.sh`: the install tests on clean distro images (smoke.yml).
  - `.github/boat/run.sh`: runs a command on a sandbox and follows it; a lost connection to boat
    doesn't fail it.
  - `.github/workflows/prune.yml`: by hand, drops other engines' caches from `harbor-browser`.
- Sandboxes are `large`, start from the saved snapshots (`harbor-build`, `harbor-browser`,
  `harbor-browser-aarch64`, `harbor-browser-android`) and are deleted when the job ends.
- A sandbox's disk loads on first touch, one file at a time: reading ahead in parallel made a run
  30 times slower. `harbor-build` keeps the build images as folders so nothing waits for docker
  (`.github/boat/warm.sh`, `run_in` in `.github/boat/lib.sh`).
- If no script covers the job you need, stop and ask the user before writing one. Don't improvise
  boat CLI commands; the new script should cover the job for every agent after you.
