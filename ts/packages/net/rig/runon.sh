#!/bin/bash
# Run inside `unshare -Urnm` only: a Harbor on a synthetic db with an SSH device whose ssh runs locally.
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 3; }
ip link set lo up
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd)
FAKE=${FAKE_CLAUDE:?a fake claude executable}
export HTS_STREAM_S=2
TOK=0123456789abcdef0123456789abcdef0123456789abcdef
SID=0b7c1a7e-1111-4222-8333-944455556666
A=$T/a; DEV=$T/device
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_NO_DISCOVERY=1
unset WAYLAND_DISPLAY DISPLAY
mkdir -p $T/bin $A/{home/.claude,data/harbor,state,cfg,cache,run} $DEV; chmod 700 $A/run
cp $FAKE $T/bin/claude
# The device: ssh runs the remote command here, in the device's own home.
cat > $T/bin/ssh <<EOF
#!/bin/sh
for a; do last=\$a; done
echo "\$last" | head -c 300 >> $T/ssh.log; echo >> $T/ssh.log
cd $DEV && HOME=$DEV exec sh -c "\$last"
EOF
chmod +x $T/bin/claude $T/bin/ssh
export PATH=$T/bin:/usr/bin
echo '{}' > $A/home/.claude/.credentials.json
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
penv() { echo "HOME=$1/home XDG_DATA_HOME=$1/data XDG_STATE_HOME=$1/state XDG_CONFIG_HOME=$1/cfg XDG_CACHE_HOME=$1/cache XDG_RUNTIME_DIR=$1/run HARBOR_SOCK=$1/run/h.sock"; }
DB=$A/data/harbor/harbor.db
(cd $TS && env $(penv $A) $BUN -e 'import { Store, dataDir } from "./packages/store/src/index.ts"; Store.open(dataDir()).close()')
sqlite3 $DB "insert or replace into kv values('api_enabled','1'),('api_port','47950'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"\",\"created\":0,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]'),('remote_devices','{\"tailscale\":false,\"user\":\"\",\"key\":\"\",\"port\":0,\"devices\":[{\"id\":\"ssh:1\",\"name\":\"devbox\",\"host\":\"devbox\",\"user\":\"\",\"port\":0,\"icon\":\"\",\"dir\":\"\",\"bridge\":false,\"commands\":false,\"device_files\":true,\"hidden\":false,\"os\":\"linux\"}]}')"
sqlite3 $DB "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(NULL,'On the device','$SID',1,'claude','claude-opus-5-5','medium','full',0,1761200000,'lead',NULL,'lead','','22222222-aaaa-4bbb-8ccc-000000000001','',0,0)"
sqlite3 $DB "insert into items values(1,0,'{\"kind\":\"user\",\"text\":\"hello\",\"files\":[],\"at\":1761200000}')"
slug() { echo "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
mkdir -p $A/home/.claude/projects/$(slug $A/home)
echo '{"type":"user"}' > $A/home/.claude/projects/$(slug $A/home)/$SID.jsonl
(cd $TS && exec env $(penv $A) $BUN harbor.ts --background > $T/a.log 2>&1) &
call() { curl -s --max-time 60 -w '\n%{http_code}' -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$@"; }
for i in $(seq 60); do (exec 3<>/dev/tcp/127.0.0.1/47950) 2>/dev/null && break; sleep 0.5; done
sleep 1
device() { sqlite3 $DB "select device from chats where id=1"; }
until_device() { local i; for i in $(seq 60); do [ "$(device)" = "$1" ] && return 0; sleep 0.5; done; return 1; }

out=$(call -X PATCH http://127.0.0.1:47950/v1/chats/1 -d '{"device":"ssh:1"}')
echo "== PATCH device ssh:1: $(echo "$out" | tail -1)"
until_device ssh:1 || fail "the chat didn't move to the device"
echo "== chat's device: '$(device)'"
echo "== on the device: $(cd $DEV && find . -name "$SID*" | sort | tr '\n' ' ')"
[ -n "$(find $DEV -name "$SID.jsonl")" ] || fail "the session didn't reach the device"
out=$(call -X POST http://127.0.0.1:47950/v1/chats/1/send -d '{"text":"run on the device"}')
echo "== a message while it runs on the device: $(echo "$out" | tail -1)"
for i in $(seq 60); do [ -n "$(sqlite3 $DB "select 1 from items where chat_id=1 and body like '%quick brown fox%'")" ] && break; sleep 0.5; done
[ -n "$(sqlite3 $DB "select 1 from items where chat_id=1 and body like '%quick brown fox%'")" ] || fail "no reply from the turn on the device"
echo "== its turn ran through ssh on the device: $(grep -c . $T/ssh.log) ssh calls, the turn's: $(grep -c 'claude' $T/ssh.log)"
# The fake claude starts a new session and writes no file: Claude would, on the device.
SID=$(sqlite3 $DB "select session_id from chats where id=1")
mkdir -p $DEV/.claude/projects/$(slug $DEV); echo '{"type":"assistant"}' > $DEV/.claude/projects/$(slug $DEV)/$SID.jsonl
rm -f $A/home/.claude/projects/*/*.jsonl
out=$(call -X PATCH http://127.0.0.1:47950/v1/chats/1 -d '{"device":""}')
echo "== PATCH device back to this PC: $(echo "$out" | tail -1)"
until_device "" || fail "the chat didn't come back"
sleep 1
echo "== chat's device: '$(device)'"
echo "== here again: $(cd $A/home/.claude && find . -name "$SID*" | sort | tr '\n' ' ')"
[ -n "$(find $A/home/.claude -name "$SID.jsonl")" ] || fail "the session didn't come back"
echo "== notices: $(sqlite3 $DB "select body from items where chat_id=1 and body like '%notice%'" | sed 's/"detail".*//' | tr '\n' ' ')"
out=$(call -X PATCH http://127.0.0.1:47950/v1/chats/1 -d '{"device":"nowhere"}')
echo "== PATCH device to a device that doesn't exist: $(echo "$out" | tr '\n' ' ')"
kill %1 2>/dev/null; wait 2>/dev/null
[ $FAIL = 0 ] && echo "RUN ON PASSED"
exit $FAIL
