#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bun=${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}
[ -x "$bun" ] || { echo "run.sh: Bun not found (install it from bun.sh, or set BUN=/path/to/bun)" >&2; exit 1; }
real="${XDG_DATA_HOME:-$HOME/.local/share}/harbor/harbor.db"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/harbor-ts.XXXXXX")
mkdir -p "$tmp/data/harbor" "$tmp/state" "$tmp/cache"
chmod -R go-rwx "$tmp"
cd "$here"
[ -d node_modules ] || "$bun" install --frozen-lockfile
if [ -f "$real" ]; then
  "$bun" packages/ui/src/copydb.ts "$real" "$tmp/data/harbor/harbor.db"
  echo "run.sh: a copy of $real is in $tmp (the real one isn't touched)"
else
  echo "run.sh: no harbor.db on this PC: starting empty in $tmp"
fi
export XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" XDG_CACHE_HOME="$tmp/cache"
export HARBOR_SOCK="$tmp/harbor.sock" HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1
exec "$bun" harbor.ts "$@"
