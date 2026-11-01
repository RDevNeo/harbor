#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor 0.108.0 binary}; SRC=${SCRAMBLED_DB:?a scrambled harbor.db}; F=${FAKE_CLAUDE_DIR:?a folder with a fake claude}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd); RIG=$TS/packages/store/rig
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T/{home,data/harbor,state,cfg,cache,run}; chmod 700 $T/run
export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=$T/run HARBOR_SOCK=$T/run/h.sock
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 TZ=UTC HTS_STREAM_S=1 PATH=$F:/usr/bin:/bin:$(dirname "$BUN")
unset WAYLAND_DISPLAY DISPLAY
DB=$T/data/harbor/harbor.db; TOK=0123456789abcdef0123456789abcdef0123456789abcdef; fail=0
cp "$SRC" $DB
for id in $(sqlite3 $DB "select id from repos"); do mkdir -p $T/home/p$id; sqlite3 $DB "update repos set path='$T/home/p$id' where id=$id"; done
sqlite3 $DB "insert or replace into kv values('api_enabled','1'),('api_port','47930'),('mesh_id','pc:hr'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"\",\"created\":0,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]')"
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
get() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" "http://127.0.0.1:47930$1" > "$2"; }
post() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X POST -d "$2" "http://127.0.0.1:47930$1"; }
up() { for i in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:47930/ && return 0; sleep 0.2; done; return 1; }
rust() { "$B" --background > $T/rust-$1.log 2>&1 & APP=$!; up || bad "rust $1 did not start"; }
tsapp() { (cd $TS && exec ${TS_CMD:-"$BUN" harbor.ts} --background > $T/ts-$1.log 2>&1) & APP=$!; up || bad "ts $1 did not start"; }
stop() { kill $APP 2>/dev/null; wait $APP 2>/dev/null; }
cmp() { "$BUN" $RIG/dbswap.ts same "$1" "$2" || fail=1; }
sample() {
  tag=$1; shift
  get /v1/state $T/$tag-state.json
  for c in "$@"; do get "/v1/chats/$c/items?since=0" $T/$tag-$c.json; done
}
integrity() { r=$(sqlite3 $DB "pragma integrity_check"); [ "$r" = ok ] && ok "integrity_check after $1" || bad "integrity_check after $1: $r"; }
version() { v=$(sqlite3 $DB "pragma user_version"); [ "$v" = 8 ] && ok "user_version still 8 after $1" || bad "user_version is $v after $1"; }

A=$(sqlite3 $DB "select id from chats where id in (select chat_id from items group by chat_id having count(*)>3) order by id limit 1")
D=$(sqlite3 $DB "select id from chats where id in (select chat_id from items group by chat_id having count(*)>3) order by id desc limit 1")
S="$A $((A+1)) $(sqlite3 $DB 'select id from chats order by id desc limit 1')"
echo "== 1. Rust 0.108.0 on the scrambled copy: a chat created through its phone API runs the fake claude"
"$B" mesh on > /dev/null
rust 1
sample r1 $S
ALLIDS=$(sqlite3 $DB "select id from chats order by id")
for c in $ALLIDS; do get "/v1/chats/$c/items?since=0" $T/r1all-$c.json; done
R=$(post /v1/chats '{"text":"made by Rust","account":"claude"}' | sed -E 's/.*"id":([0-9]+).*/\1/')
sleep 5
get "/v1/chats/$R/items?since=0" $T/r1-$R.json
get /v1/state $T/r1-state.json
"$B" mesh status > $T/rust-mesh.txt
stop
[ -n "$R" ] && [ "$(sqlite3 $DB "select count(*) from items where chat_id=$R")" -ge 2 ] && ok "Rust wrote chat $R with its items" || bad "Rust chat $R has no items"
integrity "Rust"; version "Rust"
snapshot=$(sqlite3 $DB "select count(*) from chats")

PEM=$(find $T/state $T/data -name identity.pem | head -1)
[ -n "$PEM" ] && ok "Rust made $PEM" || bad "no identity.pem from Rust"
SUM=$(sha256sum "$PEM" | cut -d' ' -f1)
FPR=$("$B" mesh status | sed -n 's/^key: *//p'); FPT=$(cd $TS && ${TS_CMD:-"$BUN" harbor.ts} mesh status | sed -n 's/^key: *//p')
[ -n "$FPR" ] && [ "$FPR" = "$FPT" ] && ok "Rust and TS read identity.pem as the same key $FPR" || bad "fingerprints differ: rust '$FPR' ts '$FPT'"
echo "== 2. TypeScript store and hub read what Rust wrote"
(cd $TS && "$BUN" $RIG/dbswap.ts read) && ok "Store reads every table and item" || bad "Store read"
tsapp 1
sample t1 $S $R
for c in $S $R; do cmp $T/r1-$c.json $T/t1-$c.json; done
for c in $ALLIDS; do get "/v1/chats/$c/items?since=0" $T/t1all-$c.json; done
get /v1/state $T/t1-state.json
echo "/v1/state, Rust against TS (revisions aside):"; "$BUN" $RIG/dbswap.ts statediff $T/r1-state.json $T/t1-state.json
"$BUN" $RIG/dbswap.ts samedir $T r1all t1all && ok "every chat of the scrambled copy reads the same through the TS hub as through Rust" || bad "chats differ between Rust and TS"
stop
integrity "TS hub start"; version "TS hub start"
[ "$(sha256sum "$PEM" | cut -d' ' -f1)" = "$SUM" ] && ok "identity.pem unchanged after the TS hub ran" || bad "identity.pem was rewritten"

echo "== 3. TypeScript writes: store calls and a chat run by its own hub"
tsapp 2
TR=$(post /v1/chats '{"text":"made by TS","account":"claude"}' | sed -E 's/.*"id":([0-9]+).*/\1/')
sleep 5
get "/v1/chats/$TR/items?since=0" $T/t2-$TR.json
stop
[ -n "$TR" ] && [ "$(sqlite3 $DB "select count(*) from items where chat_id=$TR")" -ge 2 ] && ok "TS hub wrote chat $TR with its items" || bad "TS chat $TR has no items"
W=$(cd $TS && "$BUN" $RIG/dbswap.ts write $R $D $A) && ok "TS store wrote: $W" || bad "TS store write"
integrity "TS writes"; version "TS writes"
[ "$(sqlite3 $DB "select count(*) from chats where id=$D")" = 0 ] && ok "deleted chat $D is gone with its items ($(sqlite3 $DB "select count(*) from items where chat_id=$D") left)" || bad "chat $D not deleted"
LEAD=$(echo "$W" | sed -E 's/.*"lead":([0-9]+).*/\1/'); SUB=$(echo "$W" | sed -E 's/.*"sub":([0-9]+).*/\1/')

echo "== 4. Rust 0.108.0 on the database TypeScript wrote"
rust 2
sample r2 $A $R $TR $LEAD $SUB
python3 - "$T" "$R" "$TR" "$LEAD" "$SUB" <<'PY' || fail=1
import json, sys
t, r, tr, lead, sub = sys.argv[1:6]
state = json.load(open(f"{t}/r2-state.json"))
rows = {c["id"]: c for c in state["chats"]}
for label, cid in (("Rust chat renamed by TS", r), ("TS hub chat", tr), ("TS lead", lead), ("TS sub", sub)):
    print(("PASS" if int(cid) in rows else "FAIL"), f"Rust lists {label} (chat {cid})", rows.get(int(cid), {}).get("title", ""))
ok = "(renamed by TS)" in rows[int(r)]["title"]
print("PASS" if ok else "FAIL", "Rust sees the rename TS saved")
def items(cid): return json.load(open(f"{t}/r2-{cid}.json"))
kinds = [i.get("kind") for i in items(lead).get("items", [])]
print("PASS" if len(kinds) == 9 else "FAIL", f"Rust reads all 9 items TS wrote to the lead ({len(kinds)}):", ",".join(kinds))
tail = [i.get("text") for i in items(r).get("items", [])][-1:]
print("PASS" if any("TS note" in (i.get("text") or "") for i in items(r).get("items", [])) else "FAIL", "Rust reads the notice TS appended to its chat")
PY
cmp $T/t2-$TR.json $T/r2-$TR.json
"$B" mesh status > /dev/null && ok "Rust CLI opens the database" || bad "Rust CLI"
stop
integrity "Rust again"; version "Rust again"
[ "$(sqlite3 $DB "select v from kv where k='ts_marker'")" = 1 ] && ok "kv written by TS survives Rust" || bad "ts kv lost"
[ "$(sqlite3 $DB "select v from kv where k='theme'")" = light ] && ok "TS kv theme survives Rust" || bad "theme lost"
[ "$(sqlite3 $DB "select count(*) from webhooks where token='ts-hook-token'")" = 1 ] && ok "webhook written by TS survives Rust" || bad "webhook lost"

echo "== 5. A database the TypeScript store creates, served by Rust"
rm -rf $T/data/harbor; mkdir -p $T/data/harbor
(cd $TS && "$BUN" $RIG/dbswap.ts fresh) > $T/fresh.txt && ok "TS created a database: $(cat $T/fresh.txt)" || bad "TS fresh"
rust 3
get /v1/state $T/r3-state.json
C=$(sed -E 's/.*"chat":([0-9]+).*/\1/' $T/fresh.txt); get "/v1/chats/$C/items?since=0" $T/r3-$C.json
grep -q "TS made this db" $T/r3-state.json && ok "Rust lists the chat TS created" || bad "Rust does not list it"
grep -q '"world"' $T/r3-$C.json || grep -q 'world' $T/r3-$C.json && ok "Rust reads its items" || bad "Rust items"
stop
integrity "fresh db served by Rust"; version "fresh db served by Rust"
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
