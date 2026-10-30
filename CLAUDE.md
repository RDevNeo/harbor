# Harbor: notes for agents

## Compute runs on boat.dev

Every build, test, benchmark or other compute-heavy job runs on a boat.dev sandbox: not on the PCs
and not on GitHub-hosted runners. GitHub Actions only orchestrates: checkout, start the boat job,
then sign, attest and publish.

A PC may well have cargo, rustc or an Android SDK installed: don't use them for Harbor. The old
local build script, `~/.cache/harbor-rel/build.sh`, is retired and only says so.

- What a PC needs: the boat CLI (`curl -fsSL https://boat.dev/install | sh`) logged in to the
  account that holds the snapshot `harbor-build` (`boat login`, or `boat login --key-stdin` with an
  API key), plus jq, git and GNU tar. No toolchain. If `boat` is missing or logged out, say so and
  stop; don't fall back to a local build.
- Rigs and anything else that needs a binary on this PC: compile on boat, run here. `scripts/boat/check
  --out DIR` brings the release binary back (`--no-release` can't be combined with it); copy it to
  the rig and run it as usual. Running a binary or a rig locally is fine; compiling is not.
- Use the premade scripts; don't drive the `boat` CLI by hand.
  - `scripts/boat/check`: every build or test of local changes. Tests the working tree (uncommitted
    changes included), then builds it for release; `-- <filter>` picks tests, `--out DIR` brings
    the binary back, `--no-release` skips the build, `-q` keeps the output short. Takes minutes:
    give it the longest timeout, or run it in the background.
  - `scripts/boat/dev`: see a change running, in about 10 seconds. Builds the working tree on one
    warm sandbox (`harbor-live`) with the `quick` profile, brings back a patch, and Harbor restarts
    into it on this PC and on the PCs that turned live previews on (`src/preview.rs`). `--check`
    is only `cargo check`, `--status` shows VM-hours, `--stop` stops it now. It's a preview, not a
    check: tests and releases stay with `scripts/boat/check`.
  - `scripts/boat/android`: the APK and the Android unit tests from the working tree (`--out DIR`).
  - `.github/actions/boat`: starts a sandbox from a saved snapshot, runs a script there, brings
    the outputs back and deletes the sandbox (also on failure or cancellation, via
    `.github/boat/cleanup.sh`).
  - `.github/boat/build.sh`: Harbor for x86_64 and aarch64, the licence reports and the unsigned
    APK (release.yml). A release is the `v*` tag alone: a push to main builds nothing, and running
    release.yml by hand on main is the dry run (signs and publishes nothing, saves the snapshot).
  - `.github/boat/browser.sh`: the Servo engine for x86_64, or (`browser.sh aarch64`) cross-compiled
    for aarch64 (browser.yml).
  - `.github/boat/browser-android.sh`: the phone app's Servo engine, arm64-v8a and armeabi-v7a, with
    the NDK (browser.yml).
  - `.github/boat/smoke.sh`: the install tests on clean distro images (smoke.yml).
  - `.github/boat/run.sh`: runs a command on a sandbox and follows it; a lost connection to boat
    doesn't fail it.
  - `.github/workflows/prune.yml`: by hand, drops other engines' caches from `harbor-browser`.
- Sandboxes are `large`, start from the saved snapshots (`harbor-build`, `harbor-browser`,
  `harbor-browser-aarch64`, `harbor-browser-android`) and are deleted when the job ends. The one
  exception is `harbor-live` (`scripts/boat/dev`): it stays, stopped, and boat's own timer stops it
  10 minutes after the last build, so VM-hours only run while someone is building.
- A sandbox's disk loads on first touch, one file at a time: reading ahead in parallel made a run
  30 times slower. `harbor-build` keeps the build images as folders so nothing waits for docker
  (`.github/boat/warm.sh`, `run_in` in `.github/boat/lib.sh`).
- If no script covers the job you need, stop and ask the user before writing one. Don't improvise
  boat CLI commands; the new script should cover the job for every agent after you.
