#!/bin/bash
# harbor --background on temp XDG dirs (loopback only, sharing off, no sign-in): a phone-API client starts
# a chat in a scratch project (Haiku, plan access) and reads the reply. CLAUDE_DIR: where a real claude is.
set -u
CLAUDE_DIR=${CLAUDE_DIR:-$(dirname "$(command -v claude)")}
export PATH=$CLAUDE_DIR:$PATH
T=${RIG_TMP:?a scratch folder}; rm -rf $T; mkdir -p $T/{data,state,run,cfg,scratch}; chmod 700 $T/run
TS=$(cd "$(dirname "$0")/../../.." && pwd); BUN=${BUN:-$(command -v bun)}; TOK=0123456789abcdef0123456789abcdef0123456789abcdef; PORT=47998
export XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_RUNTIME_DIR=$T/run XDG_CONFIG_HOME=$T/cfg HARBOR_SOCK=$T/run/h.sock
export HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_MESH_ID=pc:turnrig
cd $TS
$BUN -e "import { Store, dataDir } from './packages/store/src/index.ts'; const s = Store.open(dataDir()); s.set('api_enabled','1'); s.set('api_port','$PORT'); s.set('api_tokens', JSON.stringify([{token:'$TOK',name:'',created:0,group:'gggggggggggggggg',fp:''}])); s.addRepo('$T/scratch');"
$BUN harbor.ts --background > $T/hub.log 2>&1 & HP=$!
for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:$PORT/ && break; sleep 0.2; done
call() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$@"; }
echo "== state: $(call http://127.0.0.1:$PORT/v1/state | head -c 160)"
NEW=$(call -X POST http://127.0.0.1:$PORT/v1/chats -d '{"project_id":1,"text":"Reply with exactly one word: pong","model":"claude-haiku-5-5","access":"plan"}')
echo "== new chat: $NEW"
ID=$(echo "$NEW" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
for i in $(seq 90); do
  S=$(date +%s%N); ITEMS=$(call "http://127.0.0.1:$PORT/v1/chats/$ID/items?since=0"); echo "poll $i: $(( ($(date +%s%N)-S)/1000000 )) ms, $(echo "$ITEMS" | grep -o '"running":[a-z]*'), $(echo "$ITEMS" | grep -o '"count":[0-9]*')"
  echo "$ITEMS" | grep -q '"running":false' && echo "$ITEMS" | grep -q '"kind":"text"' && break
  sleep 1
done
echo "== items:"; echo "$ITEMS" | $BUN -e 'const v = JSON.parse(await Bun.stdin.text()); console.log("running", v.running, "count", v.count); for (const i of v.items) console.log(i.seq, i.kind, JSON.stringify(i.text ?? i.markdown ?? i.label ?? "").slice(0, 100))'
kill $HP; wait $HP 2>/dev/null; tail -5 $T/hub.log
