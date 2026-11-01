#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor 0.108.0 binary}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd); RIG=$TS/packages/store/rig
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T/{home,data/harbor,state,cfg,cache,run,client}; chmod 700 $T/run
export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=$T/run HARBOR_SOCK=$T/run/h.sock
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_NO_DISCOVERY=1 TZ=UTC PATH=$RIG/fakeclaude:/usr/bin:/bin:$(dirname "$BUN")
unset WAYLAND_DISPLAY DISPLAY
DB=$T/data/harbor/harbor.db; TOK=0123456789abcdef0123456789abcdef0123456789abcdef; fail=0
mkdir -p $T/home/proj $T/home/.claude $T/home/.claude2
echo '{}' > $T/home/.claude/.credentials.json
echo '{"oauthAccount":{"emailAddress":"two@example.com","displayName":"Two"}}' > $T/home/.claude2/.claude.json
IDS=$(cd $TS && "$BUN" $RIG/chatstate.ts make $T/home/proj); cp $DB $T/fixture.db
id() { echo "$IDS" | sed -E "s/.*\"$1\":([0-9]+).*/\1/"; }
PLAIN=$(id plain); LEAD=$(id lead); SUB=$(id sub); LIM1=$(id lim1); NOF=$(id nof)
CFP=$(cd $TS && XDG_STATE_HOME=$T/client "$BUN" $RIG/meshdump.ts fp)
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
post() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X POST -d "$2" "http://127.0.0.1:47930$1" > /dev/null; }
up() { for i in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:47930/ && { sleep 2; return 0; }; sleep 0.2; done; return 1; }
dump() { mkdir -p $T/$1-$2; (cd $TS && XDG_STATE_HOME=$T/client "$BUN" $RIG/meshdump.ts get 127.0.0.1:47930 $SFP $T/$1-$2 $PLAIN $LEAD $SUB) || bad "$1 $2: dump"; }
scenario() {
  tag=$1
  rm -f $DB $DB-wal $DB-shm; cp $T/fixture.db $DB
  sqlite3 $DB "insert or replace into kv values('mesh_enabled','1'),('net_map','0'),('mesh_allowed','[{\"node\":\"\",\"name\":\"\",\"fp\":\"$CFP\",\"id\":\"\",\"addrs\":[]}]')"
  if [ $tag = rust ]; then SFP=$("$B" mesh status | sed -n 's/^key: *//p'); "$B" --background > $T/$tag.log 2>&1 & APP=$!; else SFP=$(cd $TS && "$BUN" harbor.ts mesh status | sed -n 's/^key: *//p'); (cd $TS && exec "$BUN" harbor.ts --background > $T/$tag.log 2>&1) & APP=$!; fi
  up || bad "$tag did not start"
  dump $tag m0
  post /v1/chats/$PLAIN/send '{"text":"hello"}'
  post /v1/chats/$SUB/send '{"text":"hold on"}'; sleep 1; post /v1/chats/$SUB/send '{"text":"later","mode":"queue"}'; post /v1/chats/$LEAD/send '{"text":"hold lead"}'; sleep 1
  dump $tag m1
  sleep 12; dump $tag m2
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
}
scenario rust
scenario ts
EXPECTED='\.(epoch|digest|updated|seen|at|text|cost_usd|duration_ms|input_tokens|output_tokens|cached|turns|model|account|kind|icon|detail|count|update\.[a-z_]+|v\.items) |^ +[0-9]+ kinds'
for m in m0 m1 m2; do
  for f in $(ls $T/rust-$m); do
    out=$("$BUN" $RIG/dbswap.ts statediff $T/rust-$m/$f $T/ts-$m/$f | grep -Ev "$EXPECTED")
    if [ -z "$out" ]; then ok "$m/$f: Rust and TS export the same (timestamps, turn text, update details aside)"; else bad "$m/$f differs"; echo "$out" | head -8; fi
  done
done
for m in m0 m1; do
  for f in chats_since_0_epoch_0.json; do
    python3 - "$T/rust-$m/$f" "$T/ts-$m/$f" "$m" <<'PY' || fail=1
import json, sys
r, t = (json.load(open(p))["v"]["chats"] for p in sys.argv[1:3])
m = sys.argv[3]
by = lambda cs: {c["gid"] or str(c["id"]): c for c in cs}
r, t = by(r), by(t)
def chk(what, ok): print(("PASS" if ok else "FAIL"), f"{m}: {what}"); return ok
good = chk("same chats", set(r) == set(t))
if m == "m1":
    lead = next(c for c in r.values() if c["name"] == "lead" and c["role"] == "lead")
    sub = next(c for c in r.values() if c["role"] == "sub")
    good &= chk("Rust shows the lead running with a sub-agent, queued 1 on the sub", lead["running"] and sub["queued"] == 1 and lead["status"]["working"]["subagents"] == 1)
    good &= chk("Rust shows the PR", any(c["pr"] for c in r.values()))
sys.exit(0 if good else 1)
PY
  done
done
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
