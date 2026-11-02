#!/bin/bash
# Inside `unshare -Urn`: one app (rust|proto|runtime) on throwaway state, no network, the private compositor.
ip link set lo up
which=$1; shift
R=$HOME/.cache/hts/tmp; P=$HOME/.cache/hts/tmp-p0
T=$P/app-$which; rm -rf $T; mkdir -p $T/{home,data/harbor,state,cfg,cache}
cp --reflink=auto $R/stripped.db $T/data/harbor/harbor.db
for id in $(sqlite3 $T/data/harbor/harbor.db "select id from repos"); do
  mkdir -p $T/home/p$id; sqlite3 $T/data/harbor/harbor.db "update repos set path='$T/home/p$id' where id=$id"
done
echo x > $T/home/.exists
export HTS_REAL_HOME=$HOME HOME_REAL=$HOME
export HTS_TS=$HOME/.cache/hts/harbor/ts BUN=$HOME/.bun/bin/bun NODE=$HOME/.local/share/mise/installs/node/26.7.0/bin/node
export XDG_RUNTIME_DIR=$HTS_RT WAYLAND_DISPLAY=wayland-1
export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_CACHE_HOME=$T/cache
export HARBOR_SOCK=$T/h.sock HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1
export PATH=$P/fake:/usr/bin
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
unset DISPLAY
case $which in
  rust)    exec -a harbor-p0 $P/rs/harbor-p0 "$@" ;;
  proto)   mv $T/data/harbor/harbor.db $T/copy.db; HTS_DB=$T/copy.db HTS_CWD=$T/home HTS_CLAUDE=$P/fake/claude exec $R/dist/proto "$@" ;;
  bun)     HTS_REAL_HOME=$HOME_REAL; cd $HTS_TS/proto; exec $BUN idle-window.ts ;;
  node)    cd $HTS_TS/proto; exec $NODE --experimental-strip-types idle-window.ts ;;
  runtime) mv $T/data/harbor/harbor.db $T/copy.db; HTS_DB=$T/copy.db HTS_CWD=$T/home HTS_CLAUDE=$P/fake/claude exec $R/dist/harbor-runtime "$@" ;;
esac
