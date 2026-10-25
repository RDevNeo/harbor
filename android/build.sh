#!/bin/bash
# Build Harbor for Android -> android/build/harbor-android.apk. No Gradle: aapt2 + javac + d8 +
# zipalign + apksigner straight from an Android SDK. The only third-party code is ZXing's QR
# decoder, vendored as source in third_party/zxing (Apache-2.0).
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
# OUT=<path> writes the APK elsewhere.
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
[ -f "$KEY" ] || { echo "no signing keystore at $KEY (see the header of this script)" >&2; exit 1; }

OUT=${OUT:-$HERE/build/harbor-android.apk}
mkdir -p "$(dirname "$OUT")"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

# Harbor's own fonts (Geist, Geist Mono, the Lucide icon subset), shared with the desktop.
mkdir -p "$W/assets/fonts"
cp "$ROOT/assets/fonts/"{Geist-Regular,Geist-SemiBold,GeistMono-Regular,lucide}.ttf "$W/assets/fonts/"

"$BT/aapt2" compile --dir "$HERE/res" -o "$W/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$HERE/AndroidManifest.xml" -o "$W/base.apk" "$W/res.zip" \
  -A "$W/assets" --java "$W/gen" --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$CODE" --version-name "$VER"
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$JAR" -d "$W/classes" \
  $(find "$HERE/src" "$HERE/third_party/zxing/src" "$W/gen" -name '*.java')
# Net's connection rules are plain Java: check them on this JVM before packaging.
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/AddrTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.AddrTest
# And the three-factor crypto, against the hub's own test vectors (src/phoneauth.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/SecTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.SecTest
# And the slash menu's matching (the desktop's rules, src/slash.rs).
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/SlashTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.SlashTest
# So is the QR scanner's decoding of a camera frame.
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$W/classes" -d "$W/test" "$HERE/test/QrTest.java"
java -cp "$W/classes:$W/test" dev.harbor.app.QrTest "$HERE/test/pair-qr.png"
"$BT/d8" --release --lib "$JAR" --min-api 26 --output "$W" $(find "$W/classes" -name '*.class')
(cd "$W" && zip -qj base.apk classes.dex)
"$BT/zipalign" -f 4 "$W/base.apk" "$W/aligned.apk"
"$BT/apksigner" sign --ks "$KEY" --ks-pass "$KSPASS" --ks-key-alias "$ALIAS" --out "$OUT" "$W/aligned.apk"
rm -f "$OUT.idsig"
echo "built $(basename "$OUT") $VER (versionCode $CODE, $(du -h "$OUT" | cut -f1))"
