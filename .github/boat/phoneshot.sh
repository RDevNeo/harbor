#!/bin/bash
# Run by scripts/boat/phoneshot on a boat.dev sandbox, from the copied working tree: screenshots of
# the phone app. Builds a test APK (android/build.sh with HARBOR_RIG_PORT: signed in to nobody, it
# knows one PC on loopback, Rig.java) and boots an Android emulator (KVM, headless, SwiftShader),
# both while a hub with made-up data starts (ts/rig/phonehub.ts); then plays the steps given and
# leaves the PNGs in ~/out/shots, packed as ~/out/shots.tgz.
#
# Steps, one argument each: screen:<chats|chat|chat:lead|chat:<gid>|settings|new|palette|home>,
# tap:<x>,<y>, swipe:<x1>,<y1>,<x2>,<y2>, text:<words>, key:<BACK|ENTER|…>, wait:<seconds>,
# shot:<name>. A screen ends with a shot of its own. Env: DARK=1 the system's dark theme; IMAGE (an
# sdkmanager system image) and GPU (the emulator's -gpu) replace the defaults.
. "$(dirname "$0")/lib.sh"
s0=$SECONDS
phase() { echo "<== $1 $((SECONDS - ${2:-$s0}))s"; }
port=47931 token=rig-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
sdk=$cache/android/sdk adb=$cache/android/sdk/platform-tools/adb
sysimg=${IMAGE:-system-images;android-34;default;x86_64} gpu=${GPU:-swiftshader_indirect}
shots=$HOME/out/shots logs=$HOME/out/logs
mkdir -p "$shots" "$logs"
# What there is, also after a failure: the shots so far and the logs.
trap 'tar -czf "$HOME/out/shots.tgz" -C "$HOME/out" shots logs 2>/dev/null' EXIT
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "no usable /dev/kvm on this sandbox: the emulator needs it"; exit 1; }

andr=$(image harbor-android .github/boat/Dockerfile.android)
core=$(image harbor-builder .github/boat/Dockerfile)

# The SDK, the emulator and its system image (once per snapshot; minutes when missing).
s=$SECONDS
echo "==> sdk"
android_sdk "$andr" emulator platform-tools "$sysimg"
echo "sdk: $(du -sh "$sdk" | cut -f1) (system image $(du -sh "$sdk/${sysimg//;//}" | cut -f1))"
phase sdk $s

# The device: a Pixel-sized phone (1080x2400, 420 dpi), written here rather than by avdmanager.
avd=$cache/avd
mkdir -p "$avd/rig.avd"
printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-34\n' "$avd/rig.avd" > "$avd/rig.ini"
cat > "$avd/rig.avd/config.ini" <<EOF
AvdId=rig
avd.ini.displayname=rig
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=4
hw.ramSize=4096
vm.heapSize=512
disk.dataPartition.size=4G
image.sysdir.1=${sysimg//;//}/
tag.id=$(cut -d";" -f3 <<< "$sysimg")
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
hw.keyboard=yes
hw.mainKeys=no
hw.gpu.enabled=yes
hw.gpu.mode=$gpu
hw.audioInput=no
hw.audioOutput=no
hw.camera.back=none
hw.camera.front=none
showDeviceFrame=no
EOF
s=$SECONDS
echo "==> emulator (booting in the background)"
ANDROID_SDK_ROOT=$sdk ANDROID_HOME=$sdk ANDROID_AVD_HOME=$avd ANDROID_EMULATOR_HOME=$cache/android \
  setsid "$sdk/emulator/emulator" -avd rig -no-window -gpu "$gpu" -no-audio -no-boot-anim \
  -no-snapshot-save -no-metrics -accel on -netdelay none -netspeed full > "$logs/emulator.log" 2>&1 < /dev/null &
emu=$! boot0=$s

# The hub, from source: Bun as the release pins it, the made-up data, the phone API on loopback.
s=$SECONDS
echo "==> hub"
b=$(bun_get "$core" x64)
run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BUN_INSTALL_CACHE_DIR=/c/bun-cache -- \
  bash -euo pipefail -c 'cd ts && bun install --frozen-lockfile >/dev/null'
rm -rf /tmp/phonehub
run_in "$core" -e PATH="$b:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -- \
  bash -c "cd ts && exec bun rig/phonehub.ts /tmp/phonehub $port $token" > "$logs/hub.log" 2>&1 &
for _ in $(seq 120); do grep -q '^phonehub ready' "$logs/hub.log" && break; sleep 0.5; done
grep -q '^phonehub ready' "$logs/hub.log" || { echo "the hub didn't start:"; tail -40 "$logs/hub.log"; exit 1; }
gids=$(grep '^{' "$logs/hub.log" | head -1)
phase hub $s

# The test APK, for the emulator's ABI, signed with a throwaway key.
s=$SECONDS
echo "==> apk"
run_in "$andr" -- bash -euo pipefail -c '[ -f /c/android/rig.jks ] || keytool -genkeypair -keystore /c/android/rig.jks -storepass rig-only -keypass rig-only \
  -alias harbor -keyalg RSA -keysize 2048 -validity 10000 -dname CN=rig >/dev/null 2>&1'
run_in "$andr" -e ANDROID_BUILD=/c/android -e HARBOR_ANDROID_DEPS=/c/android/deps -e ANDROID_ABIS=x86_64 \
  -e ANDROID_KEYSTORE=/c/android/rig.jks -e ANDROID_KEYSTORE_PASS=rig-only -e HARBOR_RIG_PORT="$port" -e HARBOR_RIG_TOKEN="$token" \
  -e OUT=/out/harbor-rig.apk -- bash -euo pipefail -c 'ANDROID_HOME=/c/android/sdk android/build.sh' > "$logs/apk.log" 2>&1 ||
  { tail -60 "$logs/apk.log"; echo "<== apk FAILED"; exit 1; }
tail -1 "$logs/apk.log"
phase apk $s

# The emulator, booted.
s=$SECONDS
echo "==> boot"
timeout 240 "$adb" wait-for-device || { tail -40 "$logs/emulator.log"; echo "the emulator never showed up"; exit 1; }
for _ in $(seq 300); do
  [ "$(timeout 10 "$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  kill -0 "$emu" 2>/dev/null || { tail -40 "$logs/emulator.log"; echo "the emulator quit"; exit 1; }
  sleep 1
done
[ "$(timeout 10 "$adb" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || { tail -40 "$logs/emulator.log"; echo "the emulator didn't boot"; exit 1; }
echo "booted $((SECONDS - boot0))s after its start"
# root: the app's screens other than its first aren't exported, and only root may open them.
"$adb" root >/dev/null 2>&1 && timeout 60 "$adb" wait-for-device
ad() { timeout 30 "$adb" shell "$@"; }
for k in window_animation_scale transition_animation_scale animator_duration_scale; do ad settings put global "$k" 0; done
ad settings put system screen_off_timeout 2147483647
ad svc power stayon true
ad wm dismiss-keyguard >/dev/null 2>&1 || true
ad input keyevent KEYCODE_WAKEUP
[ -z "${DARK:-}" ] || ad cmd uimode night yes >/dev/null
timeout 120 "$adb" install -r -g "$HOME/out/harbor-rig.apk" >/dev/null || { echo "the APK didn't install"; exit 1; }
"$adb" reverse "tcp:$port" "tcp:$port" >/dev/null
ad logcat -c
phase boot $s

pkg=dev.harbor.app
pid() { ad pidof "$pkg" | tr -d '\r'; }
# Fails when the app crashed (its last words from logcat) or isn't the screen in front.
alive() {
  if ad logcat -d -b crash | grep -q "Process: $pkg"; then
    echo "THE APP CRASHED ($1):"; ad logcat -d -b crash | tail -40; return 1
  fi
  [ -n "$(pid)" ] || { echo "THE APP IS NOT RUNNING ($1)"; ad logcat -d | grep -E 'AndroidRuntime|ActivityManager.*harbor' | tail -30; return 1; }
  local top; top=$(ad dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity' | tr -d '\r')
  [[ $top == *"$pkg"* ]] || { echo "THE APP IS NOT IN FRONT ($1): $top"; return 1; }
}
# capture <png>: the screen as SurfaceFlinger composed it. One colour all over (the system image
# composes nothing headless: the ATD images do that, and the emulator's own screenshot is a grey
# blank then) is a failure, not a shot.
uniform() { python3 -c '
import sys
d = open(sys.argv[1], "rb").read()[16:]
px = {d[i:i + 3] for i in range(0, len(d) - 4, 4 * 97)}
sys.exit(0 if len(px) <= 1 else 1)' "$1"; }
capture() {
  timeout 20 "$adb" exec-out screencap > "$logs/raw"
  if uniform "$logs/raw"; then
    echo "THE SCREEN IS BLANK: one colour all over ($(ad dumpsys power | grep -m1 -o 'mWakefulness=[A-Za-z]*' | tr -d '\r'), image $sysimg, gpu $gpu)"
    return 1
  fi
  timeout 20 "$adb" exec-out screencap -p > "$1"
}
# Waits until the screen stops changing (two equal frames 0.6 s apart, after at least 1.5 s; at
# most 25 s), then keeps a PNG of it.
n=0
shot() {
  local name="$1" a="" b t=$SECONDS out
  sleep 1.5
  while [ $((SECONDS - t)) -lt 25 ]; do
    b=$(timeout 20 "$adb" exec-out screencap | md5sum)
    [ "$b" = "$a" ] && break
    a=$b; sleep 0.6
  done
  alive "$name" || return 1
  n=$((n + 1)); out=$(printf '%s/%02d-%s.png' "$shots" "$n" "${name//[^a-zA-Z0-9_-]/_}")
  capture "$out" || return 1
  # Nothing drawn: no text on the screen at all (the dump lists every view's text).
  ad uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && "$adb" pull /sdcard/ui.xml "$logs/ui-$n.xml" >/dev/null 2>&1 &&
    ! grep -qE 'text="[^"]+"' "$logs/ui-$n.xml" && { echo "THE APP SHOWED NOTHING ($name): no text on the screen"; return 1; }
  echo "shot $(basename "$out") after $((SECONDS - t + 1))s"
}
gid() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" <<< "$gids"; }
open() {
  local what="$1" a=(-W -S -n)
  case "$what" in
    home|chats) a+=("$pkg/.Hubs") ;;
    chat) a+=("$pkg/.Chat" --es hub rig --es chat "$(gid cards)") ;;
    chat:lead) a+=("$pkg/.Chat" --es hub rig --es chat "$(gid lead)") ;;
    chat:*) a+=("$pkg/.Chat" --es hub rig --es chat "${what#chat:}") ;;
    settings) a+=("$pkg/.Settings" --es hub rig) ;;
    new) a+=("$pkg/.NewChat" --es hub rig) ;;
    palette) a+=("$pkg/.Palette" --es hub rig) ;;
    *) echo "unknown screen: $what"; return 2 ;;
  esac
  ad am start "${a[@]}" >/dev/null || { echo "could not open $what"; return 1; }
}

s=$SECONDS
echo "==> shots"
[ $# -gt 0 ] || set -- screen:chats
fail=0
for st in "$@"; do
  case "$st" in
    screen:*) open "${st#screen:}" && shot "${st#screen:}" || { fail=1; break; } ;;
    tap:*) xy=${st#tap:}; ad input tap "${xy%,*}" "${xy#*,}" ;;
    swipe:*) IFS=, read -r x1 y1 x2 y2 <<< "${st#swipe:}"; ad input swipe "$x1" "$y1" "$x2" "$y2" 300 ;;
    text:*) t=${st#text:}; ad input text "$(printf %q "${t// /%s}")" ;;
    key:*) ad input keyevent "KEYCODE_${st#key:}" ;;
    wait:*) sleep "${st#wait:}" ;;
    shot:*) shot "${st#shot:}" || { fail=1; break; } ;;
    *) echo "unknown step: $st"; fail=1; break ;;
  esac
done
phase shots $s
ad logcat -d > "$logs/logcat.txt" 2>/dev/null || true
tar -czf "$HOME/out/shots.tgz" -C "$HOME/out" shots logs
phase total
[ "$fail" = 0 ] || { echo "<== phoneshot FAILED"; tail -20 "$logs/hub.log"; exit 1; }
echo "<== phoneshot ok"
