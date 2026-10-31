#!/bin/bash
# Run by release.yml (job cache) on the build's sandbox, before its snapshot is saved: the release
# build doesn't compile the tests, but scripts/boat/check does, from this snapshot. When the
# dependencies or the compiler changed, compiles them once so every check after this starts warm.
# Then gives each build script's binary its own copy, or the next sandbox can't link it (relink.sh).
# Also saves the images as folders for the next sandbox (lib.sh), and drops what nothing uses: a
# sandbox loads its whole snapshot in the background, and until that's done the disk starves the
# compiles (732 s against 111 s, at 30 GB). Cargo never deletes an old version's Harbor, 0.9 GB a
# release, and aarch64 is never built for debug.
. "$(dirname "$0")/lib.sh"
rootfs_save harbor-builder .github/boat/Dockerfile
rootfs_save harbor-android .github/boat/Dockerfile.android
core=$(image harbor-builder .github/boat/Dockerfile)
key=$( (sha256sum < Cargo.lock; run_in "$core" "${rust[@]}" -- rustc -V) | sha256sum | cut -c1-32)
if [ "$(cat "$cache/test-deps" 2>/dev/null)" != "$key" ]; then
  run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target -- cargo test --locked --no-run
  echo "$key" > "$cache/test-deps"
fi
rm -rf "${cache:?}/target-aarch64/debug" "${cache:?}/target-aarch64/aarch64-unknown-linux-gnu/debug"
for d in "$cache"/target/{debug,release}/deps "$cache"/target-aarch64/aarch64-unknown-linux-gnu/release/deps; do
  { ls -t "$d"/harbor-???????????????? 2>/dev/null || true; } | tail -n +2 | while read -r old; do rm -f "$old" "$old.d"; done
done
{ ls -td "$cache"/target/debug/incremental/harbor-* 2>/dev/null || true; } | tail -n +2 | xargs -r rm -rf
bash .github/boat/relink.sh --split "$cache"/target/{release,debug} "$cache"/target-aarch64/release
echo "snapshot: $(df --output=used -BG "$cache" | tail -1 | tr -d ' ') used"
rootfs_down
