#!/bin/bash
# Run by release.yml (jobs build and build-aarch64) on a boat.dev sandbox, from the extracted source:
# the parts it names, side by side, of x86_64, aarch64, licences (the reports) and android (the
# unsigned APK). Without any, all four.
#
# Harbor is TypeScript on Bun (ts/): each architecture gets the single executable `harbor` (what
# install.sh installs and older Harbors update to), and for the updater the runtime alone
# (harbor-runtime-<arch>) and the arch-neutral app bundle (harbor-app.js, x86_64's job only).
# HARBOR_VERSION names the version, HARBOR_MIN_RUNTIME the runtime the bundle needs (release.yml
# decides it from the release lane; the version itself when unset).
. "$(dirname "$0")/lib.sh"
core=$(image harbor-builder .github/boat/Dockerfile)
apk=$(image harbor-android .github/boat/Dockerfile.android)
ver=${HARBOR_VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' ts/package.json | head -1)}
sha=${HARBOR_GIT_SHA:-}
sha=${sha:0:7}
min=${HARBOR_MIN_RUNTIME:-$ver}

# Harbor's Google OAuth clients (scripts/build.ts bakes them in), when release.yml passes them: by
# name only, so the values never show on a command line.
google=(-e HARBOR_GOOGLE_CLIENT_ID -e HARBOR_GOOGLE_CLIENT_SECRET -e HARBOR_GOOGLE_WEB_CLIENT_ID -e HARBOR_GOOGLE_WEB_CLIENT_SECRET)

# Builds the three files from a tree at /src (bun on PATH), into /out/harbor-$ARCH.
# --frozen-lockfile: what bun.lock says, as the tests ran it.
build_ts='
  cd /src/ts
  bun install --frozen-lockfile
  o=/out/harbor-$ARCH
  mkdir -p "$o"
  bun scripts/build.ts single "$o/harbor" --version "$V" --sha "$SHA"
  bun scripts/build.ts runtime "$o/harbor-runtime-$ARCH" --version "$V"
  [ "$ARCH" != x86_64 ] || bun scripts/build.ts app "$o/harbor-app.js" --version "$V" --min-runtime "$MIN" --sha "$SHA"
  "$o/harbor" --version
  [ "$("$o/harbor-runtime-$ARCH" runtime-version)" = "$V" ]
  [ ! -f "$o/harbor-app.js" ] || [ "$("$o/harbor-runtime-$ARCH" smoke-bundle "$o/harbor-app.js")" = "harbor $V" ]'

x86_64() {
  local b; b=$(bun_get "$core" x64)
  run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BUN_INSTALL_CACHE_DIR=/c/bun-cache -e ARCH=x86_64 "${google[@]}" \
    -e V="$ver" -e SHA="$sha" -e MIN="$min" -- bash -euo pipefail -c "$build_ts"
  ldd "$HOME/out/harbor-x86_64/harbor"
  npm_notices
}
# boat has no arm64 machines, and Bun compiles for the machine it runs on (the native addons are
# picked by process.arch): ubuntu:22.04 for arm64 under qemu, on a copy of the tree so its
# node_modules don't meet x86_64's.
aarch64() {
  local b src="$HOME/src-aarch64"; b=$(bun_get "$core" aarch64)
  binfmt
  rm -rf "$src" && mkdir -p "$src"
  tar -C "$PWD" --exclude=node_modules --exclude=target --exclude=.git -cf - . | tar -C "$src" -xf -
  docker run --rm --platform linux/arm64 -u "$(id -u):$(id -g)" -e HOME=/tmp -e PATH="$b:/usr/bin:/bin" \
    -e BUN_INSTALL_CACHE_DIR=/c/bun-cache-aarch64 -e ARCH=aarch64 "${google[@]}" -e V="$ver" -e SHA="$sha" -e MIN="$min" \
    -v "$src:/src" -v "$cache:/c" -v "$HOME/out:/out" \
    ubuntu:22.04 bash -euo pipefail -c "$build_ts"
}

# The licence reports: the browser engine's crates (cargo-about), which only change with its
# dependencies or the template, and the app's npm packages (their LICENSE files, from x86_64's
# node_modules: run after it). A failure never stops a release: the last good report is used, or none.
licences() {
  strip() { sed '/^name = "harbor[^"]*"$/{n;d}' "$1"; }
  local key
  key=$( (strip browser/Cargo.lock; cat packaging/about.toml packaging/about.hbs) | sha256sum | cut -c1-32)
  if [ "$(cat "$cache/lic/key" 2>/dev/null)" != "$key" ]; then
    toolchain "$core"
    run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-tools -- bash -euo pipefail -c '
      command -v cargo-about >/dev/null || { timeout 600 cargo install --locked -q --features cli cargo-about; rm -rf /c/target-tools; }
      fetch() { for i in 1 2; do timeout 120 cargo fetch --locked "$@" && return 0; sleep 5; done; return 1; }
      cd browser && fetch
      rm -rf /c/lic.new && mkdir -p /c/lic.new
      timeout 420 cargo about generate --frozen -c ../packaging/about.toml ../packaging/about.hbs -o /c/lic.new/harbor-browser.html' \
      && echo "$key" > "$cache/lic.new/key" && rm -rf "$cache/lic" && mv "$cache/lic.new" "$cache/lic" \
      || echo "::warning::the browser's licence report failed; using the last good one, if any"
  fi
  mkdir -p "$HOME/out/extra/lic"
  cp "$cache"/lic/*.html "$HOME/out/extra/lic/" 2>/dev/null || true
  rsvg-convert -w 256 -h 256 packaging/harbor.svg -o "$HOME/out/extra/harbor-256.png"
}
npm_notices() {
  local b; b=$(bun_get "$core" x64)
  run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -- bun ts/scripts/notices.ts "/out/extra/lic/third-party-harbor.txt" \
    || echo "::warning::the npm packages' notices failed"
}

# Signed later in GitHub Actions, where the keystore is.
android() { apk_unsigned "$apk" /out/harbor-android/harbor-android-unsigned.apk; }

cpu_mark
# When the sandbox's lazy disk stops loading: ~ moves from FUSE to its real disk.
( while [ "$(findmnt -no FSTYPE -T "$cache")" = fuse ]; do sleep 2; done; echo "disk loaded at $SECONDS s" ) > "$HOME/out/disk.log" &
disk=$!
names=("$@")
[ $# != 0 ] || names=(x86_64 aarch64 licences android)
pids=()
for n in "${names[@]}"; do
  ( s=$(date +%s); "$n"; echo "$n: $(( $(date +%s) - s ))s" ) > "$HOME/out/$n.log" 2>&1 &
  pids+=($!)
done
failed=()
for i in "${!pids[@]}"; do wait "${pids[$i]}" || failed+=("${names[$i]}"); done
for n in "${names[@]}"; do echo "::group::$n"; cat "$HOME/out/$n.log"; echo "::endgroup::"; done
for n in "${names[@]}"; do tail -1 "$HOME/out/$n.log"; done
cpu_report
if kill "$disk" 2>/dev/null; then echo "disk still loading at $SECONDS s"; else cat "$HOME/out/disk.log"; fi
[ ${#failed[@]} = 0 ] || { echo "::error::failed: ${failed[*]}"; exit 1; }
