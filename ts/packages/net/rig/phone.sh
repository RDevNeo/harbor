#!/bin/bash
# Run inside `unshare -Urn` only: the same synthetic harbor.db served by the Rust hub and by the
# TypeScript hub, and their phone API answers compared (loopback, a pairing token from before accounts).
set -u
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T/a/{home,data,state,cfg,cache,run} $T/t/data; chmod 700 $T/a/run
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 PATH=/usr/bin TZ=UTC
unset WAYLAND_DISPLAY DISPLAY
A="HOME=$T/a/home XDG_DATA_HOME=$T/a/data XDG_STATE_HOME=$T/a/state XDG_CONFIG_HOME=$T/a/cfg XDG_CACHE_HOME=$T/a/cache XDG_RUNTIME_DIR=$T/a/run HARBOR_SOCK=$T/a/run/h.sock"
env $A $B mesh status > /dev/null
DB=$T/a/data/harbor/harbor.db; TOK=0123456789abcdef0123456789abcdef0123456789abcdef
sqlite3 $DB "insert or replace into kv values('api_enabled','1'),('api_port','47930'),('mesh_id','pc:rig'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"\",\"created\":0,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]')"
add_chat() { # title role
  sqlite3 $DB "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(NULL,'$1','',1,'claude','claude-opus-5-5','medium','full',0,1761200000,'$2',NULL,'lead','','$(cat /proc/sys/kernel/random/uuid)','',0,0)"
  sqlite3 $DB "select max(id) from chats"
}
put() { sqlite3 $DB "insert into items values($1,$2,'$(printf '%s' "$3" | sed "s/'/''/g")')"; }
for role in chat lead; do
  C=$(add_chat "Parity $role" $role)
  put $C 0 '{"kind":"user","text":"Fix it, see /tmp/notes.txt","files":["/tmp/shot.png","/tmp/notes.txt"],"at":1761200000}'
  put $C 1 '{"kind":"thinking","text":"hmm"}'
  put $C 2 '{"kind":"tool","id":"t1","name":"Bash","summary":"ls","input":"{\"command\":\"ls\"}","result":"a\nb","is_error":false}'
  put $C 3 '{"kind":"tool","id":"t2","name":"mcp__harbor__spawn_agent","summary":"api","input":"{}","result":null,"is_error":false}'
  put $C 4 '{"kind":"text","text":"# Done\n\nSome **bold**, *it*, `code`, ~~gone~~ and [a link](https://example.org/x).\nSee https://example.com/path, then:\n\n- one\n- [x] two\n  1. a\n\n> quoted\n\n| A | B |\n|---|---|\n| 1 | **2** |\n\n```rust\nfn main() {}\n```\n\n---","at":1761200001}'
  put $C 5 '{"kind":"result","cost_usd":0.5,"duration_ms":4300,"turns":1,"input_tokens":10,"output_tokens":5,"cached":0,"at":1761200002,"account":"claude","model":"claude-opus-5-5"}'
  put $C 6 '{"kind":"notice","icon":"process","text":"dev","detail":"http://127.0.0.1:3000"}'
  put $C 7 '{"kind":"message","from":"api","to":"lead","text":"done"}'
  put $C 8 '{"kind":"error","text":"boom"}'
done
get() { # port path out
  curl -s --max-time 30 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$1$2" > $3
}
env $A $B --background > $T/a.log 2>&1 & PA=$!
for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:47930/ && break; sleep 0.2; done
for c in 1 2; do get 47930 "/v1/chats/$c/items?since=0" $T/rust-$c.json; done
get 47930 /v1/state $T/rust-state.json
kill $PA; wait $PA 2>/dev/null
mkdir -p $T/t/data && cp $DB* $T/t/data/
(cd $TS && env DIR=$T/t PORT=47931 ID=pc:rig NAME=rig TOKEN=$TOK SECS=6 $BUN packages/net/rig/peer.ts > $T/t.log 2>&1) & PT=$!
for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:47931/ && break; sleep 0.2; done
for c in 1 2; do get 47931 "/v1/chats/$c/items?since=0" $T/ts-$c.json; done
get 47931 /v1/state $T/ts-state.json
wait $PT
cd $TS && $BUN packages/net/rig/compare.ts $T
