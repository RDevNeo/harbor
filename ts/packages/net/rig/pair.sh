#!/bin/bash
# Run inside `unshare -Urn` only: pairing by code between the Rust app and the TypeScript CLI, both ways.
set -u
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_ADDRS=127.0.0.1 PATH=/usr/bin
unset WAYLAND_DISPLAY DISPLAY
envof() { local d=$T/$1; mkdir -p $d/{home,data,state,cfg,cache,run}; chmod 700 $d/run; echo "HOME=$d/home XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/cfg XDG_CACHE_HOME=$d/cache XDG_RUNTIME_DIR=$d/run HARBOR_SOCK=$d/run/h.sock"; }
R=$(envof rust); S=$(envof ts)
env $R $B mesh status > /dev/null
sqlite3 $T/rust/data/harbor/harbor.db "insert or replace into kv values('mesh_enabled','1'),('api_port','47930'),('mesh_id','pc:rust')"
env $R $B --background > $T/rust.log 2>&1 & PR=$!
sleep 3
echo "== Rust shows a code, the TypeScript CLI joins"
env $R $B mesh pair > $T/pair.out 2>&1 & PP=$!
sleep 1; CODE=$(sed -n 's/^Pairing code: \([^ ]*\).*/\1/p' $T/pair.out)
(cd $TS && env $S $BUN harbor.ts mesh join 127.0.0.1:47930 "$CODE")
wait $PP; tail -1 $T/pair.out
echo "Rust allows: $(sqlite3 $T/rust/data/harbor/harbor.db "select v from kv where k='mesh_allowed'" | grep -o '"fp":"[0-9a-f]\{16\}' | sed 's/"fp":"//')"
echo "TS key:      $(cd $TS && env $S $BUN -e 'import { loadOrCreate } from "./packages/net/src/tls.ts"; import { stateDir } from "./packages/store/src/index.ts"; console.log(loadOrCreate(stateDir()).fp.slice(0,16))')"
kill $PR; wait $PR 2>/dev/null
echo "== A TypeScript hub shows a code, Rust joins"
(cd $TS && env DIR=$T/ts2/hub PORT=47931 ID=pc:ts2 NAME=ts2 SECS=25 $BUN packages/net/rig/peer.ts > $T/ts2.log 2>&1) & PH=$!
sleep 2
CODE2=$(cd $TS && DIR=$T/ts2/hub $BUN -e 'import { Store } from "./packages/store/src/index.ts"; import { showCode } from "./packages/net/src/index.ts"; console.log(showCode(Store.open(process.env.DIR + "/data")).code)')
env $R $B mesh join 127.0.0.1:47931 "$CODE2" 2>&1 | tail -1
wait $PH; grep "^chat\|^peer" $T/ts2.log | head -3
echo "TS hub's code: $(cd $TS && DIR=$T/ts2/hub $BUN -e 'import { Store } from "./packages/store/src/index.ts"; import { loadCode, loadAllowed } from "./packages/net/src/index.ts"; const s = Store.open(process.env.DIR + "/data"); console.log(JSON.stringify(loadCode(s)?.paired), loadAllowed(s).map((a) => a.fp.slice(0,16)).join(","))')"
echo "Rust key:      $(env $R $B mesh status | sed -n 's/^key: *//p' | cut -c1-16)"
