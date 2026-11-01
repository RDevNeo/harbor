#!/bin/bash
# `turn` makes a real, paid Anthropic call; `window` needs a headless compositor (HTS_RT, see README.md); `swap` replaces the bundle of the running window.
set -u
HTS=${HTS:-$HOME/.cache/hts}
TS=${TS:-$(cd "$(dirname "$0")/.." && pwd)}
W=${W:-$HTS/tmp-bundle}
B=$W/install
T=$W/state
BUN=${BUN:-$HOME/.bun/bin/bun}
CLAUDE=${CLAUDE:-$HOME/.local/share/mise/installs/claude/latest/claude}
REAL_HOME=$HOME
[ $# -gt 0 ] || set -- version background turn window swap

build() {
  rm -rf "$W"; mkdir -p "$B" "$T"/{home,data/harbor,state,cfg,run}
  (cd "$TS" && $BUN scripts/build.ts app "$B/harbor-app.js" --version 0.109.0 --min-runtime 0.109.0 --sha abcdef0 && $BUN scripts/build.ts runtime "$B/harbor" --version 0.109.0) || exit 1
  touch "$B/.managed"; echo 0.109.0 > "$B/VERSION"
  ls -la "$B"
}

env_up() {
  export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_RUNTIME_DIR=$T/run
  export HARBOR_SOCK=$T/run/h.sock HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_UPDATE_WORKER=off
}

inside() {
  [ "$1" = turn ] || ip link set lo up
  env_up
  case $1 in
    version) "$B/harbor" --version; "$B/harbor" bogus; echo "exit $?" ;;
    background)
      "$B/harbor" --background > "$W/bg.log" 2>&1 & bg=$!
      sleep 4; echo "alive: $(kill -0 $bg 2>/dev/null && echo yes || echo no)"; ls "$XDG_RUNTIME_DIR"
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_processes","arguments":{}}}' | timeout 20 "$B/harbor" mcp --chat 1
      kill -TERM $bg; sleep 1; echo "stopped: $(kill -0 $bg 2>/dev/null && echo no || echo yes)"; cat "$W/bg.log" ;;
    turn)
      mkdir -p "$W/turn" "$W/scratch"
      printf '{"program":"%s","args":["-p","Reply with exactly: bundle ok","--model","haiku","--output-format","stream-json","--verbose","--no-session-persistence","--max-turns","1"],"cwd":"%s","env":[],"input":false}' "$CLAUDE" "$W/scratch" > "$W/turn/cmd.json"
      HOME=$REAL_HOME "$B/harbor" turn "$W/turn"; echo "exit $(cat "$W/turn/exit")"; grep -o '"result":"[^"]*"' "$W/turn/out" ;;
    window|swap)
      cp "$HTS/tmp/stripped.db" "$T/data/harbor/harbor.db"
      for id in $(sqlite3 "$T/data/harbor/harbor.db" "select id from repos"); do mkdir -p "$T/home/p$id"; sqlite3 "$T/data/harbor/harbor.db" "update repos set path='$T/home/p$id' where id=$id"; done
      export XDG_RUNTIME_DIR=$HTS_RT WAYLAND_DISPLAY=wayland-1
      if [ "$1" = swap ]; then
        HARBOR_POINTER="130,145,click,3;680,780,click,4;680,780,type:half a sentence,5" "$B/harbor" > "$W/win.log" 2>&1 & win=$!
        sleep 8; echo "pid before: $win, lock holder: $(cat "$T/run/h.lock")"
        cp "$B/harbor-app.js" "$B/harbor-app.js.new" && mv "$B/harbor-app.js.new" "$B/harbor-app.js"
        sleep 8; echo "old process alive: $(kill -0 $win 2>/dev/null && echo yes || echo no), lock holder: $(cat "$T/run/h.lock")"
        grim "$W/swap.png" && echo "screenshot: $W/swap.png (the draft is back in the composer)"
        kill -TERM "$(cat "$T/run/h.lock")"; sleep 1
      else
        HARBOR_POINTER="130,145,click,3" "$B/harbor" > "$W/win.log" 2>&1 & win=$!
        sleep 8; echo "alive: $(kill -0 $win 2>/dev/null && echo yes || echo no)"
        grim "$W/window.png" && echo "screenshot: $W/window.png"
        kill -TERM $win; sleep 1
      fi ;;
  esac
}

if [ "${1:-}" = "--inside" ]; then shift; inside "$@"; exit; fi
build
for step in "$@"; do
  echo "=== $step"
  if [ "$step" = turn ]; then
    "$0" --inside turn
  elif [ "$step" = window ] || [ "$step" = swap ]; then
    unshare -Urn env HTS_RT="${HTS_RT:?set HTS_RT to the compositor runtime folder}" "$0" --inside "$step"
  else
    unshare -Urn "$0" --inside "$step"
  fi
done
