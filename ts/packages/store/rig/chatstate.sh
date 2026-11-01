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
mkdir -p $T/home/proj $T/home/.claude $T/home/.claude2
echo '{}' > $T/home/.claude/.credentials.json
echo '{"oauthAccount":{"emailAddress":"two@example.com","displayName":"Two"}}' > $T/home/.claude2/.claude.json
IDS=$(cd $TS && "$BUN" $RIG/chatstate.ts make $T/home/proj); cp $DB $T/fixture.db
id() { echo "$IDS" | sed -E "s/.*\"$1\":([0-9]+).*/\1/"; }
LIM1=$(id lim1); LIM2=$(id lim2); NOF=$(id nof); FAR=$(id far); NEAR=$(id near)
PLAIN=$(id plain); FAILING=$(id failing); LEAD=$(id lead); SUB=$(id sub); OTHER=$(id other)
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
get() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" "http://127.0.0.1:47930$1" > "$2"; }
post() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X POST -d "$2" "http://127.0.0.1:47930$1" > /dev/null; }
up() { for i in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:47930/ && { get /v1/state /dev/null; sleep 2; return 0; }; sleep 0.2; done; return 1; }
statuses() {
  for n in lead:$LEAD sub:$SUB lim1:$LIM1 lim2:$LIM2 nof:$NOF far:$FAR near:$NEAR; do
    get "/v1/chats/${n#*:}/items?since=0" $T/$1-$2-${n%%:*}.full.json; "$BUN" $RIG/chatstate.ts status $T/$1-$2-${n%%:*}.full.json > $T/$1-$2-${n%%:*}.st.json
  done
}
sample() { get /v1/state $T/$1-$2.full.json; "$BUN" $RIG/chatstate.ts pick $T/$1-$2.full.json > $T/$1-$2.json; }
field() { python3 -c "import json,sys; r={c['id']:c for c in json.load(open('$1'))}; print(r[$2]['$3'])"; }
scenario() {
  tag=$1
  rm -f $DB $DB-wal $DB-shm; cp $T/fixture.db $DB
  if [ $tag = rust ]; then "$B" --background > $T/$tag.log 2>&1 & APP=$!; else (cd $TS && exec "$BUN" harbor.ts --background > $T/$tag.log 2>&1) & APP=$!; fi
  up || bad "$tag did not start"
  sample $tag 0; statuses $tag s0
  post /v1/chats/$PLAIN/send '{"text":"hello"}'; post /v1/chats/$FAILING/send '{"text":"boom"}'; post /v1/chats/$OTHER/send '{"text":"hello"}'
  sleep 5; sample $tag 1
  get "/v1/chats/$FAILING/items?since=0" /dev/null; sample $tag 2
  post /v1/chats/$SUB/send '{"text":"hold on"}'
  sleep 1; post /v1/chats/$SUB/send '{"text":"later","mode":"queue"}'; sleep 1; sample $tag 3; statuses $tag s3
  post /v1/chats/$LEAD/send '{"text":"hold lead"}'; sleep 1; sample $tag 3b; statuses $tag s3b
  sleep 10; sample $tag 4; statuses $tag s4
  for r in app hubs snooze usage people palette tags slash voice versions inbox apps/gmail apps/discord chats/$LEAD/team chats/$PLAIN/move_targets chats/$PLAIN/slash chats/$PLAIN/tags chats/$PLAIN/mention; do
    get "/v1/$r" $T/$tag-route-$(echo $r | tr / _).json
  done
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
}
scenario rust
scenario ts
for n in 0 1 2 3 3b 4; do
  if cmp -s $T/rust-$n.json $T/ts-$n.json; then ok "sample $n: Rust and TS give the same pr, unread, failed, working and running for all 5 chats"; else bad "sample $n differs"; diff <(python3 -m json.tool $T/rust-$n.json) <(python3 -m json.tool $T/ts-$n.json) | head -20; fi
done
for n in 0 3b 4; do
  d=$("$BUN" $RIG/dbswap.ts statediff $T/rust-$n.full.json $T/ts-$n.full.json | tail -1)
  case "$d" in *" 0 kinds"*) ok "/v1/state at sample $n: no difference between Rust and TS";; *) bad "/v1/state at sample $n: $d"; "$BUN" $RIG/dbswap.ts statediff $T/rust-$n.full.json $T/ts-$n.full.json | head;; esac
done
for f in $(cd $T && ls rust-route-*.json); do
  d=$("$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-${f#rust-} | tail -1)
  case "$d" in *" 0 kinds"*) ok "${f#rust-route-}: same";; *) bad "${f#rust-route-}: $d"; "$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-${f#rust-} | head -8;; esac
done
for n in s0 s3 s3b s4; do for w in lead sub lim1 lim2 nof far near; do
  if cmp -s $T/rust-$n-$w.st.json $T/ts-$n-$w.st.json; then ok "status $n of $w: Rust and TS say the same"; else bad "status $n of $w differs"; diff <(python3 -m json.tool $T/rust-$n-$w.st.json) <(python3 -m json.tool $T/ts-$n-$w.st.json) | head -20; fi
done; done
st() { python3 -c "import json; v=json.load(open('$T/rust-$1-$2.st.json'))
for k in '$3'.split('.'): v=v[int(k)] if k.isdigit() else (v or {}).get(k)
print(json.dumps(v) if not isinstance(v,str) else v)"; }
stchk() { r=$(st $1 $2 $3); case "$r" in *"$4"*) ok "Rust $1 $2 $3 has $4";; *) bad "Rust $1 $2 $3 is $r, expected $4";; esac; }
stchk s0 lim1 limit.text "Usage limit · resets"; stchk s0 lim1 limit.can_cancel false; stchk s0 lim1 limit.targets.0.id claude
stchk s0 lim2 limit.can_cancel true; stchk s0 lim2 limit.text "continuing at"
stchk s0 nof folder.text "gone's folder"; stchk s0 nof folder.action "Use a folder here"; stchk s0 lead folder null; stchk s0 near folder.text "it's on"; stchk s0 near folder.owner.id pc:far; stchk s0 near folder.action "Use a folder here"
stchk s3 lead waiting.agents.0.name worker; stchk s3 lead agents.title "1 agent working"; stchk s3 lead working null; stchk s3 sub working.subagents 0
stchk s3b lead working.subagents 1; stchk s3b lead working.text "1 sub-agent running"; stchk s3b lead waiting null; stchk s3b lead agents.rows.0.task Sub
echo "== the fixture is not at its defaults (Rust's own answers)"
chk() { [ "$(field $T/rust-$1.json $2 $3)" = "$4" ] && ok "Rust sample $1: chat $2 $3 = $4" || bad "Rust sample $1: chat $2 $3 is $(field $T/rust-$1.json $2 $3), expected $4"; }
chk 0 $LEAD pr "{'label': 'PR #7 · Open', 'number': 7, 'state': 'open', 'title': 'Add it', 'url': 'https://github.com/o/r/pull/7'}"
chk 0 $SUB pr "{'label': 'PR #7 · Open', 'number': 7, 'state': 'open', 'title': 'Add it', 'url': 'https://github.com/o/r/pull/7'}"
chk 0 $OTHER pr "{'label': 'PR #3 · Merged', 'number': 3, 'state': 'merged', 'title': 'Old', 'url': 'https://github.com/o/r/pull/3'}"
chk 0 $PLAIN pr None
chk 1 $PLAIN unread True; chk 1 $PLAIN failed False
chk 1 $FAILING unread True; chk 1 $FAILING failed True
chk 2 $FAILING unread False; chk 2 $FAILING failed False; chk 2 $PLAIN unread True
chk 3 $SUB running True; chk 3b $LEAD running True; chk 3 $LEAD running False; chk 3 $SUB queued 1; chk 3 $LEAD queued 0; chk 4 $SUB queued 0; chk 3 $LEAD working True; chk 3 $PLAIN working False
chk 4 $LEAD working False
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
