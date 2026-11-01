#!/bin/bash
# Run inside `unshare -Urn` only: throwaway identities and synthetic dbs. RELAY=rust|ts adds a
# relay PC and makes A and T unreachable to each other directly.
set -u
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
RELAY=${RELAY:-}
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 PATH=/usr/bin
unset WAYLAND_DISPLAY DISPLAY

rust_env() { # name
  local d=$T/$1; mkdir -p $d/{home,data,state,cfg,cache,run}; chmod 700 $d/run
  echo "HOME=$d/home XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/cfg XDG_CACHE_HOME=$d/cache XDG_RUNTIME_DIR=$d/run HARBOR_SOCK=$d/run/h.sock"
}
rust_fp() { env $(rust_env $1) $B mesh status | sed -n 's/^key: *//p'; }
rust_db() { echo $T/$1/data/harbor/harbor.db; }

AFP=$(rust_fp a)
mkdir -p $T/t; TFP=$(cd $TS && DIR=$T/t $BUN -e 'import { loadOrCreate } from "./packages/net/src/tls.ts"; console.log(loadOrCreate(process.env.DIR).fp)')
echo "rust A $AFP"; echo "ts   T $TFP"
VFP=""
if [ "$RELAY" = rust ]; then VFP=$(rust_fp v); echo "rust V $VFP (relay)"; fi
if [ "$RELAY" = ts ]; then mkdir -p $T/v; VFP=$(cd $TS && DIR=$T/v $BUN -e 'import { loadOrCreate } from "./packages/net/src/tls.ts"; console.log(loadOrCreate(process.env.DIR).fp)'); echo "ts   V $VFP (relay)"; fi

allowed() { # fp=addr ... → mesh_allowed JSON
  local out="" sep=""
  for x in "$@"; do out="$out$sep{\"node\":\"\",\"name\":\"\",\"fp\":\"${x%%=*}\",\"id\":\"\",\"addrs\":[\"${x#*=}\"]}"; sep=","; done
  echo "[$out]"
}

seed_rust() { # name port id allowed-json title
  local db=$(rust_db $1)
  sqlite3 $db "insert or replace into kv values('mesh_enabled','1'),('api_port','$2'),('mesh_id','$3'),('mesh_allowed','$4')"
  if [ -n "$5" ]; then
    sqlite3 $db "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(NULL,'$5','',0,'claude','claude-opus-5-5','medium','full',0,1761200000,'lead',NULL,'lead','','$(cat /proc/sys/kernel/random/uuid)','',0,0)"
    local cid=$(sqlite3 $db "select max(id) from chats")
    sqlite3 $db "insert into items values($cid,0,'{\"kind\":\"user\",\"text\":\"hello from rust\",\"files\":[],\"at\":1761200000}'),($cid,1,'{\"kind\":\"text\",\"text\":\"a reply on rust\",\"at\":1761200001}')"
  fi
}

A_ALLOW="$TFP=127.0.0.1:47931"; T_ALLOW="$AFP=127.0.0.1:47930"; UA=""; UT=""
if [ -n "$RELAY" ]; then
  A_ALLOW="$A_ALLOW $VFP=127.0.0.1:47932"; T_ALLOW="$T_ALLOW,$VFP=127.0.0.1:47932"
  UA="HARBOR_UNREACHABLE=127.0.0.1:47931"; UT="HARBOR_UNREACHABLE=127.0.0.1:47930"
fi
seed_rust a 47930 pc:rust-a "$(allowed $A_ALLOW)" "Chat made on Rust"
[ "$RELAY" = rust ] && seed_rust v 47932 pc:rust-v "$(allowed $AFP=127.0.0.1:47930 $TFP=127.0.0.1:47931)" ""

env $(rust_env a) $UA $B --background > $T/a.log 2>&1 & PA=$!
[ "$RELAY" = rust ] && { env $(rust_env v) $B --background > $T/v.log 2>&1 & PV=$!; }
if [ "$RELAY" = ts ]; then
  (cd $TS && env DIR=$T/v PORT=47932 ID=pc:ts-v NAME=ts-v ALLOW="$AFP=127.0.0.1:47930,$TFP=127.0.0.1:47931" SECS=40 $BUN packages/net/rig/peer.ts > $T/v.log 2>&1) & PV=$!
fi
(cd $TS && env $UT DIR=$T/t PORT=47931 ID=pc:ts NAME=ts ALLOW="$T_ALLOW" SEED="Chat made on TypeScript" SECS=${SECS:-30} $BUN packages/net/rig/peer.ts > $T/t.log 2>&1) & PT=$!
wait $PT
echo "== TypeScript PC's harbor.db"; cat $T/t.log | grep -v '^fp '
echo "== Rust PC A's harbor.db"
sqlite3 $(rust_db a) "select id, case home when '' then '(own)' else home end, substr(gid,1,8), title, (select count(*) from items i where i.chat_id=c.id) from chats c"
echo "== Rust A's copy of the TS chat's items"
sqlite3 $(rust_db a) "select i.seq, i.body from items i join chats c on c.id=i.chat_id where c.home!='' order by i.seq"
kill $PA ${PV:-} 2>/dev/null; sleep 0.5
grep -iE "error|panic" $T/a.log | head -5
[ -n "$RELAY" ] && { echo "== relay log"; grep -v '^fp ' $T/v.log | head -10; }
exit 0
