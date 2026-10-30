#!/bin/bash
# Run by release.yml (job cache) on the build's sandbox, before its snapshot is saved: the release
# build doesn't compile the tests, but scripts/boat/check does, from this snapshot. When the
# dependencies or the compiler changed, compiles them once so every check after this starts warm.
# Also saves the images as folders for the next sandbox (lib.sh).
. "$(dirname "$0")/lib.sh"
rootfs_save harbor-builder .github/boat/Dockerfile
rootfs_save harbor-android .github/boat/Dockerfile.android
core=$(image harbor-builder .github/boat/Dockerfile)
key=$( (sha256sum < Cargo.lock; run_in "$core" "${rust[@]}" -- rustc -V) | sha256sum | cut -c1-32)
if [ "$(cat "$cache/test-deps" 2>/dev/null)" != "$key" ]; then
  run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target -- cargo test --locked --no-run
  echo "$key" > "$cache/test-deps"
fi
rootfs_down
