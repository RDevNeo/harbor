#!/bin/bash
# Run by release.yml (job cache) on the build's sandbox, before its snapshot is saved: keeps Bun and
# its package cache warm for the next build and for scripts/boat/check, saves the images as folders
# for the next sandbox (lib.sh), and drops what nothing uses: a sandbox loads its whole snapshot in
# the background, and the disk can stall whatever runs meanwhile for minutes (at 30 GB, a 732 s
# compile, an 8 minute scp; at 10 GB it loaded in 124 s).
. "$(dirname "$0")/lib.sh"
rootfs_save harbor-builder .github/boat/Dockerfile
rootfs_save harbor-android .github/boat/Dockerfile.android
core=$(image harbor-builder .github/boat/Dockerfile)
b=$(bun_get "$core" x64)
bun_get "$core" aarch64 >/dev/null
run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BUN_INSTALL_CACHE_DIR=/c/bun-cache -- bash -euo pipefail -c 'cd ts && bun install --frozen-lockfile >/dev/null'
# Older Bun versions, and the Rust app's build folders from before it was rewritten (0.109 and older).
v=$(bun_version)
find "$cache/bun" -mindepth 1 -maxdepth 1 ! -name "$v-*" -exec rm -rf {} + 2>/dev/null || true
rm -rf "${cache:?}/target" "${cache:?}/target-aarch64" "${cache:?}/test-deps" "${cache:?}/aarch64-deps"
echo "disk at the save: $(findmnt -no FSTYPE -T "$cache") (fuse: still loading)"
rootfs_down
