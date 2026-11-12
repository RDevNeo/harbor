#!/bin/sh
# Harbor installer for Linux and macOS (Apple Silicon, macOS 13+): per user. Harbor installs what it
# needs beside itself when it's missing: Claude Code (Anthropic's installer), Codex (OpenAI's release)
# and git (on macOS Apple's Command Line Tools ask once; on Linux the package manager asks for your
# password once). HARBOR_NO_DEPS=1 leaves those out.
#
#   curl -fsSL https://github.com/RDevNeo/harbor/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --uninstall        # remove Harbor (keeps your chats)
#   curl -fsSL …/install.sh | sh -s -- --uninstall --purge  # …and its data
#
# Offline: run ./install.sh from an extracted harbor-<arch>-linux.tar.gz (x86_64 or aarch64). It installs the files
# next to it, checked against the SHA256SUMS and its signature in that folder.
#
# The video player (libmpv-harbor.so, about 5 MB) comes along too; without it Harbor fetches it later.
#
# Every download is checked against the release's minisign signature. Without minisign installed,
# the static minisign pinned below is fetched (and checked against its SHA-256) for that. To install
# without a signature check anyway: HARBOR_INSECURE=1.
#
# Layout: ~/.local/lib/harbor/{harbor,libmpv-harbor.so,harbor-android.apk}, ~/.local/bin/harbor (link),
# ~/.local/share/applications/harbor.desktop, ~/.local/share/icons/hicolor/…/harbor.{svg,png}.
# macOS: ~/Applications/Harbor.app (from harbor-aarch64-macos.tar.gz), ~/.local/bin/harbor (link).
# Harbor updates itself afterwards (Settings › General).
set -eu

REPO="RDevNeo/harbor"
PUBKEY="RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh"
# The same minisign the release workflow signs with.
MINISIGN_URL="https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz"
MINISIGN_SHA256="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"
# macOS's minisign, from the same release.
MINISIGN_MAC_URL="https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-macos.zip"
MINISIGN_MAC_SHA256="89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63"
INSECURE="${HARBOR_INSECURE:-0}"
VERSION="${HARBOR_VERSION:-latest}"
UNINSTALL=0
PURGE=0
# A local folder with the release files (for testing): HARBOR_FROM=/path/to/dist
FROM="${HARBOR_FROM:-}"

for a in "$@"; do
  case "$a" in
    # Harbor has no built-in browser since 0.177: its options are taken and do nothing.
    --with-browser|--no-browser) ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --version=*) VERSION="${a#--version=}" ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "harbor install: unknown option $a" >&2; exit 2 ;;
  esac
done

LIB="$HOME/.local/lib/harbor"
BIN="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
# The launcher's Exec= points into $HOME, so the data dir must live there too (a test run with a
# temporary HOME must not write into the real session's data dir).
case "$DATA/" in
  "$HOME"/*) ;;
  *) say_note="XDG_DATA_HOME ($DATA) is outside HOME; using $HOME/.local/share"
     DATA="$HOME/.local/share" ;;
esac
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor"

say() { printf '%s\n' "$*"; }
die() { printf 'harbor install: %s\n' "$*" >&2; exit 1; }
# Something can't be checked: refused, unless HARBOR_INSECURE=1 asks to install it anyway.
unchecked() { # what
  if [ "$INSECURE" = 1 ]; then
    printf 'harbor install: WARNING: %s. Installing it anyway (HARBOR_INSECURE=1).\n' "$1" >&2
  else
    die "$1. Run with HARBOR_INSECURE=1 to install without the check."
  fi
}
[ -z "${say_note:-}" ] || say "note: $say_note"

refresh_menus() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
}

# Asks a running Harbor to quit cleanly (turns stop, data saved) before its files go.
quit_harbor() {
  for h in "$BIN/harbor" "$HOME/Applications/Harbor.app/Contents/MacOS/harbor" "$LIB/harbor"; do
    if [ -x "$h" ]; then "$h" quit >/dev/null 2>&1 || true; return 0; fi
  done
}

if [ "$UNINSTALL" = 1 ] && [ "$(uname -s)" = Darwin ]; then
  quit_harbor
  if [ -L "$BIN/harbor" ] && [ "$(readlink "$BIN/harbor")" = "$HOME/Applications/Harbor.app/Contents/MacOS/harbor" ]; then rm -f "$BIN/harbor"; fi
  rm -rf "$HOME/Applications/Harbor.app"
  rm -f "$HOME/Library/LaunchAgents/dev.harbor.Harbor.plist"
  if [ "$PURGE" = 1 ]; then rm -rf "$DATA/harbor"; say "Harbor and its data were removed."; else say "Harbor was removed. Your chats are still in $DATA/harbor (add --purge to delete them)."; fi
  exit 0
fi

if [ "$UNINSTALL" = 1 ]; then
  quit_harbor
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

# What Harbor needs beside itself, installed here when missing (nothing to install by hand first): git,
# Claude Code and Codex. HARBOR_NO_DEPS=1 leaves them out (test installs).
install_deps() {
  [ "${HARBOR_NO_DEPS:-}" = 1 ] && return 0
  mkdir -p "$BIN"
  if [ "$(uname -s)" = Darwin ]; then
    # macOS's git comes with Apple's Command Line Tools: macOS asks once, in a window, to install them.
    if ! xcode-select -p >/dev/null 2>&1; then
      say "Harbor needs git, which comes with Apple's Command Line Tools: macOS will ask you to install them (click Install)."
      xcode-select --install >/dev/null 2>&1 || true
    fi
  elif ! command -v git >/dev/null 2>&1; then
    say "Harbor needs git, which isn't installed. Installing it with your package manager (it asks for your password once)…"
    ok=1
    if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y git || ok=0
    elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git || ok=0
    elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --needed --noconfirm git || ok=0
    elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install git || ok=0
    elif command -v apk >/dev/null 2>&1; then sudo apk add git || ok=0
    else ok=0; fi
    [ "$ok" = 1 ] || say "git didn't install: install it with your system's package manager, then run Harbor."
  fi
  if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
    say "Installing Claude Code (Anthropic's installer)…"
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || say "Claude Code didn't install; get it from https://claude.ai/install.sh"
  fi
  if ! command -v codex >/dev/null 2>&1 && [ ! -x "$BIN/codex" ]; then
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) target=aarch64-apple-darwin ;;
      Linux-x86_64|Linux-amd64) target=x86_64-unknown-linux-musl ;;
      Linux-aarch64|Linux-arm64) target=aarch64-unknown-linux-musl ;;
      *) target="" ;;
    esac
    if [ -n "$target" ]; then
      say "Installing Codex (OpenAI's release)…"
      api="https://api.github.com/repos/openai/codex/releases/latest"
      meta="$(curl -fsSL "$api" 2>/dev/null || true)"
      url="$(printf '%s' "$meta" | tr ',' '\n' | grep '"browser_download_url"' | grep "/codex-$target.tar.gz\"" | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')"
      want="$(printf '%s' "$meta" | tr '{' '\n' | grep "\"name\": *\"codex-$target.tar.gz\"" | head -1 | sed -n 's/.*"digest": *"sha256:\([0-9a-f]*\)".*/\1/p')"
      if [ -n "$url" ] && curl -fsSL --retry 3 -o "$TMP/codex.tgz" "$url"; then
        got="$(sha256_of "$TMP/codex.tgz")"
        if [ -n "$want" ] && [ "$got" != "$want" ]; then
          say "Codex's download doesn't match its checksum: left out."
        else
          mkdir -p "$TMP/codex" && tar -xzf "$TMP/codex.tgz" -C "$TMP/codex" \
            && mv -f "$TMP/codex/codex-$target" "$BIN/codex" && chmod 755 "$BIN/codex" || say "Codex didn't install."
        fi
      else
        say "Codex didn't download; install it later from https://github.com/openai/codex/releases"
      fi
    fi
  fi
}

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ "$(uname -s)" = Darwin ]; then
  [ "$(uname -m)" = arm64 ] || die "Harbor for macOS runs on Apple Silicon (M1 or newer)."
  major="$(sw_vers -productVersion | cut -d. -f1)"
  [ "${major:-0}" -ge 13 ] || die "Harbor needs macOS 13 (Ventura) or newer."
  APPDIR="$HOME/Applications"
  if [ "$VERSION" = latest ]; then BASE="https://github.com/$REPO/releases/latest/download"; else BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"; fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT INT TERM
  fetch() { if [ -n "$FROM" ]; then cp "$FROM/$1" "$TMP/$1" 2>/dev/null; else curl -fsSL --retry 3 -o "$TMP/$1" "$BASE/$1"; fi; }
  mac_minisign() {
    command -v minisign >/dev/null 2>&1 && { echo minisign; return 0; }
    curl -fsSL --retry 3 -o "$TMP/minisign.zip" "$MINISIGN_MAC_URL" 2>/dev/null || return 1
    [ "$(sha256_of "$TMP/minisign.zip")" = "$MINISIGN_MAC_SHA256" ] || die "the minisign download doesn't match its pinned checksum."
    mkdir -p "$TMP/minisign" && (cd "$TMP/minisign" && unzip -q ../minisign.zip) && chmod 755 "$TMP/minisign/minisign" && echo "$TMP/minisign/minisign"
  }
  CORE="harbor-aarch64-macos.tar.gz"
  fetch SHA256SUMS || die "could not reach the release ($BASE)."
  say "Downloading Harbor ($VERSION)…"
  fetch "$CORE" || die "could not download $CORE"
  want="$(grep "  $CORE\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$want" ] || die "$CORE is not listed in SHA256SUMS."
  [ "$(sha256_of "$TMP/$CORE")" = "$want" ] || die "$CORE: checksum mismatch."
  if ! fetch "$CORE.minisig"; then
    unchecked "could not download $CORE.minisig"
  elif ms="$(mac_minisign)"; then
    "$ms" -Vqm "$TMP/$CORE" -P "$PUBKEY" || die "$CORE: bad signature."
  else
    unchecked "$CORE: its signature can't be checked (minisign couldn't be downloaded)"
  fi
  mkdir -p "$TMP/core" "$APPDIR" "$BIN"
  tar -xzf "$TMP/$CORE" -C "$TMP/core"
  [ -x "$TMP/core/Harbor.app/Contents/MacOS/harbor" ] || die "no Harbor.app in $CORE."
  # Marks a per-user install the in-app updater may manage.
  echo "install.sh" > "$TMP/core/Harbor.app/Contents/MacOS/.managed"
  rm -rf "$APPDIR/.Harbor.app.old"
  [ -d "$APPDIR/Harbor.app" ] && mv "$APPDIR/Harbor.app" "$APPDIR/.Harbor.app.old"
  mv "$TMP/core/Harbor.app" "$APPDIR/Harbor.app"
  rm -rf "$APPDIR/.Harbor.app.old"
  ln -sfn "$APPDIR/Harbor.app/Contents/MacOS/harbor" "$BIN/harbor"
  install_deps
  say "Harbor $(cat "$APPDIR/Harbor.app/Contents/MacOS/VERSION") installed in $APPDIR/Harbor.app: open it from Launchpad or Spotlight, or type harbor."
  exit 0
fi

[ "$(uname -s)" = Linux ] || die "Harbor runs on Linux and macOS."
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "no build for $(uname -m) yet (x86_64 and aarch64 only)." ;;
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

# minisign for the signature checks: the system's, else the static one pinned above, checked
# against its SHA-256. Fails (returns 1) when neither is to be had.
MINISIGN=""
get_minisign() {
  [ -n "$MINISIGN" ] && return 0
  if command -v minisign >/dev/null 2>&1; then
    MINISIGN=minisign
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 1
  say "minisign isn't installed; fetching it to check the signatures…"
  curl -fsSL --retry 3 -o "$TMP/minisign.tgz" "$MINISIGN_URL" 2>/dev/null || return 1
  printf '%s  %s\n' "$MINISIGN_SHA256" "$TMP/minisign.tgz" | sha256sum -c --quiet - >/dev/null 2>&1 \
    || die "the minisign download doesn't match its pinned checksum."
  mkdir -p "$TMP/minisign"
  tar -xzf "$TMP/minisign.tgz" -C "$TMP/minisign" 2>/dev/null || return 1
  [ -x "$TMP/minisign/minisign-linux/$ARCH/minisign" ] || return 1
  MINISIGN="$TMP/minisign/minisign-linux/$ARCH/minisign"
}


# Checks a downloaded asset against SHA256SUMS and its minisign signature (Harbor's own updater
# checks signatures too).
verify() {
  line="$(grep "  $1\$" "$TMP/SHA256SUMS" || true)"
  [ -n "$line" ] || die "$1 is not listed in SHA256SUMS."
  (cd "$TMP" && printf '%s\n' "$line" | sha256sum -c --quiet -) || die "$1: checksum mismatch."
  # Like a folder without SHA256SUMS.minisig: refused unless HARBOR_INSECURE=1 (CI's unsigned builds).
  if ! fetch "$1.minisig"; then
    unchecked "could not download $1.minisig"
  elif get_minisign; then
    "$MINISIGN" -Vqm "$TMP/$1" -P "$PUBKEY" || die "$1: bad signature."
  else
    unchecked "$1: its signature can't be checked (no minisign, and it couldn't be downloaded: install minisign)"
  fi
}

# Checks a release folder against its own SHA256SUMS and that file's signature.
check_folder() { # dir name
  [ -f "$1/SHA256SUMS" ] || { unchecked "$2 has no SHA256SUMS to check its files against"; return 0; }
  (cd "$1" && sha256sum -c --quiet SHA256SUMS) || die "$2: files don't match its SHA256SUMS."
  if [ ! -f "$1/SHA256SUMS.minisig" ]; then
    unchecked "$2 has no signature (SHA256SUMS.minisig)"
  elif get_minisign; then
    "$MINISIGN" -Vqm "$1/SHA256SUMS" -P "$PUBKEY" || die "$2: bad signature on SHA256SUMS."
    say "$2: checksums and signature verified."
  else
    unchecked "$2: the signature can't be checked (no minisign, and it couldn't be downloaded: install minisign)"
  fi
}

if [ -n "$HERE" ]; then
  SRC="$HERE"
  say "Installing Harbor $(cat "$SRC/VERSION") from $SRC…"
  check_folder "$SRC" "harbor-$ARCH-linux"
fi

if [ -z "$HERE" ]; then
  [ -n "$FROM" ] || command -v curl >/dev/null 2>&1 || die "curl is required."
  fetch SHA256SUMS || die "could not reach the release ($BASE)."
  say "Downloading Harbor ($VERSION)…"
  CORE="harbor-$ARCH-linux.tar.gz"
  fetch "$CORE" || die "could not download $CORE"
  verify "$CORE"
  mkdir -p "$TMP/core"
  tar -xzf "$TMP/$CORE" -C "$TMP/core"
  SRC="$TMP/core/harbor-$ARCH-linux"
fi
[ -x "$SRC/harbor" ] || die "no harbor binary in $SRC."

# The phone app (Settings › Phones serves it to Harbor for Android), when the release has one.
APK=""
if [ -z "$HERE" ] && grep -q "  harbor-android.apk\$" "$TMP/SHA256SUMS" 2>/dev/null; then
  if fetch harbor-android.apk; then
    verify harbor-android.apk
    APK="$TMP/harbor-android.apk"
  fi
fi

# The video player: beside an extracted folder, or from the release. Harbor fetches it itself when
# it can't be had here, so nothing here is a failure.
VSRC=""
if [ -n "$HERE" ]; then
  side="$(dirname -- "$HERE")"
  if [ -f "$side/harbor-video-$ARCH-linux/libmpv-harbor.so" ]; then
    VSRC="$side/harbor-video-$ARCH-linux"
  elif [ -f "$side/harbor-video-$ARCH-linux.tar.gz" ]; then
    mkdir -p "$TMP/video"
    tar -xzf "$side/harbor-video-$ARCH-linux.tar.gz" -C "$TMP/video"
    VSRC="$TMP/video/harbor-video-$ARCH-linux"
  fi
  [ -z "$VSRC" ] || check_folder "$VSRC" "harbor-video-$ARCH-linux"
elif grep -q "  harbor-video-$ARCH-linux.tar.gz\$" "$TMP/SHA256SUMS" 2>/dev/null; then
  VR="harbor-video-$ARCH-linux.tar.gz"
  say "Downloading the video player…"
  if fetch "$VR"; then
    verify "$VR"
    mkdir -p "$TMP/video"
    tar -xzf "$TMP/$VR" -C "$TMP/video"
    VSRC="$TMP/video/harbor-video-$ARCH-linux"
  fi
fi

mkdir -p "$LIB" "$BIN" "$APPS" "$ICONS/scalable/apps" "$ICONS/256x256/apps"
STAGE="$LIB/.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -p "$SRC/harbor" "$STAGE/"
cp -p "$SRC/VERSION" "$STAGE/VERSION"
[ -f "$SRC/video.id" ] && cp -p "$SRC/video.id" "$STAGE/video.id"
cp -rp "$SRC/licenses" "$STAGE/licenses"
if [ -n "$APK" ]; then
  cp -p "$APK" "$STAGE/harbor-android.apk"
  # Its Android versionCode: 0.7.0 -> 7000 (the release workflow builds it so).
  sed 's/^v//; s/-.*//' "$SRC/VERSION" | awk -F. '{ print $1 * 1000000 + $2 * 1000 + ($3 + 0) }' > "$STAGE/harbor-android.version"
fi
if [ -n "$VSRC" ]; then
  cp -p "$VSRC/libmpv-harbor.so" "$STAGE/"
  cp -p "$VSRC/video.id" "$STAGE/video.installed"
  rm -rf "$LIB/video-licenses"
  cp -rp "$VSRC/licenses" "$LIB/video-licenses"
fi
# Helpers first, harbor last: a running Harbor sees its file change and reloads into the new
# version (rename is atomic; running processes keep the old file).
# (harbor-stream, the screen viewer, is gone since 0.18)
rm -f "$LIB/harbor-stream"
for f in libmpv-harbor.so harbor-android.apk harbor-android.version VERSION video.id video.installed; do
  [ -e "$STAGE/$f" ] && mv -f "$STAGE/$f" "$LIB/$f"
done
# What the built-in browser left (removed after 0.176): its Servo engine, its id and the --no-browser mark.
rm -rf "$LIB/harbor-browser" "$LIB/browser.id" "$LIB/browser.installed" "$LIB/.no-browser" "$LIB/.staging-browser" "$LIB/.previous/harbor-browser"
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

install_deps
# Optional programs (the README lists what each one is for).
missing=""
command -v zenity >/dev/null 2>&1 || command -v kdialog >/dev/null 2>&1 || missing="$missing zenity"
for c in git xdg-open notify-send; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
[ -z "$missing" ] || say "Optional, not installed:$missing (see the README's list of what Harbor uses)."
