#!/bin/bash
# The test caller app (AndroidManifest.xml here): OUT=<path> (default build/rigcaller.apk), signed
# with ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASS / ANDROID_KEY_ALIAS (harbor). Same toolchain as
# android/build.sh ($ANDROID_BUILD, else $ANDROID_HOME with javac on PATH). Only phoneshot builds it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=${ANDROID_BUILD:-$HOME/.local/opt/android-build}
if [ -d "$TOOLS/sdk" ]; then
  SDK=$TOOLS/sdk
  [ -d "$TOOLS/jdk" ] && export JAVA_HOME=$TOOLS/jdk PATH=$TOOLS/jdk/bin:$PATH
else
  SDK=${ANDROID_HOME:?no Android SDK: set ANDROID_BUILD or ANDROID_HOME}
fi
BT=$SDK/build-tools/${BUILD_TOOLS:-34.0.0}
JAR=$SDK/platforms/android-${PLATFORM:-34}/android.jar
OUT=${OUT:-$HERE/build/rigcaller.apk}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$(dirname "$OUT")" "$W/classes" "$W/dex"
"$BT/aapt2" link -I "$JAR" --manifest "$HERE/AndroidManifest.xml" -o "$W/base.apk"
javac -source 11 -target 11 -encoding UTF-8 -nowarn -Xlint:-options -classpath "$JAR" -d "$W/classes" $(find "$HERE/src" -name '*.java')
"$BT/d8" --release --lib "$JAR" --min-api 26 --output "$W/dex" $(find "$W/classes" -name '*.class')
(cd "$W/dex" && zip -qj "$W/base.apk" classes.dex)
"$BT/zipalign" -f 4 "$W/base.apk" "$W/aligned.apk"
if [ -n "${ANDROID_KEYSTORE_PASS:-}" ]; then KSPASS="env:ANDROID_KEYSTORE_PASS"; else KSPASS="file:${ANDROID_KEYSTORE%.jks}.pass"; fi
"$BT/apksigner" sign --ks "${ANDROID_KEYSTORE:?}" --ks-pass "$KSPASS" --ks-key-alias "${ANDROID_KEY_ALIAS:-harbor}" --out "$OUT" "$W/aligned.apk"
echo "built $OUT"
