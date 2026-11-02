#!/bin/bash
# `machines` calls from a chat on PC A (TypeScript) to B (TypeScript) and R (Rust), each in its own network
# namespace, where A's project folder doesn't exist: B and R see an empty tmpfs over A's folders.
# Run inside `unshare -Urnm` only: throwaway identities and synthetic dbs.
# env HARBOR_REF (a Rust harbor), RIG_TMP (scratch), BUN.
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 3; }
ip link set lo up
W=${RIG_TMP:?a scratch folder}; B=${HARBOR_REF:?a Rust harbor binary}; BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$W"; mkdir -p "$W"
export HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_NO_DISCOVERY=1 TZ=UTC PATH=/usr/bin:/bin:$(dirname "$BUN")
unset HARBOR_LISTEN HARBOR_ADDRS WAYLAND_DISPLAY DISPLAY
envof() { local d=$W/$1; mkdir -p $d/{home,data,state,cfg,cache,run}; chmod 700 $d/run; echo "HOME=$d/home XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CONFIG_HOME=$d/cfg XDG_CACHE_HOME=$d/cache XDG_RUNTIME_DIR=$d/run HARBOR_SOCK=$d/run/h.sock"; }
db() { echo "$W/$1/data/harbor/harbor.db"; }
# A PC other than A: its network namespace, and A's folders hidden.
apart() { local pid=$1; shift; nsenter -t "$pid" -n unshare -m sh -c 'mount -t tmpfs none "$0" && echo $$ >> "$0.pids" && exec "$@"' "$W/a" "$@"; }

unshare -n sleep 900 & PB=$!
unshare -n sleep 900 & PR=$!
sleep 0.5
AB=10.79.0.1; BIP=10.79.0.2; AR=10.79.1.1; RIP=10.79.1.2
ip link add vab type veth peer name vb; ip link set vb netns $PB
ip link add var type veth peer name vr; ip link set vr netns $PR
ip addr add $AB/24 dev vab; ip link set vab up
ip addr add $AR/24 dev var; ip link set var up
nsenter -t $PB -n sh -c "ip link set lo up; ip addr add $BIP/24 dev vb; ip link set vb up"
nsenter -t $PR -n sh -c "ip link set lo up; ip addr add $RIP/24 dev vr; ip link set vr up"

for pc in a b r; do envof $pc > /dev/null; mkdir -p $W/$pc/home/work; done
mkdir -p $W/a/home/Projects/proj
echo pc:ts-b-home > $W/b/home/marker.txt
echo pc:rust-r-home > $W/r/home/marker.txt
nsenter -t $PB -n unshare -m sh -c 'mount -t tmpfs none "$0" && test -d "$0/home/Projects/proj"' "$W/a" && { echo "FAIL B can see A's folder"; exit 1; }
echo "PASS A's project folder exists on A only"

tsfp() { (cd "$TS" && env $(envof $1) "$BUN" packages/store/rig/meshnet.ts fp); }
env $(envof r) "$B" mesh status > /dev/null
AFP=$(tsfp a); BFP=$(tsfp b); RFP=$(env $(envof r) "$B" mesh status | sed -n 's/^key: *//p')
[ -n "$AFP" ] && [ -n "$BFP" ] && [ -n "$RFP" ] || { echo "FAIL identities"; exit 1; }

(cd "$TS" && env $(envof a) "$BUN" rig/machines.ts seed pc:ts-a "$BFP=$BIP:47930,$RFP=$RIP:47930" $W/a/home/Projects/proj "Chat in proj")
(cd "$TS" && env $(envof b) "$BUN" rig/machines.ts seed pc:ts-b "$AFP=$AB:47930" $W/b/home/work)
# As on the real PCs: an entry for A's folder from a chat adopted before this start.
sqlite3 "$(db b)" "insert into repos(path,name,sort) values('$W/a/home/Projects/proj','proj',0)"
sqlite3 "$(db r)" "insert into repos(path,name,sort) values('$W/a/home/Projects/proj','proj',0)"
sqlite3 "$(db r)" "insert or replace into kv values('mesh_enabled','1'),('mesh_id','pc:rust-r'),('net_map','0'),('mesh_allowed','[{\"node\":\"\",\"name\":\"\",\"fp\":\"$AFP\",\"id\":\"\",\"addrs\":[\"$AR:47930\"]}]'); insert into repos(path,name,sort) values('$W/r/home/work','work',1)"

(cd "$TS" && apart $PB env $(envof b) "$BUN" harbor.ts --background > "$W/b.log" 2>&1) &
apart $PR env $(envof r) "$B" --background > "$W/r.log" 2>&1 &
(cd "$TS" && env $(envof a) B_HOME=$W/b/home R_HOME=$W/r/home "$BUN" rig/machines.ts drive pc:ts-b pc:rust-r "$(db b)" "$(db r)" $W/a/home/Projects/proj) 2>&1 | tee "$W/a.log" | grep -E '^(PASS|FAIL|DRIVE)|rror'
fail=${PIPESTATUS[0]}
grep -q "^DRIVE PASS" "$W/a.log" || fail=1
echo "== repos on B and R"; sqlite3 "$(db b)" "select path, name from repos"; sqlite3 "$(db r)" "select path, name from repos"
kill $(cat "$W/a.pids") 2>/dev/null; sleep 1; kill -9 $(cat "$W/a.pids") 2>/dev/null
kill $PB $PR 2>/dev/null; wait 2>/dev/null
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
