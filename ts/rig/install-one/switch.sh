#!/bin/bash
# Run inside `unshare -Urnm` only. RUST_REL: an extracted harbor-x86_64-linux folder of Rust 0.109.0 (its signature checked);
# TS_BIN: the single TypeScript executable; BAD_TS_BIN: one whose window doesn't open (loop.ts loading Slint by createRequire);
# SCRAMBLED_DB: a scrambled harbor.db; SWAY: the sway prefix (bin/, lib/); RIG_TMP: a scratch folder.
set -u
mount -t sysfs sysfs /sys 2>/dev/null
[ "$(ls /sys/class/net)" = lo ] || { echo "refused: run inside unshare -Urnm (a network namespace with only lo)" >&2; exit 99; }
ip link set lo up
# install-one.sh opens the new binary's window: on each PC's own headless sway, never on the PC's screen.
for c in /dev/dri/card*; do mount --bind /dev/null "$c" || { echo "refused: can't hide $c" >&2; exit 99; }; done
REL=${RUST_REL:?}; NEW=${TS_BIN:?}; BAD=${BAD_TS_BIN:?}; SRC=${SCRAMBLED_DB:?}; SW=${SWAY:?}; T=${RIG_TMP:?}
HERE=$(cd "$(dirname "$0")" && pwd); ONE=$HERE/../../scripts/install-one.sh
rm -rf "$T"; mkdir -p "$T"
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
TOK=0123456789abcdef0123456789abcdef0123456789abcdef

pc_env() { # name port
  local h=$T/$1/home
  mkdir -p "$h" "$T/$1/run"; chmod 700 "$T/$1/run"
  echo "HOME=$h XDG_DATA_HOME=$h/.local/share XDG_STATE_HOME=$h/.local/state XDG_CONFIG_HOME=$h/.config XDG_CACHE_HOME=$h/.cache XDG_RUNTIME_DIR=$T/$1/run PATH=$HERE/fakebin:/usr/bin:/bin HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 HARBOR_UPDATE_WORKER=off RIG_CURL_LOG=$T/$1/curl.log RIG_HOLD_S=${RIG_HOLD_S:-75} RIG_SWAY=$SW TZ=UTC"
}
# A headless sway in the PC's runtime folder, where install-one.sh finds its socket without WAYLAND_DISPLAY.
sway_for() {
  LD_LIBRARY_PATH=$SW/lib env -i HOME=$T/$1 XDG_RUNTIME_DIR=$T/$1/run WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LD_LIBRARY_PATH=$SW/lib "$SW/bin/sway" -c "$HERE/../sway.conf" > "$T/$1/sway.log" 2>&1 &
  for _ in $(seq 100); do ls "$T/$1"/run/wayland-? > /dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
on() { local n=$1; shift; env -i $(pc_env "$n") "$@"; }
lib() { echo "$T/$1/home/.local/lib/harbor"; }
db() { echo "$T/$1/home/.local/share/harbor/harbor.db"; }
port() { sqlite3 "$(db "$1")" "select v from kv where k='api_port'"; }
get() { curl -s --max-time 20 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$(port "$1")$2"; }
post() { curl -s --max-time 20 -H "Authorization: Bearer $TOK" -X "${4:-POST}" -d "$3" "http://127.0.0.1:$(port "$1")$2"; }
up() { for _ in $(seq 150); do get "$1" /v1/state > /dev/null 2>&1 && [ -n "$(get "$1" /v1/state)" ] && return 0; sleep 0.2; done; return 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
field() { python3 -I -c 'import json,sys; v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[int(k)] if isinstance(v,list) else v.get(k)
print(v if not isinstance(v,(dict,list)) else json.dumps(v))' "$1"; }
cid() { python3 -I -c 'import json,sys; v=json.load(sys.stdin); print(v.get("id") or v.get("chat",{}).get("id"))'; }
# Only this rig's processes, by the runtime folder each one has; other agents run the same binaries.
stopall() { local p; for p in /proc/[0-9]*; do tr '\0' '\n' 2>/dev/null < "$p/environ" | grep -q "^XDG_RUNTIME_DIR=$T/[a-z]/run$" && kill "${p#/proc/}" 2>/dev/null; done 2>/dev/null; sleep 1; }
rpc() { python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    try: m=json.loads(l)
    except Exception: continue
    if m.get("id")==int(sys.argv[2]) and "result" in m and (len(sys.argv)<4 or sys.argv[3] in json.dumps(m["result"])): sys.exit(0)
sys.exit(1)' "$@"; }
rss() { awk '/VmRSS/{print $2}' "/proc/$1/status" 2>/dev/null; }
apppid() { on "$1" bash "$ONE" status | sed -n 's/^running: *//p' | awk '{print $1}'; }

install_rust() { # name port id
  mkdir -p "$T/$1/rel"; cp -a "$REL" "$T/$1/rel/"
  on "$1" HARBOR_INSECURE=1 sh "$T/$1/rel/$(basename "$REL")/install.sh" > "$T/$1/install.log" 2>&1 || { bad "install.sh on $1"; cat "$T/$1/install.log"; }
  printf 'PK\003\004%s' "$(head -c 4096 /dev/urandom | base64 -w0)" > "$(lib "$1")/harbor-android.apk"
  printf '109000' > "$(lib "$1")/harbor-android.version"
  mkdir -p "$(dirname "$(db "$1")")"
  [ "$1" = a ] && cp "$SRC" "$(db a)"
  on "$1" "$(lib "$1")/harbor" mesh status > /dev/null
  for id in $(sqlite3 "$(db "$1")" "select id from repos"); do mkdir -p "$T/$1/home/p$id"; sqlite3 "$(db "$1")" "update repos set path='$T/$1/home/p$id' where id=$id"; done
  sqlite3 "$(db "$1")" "insert or replace into kv(k,v) values('api_enabled','1'),('api_port','$2'),('mesh_id','$3'),('mesh_enabled','1'),('api_tokens','[{\"token\":\"$TOK\",\"name\":\"Rig phone\",\"created\":1761200000,\"group\":\"gggggggggggggggg\",\"fp\":\"\"}]')"
}
fp_of() { on "$1" "$(lib "$1")/harbor" mesh status | sed -n 's/^key: *//p'; }
allow() { sqlite3 "$(db "$1")" "insert or replace into kv(k,v) values('mesh_allowed','[{\"node\":\"\",\"name\":\"$3\",\"fp\":\"$2\",\"id\":\"\",\"addrs\":[\"127.0.0.1:$4\"]}]')"; }

echo "== 1. Rust 0.109.0 installed by its own install.sh in a fake home, on a scrambled harbor.db"
install_rust a 47930 pc:rig-a
L=$(lib a)
check "install.sh made the real layout" test -f "$L/.managed" -a -x "$L/harbor" -a "$(cat "$L/VERSION")" = 0.109.0 -a -L "$T/a/home/.local/bin/harbor"
check "the installed harbor is Rust 0.109.0" test "$(on a "$L/harbor" --version | cut -d' ' -f2)" = 0.109.0
on z true; mkdir -p "$T/z/home/.local/state/harbor"
ZFP=$(on z "$NEW" mesh status | sed -n 's/^key: *//p')
allow a "$ZFP" "Paired PC" 47999
RUST_SHA=$(sha "$L/harbor"); PEM=$T/a/home/.local/state/harbor/identity.pem; PEM_SHA=$(sha "$PEM")
PAIRS=$(sqlite3 "$(db a)" "select k||'='||v from kv where k in ('api_tokens','mesh_allowed','mesh_id') order by k")
(cd "$T/a/home" && on a "$T/a/home/.local/bin/harbor" --background > "$T/a/rust1.log" 2>&1 &)
check "Rust is up" up a
P1=$(apppid a)
C=$(post a /v1/chats '{"text":"hold this turn across the switch","account":"claude"}' | cid)
sleep 4
RUNNER=$(pgrep -f "^$L/harbor turn" | head -1)
check "a detached turn runs (chat $C, runner ${RUNNER:-none})" test -n "$RUNNER" -a -n "$C"
CHATS0=$(sqlite3 "$(db a)" "select count(*) from chats")

echo "== 1b. install-one.sh refuses a binary whose window doesn't open, and changes nothing"
check "a.'s own sway is up" sway_for a
VERSION0=$(cat "$L/VERSION")
on a bash "$ONE" install "$BAD" --wait 6 --no-trigger > "$T/a/bad.txt" 2>&1; rc=$?
sed 's/^/   /' "$T/a/bad.txt"
check "install exits 1" test $rc = 1
check "and says the window didn't open, with the app's error" grep -q "did not open its window" "$T/a/bad.txt"
check "  (Cannot find module)" grep -q "Cannot find module" "$T/a/bad.txt"
check "harbor is still Rust, VERSION unchanged, no .previous" test "$(sha "$L/harbor")" = "$RUST_SHA" -a "$(cat "$L/VERSION")" = "$VERSION0" -a ! -e "$L/.previous"
check "no backup was made" test ! -e "$T/a/home/.local/state/harbor-switch"
check "the Rust app is still pid $P1" test "$(apppid a)" = "$P1"
on a XDG_RUNTIME_DIR="$T/a/nowhere" bash "$ONE" install "$NEW" --wait 6 --no-trigger > "$T/a/nodisplay.txt" 2>&1; rc=$?
check "with no Wayland session it refuses too ($(cat "$T/a/nodisplay.txt"))" test $rc = 1 -a "$(sha "$L/harbor")" = "$RUST_SHA"

echo "== 2. install-one.sh install, Rust running a turn and asking before it updates"
on a bash "$ONE" install "$NEW" --wait 6 --no-trigger > "$T/a/install1.txt" 2>&1; rc=$?
cat "$T/a/install1.txt"
check "install exits 0" test $rc = 0
check "its preflight saw the window on the PC's sway, found without WAYLAND_DISPLAY" grep -q "Its window opened and stayed up: .*the compositor showed it" "$T/a/install1.txt"
check "the Rust app is still pid $P1 and waits for Update" grep -q "hasn't restarted yet" "$T/a/install1.txt"
check ".previous/harbor is the Rust binary" test "$(sha "$L/.previous/harbor")" = "$RUST_SHA"
check ".previous/VERSION is 0.109.0" test "$(cat "$L/.previous/VERSION")" = 0.109.0
check "harbor is the TypeScript binary" test "$(sha "$L/harbor")" = "$(sha "$NEW")"
TV=$("$NEW" --version | cut -d" " -f2)
check "VERSION says $TV" test "$(cat "$L/VERSION")" = "$TV"
B=$(readlink -f "$T/a/home/.local/state/harbor-switch/latest")
check "the backup folder is private" test "$(stat -c %a "$B")" = 700
check "the backup db passes integrity_check" test "$(sqlite3 "$B/harbor.db" "pragma integrity_check")" = ok
check "the backup keeps identity.pem" test "$(sha "$B/identity.pem")" = "$PEM_SHA"
on a bash "$ONE" install "$NEW" --wait 2 > "$T/a/install2.txt" 2>&1; rc=$?
check "install twice: nothing to do ($(cat "$T/a/install2.txt"))" test $rc = 0 -a "$(grep -c "Already installed" "$T/a/install2.txt")" = 1
check "the second run kept .previous as Rust" test "$(sha "$L/.previous/harbor")" = "$RUST_SHA"
check "status says it can press Update from here" sh -c "env -i $(pc_env a) bash $ONE status | grep -q \"Update from here: yes\""

echo "== 2b. The gap: Rust 0.109.0 still runs while what it starts is the TypeScript binary"
TSI=$(stat -c %i "$L/harbor")
G=$(post a /v1/chats '{"text":"a turn in the gap hold8s","account":"claude"}' | cid)
sleep 3
GR=$(pgrep -f "^$L/harbor turn" | tail -1)
check "Rust started chat $G's runner from the new file: the TypeScript binary (pid ${GR:-none})" test -n "$GR" -a "$(stat -L -c %i "/proc/$GR/exe" 2>/dev/null)" = "$TSI"
check "Rust itself is still the old binary (pid $P1)" test "$(stat -L -c %i "/proc/$P1/exe")" != "$TSI"
for _ in $(seq 60); do [ "$(get a /v1/state | python3 -I -c "import json,sys; s=json.load(sys.stdin); print([c for c in s['chats'] if c['id']==${G:-0}][0].get('running'))" 2>/dev/null)" = False ] && break; sleep 1; done
check "Rust followed the TypeScript runner to the end: chat $G has its reply" test "$(sqlite3 "$(db a)" "select count(*) from items where chat_id=${G:-0} and body like '%DONE%'")" -ge 1
check "and Rust says chat $G is no longer running" test "$(get a /v1/state | python3 -I -c "import json,sys; s=json.load(sys.stdin); print([c for c in s['chats'] if c['id']==${G:-0}][0].get('running'))")" = False
MCPIN='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rig","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_processes","arguments":{}}}'
(printf '%s\n' "$MCPIN"; sleep 6) | on a timeout 20 "$L/harbor" mcp --chat "$C" > "$T/a/mcp-gap.txt" 2> "$T/a/mcp-gap.err"
check "harbor mcp from the TypeScript binary: Rust's socket answers initialize" rpc "$T/a/mcp-gap.txt" 1
check "  tools/list ($(grep -o '"name":"[a-z_]*"' "$T/a/mcp-gap.txt" | wc -l) names)" rpc "$T/a/mcp-gap.txt" 2 list_processes
check "  and a tools/call that Rust runs (list_processes)" rpc "$T/a/mcp-gap.txt" 3
(printf '%s\n' "$(echo "$MCPIN" | head -2)"; sleep 4) | on a timeout 15 "$L/harbor" app gmail > "$T/a/gmail-gap.txt" 2>&1
check "harbor app gmail from the TypeScript binary answers initialize" rpc "$T/a/gmail-gap.txt" 1

echo "== 3. install-one.sh trigger: the phone's Update over loopback, Rust restarts in place into the TypeScript app"
on a bash "$ONE" trigger --wait 30 > "$T/a/trigger.txt" 2>&1; rc=$?
cat "$T/a/trigger.txt"
check "trigger exits 0" test $rc = 0
for _ in $(seq 60); do [ "$(stat -L -c %i "/proc/$P1/exe" 2>/dev/null)" = "$(stat -c %i "$L/harbor")" ] && break; sleep 0.5; done
check "same pid $P1, now running the TypeScript binary" test "$(stat -L -c %i "/proc/$P1/exe" 2>/dev/null)" = "$(stat -c %i "$L/harbor")"
check "the TypeScript hub answers" up a
V3=$(get a /v1/app | field hub.version)
check "it says 0.109.0.ts to phones ($V3)" test "$V3" = 0.109.0.ts
check "the runner $RUNNER outlived the switch" test -d "/proc/$RUNNER"
for _ in $(seq 120); do [ "$(get a /v1/state | python3 -I -c "import json,sys; s=json.load(sys.stdin); print([c for c in s['chats'] if c['id']==$C][0].get('running'))")" = False ] && break; sleep 1; done
check "the turn finished and its reply is in harbor.db" test "$(sqlite3 "$(db a)" "select count(*) from items where chat_id=$C and body like '%DONE%'")" -ge 1
check "no chat lost ($CHATS0)" test "$(sqlite3 "$(db a)" "select count(*) from chats")" -ge "$CHATS0"
check "pairings unchanged" test "$(sqlite3 "$(db a)" "select k||'='||v from kv where k in ('api_tokens','mesh_allowed','mesh_id') order by k")" = "$PAIRS"
check "identity.pem unchanged" test "$(sha "$PEM")" = "$PEM_SHA"
check "the phone is offered the app this PC has (109000)" test "$(get a /v1/app | field version_code)" = 109000
curl -s --max-time 20 "http://127.0.0.1:47930/app.apk" -o "$T/a/got.apk"
check "and /app.apk delivers that file" cmp -s "$T/a/got.apk" "$L/harbor-android.apk"
TSC=$(post a /v1/chats '{"text":"made by the TypeScript app","account":"claude"}' | cid)
sleep 4
A1=$(sqlite3 "$(db a)" "select min(id) from chats")
post a "/v1/chats/$A1" '{"title":"renamed by TypeScript"}' PATCH > /dev/null
check "TypeScript wrote chat $TSC with a reply" test "$(sqlite3 "$(db a)" "select count(*) from items where chat_id=${TSC:-0}")" -ge 2
TSH=$(post a /v1/chats '{"text":"hold a turn of the TypeScript runner","account":"claude"}' | cid)
sleep 4
TSR=$(pgrep -f "^$L/harbor turn" | tail -1)
check "a TypeScript runner runs chat $TSH (pid ${TSR:-none})" test -n "$TSR" -a "$(stat -L -c %i "/proc/$TSR/exe" 2>/dev/null)" = "$(stat -c %i "$L/harbor")"
echo "   RSS: TypeScript app $(rss "$P1") KB, its turn runner $(rss "$TSR") KB"
CHATS1=$(sqlite3 "$(db a)" "select count(*) from chats")

echo "== 4. install-one.sh undo: Rust 0.109.0 back on the same db"
on a bash "$ONE" undo --wait 30 > "$T/a/undo1.txt" 2>&1; rc=$?
cat "$T/a/undo1.txt"
check "undo exits 0" test $rc = 0
check "harbor is Rust again" test "$(sha "$L/harbor")" = "$RUST_SHA"
check "VERSION is 0.109.0, no .skip" test "$(cat "$L/VERSION")" = 0.109.0 -a ! -e "$L/.skip"
check "the original .previous state is back (none after a fresh install)" test ! -e "$L/.previous"
check "Rust is up" up a
P2=$(apppid a)
check "Rust 0.109.0 runs it (pid $P2)" test "$(get a /v1/app | field hub.version)" = 0.109.0
check "Rust serves the TypeScript chat" test "$(get a "/v1/chats/$TSC/items?since=0" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')" -ge 2
check "Rust sees the TypeScript rename" test "$(get a /v1/state | python3 -I -c "import json,sys; print([c['title'] for c in json.load(sys.stdin)['chats'] if c['id']==$A1][0])")" = "renamed by TypeScript"
check "Rust sees every chat ($CHATS1)" test "$(sqlite3 "$(db a)" "select count(*) from chats")" = "$CHATS1"
check "integrity_check ok, user_version 8" test "$(sqlite3 "$(db a)" "pragma integrity_check")/$(sqlite3 "$(db a)" "pragma user_version")" = ok/8
check "pairings unchanged after the round trip" test "$(sqlite3 "$(db a)" "select k||'='||v from kv where k in ('api_tokens','mesh_allowed','mesh_id') order by k")" = "$PAIRS"
for _ in $(seq 120); do [ "$(sqlite3 "$(db a)" "select count(*) from items where chat_id=${TSH:-0} and body like '%DONE%'")" -ge 1 ] && break; sleep 1; done
check "Rust finished the turn the TypeScript runner started" test "$(sqlite3 "$(db a)" "select count(*) from items where chat_id=${TSH:-0} and body like '%DONE%'")" -ge 1
echo "   RSS: Rust app $(rss "$P2") KB"
on a bash "$ONE" undo > "$T/a/undo2.txt" 2>&1; rc=$?
check "undo twice: already Rust ($(cat "$T/a/undo2.txt"))" test $rc = 0 -a "$(grep -c "Already Rust" "$T/a/undo2.txt")" = 1

echo "== 5. install as the lead runs it: it presses Update itself; then undo"
C5=$(post a /v1/chats '{"text":"hold a turn over the triggered switch","account":"claude"}' | cid)
sleep 3
R5=$(pgrep -f "^$L/harbor turn" | tail -1)
P5=$(apppid a)
on a bash "$ONE" install "$NEW" --wait 30 > "$T/a/install5.txt" 2>&1; rc=$?
cat "$T/a/install5.txt"
check "install restarted Rust in place by itself (pid $P5)" test $rc = 0 -a "$(grep -c "restarted in place" "$T/a/install5.txt")" = 1 -a "$(stat -L -c %i "/proc/$P5/exe" 2>/dev/null)" = "$(stat -c %i "$L/harbor")"
echo "   $(grep -o "[0-9]* s after the swap" "$T/a/install5.txt")"
check "the runner $R5 outlived it" test -n "$R5" -a -d "/proc/$R5"
check "the TypeScript hub answers" up a
on a bash "$ONE" undo --wait 30 > "$T/a/undo5.txt" 2>&1
check "undo again: Rust back" test "$(sha "$L/harbor")" = "$RUST_SHA"
check "Rust is up" up a

echo "== 5c. install without the trigger, restart now, then undo with the db restored"
on a bash "$ONE" install "$NEW" --wait 2 --no-trigger > "$T/a/install3.txt" 2>&1
C2=$(post a /v1/chats '{"text":"hold this one too","account":"claude"}' | cid)
sleep 3
R2=$(pgrep -f "^$L/harbor turn" | tail -1)
on a bash "$ONE" restart --wait 30 > "$T/a/restart.txt" 2>&1; rc=$?
cat "$T/a/restart.txt"
check "restart brings up the TypeScript app" test $rc = 0 -a "$(get a /v1/app | field hub.version)" = 0.109.0.ts
check "the runner $R2 outlived the restart" test -n "$R2" -a -d "/proc/$R2"
B3=$(readlink -f "$T/a/home/.local/state/harbor-switch/latest")
CHATS_B3=$(sqlite3 "$B3/harbor.db" "select count(*) from chats")
post a /v1/chats '{"text":"made after the backup","account":"claude"}' > /dev/null; sleep 3
on a bash "$ONE" undo --restore-db --wait 30 > "$T/a/undo3.txt" 2>&1; rc=$?
cat "$T/a/undo3.txt"
check "undo --restore-db exits 0" test $rc = 0
check "Rust is up on the restored db" up a
check "the db is the backup's ($CHATS_B3 chats)" test "$(sqlite3 "$(db a)" "select count(*) from chats")" = "$CHATS_B3"
on a bash "$ONE" undo --restore-db > "$T/a/undo4.txt" 2>&1; rc=$?
check "a second --restore-db refuses ($(cat "$T/a/undo4.txt"))" test $rc != 0
on a bash "$ONE" status
stopall

echo "== 6. A TypeScript PC beside a Rust PC for ${MESH_S:-300} s"
install_rust r 47940 pc:rig-r
install_rust t 47941 pc:rig-t
sway_for t
on t bash "$ONE" install "$NEW" > "$T/t/install.txt" 2>&1
check "t switched while stopped" grep -q "wasn't running" "$T/t/install.txt"
RFP=$(fp_of r); TFP=$(fp_of t)
allow r "$TFP" "TS PC" 47941; allow t "$RFP" "Rust PC" 47940
sqlite3 "$(db r)" "insert or replace into kv(k,v) values('auto_update','1')"
(cd "$T/r/home" && on r "$T/r/home/.local/bin/harbor" --background > "$T/r/app.log" 2>&1 &)
(cd "$T/t/home" && on t "$T/t/home/.local/bin/harbor" --background > "$T/t/app.log" 2>&1 &)
check "both up" up r && up t
post r /v1/chats '{"text":"from the Rust PC","account":"claude"}' > /dev/null
post t /v1/chats '{"text":"from the TypeScript PC","account":"claude"}' > /dev/null
sleep "${MESH_S:-300}"
get r /v1/versions > "$T/r/versions.json"
get r /v1/app > "$T/r/app.json"
check "the Rust peer sees the TypeScript PC online" python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); sys.exit(0 if any(p.get("version")=="0.109.0.ts" and p.get("online") for p in v["pcs"]) else 1)' "$T/r/versions.json"
check "and says nothing is out" test "$(grep -c "is out\|available" "$T/r/versions.json")" = 0
check "the Rust peer knows of no newer release" test "$(field hub.latest < "$T/r/app.json")" = None
check "the Rust peer never downloaded a release to install" test "$(grep -c "RDevNeo/harbor/releases/download/.*/harbor-x86_64-linux.tar.gz" "$T/r/curl.log" 2>/dev/null)" = 0
echo "   Rust peer's GitHub checks in ${MESH_S:-300} s: $(grep -c "releases/latest" "$T/r/curl.log" 2>/dev/null)"
check "and checked GitHub at most on its own schedule" test "$(grep -c "releases/latest" "$T/r/curl.log" 2>/dev/null)" -le $(( ${MESH_S:-300} / 300 + 1 ))
check "the Rust peer fetched no phone app" test "$(grep -c "phone app" "$T/r/app.log")" = 0
check "the Rust peer has the TypeScript chat" test "$(sqlite3 "$(db r)" "select count(*) from chats where title like '%TypeScript PC%' or home!=''")" -ge 1
get t /v1/versions > "$T/t/versions.json"
check "the TypeScript PC says nothing is out either" test "$(grep -c "is out\|available" "$T/t/versions.json")" = 0
stopall
echo "== $([ $fail = 0 ] && echo ALL PASS || echo SOME FAILED)"
exit $fail
