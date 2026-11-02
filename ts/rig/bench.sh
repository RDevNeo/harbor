#!/bin/bash
# bench.sh [env...]: streambench.ts on cost.py's private compositor, under the check lock.
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${HTS_TMP:-$HOME/.cache/hts/tmp-cpu}/rt WAYLAND_DISPLAY=wayland-1
unset DISPLAY
cd "$here/.." && exec flock ~/.cache/hts/check.lock unshare -Ur env "$@" ~/.bun/bin/bun rig/streambench.ts
