#!/bin/bash
# Harbor for Windows (x64), cross-built on Linux: called by .github/boat/build.sh (part `windows`, in its
# build image) and .github/runner/build.sh (`windows`), with bun on PATH.
#
#   windows-build.sh SRC OUT
#
# SRC is the checkout (left untouched: its node_modules are Linux's, and another build may be using them),
# OUT gets harbor-windows/harbor.exe, harbor-windows/harbor.png and harbor-windows/harbor-runtime-x86_64-windows.exe.
# V (the version), SHA and the HARBOR_GOOGLE_* clients come from the environment, as for Linux's builds.
# Bun can't set a Windows executable's icon and version when it builds elsewhere: scripts/winicon.ts stamps them.
set -euo pipefail
src=$(realpath "$1") out=$(realpath -m "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Linux's build may be writing in SRC meanwhile (boat runs both side by side): tar's "file changed as we
# read it" (exit 1) is expected there; anything worse fails.
{ tar -C "$src" --exclude=node_modules --exclude=target --exclude=.git --warning=no-file-changed -cf - . || [ $? = 1 ]; } | tar -C "$work" -xf -
cd "$work/ts"
bun install --frozen-lockfile --os win32 --cpu x64
o=$out/harbor-windows
mkdir -p "$o"
bun scripts/build.ts single "$o/harbor.exe" --target windows-x64 --version "$V" --sha "${SHA:-}"
bun scripts/build.ts runtime "$o/harbor-runtime-x86_64-windows.exe" --target windows-x64 --version "$V"
# The icon is drawn here, by sharp for this machine: Linux's packages back for that.
bun install --frozen-lockfile
bun scripts/winicon.ts "$o" --stamp "$o/harbor.exe" --version "$V"
bun scripts/winicon.ts "$o" --stamp "$o/harbor-runtime-x86_64-windows.exe" --version "$V"
rm -f "$o/harbor.ico"
# What runs on Windows can't run here: that both are PE executables ("MZ") is what's checked.
for f in "$o/harbor.exe" "$o/harbor-runtime-x86_64-windows.exe"; do
  [ "$(od -An -c -N2 "$f" | tr -d ' ')" = MZ ] || { echo "$f is no Windows executable"; exit 1; }
done
ls -la "$o"
