#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# A branch's Discord app on a real desktop, next to the installed Harbor and sharing nothing with it.
#   try.sh <harbor binary>                  opens Settings › Integrations: sign in there
#   try.sh <harbor binary> tool <name> [json]   calls a tool as an agent would
#   try.sh <harbor binary> status
#   try.sh <harbor binary> wipe             signs out and removes everything of this test
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=$(realpath "$1"); shift
base=${HARBOR_DISCORD_TRY:-$HOME/.cache/harbor-discord-try}
mkdir -p "$base/data" "$base/state"
chmod 700 "$base"
export XDG_DATA_HOME=$base/data XDG_STATE_HOME=$base/state
# The shell from this checkout: an unreleased binary has no tag to download it from.
export HARBOR_DISCORD_SHELL=$(dirname "$here")
case "${1:-}" in
  "")
    HARBOR_SOCK=$base/h.sock HARBOR_LISTEN=127.0.0.1 HARBOR_ADDRS=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_VIEW=integrations exec "$bin"
    ;;
  tool|status)
    exec node "$here/tool.mjs" "$bin" "$@"
    ;;
  wipe)
    node "$here/tool.mjs" "$bin" signout || true
    sleep 8
    rm -rf "$base"
    ;;
  *)
    sed -n 3,7p "$0" >&2
    exit 2
    ;;
esac
