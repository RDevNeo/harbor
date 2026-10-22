#!/bin/sh
# Harbor installer: per user, no sudo.
#
#   curl -fsSL https://github.com/RDevNeo/harbor/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --with-browser     # also the built-in browser engine (~40 MB)
#   curl -fsSL …/install.sh | sh -s -- --uninstall        # remove Harbor (keeps your chats)
#   curl -fsSL …/install.sh | sh -s -- --uninstall --purge  # …and its data
#
# Offline: run ./install.sh from an extracted harbor-x86_64-linux.tar.gz. It installs the files
# next to it, checked against the SHA256SUMS (and its signature, with minisign) in that folder.
# --with-browser then uses an extracted harbor-browser-x86_64-linux folder (or its .tar.gz)
# beside it, and downloads only if there is neither.
#
# Layout: ~/.local/lib/harbor/{harbor,harbor-stream,harbor-browser}, ~/.local/bin/harbor (link),
# ~/.local/share/applications/harbor.desktop, ~/.local/share/icons/hicolor/…/harbor.{svg,png}.
# Harbor updates itself afterwards (Settings › General).
set -eu

REPO="RDevNeo/harbor"
PUBKEY="RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh"
VERSION="${HARBOR_VERSION:-latest}"
BROWSER=0
UNINSTALL=0
PURGE=0
# A local folder with the release files (for testing): HARBOR_FROM=/path/to/dist
FROM="${HARBOR_FROM:-}"

for a in "$@"; do
  case "$a" in
    --with-browser) BROWSER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --version=*) VERSION="${a#--version=}" ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "harbor install: unknown option $a" >&2; exit 2 ;;
  esac
done

LIB="$HOME/.local/lib/harbor"
BIN="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor"

say() { printf '%s\n' "$*"; }
die() { printf 'harbor install: %s\n' "$*" >&2; exit 1; }

refresh_menus() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -L "$BIN/harbor" ] && [ "$(readlink "$BIN/harbor")" = "$LIB/harbor" ]; then rm -f "$BIN/harbor"; fi
  rm -rf "$LIB"
  rm -f "$APPS/harbor.desktop" "$ICONS/scalable/apps/harbor.svg" "$ICONS/256x256/apps/harbor.png"
  refresh_menus
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DATA/harbor"
    say "Harbor and its data were removed."
  else
    say "Harbor was removed. Your chats are still in $DATA/harbor (add --purge to delete them)."
  fi
  exit 0
fi

[ "$(uname -s)" = Linux ] || die "Harbor runs on Linux only."
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  *) die "no build for $(uname -m) yet (x86_64 only)." ;;
esac
for c in tar sha256sum; do command -v "$c" >/dev/null 2>&1 || die "$c is required."; done

# Run from an extracted release folder (not piped from curl): install the files next to this script.
HERE=""
if [ -z "$FROM" ] && [ "$(basename -- "$0")" = install.sh ]; then
  HERE="$(cd "$(dirname -- "$0")" && pwd)"
  [ -x "$HERE/harbor" ] && [ -f "$HERE/VERSION" ] || HERE=""
fi

if [ "$VERSION" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {
  if [ -n "$FROM" ]; then
    cp "$FROM/$1" "$TMP/$1" 2>/dev/null || return 1
  else
    curl -fsSL --retry 3 -o "$TMP/$1" "$BASE/$1" || return 1
  fi
}

# Checks a downloaded asset against SHA256SUMS, and its minisign signature when minisign is installed
# (Harbor's own updater always checks signatures).
verify() {
  line="$(grep "  $1\$" "$TMP/SHA256SUMS" || true)"
  [ -n "$line" ] || die "$1 is not listed in SHA256SUMS."
  (cd "$TMP" && printf '%s\n' "$line" | sha256sum -c --quiet -) || die "$1: checksum mismatch."
  if command -v minisign >/dev/null 2>&1; then
    fetch "$1.minisig" || die "could not download $1.minisig"
    minisign -Vqm "$TMP/$1" -P "$PUBKEY" || die "$1: bad signature."
  fi
}

# Checks a release folder against its own SHA256SUMS (and signature, when minisign is installed).
check_folder() { # dir name
  if [ -f "$1/SHA256SUMS" ]; then
    (cd "$1" && sha256sum -c --quiet SHA256SUMS) || die "$2: files don't match its SHA256SUMS."
    if [ -f "$1/SHA256SUMS.minisig" ] && command -v minisign >/dev/null 2>&1; then
      minisign -Vqm "$1/SHA256SUMS" -P "$PUBKEY" || die "$2: bad signature on SHA256SUMS."
      say "$2: checksums and signature verified."
    else
      say "$2: checksums verified."
    fi
  else
    say "Note: $2 has no SHA256SUMS; installing its files unchecked."
  fi
}

# Keep the browser engine if it's already installed; add it with --with-browser.
[ -x "$LIB/harbor-browser" ] && BROWSER=1
BSRC=""
if [ -n "$HERE" ]; then
  SRC="$HERE"
  say "Installing Harbor $(cat "$SRC/VERSION") from $SRC…"
  check_folder "$SRC" "harbor-$ARCH-linux"
  if [ "$BROWSER" = 1 ]; then
    side="$(dirname -- "$HERE")"
    if [ -x "$side/harbor-browser-$ARCH-linux/harbor-browser" ]; then
      BSRC="$side/harbor-browser-$ARCH-linux"
    elif [ -f "$side/harbor-browser-$ARCH-linux.tar.gz" ]; then
      mkdir -p "$TMP/browser"
      tar -xzf "$side/harbor-browser-$ARCH-linux.tar.gz" -C "$TMP/browser"
      BSRC="$TMP/browser/harbor-browser-$ARCH-linux"
    fi
    if [ -n "$BSRC" ]; then
      check_folder "$BSRC" "harbor-browser-$ARCH-linux"
      [ "$(cat "$BSRC/browser.id" 2>/dev/null)" = "$(cat "$SRC/browser.id" 2>/dev/null)" ] || \
        say "Note: that browser engine is from another release; Harbor's updater replaces it later."
    else
      # Only the engine needs the network; Harbor itself came from this folder.
      VERSION="$(cat "$SRC/VERSION")"
      BASE="https://github.com/$REPO/releases/download/v$VERSION"
    fi
  fi
fi

if [ -z "$HERE" ]; then
  [ -n "$FROM" ] || command -v curl >/dev/null 2>&1 || die "curl is required."
  fetch SHA256SUMS || die "could not reach the release ($BASE)."
elif [ "$BROWSER" = 1 ] && [ -z "$BSRC" ]; then
  # Harbor itself is here; without the network, skip just the engine.
  if ! command -v curl >/dev/null 2>&1 || ! fetch SHA256SUMS 2>/dev/null; then
    say "Note: the browser engine needs a download ($BASE), which failed; installing Harbor without it."
    BROWSER=0
  fi
fi
if [ -z "$HERE" ]; then
  say "Downloading Harbor ($VERSION)…"
  CORE="harbor-$ARCH-linux.tar.gz"
  fetch "$CORE" || die "could not download $CORE"
  verify "$CORE"
  mkdir -p "$TMP/core"
  tar -xzf "$TMP/$CORE" -C "$TMP/core"
  SRC="$TMP/core/harbor-$ARCH-linux"
fi
[ -x "$SRC/harbor" ] || die "no harbor binary in $SRC."

if [ "$BROWSER" = 1 ] && [ -z "$BSRC" ]; then
  BR="harbor-browser-$ARCH-linux.tar.gz"
  say "Downloading the browser engine…"
  if fetch "$BR"; then
    verify "$BR"
    mkdir -p "$TMP/browser"
    tar -xzf "$TMP/$BR" -C "$TMP/browser"
    BSRC="$TMP/browser/harbor-browser-$ARCH-linux"
  else
    say "Note: this release has no browser engine; skipping it."
    BROWSER=0
  fi
fi

mkdir -p "$LIB" "$BIN" "$APPS" "$ICONS/scalable/apps" "$ICONS/256x256/apps"
STAGE="$LIB/.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -p "$SRC/harbor" "$SRC/harbor-stream" "$STAGE/"
cp -p "$SRC/VERSION" "$STAGE/VERSION"
[ -f "$SRC/browser.id" ] && cp -p "$SRC/browser.id" "$STAGE/browser.id"
cp -rp "$SRC/licenses" "$STAGE/licenses"
if [ "$BROWSER" = 1 ]; then
  cp -p "$BSRC/harbor-browser" "$STAGE/"
  cp -p "$BSRC/browser.id" "$STAGE/browser.installed"
fi
# Helpers first, harbor last: a running Harbor sees its file change and reloads into the new
# version (rename is atomic; running processes keep the old file).
for f in harbor-stream harbor-browser VERSION browser.id browser.installed; do
  [ -e "$STAGE/$f" ] && mv -f "$STAGE/$f" "$LIB/$f"
done
rm -rf "$LIB/licenses"
mv "$STAGE/licenses" "$LIB/licenses"
mv -f "$STAGE/harbor" "$LIB/harbor"
rmdir "$STAGE" 2>/dev/null || true
# Marks a per-user install the in-app updater may manage.
echo "install.sh" > "$LIB/.managed"

ln -sfn "$LIB/harbor" "$BIN/harbor"
sed "s|^Exec=harbor|Exec=$BIN/harbor|" "$SRC/harbor.desktop" > "$APPS/harbor.desktop"
cp "$SRC/harbor.svg" "$ICONS/scalable/apps/harbor.svg"
[ -f "$SRC/harbor-256.png" ] && cp "$SRC/harbor-256.png" "$ICONS/256x256/apps/harbor.png"
refresh_menus

say "Harbor $(cat "$LIB/VERSION") installed in $LIB."
case ":$PATH:" in
  *":$BIN:"*) say "Run it from your app launcher, or type: harbor" ;;
  *) say "Run it from your app launcher, or $BIN/harbor (add $BIN to your PATH to type just 'harbor')." ;;
esac

# The screen viewer uses a few common system libraries; say which are missing.
missing="$(ldd "$LIB/harbor-stream" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')"
if [ -n "$missing" ]; then
  say "Note: remote screens need these libraries, which aren't installed: $missing"
  say "      (Ubuntu/Debian: sudo apt install libssl3 libopus0 libasound2 libva2 libva-drm2)"
fi
if [ "$BROWSER" = 0 ]; then
  say "The built-in browser is optional: install it from Harbor, or rerun with --with-browser."
fi
command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || \
  say "Harbor drives coding-agent CLIs: install Claude Code (https://claude.ai/install.sh), Codex or Gemini too."
