#!/bin/bash
# Run by browser.yml on a boat.dev sandbox, from the extracted source: compiles harbor-browser.
. "$(dirname "$0")/lib.sh"
mkdir -p "$cache/rustup" "$cache/cargo"
img=$(image harbor-browser-builder .github/boat/Dockerfile.browser)
run_in "$img" -e RUSTUP_HOME=/c/rustup -e CARGO_HOME=/c/cargo -e CARGO_TARGET_DIR=/c/target-browser \
  -e PATH=/c/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -- bash -euo pipefail -c '
  [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
  rustup toolchain install stable --profile minimal >/dev/null && rustup default stable >/dev/null
  rustc --version
  cd browser
  s=$(date +%s); cargo build --release --locked; echo "::notice::harbor-browser built in $(( $(date +%s) - s ))s"
  mkdir -p /out/harbor-browser && cp /c/target-browser/release/harbor-browser /out/harbor-browser/'
