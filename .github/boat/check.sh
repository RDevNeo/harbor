#!/bin/bash
# Run by scripts/boat/check on a boat.dev sandbox, from the copied working tree: the TypeScript app's
# type check and tests, then (RELEASE=1) its release executable, as build.sh makes it.
. "$(dirname "$0")/lib.sh"
core=$(image harbor-builder .github/boat/Dockerfile)
b=$(bun_get "$core" x64)
bun_in() { run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BUN_INSTALL_CACHE_DIR=/c/bun-cache -e NO_COLOR="${NO_COLOR:-}" -- "$@"; }
step() {
  local name="$1" s=$SECONDS; shift
  echo "==> $name"
  # A home of its own: tests show paths under it as ~, and their temporary folders are in /tmp.
  if bun_in bash -euo pipefail -c "export HOME=/tmp/home && mkdir -p \$HOME && cd ts && $*" 2>&1; then
    echo "<== $name ok $((SECONDS - s))s"
  else
    echo "<== $name FAILED $((SECONDS - s))s"; exit 1
  fi
}
step install bun install --frozen-lockfile
step typecheck bun --bun node_modules/.bin/tsc --noEmit
args=""
[ $# = 0 ] || args=$(printf '%q ' "$@")
step test bun test $args
if [ "${RELEASE:-1}" = 1 ]; then
  v=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' ts/package.json | head -1)
  step release bun scripts/build.ts single /out/harbor --version "$v-check"
  "$HOME/out/harbor" --version
fi
