#!/bin/bash
# runtimes.sh bun|node: runtimes.ts on cost.py's private compositor, under the check lock.
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${HTS_TMP:-$HOME/.cache/hts/tmp-cpu}/rt WAYLAND_DISPLAY=wayland-1 DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
unset DISPLAY
node=${HTS_NODE:-$HOME/.local/share/mise/installs/node/26.7.0/bin/node}
case $1 in
  bun) run=(~/.bun/bin/bun "$here/runtimes.ts") ;;
  node) run=("$node" --experimental-strip-types --no-warnings "$here/runtimes.ts") ;;
  *) echo "usage: runtimes.sh bun|node" >&2; exit 2 ;;
esac
cd "$here/.." && exec flock ~/.cache/hts/check.lock "${run[@]}"
