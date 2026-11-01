#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_ADDRS=127.0.0.1 PATH=/usr/bin:/bin TZ=UTC
unset WAYLAND_DISPLAY DISPLAY
mk() { d=$T/$1; mkdir -p $d/{home,data,state,cfg,cache,run,turn,work}; chmod 700 $d/run; echo "HOME=$d/home XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/cfg XDG_CACHE_HOME=$d/cache XDG_RUNTIME_DIR=$d/run HARBOR_SOCK=$d/run/h.sock"; }
RE=$(mk rust); TE=$(mk ts)
norm() { sed -E "s#$T/(rust|ts)#T#g; s/harbor 0\.[0-9.]+ \([0-9a-f]+\)/harbor VERSION/; s/harbor 0\.[0-9.]+ \(ts\)/harbor VERSION/; s/[0-9a-f]{64}/FP/g; s/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/FP4/g" ; }
same=0; diff=0
try() {
  label=$1; shift
  ro=$(cd $T/rust/work && env $RE timeout 20 $B "$@" 2>&1 < /dev/null; echo "exit=$?")
  to=$(cd $T/ts/work && env $TE timeout 20 ${TS_CMD:-$BUN $TS/harbor.ts} "$@" 2>&1 < /dev/null; echo "exit=$?")
  if [ "$(echo "$ro" | norm)" = "$(echo "$to" | norm)" ]; then echo "SAME   $label"; same=$((same+1)); else echo "DIFFER $label"; echo "  rust: $(echo "$ro" | norm | head -4 | tr '\n' '|' | cut -c1-230)"; echo "  ts:   $(echo "$to" | norm | head -4 | tr '\n' '|' | cut -c1-230)"; diff=$((diff+1)); fi
}
try "--version" --version
try "-V" -V
try "net (usage)" net
try "net status" net status
try "mesh (usage)" mesh
try "mesh status" mesh status
try "mesh on" mesh on
try "mesh pair (no code)" mesh pair
try "mesh join (no target)" mesh join
try "nc (usage)" nc
try "nc to nowhere" nc 127.0.0.1 9
try "preview (usage)" preview
try "account (usage)" account
try "account status" account status
try "turn (no folder)" turn
try "mcp (no socket)" mcp
try "--check-video" --check-video
try "--restore-previous" --restore-previous
try "--update" --update
try "unknown command" frobnicate
for w in rust ts; do
  printf '{"program":"/bin/sh","args":["-c","echo out1; echo err1 >&2; exit 3"],"cwd":"%s","env":[["X","1"]]}' "$T/$w/work" > $T/$w/turn/cmd.json
done
(cd $T/rust/work && env $RE $B turn $T/rust/turn); (cd $T/ts/work && env $TE ${TS_CMD:-$BUN $TS/harbor.ts} turn $T/ts/turn)
for f in out err exit; do cmp -s $T/rust/turn/$f $T/ts/turn/$f && { echo "SAME   turn writes the same $f"; same=$((same+1)); } || { echo "DIFFER turn $f: rust $(head -c 60 $T/rust/turn/$f) | ts $(head -c 60 $T/ts/turn/$f)"; diff=$((diff+1)); }; done
echo "same $same, different $diff"
