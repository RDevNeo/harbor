#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor 0.108.0 binary}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd); RIG=$TS/packages/store/rig
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T/{home,data/harbor,state,cfg,cache,run}; chmod 700 $T/run
export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=$T/run HARBOR_SOCK=$T/run/h.sock
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 TZ=UTC PATH=$RIG/fakeclaude:/usr/bin:/bin:$(dirname "$BUN")
unset WAYLAND_DISPLAY DISPLAY
DB=$T/data/harbor/harbor.db; TOK=0123456789abcdef0123456789abcdef0123456789abcdef; fail=0
mkdir -p $T/home/proj
IDS=$(cd $TS && "$BUN" $RIG/chatstate.ts make $T/home/proj); cp $DB $T/fixture.db
id() { echo "$IDS" | sed -E "s/.*\"$1\":([0-9]+).*/\1/"; }
PLAIN=$(id plain); FAILING=$(id failing); LEAD=$(id lead); SUB=$(id sub); OTHER=$(id other)
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
get() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" "http://127.0.0.1:47930$1" > "$2"; }
post() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X POST -d "$2" "http://127.0.0.1:47930$1" > /dev/null; }
up() { for i in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:47930/ && { get /v1/state /dev/null; sleep 2; return 0; }; sleep 0.2; done; return 1; }
sample() { get /v1/state $T/$1-$2.full.json; "$BUN" $RIG/chatstate.ts pick $T/$1-$2.full.json > $T/$1-$2.json; }
field() { python3 -c "import json,sys; r={c['id']:c for c in json.load(open('$1'))}; print(r[$2]['$3'])"; }
scenario() {
  tag=$1
  rm -f $DB $DB-wal $DB-shm; cp $T/fixture.db $DB
  if [ $tag = rust ]; then "$B" --background > $T/$tag.log 2>&1 & APP=$!; else (cd $TS && exec "$BUN" harbor.ts --background > $T/$tag.log 2>&1) & APP=$!; fi
  up || bad "$tag did not start"
  sample $tag 0
  post /v1/chats/$PLAIN/send '{"text":"hello"}'; post /v1/chats/$FAILING/send '{"text":"boom"}'; post /v1/chats/$OTHER/send '{"text":"hello"}'
  sleep 5; sample $tag 1
  get "/v1/chats/$FAILING/items?since=0" /dev/null; sample $tag 2
  post /v1/chats/$SUB/send '{"text":"hold on"}'
  sleep 1; post /v1/chats/$SUB/send '{"text":"later","mode":"queue"}'; sleep 1; sample $tag 3
  sleep 8; sample $tag 4
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
}
scenario rust
scenario ts
for n in 0 1 2 3 4; do
  if cmp -s $T/rust-$n.json $T/ts-$n.json; then ok "sample $n: Rust and TS give the same pr, unread, failed, working and running for all 5 chats"; else bad "sample $n differs"; diff <(python3 -m json.tool $T/rust-$n.json) <(python3 -m json.tool $T/ts-$n.json) | head -20; fi
done
echo "== the fixture is not at its defaults (Rust's own answers)"
chk() { [ "$(field $T/rust-$1.json $2 $3)" = "$4" ] && ok "Rust sample $1: chat $2 $3 = $4" || bad "Rust sample $1: chat $2 $3 is $(field $T/rust-$1.json $2 $3), expected $4"; }
chk 0 $LEAD pr "{'label': 'PR #7 · Open', 'number': 7, 'state': 'open', 'title': 'Add it', 'url': 'https://github.com/o/r/pull/7'}"
chk 0 $SUB pr "{'label': 'PR #7 · Open', 'number': 7, 'state': 'open', 'title': 'Add it', 'url': 'https://github.com/o/r/pull/7'}"
chk 0 $OTHER pr "{'label': 'PR #3 · Merged', 'number': 3, 'state': 'merged', 'title': 'Old', 'url': 'https://github.com/o/r/pull/3'}"
chk 0 $PLAIN pr None
chk 1 $PLAIN unread True; chk 1 $PLAIN failed False
chk 1 $FAILING unread True; chk 1 $FAILING failed True
chk 2 $FAILING unread False; chk 2 $FAILING failed False; chk 2 $PLAIN unread True
chk 3 $SUB running True; chk 3 $LEAD running False; chk 3 $SUB queued 1; chk 3 $LEAD queued 0; chk 4 $SUB queued 0; chk 3 $LEAD working True; chk 3 $PLAIN working False
chk 4 $LEAD working False
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
