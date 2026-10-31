#!/bin/bash
# Build Harbor for Android -> android/build/harbor-android.apk. No Gradle: aapt2 + javac + d8 +
# zipalign + apksigner straight from an Android SDK. Third-party code: sherpa-onnx's Java bindings,
# vendored as source in third_party/sherpa-onnx, and the few Google Play services client libraries
# Gmail's native sign-in needs (below, third_party/play-services/NOTICE).
#
# Version: versionName is Cargo.toml's version; versionCode is major*1000000 + minor*1000 + patch
# (0.7.0 -> 7000), so the app the desktop serves and the one on the phone compare as numbers.
#
# Toolchain: $ANDROID_BUILD (default ~/.local/opt/android-build, holding jdk/ and sdk/), else
# $ANDROID_HOME (or $ANDROID_SDK_ROOT) with javac on PATH, as on a CI runner.
#
# Signing: every build must be signed with the same key, or phones need an uninstall first.
#   ANDROID_KEYSTORE       keystore path (default ~/.local/share/harbor-android/harbor-android.jks)
#   ANDROID_KEYSTORE_PASS  its password (default: the file next to it, harbor-android.pass)
#   ANDROID_KEY_ALIAS      key alias (default harbor)
# OUT=<path> writes the APK elsewhere. UNSIGNED=1 stops before signing (CI signs it elsewhere).
#
# Accounts (Account.java, android/PROTOCOL.md "Accounts"): HARBOR_CLERK_URL, HARBOR_CLERK_CLIENT_ID
# HARBOR_ACCOUNTS_URL and HARBOR_GOOGLE_WEB_CLIENT_ID replace the built-in values (test builds against fakes; an http:// URL
# to 127.0.0.1 also lets the app talk plain HTTP to loopback, for `adb reverse`).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")

TOOLS=${ANDROID_BUILD:-$HOME/.local/opt/android-build}
if [ -d "$TOOLS/sdk" ]; then
  SDK=$TOOLS/sdk
  [ -d "$TOOLS/jdk" ] && export JAVA_HOME=$TOOLS/jdk PATH=$TOOLS/jdk/bin:$PATH
else
  SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$SDK" ] || { echo "no Android SDK: set ANDROID_BUILD or ANDROID_HOME" >&2; exit 1; }
fi
BT=$SDK/build-tools/${BUILD_TOOLS:-34.0.0}
JAR=$SDK/platforms/android-${PLATFORM:-34}/android.jar
[ -x "$BT/aapt2" ] && [ -f "$JAR" ] || { echo "missing build-tools or platform in $SDK" >&2; exit 1; }

VER=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)
IFS=.- read -r MA MI PA _ <<< "$VER"
CODE=$((MA * 1000000 + MI * 1000 + PA))

KEY=${ANDROID_KEYSTORE:-$HOME/.local/share/harbor-android/harbor-android.jks}
ALIAS=${ANDROID_KEY_ALIAS:-harbor}
if [ -n "${ANDROID_KEYSTORE_PASS:-}" ]; then KSPASS="env:ANDROID_KEYSTORE_PASS"
else KSPASS="file:${KEY%.jks}.pass"; fi
[ -n "${UNSIGNED:-}" ] || [ -f "$KEY" ] || { echo "no signing keystore at $KEY (see the header of this script)" >&2; exit 1; }

OUT=${OUT:-$HERE/build/harbor-android.apk}
mkdir -p "$(dirname "$OUT")"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

# Harbor's own fonts (Geist, Geist Mono, the Lucide icon subset), shared with the desktop.
mkdir -p "$W/assets/fonts"
cp "$ROOT/assets/fonts/"{Geist-Regular,Geist-SemiBold,GeistMono-Regular,lucide}.ttf "$W/assets/fonts/"
# And the providers' logos (48×48 alpha masks or RGBA), as the desktop draws them.
mkdir -p "$W/assets/logos"
cp "$ROOT/assets/logos/"p-*.{a8,rgba} "$W/assets/logos/"

# Dictation on the phone (Voice, Asr): sherpa-onnx's JNI library (onnxruntime linked in) and
# Silero VAD's model, pinned by SHA-256 and cached between builds. ANDROID_ABIS picks the ABIs
# packaged (default arm64-v8a armeabi-v7a: phones with a 32-bit Android refuse an APK without
# their ABI, INSTALL_FAILED_NO_MATCHING_ABIS; add x86_64 for the emulator). See
# third_party/sherpa-onnx/NOTICE.
SHERPA=2.0.1
SHERPA_SHA=fe1c9ceffd86770218a1d4bba6b410d6f726b2b8dda6a5488499b05250b53aea
VAD_SHA=9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6
DEPS=${HARBOR_ANDROID_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/harbor-android-deps}
mkdir -p "$DEPS"
fetch() { # url sha256 file
  if [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet >/dev/null 2>&1; then return; fi
  curl -fsSL --retry 3 "$1" -o "$3.part"
  echo "$2  $3.part" | sha256sum -c --quiet >/dev/null 2>&1 || { echo "checksum mismatch: $1" >&2; rm -f "$3.part"; exit 1; }
  mv "$3.part" "$3"
}
fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA/sherpa-onnx-v$SHERPA-android-static-link-onnxruntime.tar.bz2" \
  "$SHERPA_SHA" "$DEPS/sherpa-onnx-$SHERPA-android.tar.bz2"
fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" "$VAD_SHA" "$DEPS/silero_vad.onnx"
cp "$DEPS/silero_vad.onnx" "$W/assets/"
# Asr.ABIS lists these: on any other ABI the app doesn't load the library (#97).
for abi in ${ANDROID_ABIS:-arm64-v8a armeabi-v7a}; do
  mkdir -p "$W/lib/$abi"
  tar xjf "$DEPS/sherpa-onnx-$SHERPA-android.tar.bz2" -C "$W/lib/$abi" --strip-components=3 "./jniLibs/$abi/libsherpa-onnx-jni.so"
done

# Gmail's native consent (Gmail.java): Google's AuthorizationClient only ships in Play services'
# client libraries, and it needs only these (Kotlin, AndroidX fragments and the rest of
# play-services-auth's dependency list aren't reached by it). Pinned by SHA-256, cached between
# builds, their classes dexed as they are.
GMS=https://dl.google.com/android/maven2/com/google/android/gms
LIBS=()
aar() { # name version sha256
  fetch "$GMS/$1/$2/$1-$2.aar" "$3" "$DEPS/$1-$2.aar"
  mkdir -p "$W/libs/$1"
  unzip -qo "$DEPS/$1-$2.aar" classes.jar -d "$W/libs/$1"
  LIBS+=("$W/libs/$1/classes.jar")
}
aar play-services-auth 22.0.0 0897c1ad398cae3f7a743a24d66373cc7440e63d11e7429ed9a17a77a61c96dc
aar play-services-basement 18.9.0 c6ed7236b1b3ce0296b508a5c0a09108fd52d83559d35cad2639505cd04ab255
aar play-services-base 18.5.0 59a5c0c2da12311d75d965ce1f419498536b1a167fb28ff7dfc2dfd9cefa4157
aar play-services-tasks 18.2.0 7f2aaa8f502068eaf54356ca92aec04271d6e7c416c52c45c0d23440fcbd1654
fetch https://dl.google.com/android/maven2/androidx/collection/collection/1.1.0/collection-1.1.0.jar \
  632a0e5407461de774409352940e292a291037724207a787820c77daf7d33b72 "$DEPS/collection-1.1.0.jar"
LIBS+=("$DEPS/collection-1.1.0.jar")
LIBCP=$(IFS=:; echo "${LIBS[*]}")

# The built-in browser's engine (android/servo: Servo as libharborservo.so), built separately with
# the NDK (android/servo/build.sh, or CI's cached build): $SERVO_LIBS/<abi>/libharborservo.so
# with its libc++_shared.so,
# default android/servo/out. Packaged for each of ANDROID_ABIS it exists for (arm64-v8a and
# armeabi-v7a in releases; each ABI folder must hold every library: Android installs one). SERVO_REQUIRED=1 (releases) fails without the arm64 one.
SERVO_LIBS=${SERVO_LIBS:-$HERE/servo/out}
for abi in ${ANDROID_ABIS:-arm64-v8a armeabi-v7a}; do
  if [ -f "$SERVO_LIBS/$abi/libharborservo.so" ]; then
    cp "$SERVO_LIBS/$abi/libharborservo.so" "$SERVO_LIBS/$abi/libc++_shared.so" "$W/lib/$abi/"
  elif [ "$abi" = arm64-v8a ] && [ -n "${SERVO_REQUIRED:-}" ]; then
    echo "no browser engine at $SERVO_LIBS/$abi/libharborservo.so" >&2; exit 1
  fi
done

# Where the app signs in (Config.java): RDevNeo's Clerk app and account service by default.
CLERK_URL=${HARBOR_CLERK_URL:-https://maximum-feline-2818.clerk.accounts.dev}
CLERK_CLIENT=${HARBOR_CLERK_CLIENT_ID:-FWUnta6BgUIwVT9O}
ACCOUNTS_URL=${HARBOR_ACCOUNTS_URL:-https://harbor-accounts.rdevneo.workers.dev}
# Harbor's Google Cloud Web client id: set, Android 14+ signs in with its own account picker
# (Credential Manager); empty, the browser through Clerk. Fill it once the Google Cloud clients exist.
GOOGLE_WEB_CLIENT=${HARBOR_GOOGLE_WEB_CLIENT_ID-}
case "$GOOGLE_WEB_CLIENT" in *[\\\"]*) echo "bad Google client id" >&2; exit 1 ;; esac
for v in "$CLERK_URL" "$CLERK_CLIENT" "$ACCOUNTS_URL"; do
  case "$v" in *[\\\"]*|"") echo "bad accounts setting: $v" >&2; exit 1 ;; esac
done
mkdir -p "$W/gen/dev/harbor/app"
cat > "$W/gen/dev/harbor/app/Config.java" <<JAVA
package dev.harbor.app;

/** Generated by android/build.sh: where the app signs in. */
final class Config {
    static final String CLERK_URL = "${CLERK_URL%/}";
    static final String CLERK_CLIENT_ID = "$CLERK_CLIENT";
    static final String ACCOUNTS_URL = "${ACCOUNTS_URL%/}";
    static final String GOOGLE_WEB_CLIENT_ID = "$GOOGLE_WEB_CLIENT";
}
JAVA
cp -r "$HERE/res" "$W/res"
case "$CLERK_URL $ACCOUNTS_URL" in
  *http://127.0.0.1*)
    cat > "$W/res/xml/network.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<!-- A test build: plain HTTP to the fake sign-in services on loopback only. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config>
</network-security-config>
XML
    ;;
esac
"$BT/aapt2" compile --dir "$W/res" -o "$W/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$HERE/AndroidManifest.xml" -o "$W/base.apk" "$W/res.zip" \
  -A "$W/assets" --java "$W/gen" --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$CODE" --version-name "$VER"
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$JAR:$LIBCP" -d "$W/classes" \
  $(find "$HERE/src" "$HERE/third_party/sherpa-onnx/src" "$W/gen" -name '*.java')
# Net's connection rules are plain Java: check them on this JVM before packaging.
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/AddrTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.AddrTest
# And the slash menu's matching (the desktop's rules, src/slash.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/SlashTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.SlashTest
# And the composer's @ and # tags (src/tags.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/TagTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.TagTest
# And when an automatic update may install (Quiet).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/UpdateTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.UpdateTest
# And the chat list's workspace filter (src/sidebar.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/WsFilterTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.WsFilterTest
# And dictation's dictionary and commands, against the hub's cases (src/dictwords.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/WordsTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.WordsTest "$HERE/test/dictation-cases.txt"
"$BT/d8" --release --lib "$JAR" --min-api 26 --output "$W" $(find "$W/classes" -name '*.class') "${LIBS[@]}"
(cd "$W" && zip -qj base.apk classes*.dex)
(cd "$W" && zip -qr base.apk lib)
"$BT/zipalign" -f 4 "$W/base.apk" "$W/aligned.apk"
if [ -n "${UNSIGNED:-}" ]; then
  cp "$W/aligned.apk" "$OUT"
  echo "built $(basename "$OUT") $VER (versionCode $CODE, unsigned)"
  exit 0
fi
"$BT/apksigner" sign --ks "$KEY" --ks-pass "$KSPASS" --ks-key-alias "$ALIAS" --out "$OUT" "$W/aligned.apk"
rm -f "$OUT.idsig"
echo "built $(basename "$OUT") $VER (versionCode $CODE, $(du -h "$OUT" | cut -f1))"
