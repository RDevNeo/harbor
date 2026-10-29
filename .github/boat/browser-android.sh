#!/bin/bash
# Run by browser.yml (job engine-android) on a boat.dev sandbox, from the extracted source: the phone
# app's engine, android/servo as libharborservo.so (+ libc++_shared.so) for arm64-v8a and
# armeabi-v7a, cross-compiled with the NDK into ~/out/android/<abi>/.
. "$(dirname "$0")/lib.sh"
ndk=29.0.14206865 zip=android-ndk-r29-linux.zip
mkdir -p "$cache/rustup" "$cache/cargo" "$cache/ndk"
img=$(image harbor-browser-builder .github/boat/Dockerfile.browser)
run_in "$img" -e RUSTUP_HOME=/c/rustup -e CARGO_HOME=/c/cargo -e CARGO_TARGET_DIR=/c/target-android \
  -e PATH=/c/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e ANDROID_NDK_HOME=/c/ndk/$ndk -e NDK=$ndk -e ZIP=$zip -- bash -euo pipefail -c '
  if ! grep -qx "Pkg.Revision = $NDK" "$ANDROID_NDK_HOME/source.properties" 2>/dev/null; then
    rm -rf /c/ndk/* && curl -fsSL --retry 3 "https://dl.google.com/android/repository/$ZIP" -o /tmp/ndk.zip
    unzip -q /tmp/ndk.zip -d /c/ndk/x && rm /tmp/ndk.zip && mv /c/ndk/x/android-ndk-* "$ANDROID_NDK_HOME" && rmdir /c/ndk/x
    grep -x "Pkg.Revision = $NDK" "$ANDROID_NDK_HOME/source.properties"
  fi
  [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
  rustup toolchain install stable --profile minimal --target aarch64-linux-android --target armv7-linux-androideabi >/dev/null
  rustup default stable >/dev/null
  command -v cargo-ndk >/dev/null || CARGO_TARGET_DIR=/tmp/t cargo install --locked -q cargo-ndk
  rustc --version
  s=$(date +%s); LOCKED=1 ABIS="arm64-v8a armeabi-v7a" android/servo/build.sh
  echo "::notice::libharborservo.so (arm64-v8a, armeabi-v7a) built in $(( $(date +%s) - s ))s"
  mkdir -p /out/android && cp -r android/servo/out/arm64-v8a android/servo/out/armeabi-v7a /out/android/'
df -h / | tail -1
