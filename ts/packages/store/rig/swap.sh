#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
W=${RIG_TMP:?a scratch folder}; F=${FAKE_CLAUDE_DIR:?a folder with a fake claude}
rm -rf "$W"; mkdir -p "$W/art"
cd "$TS"
"$BUN" scripts/build.ts runtime "$W/art/runtime-a" --version 0.109.0 > /dev/null || exit 1
"$BUN" scripts/build.ts app "$W/art/bundle-a.js" --version 0.109.0 --min-runtime 0.109.0 --sha aaaaaaa > /dev/null || exit 1
"$BUN" scripts/build.ts runtime "$W/art/runtime-b" --version 0.110.0 > /dev/null || exit 1
"$BUN" scripts/build.ts app "$W/art/bundle-b.js" --version 0.110.0 --min-runtime 0.110.0 --sha bbbbbbb > /dev/null || exit 1
exec "$BUN" packages/store/rig/swap.ts "$W" "$W/art" "$F"
