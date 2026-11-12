#!/bin/bash
# Harbor for macOS (Apple Silicon), cross-built on Linux: called by .github/boat/build.sh (part `macos`,
# in its build image) and .github/runner/build.sh (`macos`), with bun on PATH.
#
#   macos-build.sh SRC OUT
#
# SRC is the checkout (left untouched: its node_modules are Linux's, and another build may be using
# them), OUT gets harbor-macos/Harbor.app and harbor-macos/harbor-runtime-aarch64-macos. V (the version),
# SHA and the HARBOR_GOOGLE_* clients come from the environment, as for Linux's builds. Slint's addon is
# npm's (Harbor's own build is Linux's only for now), with its libintl bundled (scripts/build.ts).
set -euo pipefail
src=$(realpath "$1") out=$(realpath -m "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Linux's build may be writing in SRC meanwhile (boat runs both side by side): tar's "file changed as we
# read it" (exit 1) is expected there; anything worse fails.
{ tar -C "$src" --exclude=node_modules --exclude=target --exclude=.git --warning=no-file-changed -cf - . || [ $? = 1 ]; } | tar -C "$work" -xf -
cd "$work/ts"
bun install --frozen-lockfile --os darwin --cpu arm64
o=$out/harbor-macos
mkdir -p "$o"
bun scripts/build.ts single "$work/harbor" --target darwin-arm64 --version "$V" --sha "${SHA:-}"
bun scripts/build.ts runtime "$o/harbor-runtime-aarch64-macos" --target darwin-arm64 --version "$V"
# The app's icon is drawn here, by sharp for this machine: Linux's packages back for that.
bun install --frozen-lockfile
bun scripts/macapp.ts "$work/harbor" "$o" --version "$V"
# What runs on a Mac can't run here: that both are 64-bit Mach-O files (cf fa ed fe) is what's checked.
for f in "$o/Harbor.app/Contents/MacOS/harbor" "$o/harbor-runtime-aarch64-macos"; do
  [ "$(od -An -tx1 -N4 "$f" | tr -d ' ')" = cffaedfe ] || { echo "$f is no Mach-O executable"; exit 1; }
done
ls -la "$o" "$o/Harbor.app/Contents/MacOS"
