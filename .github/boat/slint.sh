#!/bin/bash
# Run by slint.yml and scripts/boat/slint on a boat.dev sandbox, from the source: Harbor's Slint
# addon (slint/build.sh) into ~/out/slint.
#   slint.sh                       x86_64, aarch64, and its sources and licences
#   slint.sh lock                  resolves slint/Cargo.lock (to commit), first in a run
#   slint.sh x86_64 [aarch64…]     only those, for trying a change
. "$(dirname "$0")/lib.sh"
img=$(image harbor-slint-builder slint/Dockerfile)
targets=("$@")
[ $# -gt 0 ] || targets=(x86_64 aarch64 source)
t=aarch64-unknown-linux-gnu
toolchain "$img" --target "$t"
for w in "${targets[@]}"; do
  echo "==> slint $w"
  case "$w" in
    aarch64)
      run_in "$img" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-slint-aarch64 \
        -e CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
        -e CC_$t=aarch64-linux-gnu-gcc -e CXX_$t=aarch64-linux-gnu-g++ -e AR_$t=aarch64-linux-gnu-ar \
        -e PKG_CONFIG_ALLOW_CROSS=1 -e PKG_CONFIG_LIBDIR_$t=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
        -e BINDGEN_EXTRA_CLANG_ARGS_$t=--target=aarch64-linux-gnu -- bash slint/build.sh aarch64 ;;
    *) run_in "$img" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target-slint -- bash slint/build.sh "$w" ;;
  esac
  echo "<== slint $w ok"
done
