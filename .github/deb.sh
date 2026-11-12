#!/bin/bash
# Harbor's .deb, from an assembled release folder: called by release.yml's package job (Pack), after
# the folder's SHA256SUMS is signed. Plain file copies and dpkg-deb: nothing is built here.
#
#   deb.sh PKG ARCH VERSION OUT
#
# PKG is pkg/harbor-<x86_64|aarch64>-linux (what harbor-<arch>-linux.tar.gz holds), OUT the .deb to write.
# Layout: that folder as is in /usr/lib/harbor (install.sh checks it against its SHA256SUMS), the launcher
# packaging/deb/harbor as /usr/bin/harbor (each user runs a copy of their own in ~/.local/lib/harbor, which
# Harbor updates itself: root's files can't be), the menu entry and the icons. No maintainer scripts: dpkg's
# triggers refresh the menus and icon caches, and nothing runs as root.
set -euo pipefail
pkg=$(realpath "$1") arch=$2 ver=$3 out=$(realpath -m "$4")
root=$(cd "$(dirname "$0")/.." && pwd)
case "$arch" in
  x86_64) darch=amd64 ;;
  aarch64) darch=arm64 ;;
  *) echo "deb.sh: no Debian architecture for $arch" >&2; exit 2 ;;
esac
# Debian's version: 0.180.22 as is, a pre-release 0.181.0-rc.1 as 0.181.0~rc.1 (sorts before 0.181.0).
dver=${ver/-/\~}
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
mkdir -p "$d/DEBIAN" "$d/usr/lib" "$d/usr/bin" "$d/usr/share/applications" \
  "$d/usr/share/icons/hicolor/scalable/apps" "$d/usr/share/icons/hicolor/256x256/apps" "$d/usr/share/doc/harbor"
cp -a "$pkg" "$d/usr/lib/harbor"
chmod 755 "$d/usr/lib/harbor/harbor" "$d/usr/lib/harbor/install.sh"
install -m755 "$root/packaging/deb/harbor" "$d/usr/bin/harbor"
install -m644 "$pkg/harbor.desktop" "$d/usr/share/applications/harbor.desktop"
install -m644 "$pkg/harbor.svg" "$d/usr/share/icons/hicolor/scalable/apps/harbor.svg"
install -m644 "$pkg/harbor-256.png" "$d/usr/share/icons/hicolor/256x256/apps/harbor.png"
cat > "$d/usr/share/doc/harbor/copyright" <<'EOF'
Harbor: https://github.com/RDevNeo/harbor
Harbor is MIT licensed. The licences of what it includes are in /usr/lib/harbor/licenses.
EOF
size=$(du -sk --exclude=DEBIAN "$d" | cut -f1)
# Depends: what Slint's window and the agents need (the libraries smoke-install.sh installs on a bare image).
# ripgrep is recommended (Ubuntu has it in universe): install.sh --deps fetches it when it's missing.
cat > "$d/DEBIAN/control" <<EOF
Package: harbor
Version: $dver
Architecture: $darch
Maintainer: Harbor <227877315+RDevNeo@users.noreply.github.com>
Installed-Size: $size
Depends: git, curl, ca-certificates, libgl1, libegl1, libgbm1, libinput10, libfontconfig1, libxkbcommon0, libxkbcommon-x11-0, libx11-xcb1, libxcursor1, libxrandr2, libxi6
Recommends: ripgrep, libgl1-mesa-dri, xdg-utils, libnotify-bin, zenity
Section: devel
Priority: optional
Homepage: https://github.com/RDevNeo/harbor
Description: Chat with coding agents, organised by project
 Harbor runs Claude Code and Codex agents for your projects, on this PC and
 the others you pair, with a phone app to follow them.
 .
 Each user runs a copy of Harbor in ~/.local/lib/harbor that updates itself;
 the first start installs Claude Code, Codex and ripgrep there when missing.
EOF
mkdir -p "$(dirname "$out")"
dpkg-deb --root-owner-group -Zgzip -z9 --build "$d" "$out"
dpkg-deb --info "$out" | sed -n '/Package:/,$p'
