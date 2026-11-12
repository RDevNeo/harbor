#!/bin/bash
# Run by release.yml's job android on the GitHub runner itself (ubuntu-22.04, which ships a JDK and
# the Android SDK): the phone app, unsigned, as boat built it before (`.github/boat/build.sh
# android`). The job signs it next. An exception to "every build runs on
# boat" (CLAUDE.md): on a sandbox the 0.148.0 APK took 193 s, nearly all of it the lazy disk
# loading the SDK (iowait 80 %, user 4 %).
#
#   android.sh OUT.apk
#
# android/build.sh's unit tests (android/test) run as part of it. Its downloads (sherpa-onnx, the
# Play services libraries), pinned by SHA-256, are kept in $HARBOR_ANDROID_DEPS (release.yml caches
# them). HARBOR_GOOGLE_WEB_CLIENT_ID passes through when set.
set -euo pipefail
out=$(realpath -m "$1")
cd "$(dirname "$0")/../.."

# JDK 17, as boat's eclipse-temurin:17 image (the runner's default java is older).
export JAVA_HOME=${JAVA_HOME_17_X64:-${JAVA_HOME:?no JDK}}
export PATH="$JAVA_HOME/bin:$PATH"
java -version 2>&1 | head -1

# The build-tools and platform android/build.sh asks for (BUILD_TOOLS, PLATFORM), installed when
# this runner image lacks them.
sdk=${ANDROID_HOME:?no Android SDK}
bt=${BUILD_TOOLS:-34.0.0} pf=${PLATFORM:-34}
want=()
[ -x "$sdk/build-tools/$bt/aapt2" ] || want+=("build-tools;$bt")
[ -f "$sdk/platforms/android-$pf/android.jar" ] || want+=("platforms;android-$pf")
if [ ${#want[@]} != 0 ]; then
  echo "installing ${want[*]}"
  sm=$sdk/cmdline-tools/latest/bin/sdkmanager
  yes | "$sm" --licenses >/dev/null || true
  "$sm" --install "${want[@]}" >/dev/null
fi
"$sdk/build-tools/$bt/aapt2" version

mkdir -p "$(dirname "$out")"
ANDROID_BUILD=/nonexistent ANDROID_HOME="$sdk" UNSIGNED=1 OUT="$out" \
  HARBOR_ANDROID_DEPS="${HARBOR_ANDROID_DEPS:-$HOME/.cache/harbor-android-deps}" android/build.sh
ls -la "$out"
