#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor 0.108.0 binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd); RIG=$TS/packages/store/rig
W=${RIG_TMP:?a scratch folder}; MODE=${MODE:-direct}; RELAY=${RELAY:-rust}; WAIT=${WAIT:-90}
rm -rf "$W"; mkdir -p "$W"
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 TZ=UTC PATH=/usr/bin:/bin:$(dirname "$BUN")
unset HARBOR_LISTEN HARBOR_ADDRS WAYLAND_DISPLAY DISPLAY
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
envof() { local d=$W/$1; mkdir -p $d/{home,data,state,cfg,cache,run}; chmod 700 $d/run; echo "HOME=$d/home XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/cfg XDG_CACHE_HOME=$d/cache XDG_RUNTIME_DIR=$d/run HARBOR_SOCK=$d/run/h.sock"; }
in_ns() { local pid=$1; shift; nsenter -t "$pid" -n "$@"; }
db() { echo "$W/$1/data/harbor/harbor.db"; }
rust_fp() { env $(envof $1) "$B" mesh status | sed -n 's/^key: *//p'; }
ts_fp() { in_ns "$2" env $(envof $1) "$BUN" "$RIG/meshnet.ts" fp; }
allowed() {
  local out="" sep=""
  for x in "$@"; do out="$out$sep{\"node\":\"\",\"name\":\"\",\"fp\":\"${x%%=*}\",\"id\":\"\",\"addrs\":[\"${x#*=}\"]}"; sep=","; done
  echo "[$out]"
}
seed_rust() {
  sqlite3 "$(db $1)" "insert or replace into kv values('mesh_enabled','1'),('mesh_id','$2'),('net_map','0')"
  [ -n "$3" ] && sqlite3 "$(db $1)" "insert or replace into kv values('mesh_allowed','$3')"
  if [ -n "$4" ]; then
    sqlite3 "$(db $1)" "insert into chats(repo_id,title,session_id,started,account,model,effort,access,settled,updated,role,parent,name,device,gid,home,home_id,retired) values(NULL,'$4','',0,'claude','claude-opus-5-5','medium','full',0,1761200000,'lead',NULL,'','','$(cat /proc/sys/kernel/random/uuid)','',0,0)"
    local cid; cid=$(sqlite3 "$(db $1)" "select max(id) from chats")
    sqlite3 "$(db $1)" "insert into items values($cid,0,'{\"kind\":\"user\",\"text\":\"hello from $2\",\"files\":[],\"at\":1761200000}'),($cid,1,'{\"kind\":\"text\",\"text\":\"a reply on $2\",\"at\":1761200001}')"
  fi
}
seed_ts() { in_ns "$2" env $(envof $1) "$BUN" "$RIG/meshnet.ts" seed "$3" "$4" "${5:-}"; }
rust_hub() { env $(envof $1) "$B" --background > "$W/$1.log" 2>&1 & echo $!; }
ts_hub() { (cd "$TS" && exec nsenter -t "$2" -n env $(envof $1) "$BUN" harbor.ts --background > "$W/$1.log" 2>&1) & echo $!; }
reach() { timeout 2 bash -c "echo > /dev/tcp/$1/47930" 2>/dev/null; }
items_of() { sqlite3 "$(db $1)" "select i.seq, i.body from items i join chats c on c.id=i.chat_id where c.title='$2' order by i.seq"; }

unshare -n sleep 900 & PB=$!
PR=""
if [ "$MODE" = relay ]; then unshare -n sleep 900 & PR=$!; fi
sleep 0.5
if [ "$MODE" = direct ]; then
  AIP=10.77.0.1; BIP=10.77.0.2
  ip link add va type veth peer name vb; ip link set vb netns $PB
  ip addr add $AIP/24 dev va; ip link set va up
  in_ns $PB sh -c "ip link set lo up; ip addr add $BIP/24 dev vb; ip link set vb up"
else
  AIP=10.77.1.1; RAIP=10.77.1.2; RBIP=10.77.2.1; BIP=10.77.2.2
  ip link add va type veth peer name vra; ip link set vra netns $PR
  ip link add vrb type veth peer name vb; ip link set vrb netns $PR; ip link set vb netns $PB
  ip addr add $AIP/24 dev va; ip link set va up
  in_ns $PR sh -c "ip link set lo up; ip addr add $RAIP/24 dev vra; ip link set vra up; ip addr add $RBIP/24 dev vrb; ip link set vrb up"
  in_ns $PB sh -c "ip link set lo up; ip addr add $BIP/24 dev vb; ip link set vb up"
fi
if [ "$MODE" = direct ]; then
  ping -c1 -W2 $BIP > /dev/null 2>&1 && ok "the two namespaces reach each other over the veth ($AIP and $BIP)" || bad "no path over the veth"
else
  ping -c1 -W2 $RAIP > /dev/null 2>&1 && in_ns $PB ping -c1 -W2 $RBIP > /dev/null 2>&1 && ok "A reaches the relay and B reaches the relay" || bad "no path to the relay"
  ping -c1 -W2 $BIP > /dev/null 2>&1 && bad "A reaches B directly: the namespaces are not apart" || ok "A has no path to B ($BIP): no route, no forwarding in the relay"
fi

env $(envof a) "$B" mesh status > /dev/null
AFP=$(rust_fp a); BFP=$(ts_fp b $PB)
[ -n "$AFP" ] && [ -n "$BFP" ] && ok "A (Rust 0.108.0) is $AFP; B (TypeScript) is $BFP" || bad "identities"

if [ "$MODE" = direct ]; then
  seed_rust a pc:rust-a "" "Chat made on Rust"
  seed_ts b $PB pc:ts-b "Chat made on TypeScript"
  HA=$(rust_hub a)
  for i in $(seq 50); do reach $AIP && break; sleep 0.2; done
  reach $AIP && ok "the Rust hub answers on $AIP:47930 (the veth address)" || bad "the Rust hub does not listen on the veth"
  env $(envof a) "$B" mesh pair > "$W/pair.out" 2>&1 & PP=$!
  sleep 1; CODE=$(sed -n 's/^Pairing code: \([^ ]*\).*/\1/p' "$W/pair.out")
  in_ns $PB env $(envof b) "$BUN" "$TS/harbor.ts" mesh join $AIP:47930 "$CODE" > "$W/join.out" 2>&1
  wait $PP
  grep -q "paired" "$W/join.out" && ok "the TypeScript CLI paired with Rust by code over the veth: $(tail -1 "$W/join.out")" || { bad "pairing: $(cat "$W/join.out")"; }
  HB=$(ts_hub b $PB)
else
  RFP=""
  if [ "$RELAY" = rust ]; then env $(envof r) "$B" mesh status > /dev/null; RFP=$(rust_fp r); else RFP=$(ts_fp r $PR); fi
  ok "the relay is a ${RELAY} PC: $RFP"
  seed_rust a pc:rust-a "$(allowed $BFP=$BIP:47930 $RFP=$RAIP:47930)" "Chat made on Rust"
  seed_ts b $PB pc:ts-b "Chat made on TypeScript" "$AFP=$AIP:47930,$RFP=$RBIP:47930"
  if [ "$RELAY" = rust ]; then
    seed_rust r pc:relay "$(allowed $AFP=$AIP:47930 $BFP=$BIP:47930)" ""
    in_ns $PR env $(envof r) "$B" --background > "$W/r.log" 2>&1 & HR=$!
  else
    seed_ts r $PR pc:relay "" "$AFP=$AIP:47930,$BFP=$BIP:47930"
    HR=$(ts_hub r $PR)
  fi
  for i in $(seq 50); do reach $RAIP && break; sleep 0.2; done
  HA=$(rust_hub a)
  HB=$(ts_hub b $PB)
fi

echo "== waiting up to ${WAIT} s for the chats to cross"
got=0
for i in $(seq $WAIT); do
  sleep 1
  a_has=$(sqlite3 "$(db a)" "select count(*) from chats where home!='' and title='Chat made on TypeScript'")
  b_has=$(sqlite3 "$(db b)" "select count(*) from chats where home!='' and title='Chat made on Rust'")
  [ "$a_has" = 1 ] && [ "$b_has" = 1 ] && { got=1; break; }
done
[ $got = 1 ] && ok "each side holds the other's chat after $i s" || bad "the chats did not cross (Rust has TS chat: $a_has, TS has Rust chat: $b_has)"
sleep 3
[ "$(items_of a 'Chat made on TypeScript')" = "$(items_of b 'Chat made on TypeScript')" ] && [ -n "$(items_of a 'Chat made on TypeScript')" ] && ok "Rust holds the TS chat's items byte for byte ($(items_of a 'Chat made on TypeScript' | wc -l) items)" || bad "items of the TS chat differ"
[ "$(items_of a 'Chat made on Rust')" = "$(items_of b 'Chat made on Rust')" ] && [ -n "$(items_of b 'Chat made on Rust')" ] && ok "TS holds the Rust chat's items byte for byte ($(items_of b 'Chat made on Rust' | wc -l) items)" || bad "items of the Rust chat differ"
if [ "$MODE" = relay ]; then
  reach $BIP && bad "A can open a connection to B" || ok "A still has no direct path to B: the chats crossed through the relay"
fi
kill $HA $HB ${HR:-} 2>/dev/null
wait $HA $HB ${HR:-} 2>/dev/null
kill $PB ${PR:-} 2>/dev/null
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
