#!/bin/bash
set -u
BUN_DIR=${BUN_DIR:?the folder holding the aarch64 bun}; COPY=${SCRAMBLED_DB:?a scrambled harbor.db}; SRC=${SRC:?a checkout of this branch (its ts folder)}
export PATH=$BUN_DIR:$PATH
REAL=$HOME; D=${OUT:-$REAL/arm}
cd "$SRC"
echo "== bun $(bun --version) on $(uname -m), $(ldd --version | head -1)"
bun install --network-concurrency=6 2>&1 | tail -2
rm -rf "$D"; mkdir -p "$D/t"
echo "== build (native on arm64)"
bun scripts/build.ts runtime "$D/harbor" --version 0.109.0 2>&1 | tail -3
bun scripts/build.ts app "$D/harbor-app.js" --version 0.109.0 --min-runtime 0.109.0 --sha arm0000 2>&1 | tail -3
file "$D/harbor" | cut -c1-110
objdump -T "$D/harbor" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -V | uniq | tail -1
envof() { local t=$1; mkdir -p $t/{home,data/harbor,state,cfg,cache,run}; chmod 700 $t/run; export HOME=$t/home XDG_DATA_HOME=$t/data XDG_STATE_HOME=$t/state XDG_CONFIG_HOME=$t/cfg XDG_CACHE_HOME=$t/cache XDG_RUNTIME_DIR=$t/run HARBOR_SOCK=$t/run/h.sock HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1; }
T=$D/t; envof $T
echo "== --version";      "$D/harbor" --version
echo "== --check-native"; "$D/harbor" --check-native 2>&1 | head -4
echo "== turn"
mkdir -p $T/turn $T/work
printf '{"program":"/bin/sh","args":["-c","echo out1; echo err1 >&2; exit 3"],"cwd":"%s","env":[["X","1"]]}' "$T/work" > $T/turn/cmd.json
"$D/harbor" turn $T/turn; echo "turn files: out=$(tr '\n' ' ' < $T/turn/out) err=$(tr '\n' ' ' < $T/turn/err) exit=$(cat $T/turn/exit)"
echo "== hub on a scrambled harbor.db: phone API and TLS"
T2=$D/t2; rm -rf $T2; envof $T2; cp "$COPY" $T2/data/harbor/harbor.db
TOK=0123456789abcdef0123456789abcdef0123456789abcdef
(cd "$SRC" && bun -e "import { Store, dataDir } from './packages/store/src/index.ts'; const s = Store.open(dataDir()); s.setQuiet('api_enabled','1'); s.setQuiet('api_port','47930'); s.setQuiet('api_tokens', JSON.stringify([{token:'$TOK',name:'',created:0,group:'gggggggggggggggg',fp:''}])); console.log('db: ' + s.chats().length + ' chats, ' + s.repos().length + ' repos'); s.close();")
"$D/harbor" --background > $T2/hub.log 2>&1 & HP=$!
for i in $(seq 80); do curl -s -o /dev/null http://127.0.0.1:47930/ && break; sleep 0.3; done
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:47930/v1/state | bun -e 'const v = JSON.parse(await Bun.stdin.text()); console.log("phone API /v1/state: version", v.version, "chats", v.chats.length, "projects", v.projects.length)'
for v in tls1_2 tls1_3; do echo | openssl s_client -connect 127.0.0.1:47930 -$v 2>/dev/null | grep -E "Protocol|Cipher is" | head -2 | tr '\n' ' '; echo; done
kill $HP 2>/dev/null; wait $HP 2>/dev/null
echo "== window on a virtual display"
T3=$D/t3; rm -rf $T3; envof $T3; cp "$COPY" $T3/data/harbor/harbor.db
Xvfb :99 -screen 0 1400x900x24 > $T3/xvfb.log 2>&1 & XP=$!
sleep 2
SLINT_BACKEND=winit-skia-software DISPLAY=:99 "$D/harbor" > $T3/win.log 2>&1 & WP=$!
sleep 14
kill -0 $WP 2>/dev/null && echo "window process alive after 14 s" || { echo "window process DIED"; tail -5 $T3/win.log; }
DISPLAY=:99 xwininfo -root -tree 2>/dev/null | grep -E "[0-9]+x[0-9]+\+[0-9]+\+[0-9]+" | grep -v "has no name" | head -3
DISPLAY=:99 import -window root $T3/win.png 2>/dev/null
identify -format "screenshot %wx%h, %k colours, mean %[fx:mean]\n" $T3/win.png 2>/dev/null
kill $WP 2>/dev/null; wait $WP 2>/dev/null; kill $XP 2>/dev/null
echo ARM-DONE
