#!/bin/bash
# Run by browser.yml on a boat.dev sandbox, from the extracted source: compiles harbor-browser.
#   browser.sh            x86_64, natively (job engine)
#   browser.sh aarch64    cross-compiled: boat has no arm64 machines (job engine-aarch64)
. "$(dirname "$0")/lib.sh"
mkdir -p "$cache/rustup" "$cache/cargo"
rust=(-e RUSTUP_HOME=/c/rustup -e CARGO_HOME=/c/cargo -e PATH=/c/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
case "${1:-x86_64}" in
  x86_64)
    img=$(image harbor-browser-builder .github/boat/Dockerfile.browser)
    run_in "$img" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-browser -- bash -euo pipefail -c '
      [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
      rustup toolchain install stable --profile minimal >/dev/null && rustup default stable >/dev/null
      rustc --version
      cd browser
      s=$(date +%s); cargo build --release --locked; echo "::notice::harbor-browser built in $(( $(date +%s) - s ))s"
      mkdir -p /out/harbor-browser && cp /c/target-browser/release/harbor-browser /out/harbor-browser/'
    ;;
  aarch64)
    t=aarch64-unknown-linux-gnu T=AARCH64_UNKNOWN_LINUX_GNU
    img=$(image harbor-browser-aarch64-builder .github/boat/Dockerfile.browser-aarch64)
    run_in "$img" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-browser-aarch64 \
      -e CARGO_BUILD_TARGET=$t -e CARGO_TARGET_${T}_LINKER=aarch64-linux-gnu-gcc \
      -e CC_$t=aarch64-linux-gnu-gcc -e CXX_$t=aarch64-linux-gnu-g++ -e AR_$t=aarch64-linux-gnu-ar \
      -e PKG_CONFIG_ALLOW_CROSS=1 -e PKG_CONFIG_LIBDIR_$t=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
      -e BINDGEN_EXTRA_CLANG_ARGS_$t=--target=aarch64-linux-gnu -- bash -euo pipefail -c '
      [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
      rustup toolchain install stable --profile minimal --target aarch64-unknown-linux-gnu >/dev/null && rustup default stable >/dev/null
      rustc --version
      cd browser
      s=$(date +%s); cargo build --release --locked; echo "::notice::harbor-browser (aarch64) built in $(( $(date +%s) - s ))s"
      b=/c/target-browser-aarch64/aarch64-unknown-linux-gnu/release/harbor-browser
      aarch64-linux-gnu-readelf -d "$b" | grep NEEDED
      mkdir -p /out/harbor-browser && cp "$b" /out/harbor-browser/'
    ;;
  *) echo "no engine for $1" >&2; exit 1 ;;
esac
