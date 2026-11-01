#!/bin/bash
# Run inside `unshare -Urnm` only: Harbors on synthetic dbs and throwaway identities.
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 3; }
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
FAKE=${FAKE_CLAUDE:?a fake claude executable}
PAIRS=${PAIRS:-"ts:ts ts:rust rust:ts"}
TOK=0123456789abcdef0123456789abcdef0123456789abcdef
SID=0b7c1a7e-1111-4222-8333-944455556666
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_NO_DISCOVERY=1
unset WAYLAND_DISPLAY DISPLAY
mkdir -p $T/bin; cp $FAKE $T/bin/claude; chmod +x $T/bin/claude
export PATH=$T/bin:/usr/bin
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }

penv() { # dir → the environment of the Harbor in it
  echo "HOME=$1/home XDG_DATA_HOME=$1/data XDG_STATE_HOME=$1/state XDG_CONFIG_HOME=$1/cfg XDG_CACHE_HOME=$1/cache XDG_RUNTIME_DIR=$1/run HARBOR_SOCK=$1/run/h.sock"
}
db() { echo $1/data/harbor/harbor.db; }
slug() { realpath $1 | sed 's/[^A-Za-z0-9]/-/g'; }

prepare() { # dir kind → prints the key fingerprint
  local d=$1 kind=$2
  mkdir -p $d/{home/.claude,data,state,cfg,cache,run,app}; chmod 700 $d/run
  echo '{}' > $d/home/.claude/.credentials.json
  if [ $kind = rust ]; then env $(penv $d) $B mesh status | sed -n 's/^key: *//p'
  else (cd $TS && env $(penv $d) $BUN -e 'import { Store, dataDir, stateDir } from "./packages/store/src/index.ts"; import { loadOrCreate } from "./packages/net/src/tls.ts"; Store.open(dataDir()).close(); console.log(loadOrCreate(stateDir()).fp)'); fi
}

start() { # dir kind log
  if [ $2 = rust ]; then env $(penv $1) $B --background > $3 2>&1 &
  else (cd $TS && exec env $(penv $1) $BUN harbor.ts --background > $3 2>&1) &
  fi
}

call() { curl -s --max-time 60 -w '\n%{http_code}' -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$@"; }

one() { # source-kind target-kind
  local ak=$1 bk=$2 R=$T/$1-$2; local a=$R/a b=$R/b
  mkdir -p $R
  echo; echo "######## $ak PC A  ->  $bk PC B"
  local afp bfp; afp=$(prepare $a $ak); bfp=$(prepare $b $bk)
  local DA=$(db $a) DB=$(db $b)
  local allow_a="[{\"node\":\"\",\"name\":\"\",\"fp\":\"$bfp\",\"id\":\"\",\"addrs\":[\"127.0.0.1:47931\"]}]"
  local allow_b="[{\"node\":\"\",\"name\":\"\",\"fp\":\"$afp\",\"id\":\"\",\"addrs\":[\"127.0.0.1:47930\"]}]"
  sqlite3 $DA "insert or replace into kv values('mesh_enabled','1'),('api_port','47930'),('mesh_id','pc:a'),('mesh_allowed','$allow_a'),('api_enabled','1'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"\",\"created\":0,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]')"
  sqlite3 $DB "insert or replace into kv values('mesh_enabled','1'),('api_port','47931'),('mesh_id','pc:b'),('mesh_allowed','$allow_b')"
  sqlite3 $DA "insert into repos(path,name) values('$a/app','app')"
  sqlite3 $DB "insert into repos(path,name) values('$b/app','app')"
  # A's started lead with a sub-agent, a transcript each, and the lead's Claude session on disk.
  sqlite3 $DA "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(1,'Fix the build','$SID',1,'claude','claude-opus-5-5','medium','full',0,1761200000,'lead',NULL,'lead','','11111111-aaaa-4bbb-8ccc-000000000001','',0,0)"
  sqlite3 $DA "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(1,'Tests','',0,'claude','claude-opus-5-5','medium','full',0,1761200000,'sub',1,'tests','','11111111-aaaa-4bbb-8ccc-000000000002','',0,0)"
  sqlite3 $DA "insert into items values(1,0,'{\"kind\":\"user\",\"text\":\"fix the build\",\"files\":[],\"at\":1761200000}'),(1,1,'{\"kind\":\"text\",\"text\":\"fixed it on $ak\",\"at\":1761200001}'),(2,0,'{\"kind\":\"user\",\"text\":\"write tests\",\"files\":[],\"at\":1761200002}')"
  local sd=$a/home/.claude/projects/$(slug $a/app)
  mkdir -p $sd/$SID/subagents
  echo '{"type":"user"}' > $sd/$SID.jsonl; echo '{"agent":1}' > $sd/$SID/subagents/agent-1.jsonl
  start $b $bk $R/b.log; start $a $ak $R/a.log
  # A lists B as a PC the chat can go to once they see each other.
  local out="" i
  for i in $(seq 80); do
    out=$(call http://127.0.0.1:47930/v1/chats/1/move_targets)
    echo "$out" | grep -q '"id":"pc:b"' && echo "$out" | grep -q '"why":null}\]' && break
    sleep 0.5
  done
  echo "== A: GET move_targets: $(echo "$out" | head -1)"
  out=$(call -X POST http://127.0.0.1:47930/v1/chats/1/move_pc -d '{"pc":"pc:b"}')
  echo "== A: POST move_pc: $(echo "$out" | tr '\n' ' ')"
  echo "$out" | tail -1 | grep -q 202 || fail "move_pc was not accepted"
  for i in $(seq 120); do
    [ "$(sqlite3 $DA "select home from chats where id=1")" = pc:b ] && break
    sleep 0.5
  done
  sleep 3
  echo "== A's chats (id, home, home_id, gid, title, session_id, items):"
  sqlite3 $DA "select id, case home when '' then '(own)' else home end, home_id, substr(gid,1,8), title, session_id, (select count(*) from items i where i.chat_id=c.id) from chats c"
  echo "== B's chats (id, home, repo, gid, title, session_id, started, parent, items):"
  sqlite3 $DB "select id, case home when '' then '(own)' else home end, repo_id, substr(gid,1,8), title, session_id, started, parent, (select count(*) from items i where i.chat_id=c.id) from chats c"
  echo "== B's items of its chat:"
  sqlite3 $DB "select i.seq, substr(i.body,1,150) from items i join chats c on c.id=i.chat_id where c.gid like '11111111-aaaa-4bbb-8ccc-000000000001' order by i.seq"
  echo "== B's session files:"
  (cd $b/home/.claude && find projects -type f | sed 's#^projects/[^/]*/#  <project folder of B>/#' | sort)
  echo "== A's kv move_pc: $(sqlite3 $DA "select v from kv where k='move_pc'")"
  [ "$(sqlite3 $DA "select home from chats where id=1")" = pc:b ] || fail "A's chat did not become a copy of B's"
  [ "$(sqlite3 $DB "select count(*) from chats where home='' and gid like '11111111-aaaa-4bbb-8ccc-000000000001'")" = 1 ] || fail "B does not own the chat"
  [ "$(sqlite3 $DB "select count(*) from chats where home='' and role='sub'")" = 1 ] || fail "B does not own the sub-agent"
  [ -f "$b/home/.claude/projects/$(slug $b/app)/$SID.jsonl" ] || fail "B has no session file"
  [ -f "$b/home/.claude/projects/$(slug $b/app)/$SID/subagents/agent-1.jsonl" ] || fail "B has no sidecar file"
  [ "$(sqlite3 $DB "select count(*) from items where chat_id=(select id from chats where role='lead' and home='')")" -ge 3 ] || fail "B's chat lacks its items"
  kill $(jobs -p) 2>/dev/null; wait 2>/dev/null
  grep -iE "error|panic" $R/a.log $R/b.log | head -5
}

for p in $PAIRS; do one ${p%%:*} ${p##*:}; done
echo; [ $FAIL = 0 ] && echo "ALL PAIRS PASSED" || echo "SOME CHECKS FAILED"
exit $FAIL
