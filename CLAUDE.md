# Harbor: notes for agents

## Compute runs on boat.dev

Every build, test, benchmark or other compute-heavy job runs on a boat.dev sandbox: not on this
PC (it has no Rust or Android toolchain) and not on GitHub-hosted runners. GitHub Actions only
orchestrates: checkout, start the boat job, then sign, attest and publish.

- Use the premade scripts; don't drive the `boat` CLI by hand.
  - `scripts/boat/check`: every build or test of local changes. Tests the working tree (uncommitted
    changes included), then builds it for release; `-- <filter>` picks tests, `--out DIR` brings
    the binary back, `--no-release` skips the build, `-q` keeps the output short. Takes minutes:
    give it the longest timeout, or run it in the background.
  - `scripts/boat/android`: the APK and the Android unit tests from the working tree (`--out DIR`).
  - `.github/actions/boat`: starts a sandbox from a saved snapshot, runs a script there, brings
    the outputs back and deletes the sandbox (also on failure or cancellation, via
    `.github/boat/cleanup.sh`).
  - `.github/boat/build.sh`: Harbor for x86_64 and aarch64, the updater tests, the licence
    reports and the unsigned APK (release.yml).
  - `.github/boat/browser.sh`: the Servo engine for x86_64, or (`browser.sh aarch64`) cross-compiled
    for aarch64 (browser.yml).
  - `.github/boat/browser-android.sh`: the phone app's Servo engine, arm64-v8a and armeabi-v7a, with
    the NDK (browser.yml).
  - `.github/boat/smoke.sh`: the install tests on clean distro images (smoke.yml).
- Sandboxes are `large`, start from the saved snapshots (`harbor-build`, `harbor-browser`,
  `harbor-browser-aarch64`, `harbor-browser-android`) and are deleted when the job ends.
- If no script covers the job you need, stop and ask the user before writing one. Don't improvise
  boat CLI commands; the new script should cover the job for every agent after you.
