#!/bin/bash
# Inside `unshare -Urnm` only: a TypeScript PC (t) and a Rust PC (r) share chats over loopback TLS; each window, driven by
# HARBOR_POINTER on a private headless sway, writes into the chat homed on the other PC. Synthetic dbs, throwaway identities.
# HARBOR_REF: Rust 0.109.0; RIG_TMP: scratch; SWAY: the sway prefix (bin/, lib/).
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 99; }
ip link set lo up
RS=${HARBOR_REF:?}; T=${RIG_TMP:?}; SW=${SWAY:?}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/.." && pwd); FAKE=$TS/rig/install-one/fakebin
rm -rf "$T"; mkdir -p "$T/rt" "$T/shots"; chmod 700 "$T/rt"
TOK=0123456789abcdef0123456789abcdef0123456789abcdef
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { local w=$1; shift; if "$@"; then ok "$w"; else bad "$w"; fi; }

pc() {
  local h=$T/$1 id=rig-$1
  mkdir -p "$h/home" "$h/data" "$h/state" "$h/cfg" "$h/cache"
  echo "HOME=$h/home XDG_DATA_HOME=$h/data XDG_STATE_HOME=$h/state XDG_CONFIG_HOME=$h/cfg XDG_CACHE_HOME=$h/cache XDG_RUNTIME_DIR=$T/rt WAYLAND_DISPLAY=wayland-1 HARBOR_SOCK=$h/h.sock PATH=$FAKE:$(dirname "$BUN"):/usr/bin:/bin HARBOR_MESH_ID=$id HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_UPDATE_WORKER=off RIG_CURL_LOG=$h/curl.log RIG_HOLD_S=${RIG_HOLD_S:-40} DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent TZ=UTC"
}
db() { echo "$T/$1/data/harbor/harbor.db"; }
q() { sqlite3 "$(db "$1")" "$2"; }
ts() { (cd "$TS" && env -i $(pc t) "$@"); }
rust() { env -i $(pc r) "$@"; }
api() { curl -s --max-time 10 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$1$2"; }
up() { for _ in $(seq 150); do [ -n "$(api "$1" /v1/state)" ] && return 0; sleep 0.2; done; return 1; }
shot() { env XDG_RUNTIME_DIR=$T/rt WAYLAND_DISPLAY=wayland-1 /usr/bin/grim "$T/shots/$1.png" 2>/dev/null; }
# Only this rig's processes: every one has its XDG_RUNTIME_DIR. Other agents run the same binaries.
mine() { local p; for p in /proc/[0-9]*; do tr '\0' '\n' 2>/dev/null < "$p/environ" | grep -qxF "XDG_RUNTIME_DIR=$T/rt" && echo "${p#/proc/}"; done 2>/dev/null; }
mine_cmd() { local p; for p in $(mine); do tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline" | grep -q -- "$1" && echo "$p"; done 2>/dev/null; }
killmine() { local p; for p in $(mine_cmd "$1"); do kill "$p" 2>/dev/null; done; }
stopall() { killmine "^$RS"; killmine "harbor.ts"; killmine "$FAKE/claude"; sleep 1; }
field() { python3 -I -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[int(k)] if isinstance(v,list) else (v or {}).get(k)
print(json.dumps(v))' "$1"; }

seed() { # name port id peer-fp peer-port title
  local d; d=$(db "$1")
  mkdir -p "$T/$1/home/proj"
  q "$1" "insert into repos(path,name) values('$T/$1/home/proj','proj')"
  q "$1" "insert or replace into kv(k,v) values('api_enabled','1'),('api_port','$2'),('mesh_id','$3'),('mesh_enabled','1'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"Rig phone\",\"created\":1761200000,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]'),('mesh_allowed','[{\"node\":\"\",\"name\":\"\",\"fp\":\"$4\",\"id\":\"\",\"addrs\":[\"127.0.0.1:$5\"]}]')"
  q "$1" "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values((select min(id) from repos),'$6','',0,'claude','claude-haiku-5-5','','full',0,1761200000,'lead',NULL,'lead','','$(cat /proc/sys/kernel/random/uuid)','',0,0)"
  local c; c=$(q "$1" "select max(id) from chats")
  q "$1" "insert into items values($c,0,'{\"kind\":\"user\",\"text\":\"hello on $1\",\"files\":[],\"at\":1761200000}'),($c,1,'{\"kind\":\"text\",\"text\":\"a reply on $1\",\"at\":1761200001}')"
}

echo "== 0. two PCs, paired by key"
RFP=$(rust "$RS" mesh status | sed -n 's/^key: *//p')
TFP=$(ts "$BUN" "$TS/harbor.ts" mesh status | sed -n 's/^key: *//p')
check "both have keys" test -n "$RFP" -a -n "$TFP"
seed r 47930 rig-r "$TFP" 47931 "Chat homed on Rust"
seed t 47931 rig-t "$RFP" 47930 "Chat homed on TypeScript"
RID=$(q r "select max(id) from chats"); TID=$(q t "select max(id) from chats")
rust "$RS" --background > "$T/r1.log" 2>&1 &
ts "$BUN" "$TS/harbor.ts" --background > "$T/t1.log" 2>&1 &
check "both hubs up" up 47930 && up 47931
for _ in $(seq 60); do CT=$(q t "select id from chats where home!='' and home_id=$RID"); CR=$(q r "select id from chats where home!='' and home_id=$TID"); [ -n "$CT" ] && [ -n "$CR" ] && break; sleep 0.5; done
check "each PC has the other's chat (TS copy $CT, Rust copy $CR)" test -n "$CT" -a -n "$CR"
stopall

LD_LIBRARY_PATH=$SW/lib env -i HOME=$T XDG_RUNTIME_DIR=$T/rt WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LD_LIBRARY_PATH=$SW/lib "$SW/bin/sway" -c "$TS/rig/sway.conf" > "$T/sway.log" 2>&1 &
for _ in $(seq 100); do [ -e "$T/rt/wayland-1" ] && break; sleep 0.1; done
check "sway is up" test -e "$T/rt/wayland-1"

echo "== 1. the TypeScript window writes into the Rust PC's chat"
q t "insert or replace into kv(k,v) values('last_chat','$CT')"
rust "$RS" --background > "$T/r2.log" 2>&1 &
check "Rust hub up" up 47930
CX=${CX:-760}; CY=${CY:-820}
STEPS="$CX,$CY,click,8;$CX,$CY,type:hold_this_turn,9;$CX,$CY,key:Return,16;$CX,$CY,type:steer_it_now,22;$CX,$CY,key:Return,23;$CX,$CY,type:queue_this_one,26;$CX,$CY,ctrl:Return,27;$CX,$CY,key:Escape,32"
(cd "$TS" && env -i $(pc t) HARBOR_VIEW=chat HARBOR_POINTER="$STEPS" "$BUN" "$TS/harbor.ts" > "$T/t2.log" 2>&1) &
sleep 7; shot 1-open
sleep 5
TYP=$(api 47930 "/v1/chats/$RID/items?since=0" | field typing)
VIEW=$(api 47930 /v1/state | python3 -I -c "import json,sys; print(json.dumps([c.get('viewing') for c in json.load(sys.stdin)['chats'] if c['id']==$RID]))")
echo "   Rust sees typing $TYP, viewing $VIEW"; shot 2-typing
check "the Rust PC sees the TypeScript PC typing" grep -q "pc:" <<< "$TYP"
check "and viewing the chat" grep -q "rig-t\|pc:" <<< "$VIEW"
sleep 7
check "the message reached the Rust PC" test "$(q r "select count(*) from items where chat_id=$RID and body like '%hold this turn%'")" = 1
echo "   sender: $(q r "select json_extract(body,'$.sender') from items where chat_id=$RID and body like '%hold this turn%'")"
check "a turn runs on the Rust PC" test -n "$(mine_cmd "^$RS turn")"
sleep 3; shot 3-running
check "the reply streams into the TypeScript copy" test "$(q t "select count(*) from items where chat_id=$CT and body like '%word word%'")" -ge 1
sleep 4
echo "   Rust's chat after steer: $(api 47930 "/v1/chats/$RID/items?since=999" | python3 -I -c 'import json,sys; v=json.load(sys.stdin); print(json.dumps({k: v.get(k) for k in ("running","queued","status")})[:600])')"
STEER=$(q r "select body from items where chat_id=$RID and body like '%steer it now%'")
check "steering reached the Rust PC" grep -q "steer it now" <<< "$STEER$(api 47930 "/v1/chats/$RID/items?since=999")"
sleep 3
QN=$(api 47930 "/v1/chats/$RID/items?since=999" | field queued)
check "Ctrl+Enter queued a message at the Rust PC ($QN)" test "${QN:-0}" -ge 1
sleep 3; shot 4-stopped
for _ in $(seq 20); do [ -z "$(mine_cmd "^$RS turn")" ] && break; sleep 0.5; done
check "Escape stopped the turn on the Rust PC" test -z "$(mine_cmd "^$RS turn")"
check "the Rust PC says it's not running" test "$(api 47930 /v1/state | python3 -I -c "import json,sys; print([c.get('running') for c in json.load(sys.stdin)['chats'] if c['id']==$RID][0])")" = False
check "and holds the queued message (stop with hold)" test "$(api 47930 "/v1/chats/$RID/items?since=999" | field queued)" -ge 1
killmine "^$RS"; sleep 15; shot 5-home-off
echo "   look at $T/shots/5-home-off.png: the read-only note"
stopall

echo "== 2. the Rust window writes into the TypeScript PC's chat"
q r "insert or replace into kv(k,v) values('reload_state','{\"view\":{\"t\":\"chat\",\"id\":$CR}}')"
ts "$BUN" "$TS/harbor.ts" --background > "$T/t3.log" 2>&1 &
check "TypeScript hub up" up 47931
rust env HARBOR_POINTER="700,773,click,8;700,773,type:from_the_rust_window,9;1025,853,click,11" "$RS" > "$T/r3.log" 2>&1 &
sleep 7; shot 6-rust-open
sleep 3
TY2=$(api 47931 "/v1/chats/$TID/items?since=999" | field typing)
echo "   TypeScript sees typing $TY2"
check "the TypeScript PC sees the Rust PC typing" grep -q "pc:rig-r" <<< "$TY2"
sleep 7; shot 7-rust-sent
check "the Rust window's message reached the TypeScript PC" test "$(q t "select count(*) from items where chat_id=$TID and body like '%from the rust window%'")" = 1
for _ in $(seq 30); do [ "$(q t "select count(*) from items where chat_id=$TID and body like '%DONE%'")" -ge 1 ] && break; sleep 1; done
check "the turn ran on the TypeScript PC" test "$(q t "select count(*) from items where chat_id=$TID and body like '%DONE%'")" -ge 1
sleep 3
check "and its reply is in the Rust copy" test "$(q r "select count(*) from items where chat_id=$CR and body like '%DONE%'")" -ge 1
stopall
killmine "$SW/bin/sway"
echo "== $([ $fail = 0 ] && echo ALL PASS || echo SOME FAILED)"
exit $fail
