#!/bin/bash
# Run by scripts/boat/windows on a boat.dev sandbox, from the copied working tree (~/src): the Windows
# test VM, Windows 11 Enterprise (evaluation licence) under QEMU/KVM, driven over SSH and QMP.
#
#   windows.sh make        installs Windows from Microsoft's evaluation ISO, unattended
#                          (windows/autounattend.xml, windows/harbor-setup.ps1), into
#                          ~/cache/windows/base.qcow2: what scripts/boat/windows --save-snapshot keeps
#   windows.sh up          boots the VM on a throwaway layer over base.qcow2 and waits for SSH and the
#                          logged-on desktop
#   windows.sh ps SCRIPT   runs PowerShell in the VM (over SSH, as the administrator "harbor"); its
#                          exit code is the script's ($LASTEXITCODE or 1 on an error)
#   windows.sh gui CMDLINE starts a cmd.exe line in the logged-on desktop (only there do windows show);
#                          its output goes to C:\rig\gui.log
#   windows.sh put SRC DST / get SRC DST   copies between this sandbox and the VM (scp; DST in the VM
#                          like C:/rig/x.exe)
#   windows.sh shot OUT.png | key K… | type TEXT | click X Y [btn] [n] | move X Y | scroll X Y N
#                          the VM's screen and input (qmp.py)
#   windows.sh build       cross-builds Harbor for Windows x64 from ~/src (ts/scripts/build.ts --target
#                          windows-x64, the addons from bun install --os win32 --cpu x64) to ~/out/harbor.exe,
#                          in the release's build image with the pinned Bun, as check.sh builds Linux's
#   windows.sh down        shuts Windows down (powers off after 60 s)
#   windows.sh status      whether the VM runs
#
# Everything runs in the harbor-windows image (Dockerfile.windows) as a folder (lib.sh's run_in), with
# ~/cache at /c. The VM: 6 CPUs, 10 GB, SATA disk and e1000e network (drivers Windows has), the std VGA
# at 1920x1080, a USB tablet; its SSH is 127.0.0.1:2222 here and the sandbox is 10.0.2.2 from inside.
. "$(dirname "$0")/lib.sh"
w=/c/windows            # as run_in sees it
wh=$cache/windows       # as this shell sees it
mkdir -p "$wh/run" "$HOME/out/shots"
rootfs_save harbor-windows .github/boat/Dockerfile.windows
img=$(image harbor-windows .github/boat/Dockerfile.windows)
vm() { run_in "$img" -- "$@"; }
KEY_OPTS=(-i "$w/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH_OPTS=("${KEY_OPTS[@]}" -p 2222) SCP_OPTS=("${KEY_OPTS[@]}" -P 2222)

# The ISO and the installers, checked: the ISO by its size (Microsoft publishes no hash for it), the
# others by sha256.
# Windows 11 Enterprise 26H2, evaluation (90 days from the install). An evaluation build also stops at a
# date of its own (the 2024 LTSC one said "Windows License is expired" right after installing in 2026):
# when it does, take the newest from https://www.microsoft.com/evalcenter (Windows 11 Enterprise, ISO, en-US).
ISO_URL=https://software-static.download.prss.microsoft.com/dbazure/26300.9457.260913-1737.26h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso
ISO_SIZE=8225329152
SSH_MSI=https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64-v10.0.0.0.msi
SSH_SHA=ddec9c53864280759cf9f74791cefd387100e3946aa849a1c138a4ed1b96b7d9
GIT_EXE=https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe
GIT_SHA=c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559
# The Visual C++ runtime, for runs from source (bun install's Slint addon links it; Harbor's builds carry
# their own copy, ts/scripts/vcruntime.ts, pinned to the same file).
VC_EXE=https://download.visualstudio.microsoft.com/download/pr/e9604e21-4b79-4096-a4b3-1b63d4b55b4d/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe
VC_SHA=cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b

qemu_up() {  # qemu_up <disk> [extra qemu args…]: daemonized, QMP at run/qmp.sock
  local disk=$1; shift
  rm -f "$wh/run/qmp.sock" "$wh/run/qemu.pid"
  vm qemu-system-x86_64 -name harbor-win -enable-kvm -machine q35 \
    -cpu host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time -smp 6 -m 10240 \
    -device ahci,id=ahci -drive "file=$disk,if=none,id=d0,discard=unmap,detect-zeroes=unmap,cache=unsafe" \
    -device ide-hd,drive=d0,bus=ahci.0 \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22${FWD:-}" -device e1000e,netdev=n0 \
    -vga std -global VGA.vgamem_mb=32 -device qemu-xhci -device usb-tablet \
    -rtc base=utc,clock=host -display none -serial none \
    -qmp "unix:$w/run/qmp.sock,server=on,wait=off" -pidfile "$w/run/qemu.pid" -daemonize "$@"
}
running() { [ -f "$wh/run/qemu.pid" ] && kill -0 "$(cat "$wh/run/qemu.pid")" 2>/dev/null; }
# Bounded: a screendump can hang while the guest switches modes, and the install's watch loop must go on.
qmp() { vm timeout 60 python3 /src/.github/boat/windows/qmp.py "$w/run/qmp.sock" "$@"; }
# ps <script>: PowerShell in the VM, sent as -EncodedCommand (UTF-16LE base64): no quoting to get wrong.
ps_run() {
  local enc
  # Everything (errors too) as plain text on stdout: over SSH, PowerShell's stderr comes as CLIXML.
  enc=$(printf '%s\n%s\n%s' '$ProgressPreference="SilentlyContinue"; $ErrorActionPreference="Continue"; $global:c = 0; & { try {' "$1" \
    '; $global:c = $LASTEXITCODE } catch { $_ | Out-String; $global:c = 1 } } *>&1 | Out-String -Stream -Width 250; exit $global:c' | iconv -t UTF-16LE | base64 -w0)
  vm ssh "${SSH_OPTS[@]}" harbor@127.0.0.1 "powershell -NoProfile -NonInteractive -EncodedCommand $enc"
}
wait_ssh() {  # wait_ssh <seconds>
  local until=$((SECONDS + $1))
  while [ $SECONDS -lt $until ]; do
    running || { echo "the VM stopped"; return 1; }
    vm ssh "${SSH_OPTS[@]}" -o ConnectTimeout=5 harbor@127.0.0.1 'echo ok' >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}
fetch() {  # fetch <url> <file> <sha256|size:N>
  [ -f "$2" ] && check "$2" "$3" && return 0
  vm curl -fsSL --retry 3 -o "${2/#$cache//c}.part" "$1"
  mv "$2.part" "$2"
  check "$2" "$3" || { echo "$2: wrong file (wanted $3)"; rm -f "$2"; return 1; }
}
check() {
  case "$2" in
    size:*) [ "$(stat -c %s "$1")" = "${2#size:}" ] ;;
    *) echo "$2  $1" | sha256sum -c --quiet - ;;
  esac
}

make_base() {
  local s=$SECONDS dl="$wh/dl" cfg="$wh/cfg" v
  mkdir -p "$dl" "$cfg"
  echo "==> downloads"
  fetch "$ISO_URL" "$dl/win.iso" "size:$ISO_SIZE"
  fetch "$SSH_MSI" "$dl/${SSH_MSI##*/}" "$SSH_SHA"
  fetch "$GIT_EXE" "$dl/${GIT_EXE##*/}" "$GIT_SHA"
  fetch "$VC_EXE" "$dl/VC_redist.x64.exe" "$VC_SHA"
  v=$(bun_version)
  vm bash -euo pipefail -c "cd $w/dl && curl -fsSL --retry 3 -o bun-windows-x64.zip https://github.com/oven-sh/bun/releases/download/bun-v$v/bun-windows-x64.zip &&
    curl -fsSL --retry 3 https://github.com/oven-sh/bun/releases/download/bun-v$v/SHASUMS256.txt | grep ' bun-windows-x64.zip\$' | sha256sum -c -"
  # The Visual C++ runtime's three DLLs, out of Microsoft's redistributable (ts/scripts/vcruntime.ts, in the build
  # image's Bun): beside bun.exe they serve runs from source. Its installer, run as SYSTEM in the first boot's
  # SetupComplete, never came back (the install passed 90 minutes).
  local core b
  core=$(image harbor-builder .github/boat/Dockerfile)
  b=$(bun_get "$core" x64)
  rm -rf "$dl/vc"
  run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -- \
    bun /src/ts/scripts/vcruntime.ts "$w/dl/VC_redist.x64.exe" "$w/dl/vc"
  ls "$dl/vc"/msvcp140.dll "$dl/vc"/vcruntime140.dll "$dl/vc"/vcruntime140_1.dll >/dev/null
  echo "<== downloads $((SECONDS - s))s"
  [ -f "$wh/id_ed25519" ] || vm ssh-keygen -q -t ed25519 -N '' -C harbor-test-vm -f "$w/id_ed25519"
  rm -rf "$cfg" && mkdir -p "$cfg"
  cp .github/boat/windows/autounattend.xml .github/boat/windows/harbor-setup.ps1 .github/boat/windows/SetupComplete.cmd .github/boat/windows/screen.ps1 "$cfg/"
  cp "$wh/id_ed25519.pub" "$cfg/authorized_keys"
  cp "$dl/${SSH_MSI##*/}" "$dl/${GIT_EXE##*/}" "$dl/vc/"*.dll "$dl/bun-windows-x64.zip" "$cfg/"
  vm xorriso -as mkisofs -quiet -J -joliet-long -R -V HARBORCFG -o "$w/cfg.iso" "$w/cfg"
  rm -f "$wh/disk.qcow2"
  vm qemu-img create -q -f qcow2 "$w/disk.qcow2" 64G
  echo "==> install (unattended, then harbor-setup.ps1, the first logon, then it powers off)"
  s=$SECONDS
  qemu_up "$w/disk.qcow2" -drive "file=$w/dl/win.iso,media=cdrom,readonly=on" \
    -drive "file=$w/cfg.iso,media=cdrom,readonly=on" -boot once=d
  local n=0
  while running; do
    sleep 20; n=$((n + 1))
    # A screen a minute, to see where a stuck install stands (scripts/boat/windows brings them back).
    [ $((n % 3)) != 0 ] || qmp shot "/out/shots/install-$(printf %03d $((SECONDS - s)))s.png" 2>/dev/null || true
    [ $((SECONDS - s)) -lt 5400 ] || { echo "the install took over 90 minutes: stopping it"; qmp quit || true; return 1; }
  done
  echo "<== install $((SECONDS - s))s"
  echo "==> check: boots, SSH answers, setup finished"
  s=$SECONDS
  rm -f "$wh/check.qcow2"
  vm qemu-img create -q -f qcow2 -b "$w/disk.qcow2" -F qcow2 "$w/check.qcow2"
  qemu_up "$w/check.qcow2"
  wait_ssh 600 || { echo "no SSH after 10 minutes"; qmp shot /out/shots/check-nossh.png || true; return 1; }
  ps_run '$log = "C:\Windows\Setup\Scripts\harbor-setup.log"; Get-Content $log; if (-not (Test-Path C:\rig\setup-done)) { exit 1 }; (Get-CimInstance Win32_OperatingSystem).Caption; [Environment]::OSVersion.VersionString; git --version; & C:\Tools\bun\bun.exe --version; cscript //nologo C:\Windows\System32\slmgr.vbs /xpr'
  sleep 20; qmp shot /out/shots/check-desktop.png || true
  down
  rm -f "$wh/check.qcow2"
  echo "<== check $((SECONDS - s))s"
  echo "==> compress"
  s=$SECONDS
  vm qemu-img convert -c -O qcow2 -o compression_type=zstd "$w/disk.qcow2" "$w/base.qcow2.new"
  mv "$wh/base.qcow2.new" "$wh/base.qcow2"
  rm -rf "$wh/disk.qcow2" "$wh/cfg" "$wh/cfg.iso" "$dl"
  echo "base: $(du -h "$wh/base.qcow2" | cut -f1) on disk"
  echo "<== compress $((SECONDS - s))s"
}

up() {
  [ -f "$wh/base.qcow2" ] || { echo "no ~/cache/windows/base.qcow2 on this sandbox: scripts/boat/windows --save-snapshot makes one"; return 1; }
  if running; then echo "the VM runs already"; return 0; fi
  local s=$SECONDS
  rm -f "$wh/run/layer.qcow2"
  vm qemu-img create -q -f qcow2 -b "$w/base.qcow2" -F qcow2 "$w/run/layer.qcow2"
  qemu_up "$w/run/layer.qcow2"
  wait_ssh 900 || { echo "no SSH after 15 minutes"; qmp shot /out/shots/up-nossh.png || true; return 1; }
  echo "ssh after $((SECONDS - s))s"
  # The desktop: explorer runs in the logged-on session.
  local until=$((SECONDS + 300))
  until ps_run 'if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { exit 1 }' >/dev/null 2>&1; do
    [ $SECONDS -lt $until ] || { echo "no desktop after 5 minutes"; return 1; }
    sleep 3
  done
  echo "desktop after $((SECONDS - s))s"
}

down() {
  running || return 0
  ps_run 'Stop-Computer -Force' >/dev/null 2>&1 || qmp powerdown >/dev/null 2>&1 || true
  local i
  for i in $(seq 60); do running || return 0; sleep 1; done
  qmp quit >/dev/null 2>&1 || kill "$(cat "$wh/run/qemu.pid")" 2>/dev/null || true
}

gui() {
  # The line runs as cmd.exe would run it, in the desktop session, in its own C:\rig\gui-N.cmd with its output in
  # C:\rig\gui-N.log (printed). The task only starts it and ends: a run still going (Harbor) keeps neither the
  # task nor a log busy for the next one. An older snapshot's task wrote gui.log itself, which the first run
  # then held open: its action is made the plain one here.
  local f n; f=$(mktemp -p "$wh/run" gui.XXXX); n=gui-$(date +%H%M%S)-${f##*.}
  printf '@echo off\r\ncd /d C:\\rig\r\n%s\r\n' "$1" > "$f"
  vm scp -q "${SCP_OPTS[@]}" "${f/#$cache//c}" "harbor@127.0.0.1:C:/rig/$n.cmd"
  printf '@echo off\r\nstart "" /min cmd /c "C:\\rig\\%s.cmd > C:\\rig\\%s.log 2>&1"\r\n' "$n" "$n" > "$f"
  vm scp -q "${SCP_OPTS[@]}" "${f/#$cache//c}" harbor@127.0.0.1:C:/rig/gui.cmd
  rm -f "$f"
  ps_run '$t = Get-ScheduledTask harbor-gui; if ($t.Actions[0].Arguments -ne "/c C:\rig\gui.cmd") { Set-ScheduledTask -TaskName harbor-gui -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument "/c C:\rig\gui.cmd" -WorkingDirectory C:\rig) | Out-Null }; Start-ScheduledTask -TaskName harbor-gui'
  echo "C:\\rig\\$n.log"
}

build_exe() {
  local core b v
  core=$(image harbor-builder .github/boat/Dockerfile)
  b=$(bun_get "$core" x64)
  v=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' ts/package.json | head -1)
  # The release's own Windows build (its icon and name stamped in), from a copy of the tree: Linux's
  # node_modules stay.
  run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BUN_INSTALL_CACHE_DIR=/c/bun-cache -e V="$v-win" -- \
    bash -euo pipefail -c 'export HOME=/tmp/home && mkdir -p $HOME && rm -rf /out/win && bash .github/windows-build.sh . /out/win >/dev/null &&
      cp /out/win/harbor-windows/harbor.exe /out/harbor.exe && ls -l /out/harbor.exe'
}

cmd=${1:-}; [ $# = 0 ] || shift
case "$cmd" in
  build) build_exe ;;
  make) make_base ;;
  up) up ;;
  down) down ;;
  status) running && echo running || echo stopped ;;
  ps) ps_run "$1" ;;
  gui) gui "$1" ;;
  # Paths here as the image sees them: /out is ~/out, /src ~/src, /c ~/cache.
  put) vm scp -q -r "${SCP_OPTS[@]}" "$1" "harbor@127.0.0.1:$2" ;;
  get) vm scp -q -r "${SCP_OPTS[@]}" "harbor@127.0.0.1:$1" "$2" ;;
  shot) qmp shot "$1" ;;
  # Before the sandbox is saved: the VM off, its layer and the mounts gone.
  prep) down; rm -rf "$wh/run"; rootfs_down; sudo fstrim -av 2>/dev/null || true ;;
  key|type|click|move|scroll) qmp "$cmd" "$@" ;;
  *) echo "windows.sh: unknown command $cmd" >&2; exit 2 ;;
esac
