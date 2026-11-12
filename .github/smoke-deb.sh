#!/bin/sh
# Smoke test of Harbor's .deb (.github/deb.sh) on a clean Debian or Ubuntu image (see .github/boat/smoke.sh).
# Runs as root inside the container, with the release files in /dist and the repo in /src: apt installs the
# package with its dependencies, an ordinary user starts /usr/bin/harbor (which copies Harbor to their
# ~/.local/lib/harbor, where it updates itself) and the window comes up under Xvfb; then apt removes it.
set -eu

fail() { echo "::error::$*"; exit 1; }
step() { echo "::group::$*"; }
end() { echo "::endgroup::"; }

case "$(uname -m)" in x86_64) ARCH=x86_64 ;; *) ARCH=aarch64 ;; esac
DEB=/dist/harbor-$ARCH-linux.deb

step "Install the package (apt, with its dependencies)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Only what the test itself needs (a screen, and software GL for it): the rest is the package's to bring.
apt-get install -y -qq --no-install-recommends xvfb xauth >/dev/null \
  || { dpkg --configure -a; apt-get install -y -qq --no-install-recommends xvfb xauth >/dev/null; }
cp "$DEB" /tmp/harbor.deb
apt-get install -y -qq /tmp/harbor.deb >/tmp/apt.log 2>&1 || { cat /tmp/apt.log; fail "apt couldn't install the package"; }
dpkg -s harbor | sed -n '/^Version/p;/^Status/p'
end

step "Files"
for f in /usr/bin/harbor /usr/lib/harbor/harbor /usr/lib/harbor/install.sh /usr/lib/harbor/VERSION \
         /usr/share/applications/harbor.desktop /usr/share/icons/hicolor/scalable/apps/harbor.svg \
         /usr/share/icons/hicolor/256x256/apps/harbor.png; do
  [ -f "$f" ] || fail "missing $f"
done
[ -z "$(find /usr/lib/harbor ! -user root)" ] || fail "package files not owned by root"
grep -q '^Exec=harbor$' /usr/share/applications/harbor.desktop || fail "the menu entry doesn't run harbor"
command -v git >/dev/null || fail "git didn't come with the package"
command -v rg >/dev/null || echo "::warning::ripgrep (recommended) isn't installed"
! ldd /usr/lib/harbor/harbor | grep -q "not found" || { ldd /usr/lib/harbor/harbor; fail "harbor needs a library the package doesn't depend on"; }
end

useradd -m tester
H=/home/tester
as() { su tester -s /bin/sh -c "cd && $*"; }

step "First start copies Harbor to the user"
as "HARBOR_NO_DEPS=1 harbor --version" || { cat $H/.local/state/harbor/package.log 2>/dev/null; fail "harbor --version failed"; }
for f in .local/lib/harbor/harbor .local/lib/harbor/VERSION .local/lib/harbor/.managed; do
  [ -f "$H/$f" ] || fail "missing ~/$f"
done
[ "$(cat $H/.local/lib/harbor/VERSION)" = "$(cat /usr/lib/harbor/VERSION)" ] || fail "the user's copy isn't the package's version"
[ "$(cat $H/.local/lib/harbor/.managed)" = deb ] || fail "the user's copy isn't marked as the package's"
# The package's menu entry, icons and command are the only ones.
[ ! -e $H/.local/share/applications/harbor.desktop ] || fail "a second menu entry in the home folder"
[ ! -e $H/.local/bin/harbor ] && [ ! -L $H/.local/bin/harbor ] || fail "a second harbor command in the home folder"
[ -z "$(find "$H" -user root)" ] || fail "files owned by root in the home folder"
# Its updater manages that copy: --update finds the release, or says it's up to date; never "doesn't update itself".
as "harbor --update" >/tmp/update.log 2>&1 || true
cat /tmp/update.log
! grep -q "doesn't update itself" /tmp/update.log || fail "the user's copy doesn't update itself"
end

step "Start under Xvfb"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2
set +e
as "mkdir -p -m 700 /tmp/xdg-tester && HARBOR_NO_DEPS=1 DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg-tester LIBGL_ALWAYS_SOFTWARE=1 timeout 10 harbor" >/tmp/harbor.log 2>&1
code=$?
set -e
cat /tmp/harbor.log
[ "$code" = 124 ] || fail "harbor exited with $code within 10 s"
end

# What Harbor started may outlive it: stopped by /proc (no pkill on bare images).
uid=$(id -u tester)
left() { for p in /proc/[0-9]*; do [ "$(stat -c %u "$p" 2>/dev/null)" = "$uid" ] && echo "${p#/proc/}"; done; true; }
for p in $(left); do kill "$p" 2>/dev/null || true; done
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -n "$(left)" ] || break; sleep 0.5; done
for p in $(left); do kill -9 "$p" 2>/dev/null || true; done

step "A newer package replaces an older copy"
echo 0.0.1 > $H/.local/lib/harbor/VERSION
as "HARBOR_NO_DEPS=1 harbor --version" >/dev/null || fail "harbor --version failed after the copy was older"
[ "$(cat $H/.local/lib/harbor/VERSION)" = "$(cat /usr/lib/harbor/VERSION)" ] || fail "an older copy wasn't replaced"
end

step "Remove"
apt-get remove -y -qq harbor >/dev/null || fail "apt couldn't remove the package"
for f in /usr/bin/harbor /usr/lib/harbor /usr/share/applications/harbor.desktop /usr/share/icons/hicolor/scalable/apps/harbor.svg; do
  [ ! -e "$f" ] || fail "removing left $f"
done
end
. /etc/os-release
echo "OK: .deb on $PRETTY_NAME ($(uname -m))"
