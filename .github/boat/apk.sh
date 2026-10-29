#!/bin/bash
# Run by scripts/boat/android on a boat.dev sandbox, from the copied working tree: the unsigned APK
# and its unit tests (android/build.sh), as release.yml builds it, into ~/out.
. "$(dirname "$0")/lib.sh"
apk=$(image harbor-android .github/boat/Dockerfile.android)
s=$SECONDS
echo "==> apk"
if apk_unsigned "$apk" /out/harbor-android-unsigned.apk; then echo "<== apk ok $((SECONDS - s))s"
else echo "<== apk FAILED $((SECONDS - s))s"; exit 1; fi
