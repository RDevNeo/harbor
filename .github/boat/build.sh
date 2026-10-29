#!/bin/bash
# Run by release.yml (job build) on a boat.dev sandbox, from the extracted source: Harbor for
# x86_64 and aarch64, the licence reports and the unsigned APK, side by side.
. "$(dirname "$0")/lib.sh"
core=$(image harbor-builder .github/boat/Dockerfile)
apk=$(image harbor-android .github/boat/Dockerfile.android)
# aarch64 binaries (the updater tests) run under the kernel's binfmt qemu: Ubuntu 22.04's own
# qemu-user 6.2 crashes on them.
binfmt
# Once, before the parallel builds: rustup doesn't take two installs at a time.
toolchain "$core" --target aarch64-unknown-linux-gnu

# Harbor's Google OAuth client (mcp.rs option_env!), when release.yml passes it: by name only, so
# the values never show on a command line.
google=(-e HARBOR_GOOGLE_CLIENT_ID -e HARBOR_GOOGLE_CLIENT_SECRET)

# One target dir each: cargo locks a target dir for the whole build.
x86_64() {
  run_in "$core" "${rust[@]}" "${google[@]}" -e CARGO_TARGET_DIR=/c/target -e HARBOR_GIT_SHA -- bash -euo pipefail -c '
    cargo test --locked -- update::
    cargo build --release --locked
    ldd /c/target/release/harbor
    /c/target/release/harbor --version
    mkdir -p /out/harbor-x86_64 && cp /c/target/release/harbor /out/harbor-x86_64/'
}
aarch64() {
  local t=aarch64-unknown-linux-gnu T=AARCH64_UNKNOWN_LINUX_GNU
  run_in "$core" "${rust[@]}" "${google[@]}" -e CARGO_TARGET_DIR=/c/target-aarch64 -e HARBOR_GIT_SHA \
    -e CARGO_BUILD_TARGET=$t -e CARGO_TARGET_${T}_LINKER=aarch64-linux-gnu-gcc \
    -e QEMU_LD_PREFIX=/usr/aarch64-linux-gnu \
    -e CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc -e CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ \
    -e AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar -e PKG_CONFIG_ALLOW_CROSS=1 \
    -e PKG_CONFIG_LIBDIR_aarch64_unknown_linux_gnu=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
    -- bash -euo pipefail -c '
    cargo test --locked -- update::
    cargo build --release --locked
    b=/c/target-aarch64/aarch64-unknown-linux-gnu/release/harbor
    aarch64-linux-gnu-readelf -d "$b" | grep NEEDED
    "$b" --version
    mkdir -p /out/harbor-aarch64 && cp "$b" /out/harbor-aarch64/'
}

# The licence reports only change with the dependencies or the template (Harbor's own version
# left out). A failure never stops a release: the last good report is used, or none.
licences() {
  strip() { sed '/^name = "harbor[^"]*"$/{n;d}' "$1"; }
  local key
  key=$( (strip Cargo.lock; strip browser/Cargo.lock; cat packaging/about.toml packaging/about.hbs) | sha256sum | cut -c1-32)
  if [ "$(cat "$cache/lic/key" 2>/dev/null)" != "$key" ]; then
    run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-tools -- bash -euo pipefail -c '
      command -v cargo-about >/dev/null || { timeout 600 cargo install --locked -q --features cli cargo-about; rm -rf /c/target-tools; }
      fetch() { for i in 1 2; do timeout 120 cargo fetch --locked "$@" && return 0; sleep 5; done; return 1; }
      fetch && (cd browser && fetch)
      rm -rf /c/lic.new && mkdir -p /c/lic.new
      timeout 240 cargo about generate --frozen -c packaging/about.toml packaging/about.hbs -o /c/lic.new/harbor.html
      (cd browser && timeout 420 cargo about generate --frozen -c ../packaging/about.toml ../packaging/about.hbs -o /c/lic.new/harbor-browser.html)' \
      && echo "$key" > "$cache/lic.new/key" && rm -rf "$cache/lic" && mv "$cache/lic.new" "$cache/lic" \
      || echo "::warning::the licence reports failed; using the last good ones, if any"
  fi
  mkdir -p "$HOME/out/extra/lic"
  cp "$cache"/lic/*.html "$HOME/out/extra/lic/" 2>/dev/null || true
  rsvg-convert -w 256 -h 256 packaging/harbor.svg -o "$HOME/out/extra/harbor-256.png"
}

# Signed later in GitHub Actions, where the keystore is.
android() { apk_unsigned "$apk" /out/harbor-android/harbor-android-unsigned.apk; }

pids=() names=(x86_64 aarch64 licences android)
for n in "${names[@]}"; do
  ( s=$(date +%s); "$n"; echo "$n: $(( $(date +%s) - s ))s" ) > "$HOME/out/$n.log" 2>&1 &
  pids+=($!)
done
failed=()
for i in "${!pids[@]}"; do wait "${pids[$i]}" || failed+=("${names[$i]}"); done
for n in "${names[@]}"; do echo "::group::$n"; cat "$HOME/out/$n.log"; echo "::endgroup::"; done
for n in "${names[@]}"; do tail -1 "$HOME/out/$n.log"; done
[ ${#failed[@]} = 0 ] || { echo "::error::failed: ${failed[*]}"; exit 1; }
