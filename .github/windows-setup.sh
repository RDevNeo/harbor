#!/bin/bash
# Harbor's setup for Windows, from an assembled release folder: called by release.yml's package job (Pack)
# with pkg/harbor-x86_64-windows (what harbor-x86_64-windows.zip holds). makensis (Debian's nsis) packs it
# with packaging/windows/setup.nsi: plain packing, nothing is built here.
#
#   windows-setup.sh PKG ICONS VERSION OUT
#
# ICONS is the build's folder with harbor.ico and harbor-setup.bmp (.github/windows-build.sh, scripts/winicon.ts).
set -euo pipefail
pkg=$(realpath "$1") icons=$(realpath "$2") ver=$3 out=$(realpath -m "$4")
root=$(cd "$(dirname "$0")/.." && pwd)
command -v makensis >/dev/null || { sudo apt-get install -y --no-install-recommends nsis >/dev/null; }
# Windows' four-part version: 0.181.0-rc.1 -> 0.181.0.0.
IFS=.- read -r ma mi pa _ <<< "$ver"
mkdir -p "$(dirname "$out")"
makensis -V2 -INPUTCHARSET UTF8 -DSRC="$pkg" -DICON="$icons/harbor.ico" -DBITMAP="$icons/harbor-setup.bmp" -DVERSION="$ver" -DVERSION4="$ma.$mi.${pa:-0}.0" -DOUT="$out" \
  "$root/packaging/windows/setup.nsi"
[ "$(od -An -c -N2 "$out" | tr -d ' ')" = MZ ] || { echo "$out is no Windows executable"; exit 1; }
ls -la "$out"
