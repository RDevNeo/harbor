#!/bin/sh
# Smoke test of packaging/install.sh on a clean distro image (see .github/workflows/smoke.yml).
# Runs as root inside the container, with the release files in /dist and the repo in /src:
# installs as an ordinary user (no sudo), checks the files and the libraries, starts Harbor
# under Xvfb (Mesa llvmpipe) for a few seconds, then uninstalls.
set -eu

fail() { echo "::error::$*"; exit 1; }
step() { echo "::group::$*"; }
end() { echo "::endgroup::"; }

step "Packages"
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # libgl1-mesa-dri: llvmpipe. The X11 libraries are the ones winit and glutin load at runtime.
    apt-get install -y -qq --no-install-recommends ca-certificates curl xvfb xauth \
      libgl1 libegl1 libgl1-mesa-dri libxkbcommon-x11-0 libxcursor1 libxrandr2 libxi6 libx11-xcb1 >/dev/null ;;
  fedora)
    dnf install -y -q curl xorg-x11-server-Xvfb mesa-dri-drivers mesa-libEGL mesa-libGL \
      libxkbcommon-x11 libXcursor libXrandr libXi util-linux shadow-utils findutils >/dev/null ;;
  arch)
    pacman -Syu --noconfirm --needed curl xorg-server-xvfb mesa libglvnd libxkbcommon-x11 \
      libxcursor libxrandr libxi >/dev/null ;;
  *) fail "unknown distro $ID" ;;
esac
end

useradd -m tester
H=/home/tester
# Runs a command as the test user, with a clean environment.
as() { su tester -s /bin/sh -c "cd && $*"; }

step "Install (as an ordinary user)"
insecure=1
[ -f /dist/SHA256SUMS.minisig ] && insecure=0
as "HARBOR_FROM=/dist HARBOR_INSECURE=$insecure sh /src/packaging/install.sh" || fail "install.sh failed"
end

step "Files"
for f in .local/lib/harbor/harbor .local/lib/harbor/VERSION .local/lib/harbor/.managed \
         .local/share/applications/harbor.desktop \
         .local/share/icons/hicolor/scalable/apps/harbor.svg .local/share/icons/hicolor/256x256/apps/harbor.png; do
  [ -f "$H/$f" ] || fail "missing ~/$f"
done
[ "$(readlink "$H/.local/bin/harbor")" = "$H/.local/lib/harbor/harbor" ] || fail "~/.local/bin/harbor is not a link to the install"
grep -q "^Exec=$H/.local/bin/harbor" "$H/.local/share/applications/harbor.desktop" || fail "the desktop entry doesn't run the installed harbor"
[ -z "$(find "$H" -user root)" ] || fail "files owned by root in the home folder"
ls -la "$H/.local/lib/harbor"
end

step "Libraries"
ldd "$H/.local/lib/harbor/harbor"
! ldd "$H/.local/lib/harbor/harbor" | grep -q "not found" || fail "harbor needs a library this distro doesn't have"
as ".local/bin/harbor --version" || fail "harbor --version failed"
end

step "Start under Xvfb"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2
set +e
as "mkdir -p -m 700 /tmp/xdg-tester && DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg-tester LIBGL_ALWAYS_SOFTWARE=1 timeout 10 .local/bin/harbor" >/tmp/harbor.log 2>&1
code=$?
set -e
cat /tmp/harbor.log
# 124: still running when timeout stopped it.
[ "$code" = 124 ] || fail "harbor exited with $code within 10 s"
end

step "Uninstall"
as "sh /src/packaging/install.sh --uninstall" || fail "--uninstall failed"
for f in .local/lib/harbor .local/bin/harbor .local/share/applications/harbor.desktop \
         .local/share/icons/hicolor/scalable/apps/harbor.svg .local/share/icons/hicolor/256x256/apps/harbor.png; do
  [ ! -e "$H/$f" ] && [ ! -L "$H/$f" ] || fail "--uninstall left ~/$f"
done
[ -d "$H/.local/share/harbor" ] || fail "--uninstall removed the data folder"
end
echo "OK: $PRETTY_NAME ($(uname -m))"
