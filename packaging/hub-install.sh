#!/usr/bin/env bash
# Builds Hub (this checkout: Harbor's app forked as Hub, its own world) and installs it for this user:
#   ~/.local/lib/hub/{hub, harbor-app.js, VERSION, RUNTIME, hub-machines/}   the app (runtime + bundle)
#   ~/.local/bin/hub                                                       the command (a link)
#   ~/.local/share/applications/hub.desktop, ~/.local/share/icons/hicolor/scalable/apps/hub.svg
#   ~/.config/autostart/hub.desktop                                        starts at login (`hub --background`)
# Data: ~/.local/share/hub, state ~/.local/state/hub (made at its first start; scripts/hub-cutover.sh in
# creators-hub copies Harbor's there). Port 47940. It never updates itself from Harbor: running this again is the
# update (a running Hub restarts into the new build when VERSION changes).
#
# The runtime is Harbor's signed release runtime (compiled Bun + native addons), pinned below and checked by sha256.
# Google sign-in clients (baked into Harbor's bundles) come from HARBOR_GOOGLE_* in the environment, else from an
# existing bundle (--google-from FILE, else Person Hub's engine or an old Harbor install).
# hub-machines (the agents' tools for the other PCs) comes from --machines DIR (creators-hub's tools/hub-machines).
#
# Usage: bash packaging/hub-install.sh [--prefix DIR] [--stage DIR | --install-stage DIR] [--google-from BUNDLE] [--machines DIR] [--no-desktop]
#   --stage DIR          only builds into DIR (nothing installed; for checks, and for the cutover's build step)
#   --install-stage DIR  installs what --stage built in DIR (no build)
#   --apk FILE           Hub for Android (android/build.sh) to serve to phones at /app.apk (versionCode from its name's
#                        version file, else ts/package.json's version)
#   --prefix DIR install the app there instead of ~/.local/lib/hub (and no launcher, menu entry or autostart)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

RUNTIME=0.189.0
RUNTIME_ASSET=harbor-runtime-x86_64
RUNTIME_SHA256=e3e0151608d17a0e32465c065d42537004fb18841a2c81c9a985d0ddd3d9d5b8
LIB="$HOME/.local/lib/hub"
STAGE_ONLY=""
FROM_STAGE=""
APK=""
DESKTOP=1
GOOGLE_FROM=()
MACHINES=""
for d in "$HOME/Documents/harbor-projects/creators-hub/tools/hub-machines" "$HOME/Documents/harbor-projects/creators-hub-machines/tools/hub-machines"; do
  [[ -z "$MACHINES" && -f "$d/server.ts" ]] && MACHINES="$d"
done
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) LIB="$2"; DESKTOP=0; shift ;;
    --stage) STAGE_ONLY="$2"; shift ;;
    --install-stage) FROM_STAGE="$2"; shift ;;
    --apk) APK="$2"; shift ;;
    --google-from) GOOGLE_FROM+=("$2"); shift ;;
    --machines) MACHINES="$2"; shift ;;
    --no-desktop) DESKTOP=0 ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
  esac
  shift
done

say() { echo "hub-install: $*"; }
install_files() { # DIR with hub, harbor-app.js, RUNTIME, hub.svg, VERSION(.new), hub-machines/
  local from="$1" version
  version=$(cat "$from/VERSION.new" 2>/dev/null || cat "$from/VERSION")
  mkdir -p "$LIB"
  # Harbor's mark of an install it runs from (the start watchdog, the VERSION watch that restarts into a new build, the
  # APK it serves). Hub's updater never fetches Harbor's releases (delivery.ts harborsReleases).
  touch "$LIB/.managed"
  for f in hub harbor-app.js RUNTIME hub.svg; do
    cp "$from/$f" "$LIB/.$f.new" && mv -f "$LIB/.$f.new" "$LIB/$f"
  done
  if [[ -d "$from/hub-machines" ]]; then
    rm -rf "$LIB/hub-machines.new"; cp -r "$from/hub-machines" "$LIB/hub-machines.new"
    # the machines' policies are this PC's own once installed: an edited machines.json stays
    [[ -f "$LIB/hub-machines/machines.json" ]] && cp "$LIB/hub-machines/machines.json" "$LIB/hub-machines.new/machines.json"
    rm -rf "$LIB/hub-machines"; mv "$LIB/hub-machines.new" "$LIB/hub-machines"
  fi
  if [[ -n "$APK" ]]; then
    local code
    code=$(node -p "const [a,b,c]=require('./ts/package.json').version.split('.').map(Number); a*1000000+b*1000+c")
    cp "$APK" "$LIB/.harbor-android.apk.new" && mv -f "$LIB/.harbor-android.apk.new" "$LIB/harbor-android.apk"
    echo "$code" > "$LIB/harbor-android.version"
    say "serving Hub for Android ($code) to phones"
  fi
  echo "$version" > "$LIB/.VERSION.new" && mv -f "$LIB/.VERSION.new" "$LIB/VERSION"
  if [[ $DESKTOP == 1 ]]; then
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps" "$HOME/.config/autostart"
    ln -sfn "$LIB/hub" "$HOME/.local/bin/hub"
    sed "s#^Exec=hub#Exec=$LIB/hub#" packaging/hub.desktop > "$HOME/.local/share/applications/hub.desktop"
    cp packaging/hub.svg "$HOME/.local/share/icons/hicolor/scalable/apps/hub.svg"
    printf '[Desktop Entry]\nType=Application\nName=Hub\nComment=Starts Hub in the background\nExec=%s --background\nIcon=hub\nTerminal=false\nX-GNOME-Autostart-enabled=true\n' "$LIB/hub" > "$HOME/.config/autostart/hub.desktop"
    command -v update-desktop-database >/dev/null && update-desktop-database -q "$HOME/.local/share/applications" 2>/dev/null || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  fi
  say "installed Hub $version in $LIB"
}
if [[ -n "$FROM_STAGE" ]]; then
  [[ -x "$FROM_STAGE/hub" && -f "$FROM_STAGE/harbor-app.js" ]] || { say "no staged build in $FROM_STAGE" >&2; exit 1; }
  install_files "$FROM_STAGE"
  exit 0
fi
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/hub-build"
mkdir -p "$CACHE"
RT="$CACHE/harbor-runtime-$RUNTIME"
sha_ok() { [[ -f "$1" ]] && [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$RUNTIME_SHA256" ]]; }
if ! sha_ok "$RT"; then
  for c in "$HOME/.cache/creators-hub/engine/harbor-runtime-$RUNTIME"; do sha_ok "$c" && cp "$c" "$RT.tmp" && mv "$RT.tmp" "$RT"; done
fi
if ! sha_ok "$RT"; then
  say "downloading the runtime $RUNTIME…"
  curl -fsSL -o "$RT.tmp" "https://github.com/RDevNeo/harbor/releases/download/v$RUNTIME/$RUNTIME_ASSET"
  sha_ok "$RT.tmp" || { rm -f "$RT.tmp"; say "the runtime's sha256 isn't the pinned one" >&2; exit 1; }
  mv "$RT.tmp" "$RT"
fi
chmod 755 "$RT"

COMMIT=$(git rev-parse HEAD)
VERSION="$(node -p "require('./ts/package.json').version")+${COMMIT:0:7}"
[[ -z "$(git status --porcelain -- ts)" ]] || VERSION="$VERSION-dirty"
STAGE=$(mktemp -d "$CACHE/stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
GENV="$STAGE/google.env"
if [[ -n "${HARBOR_GOOGLE_CLIENT_ID:-}" ]]; then say "google clients: from the environment"
elif ! node packaging/hub-google.cjs "$GENV" "${GOOGLE_FROM[@]}" "$LIB/harbor-app.js" "$HOME/.local/opt/creators-hub/engine/harbor-app.js" "$HOME/.local/lib/harbor/harbor-app.js"; then
  say "WARNING: no Google clients found (Google sign-ins of integrations won't work); pass --google-from BUNDLE" >&2
fi

say "building $VERSION…"
(
  cd ts
  export BUN_BE_BUN=1
  if [[ -f "$GENV" ]]; then set -a; . "$GENV"; set +a; fi
  nice "$RT" install --frozen-lockfile >/dev/null
  nice "$RT" node_modules/typescript/bin/tsc --noEmit
  nice "$RT" scripts/build.ts app "$STAGE/harbor-app.js" --version "$VERSION" --min-runtime "$RUNTIME" --sha "$COMMIT" >/dev/null
)
"$RT" smoke-bundle "$STAGE/harbor-app.js"

OUT="$STAGE/hub"
mkdir -p "$OUT"
cp "$RT" "$OUT/hub"
mv "$STAGE/harbor-app.js" "$OUT/harbor-app.js"
echo "$RUNTIME" > "$OUT/RUNTIME"
cp packaging/hub.svg "$OUT/hub.svg"
if [[ -n "$MACHINES" ]]; then
  mkdir -p "$OUT/hub-machines"
  (cd "$MACHINES" && cp -r --parents $(ls *.ts *.json 2>/dev/null) "$OUT/hub-machines/")
  say "hub-machines from $MACHINES"
else
  say "WARNING: no hub-machines (--machines DIR): agents won't have the other PCs' tools" >&2
fi
echo "$VERSION" > "$OUT/VERSION.new"

if [[ -n "$STAGE_ONLY" ]]; then
  rm -rf "$STAGE_ONLY"; mkdir -p "$(dirname "$STAGE_ONLY")"
  mv "$OUT/VERSION.new" "$OUT/VERSION"
  mv "$OUT" "$STAGE_ONLY"
  say "built $VERSION in $STAGE_ONLY (not installed)"
  exit 0
fi

# Install: the files beside the running ones, then VERSION last (a running Hub restarts into the new build on it).
install_files "$OUT"
