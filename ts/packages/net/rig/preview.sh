#!/bin/bash
# Run inside `unshare -Urnm` only: Harbors on synthetic dbs and throwaway identities.
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 3; }
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_NO_DISCOVERY=1 PATH=/usr/bin
unset WAYLAND_DISPLAY DISPLAY

penv() { echo "HOME=$1/home XDG_DATA_HOME=$1/data XDG_STATE_HOME=$1/state XDG_CONFIG_HOME=$1/cfg XDG_CACHE_HOME=$1/cache XDG_RUNTIME_DIR=$1/run HARBOR_SOCK=$1/run/h.sock"; }
tsfp() { (cd $TS && env $(penv $1) $BUN -e 'import { Store, dataDir, stateDir } from "./packages/store/src/index.ts"; import { loadOrCreate } from "./packages/net/src/tls.ts"; Store.open(dataDir()).close(); console.log(loadOrCreate(stateDir()).fp)'); }

answers() { # kind of the Harbor answering → what it says to a paired PC and to a stranger
  local kind=$1 R=$T/$1; local a=$R/a b=$R/b x=$R/x
  mkdir -p $a/{home,data,state,cfg,cache,run} $b/{home,data,state,cfg,cache,run} $x/{home,data,state,cfg,cache,run}; chmod 700 $a/run $b/run $x/run
  local afp bfp; afp=$(tsfp $a); tsfp $x > /dev/null
  if [ $kind = rust ]; then bfp=$(env $(penv $b) $B mesh status | sed -n 's/^key: *//p'); else bfp=$(tsfp $b); fi
  sqlite3 $b/data/harbor/harbor.db "insert or replace into kv values('mesh_enabled','1'),('api_port','47941'),('mesh_id','pc:b'),('mesh_allowed','[{\"node\":\"\",\"name\":\"a\",\"fp\":\"$afp\",\"id\":\"pc:a\",\"addrs\":[\"127.0.0.1:47940\"]}]')"
  if [ $kind = rust ]; then env $(penv $b) $B --background > $R/b.log 2>&1 &
  else (cd $TS && exec env $(penv $b) $BUN harbor.ts --background > $R/b.log 2>&1) &
  fi
  local i; for i in $(seq 60); do (exec 3<>/dev/tcp/127.0.0.1/47941) 2>/dev/null && break; sleep 0.5; done
  sleep 1
  local call="$BUN $TS/packages/net/rig/meshcall.ts"
  local offer='{"id":"p1","sha256":"abababababababababababababababababababababababababababababababab","note":"try this","kind":"bundle"}'
  echo "POST preview, a paired PC's offer: $($call $a/state/harbor pc:a a 127.0.0.1:47941 $bfp POST /mesh/v1/preview "$offer")"
  echo "POST preview, no offer:            $($call $a/state/harbor pc:a a 127.0.0.1:47941 $bfp POST /mesh/v1/preview '{}')"
  echo "POST preview, not JSON fields:     $($call $a/state/harbor pc:a a 127.0.0.1:47941 $bfp POST /mesh/v1/preview '["p1"]')"
  echo "GET preview/file, nothing offered: $($call $a/state/harbor pc:a a 127.0.0.1:47941 $bfp GET '/mesh/v1/preview/file?kind=bundle&id=p1')"
  echo "GET preview/file, a stranger:      $($call $x/state/harbor pc:x x 127.0.0.1:47941 $bfp GET '/mesh/v1/preview/file?kind=bundle&id=p1')"
  kill %1 2>/dev/null; wait 2>/dev/null
}

answers rust > $T/rust.txt
answers ts > $T/ts.txt
echo "== Rust 0.108.0:"; cat $T/rust.txt
echo "== TypeScript:"; cat $T/ts.txt
if diff $T/rust.txt $T/ts.txt > /dev/null; then echo "SAME ANSWERS"; else echo "DIFFERENT:"; diff $T/rust.txt $T/ts.txt; exit 1; fi
