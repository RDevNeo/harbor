#!/bin/bash
# Inside `unshare -Urnm` only; it never touches the PC's own screen.
# SWAY: the sway prefix (bin/, lib/); RIG_TMP: scratch; HOLD_S: how long each window must stay up (6).
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 99; }
ip link set lo up
# Nothing here may reach the PC's own screen: the display cards are hidden, the render nodes stay.
for c in /dev/dri/card*; do mount --bind /dev/null "$c" || { echo "refused: can't hide $c" >&2; exit 99; }; done
SW=${SWAY:?}; T=${RIG_TMP:?}; HOLD=${HOLD_S:-6}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$T"; mkdir -p "$T/sway"; chmod 700 "$T/sway"
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { local w=$1; shift; if "$@"; then ok "$w"; else bad "$w"; fi; }

echo "== building"
(cd "$TS" && "$BUN" scripts/build.ts single "$T/single/harbor" --version 0.0.1-ts --sha rig0000 > "$T/build.log" 2>&1 &&
  "$BUN" scripts/build.ts runtime "$T/runtime/harbor" --version 0.0.1-ts >> "$T/build.log" 2>&1 &&
  "$BUN" scripts/build.ts app "$T/runtime/harbor-app.js" --version 0.0.1-ts --min-runtime 0.0.1-ts --sha rig0000 >> "$T/build.log" 2>&1) || { cat "$T/build.log"; echo "== SOME FAILED"; exit 1; }
for f in single runtime; do touch "$T/$f/.managed"; printf 0.0.1-ts > "$T/$f/VERSION"; done

LD_LIBRARY_PATH=$SW/lib env -i HOME=$T XDG_RUNTIME_DIR=$T/sway WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LD_LIBRARY_PATH=$SW/lib "$SW/bin/sway" -c "$TS/rig/sway.conf" > "$T/sway.log" 2>&1 &
for _ in $(seq 100); do [ -S "$T/sway/wayland-1" ] && break; sleep 0.1; done
check "sway is up" test -S "$T/sway/wayland-1"
swaymsg() { LD_LIBRARY_PATH=$SW/lib SWAYSOCK=$(ls "$T"/sway/sway-ipc.*.sock | head -1) "$SW/bin/swaymsg" "$@"; }
shot() { env XDG_RUNTIME_DIR=$T/sway WAYLAND_DISPLAY=wayland-1 /usr/bin/grim -t ppm "$1"; }
# The rectangle sway shows for pid $1, empty when it shows none.
rect() { swaymsg -t get_tree | python3 -I -c 'import json,sys
def walk(n):
    yield n
    for c in n.get("nodes",[])+n.get("floating_nodes",[]): yield from walk(c)
for n in walk(json.load(sys.stdin)):
    if n.get("pid")==int(sys.argv[1]) and n.get("visible"): r=n["rect"]; print(r["x"],r["y"],r["width"],r["height"]); break' "$1"; }
# Distinct colours inside a rectangle of a ppm (P6) shot.
colours() { python3 -I -c 'import sys
d=open(sys.argv[1],"rb").read(); parts=d.split(maxsplit=4); w,h=int(parts[1]),int(parts[2]); px=parts[4]
x,y,rw,rh=map(int,sys.argv[2:6]); seen=set()
for j in range(y,min(y+rh,h),3):
    row=px[(j*w)*3:(j*w+w)*3]
    for i in range(x,min(x+rw,w),3): seen.add(row[i*3:i*3+3])
print(len(seen))' "$@"; }
env_of() { # form
  local h=$T/$1/pc
  mkdir -p "$h/home" "$h/run"; chmod 700 "$h/run"
  echo "HOME=$h/home XDG_DATA_HOME=$h/data XDG_STATE_HOME=$h/state XDG_CONFIG_HOME=$h/cfg XDG_CACHE_HOME=$h/cache XDG_RUNTIME_DIR=$h/run WAYLAND_DISPLAY=$T/sway/wayland-1 HARBOR_SOCK=$h/h.sock HARBOR_OFFLINE=1 HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent PATH=/usr/bin:/bin TZ=UTC"
}
# Only this rig's processes, by the runtime folder each one has.
stopall() { local p; for p in /proc/[0-9]*; do tr '\0' '\n' 2>/dev/null < "$p/environ" | grep -q "^XDG_RUNTIME_DIR=$T/" && kill "${p#/proc/}" 2>/dev/null; done 2>/dev/null; sleep 1; }

shot "$T/empty.ppm"
for f in single runtime; do
  echo "== the $f form: harbor with no arguments"
  env -i $(env_of $f) "$T/$f/harbor" > "$T/$f/app.log" 2>&1 &
  pid=$!
  r=""
  for _ in $(seq 150); do r=$(rect $pid); [ -n "$r" ] && break; kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  check "sway maps its window ($r)" test -n "$r"
  sleep "$HOLD"
  check "it is still running after $HOLD s" kill -0 $pid
  check "and sway still shows it" test -n "$(rect $pid)"
  shot "$T/$f.ppm"
  n=$(colours "$T/$f.ppm" ${r:-0 0 1 1}); e=$(colours "$T/empty.ppm" ${r:-0 0 1 1})
  check "it drew its screen: $n colours where the empty desktop has $e" test "${n:-0}" -ge 40 -a "${e:-0}" -le 4
  check "its loop's poll Worker runs" grep -qx Worker /proc/$pid/task/*/comm
  check "its start was confirmed (starting.json says ok)" grep -q '"stage":"ok"' "$T/$f/starting.json"
  check "and the start log was let go of: stderr is back where it was" test "$(readlink /proc/$pid/fd/2)" = "$T/$f/app.log"
  kill $pid; for _ in $(seq 50); do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  check "it quits on SIGTERM" sh -c "! kill -0 $pid 2>/dev/null"
  [ $fail = 0 ] || { echo "--- $f/app.log"; grep -v '^Warning: \[object Object\]$' "$T/$f/app.log" | tail -20; }
done

echo "== harbor --check-window"
env -i $(env_of check) "$T/single/harbor" --check-window 3 > "$T/check.out" 2>&1; rc=$?
check "it opens the window and passes ($(grep '^window' "$T/check.out"))" test $rc = 0 -a "$(grep -c '^window ok: ' "$T/check.out")" = 1
env -i $(env_of nodisplay) WAYLAND_DISPLAY=$T/nowhere timeout 60 "$T/single/harbor" --check-window 3 > "$T/nodisplay.out" 2>&1; rc=$?
check "with no display it fails at once and says why (rc $rc: $(grep -m1 '^error' "$T/nodisplay.out" | cut -c1-80))" test $rc != 0 -a $rc != 124 -a -s "$T/nodisplay.out"
env -i $(env_of online) HARBOR_OFFLINE= "$T/single/harbor" --check-window 3 > "$T/online.out" 2>&1; rc=$?
check "it refuses to run online" test $rc = 2

echo "== a start that fails keeps its stderr in failed-start.log"
env -i $(env_of fails) WAYLAND_DISPLAY=$T/nowhere timeout 60 "$T/single/harbor" > "$T/fails.out" 2>&1; rc=$?
check "a start with no display exits (rc $rc)" test $rc != 0 -a $rc != 124
for _ in $(seq 50); do [ -f "$T/single/failed-start.log" ] && break; sleep 0.2; done
check "failed-start.log has the app's error ($(grep -m1 '^error' "$T/single/failed-start.log" 2>/dev/null | cut -c1-80))" test -s "$T/single/failed-start.log"
check "the start log is gone and no attempt is left" test ! -e "$T/single/start.log" -a ! -e "$T/single/starting.json"
sleep 2
check "the watchdog didn't start it again: nothing to go back to" test -z "$(for p in /proc/[0-9]*; do tr '\0' '\n' 2>/dev/null < "$p/environ" | grep -qx "XDG_RUNTIME_DIR=$T/fails/pc/run" && echo "${p#/proc/}"; done 2>/dev/null)"

stopall
echo "== $([ $fail = 0 ] && echo ALL PASS || echo SOME FAILED)"
exit $fail
