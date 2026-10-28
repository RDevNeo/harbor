#!/bin/bash
# Builds the browser engine (Servo as libharborservo.so) with the Android NDK into out/<abi>/,
# with the NDK's libc++_shared.so beside it (Servo's C++ parts link it): android/build.sh
# packages both. Needs rustup's Android targets, cargo-ndk (`cargo install cargo-ndk`) and
# NDK r29 ($ANDROID_NDK_HOME, default <sdk>/ndk/29.0.14206865). A cold build compiles all of Servo.
#   ABIS="arm64-v8a" (default; the emulator needs x86_64)   CARGO_TARGET_DIR as usual
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_HOME:-$HOME/.local/opt/android-build/sdk}
export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-$SDK/ndk/29.0.14206865}
cd "$HERE"
for abi in ${ABIS:-arm64-v8a}; do
  case $abi in
    arm64-v8a) triple=aarch64-linux-android ;;
    x86_64) triple=x86_64-linux-android ;;
    *) echo "no engine for $abi" >&2; exit 1 ;;
  esac
  cargo ndk -t "$abi" -P 28 -o out build --release ${LOCKED:+--locked}
  cp "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$triple/libc++_shared.so" "out/$abi/"
  ls -la "out/$abi"
done
