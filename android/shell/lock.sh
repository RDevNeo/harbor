#!/bin/bash
# The shell's version and what it covers (android/README.md, "Shell and code"). Plain bash, no SDK:
# runs on any PC.
#
#   android/shell/lock.sh check   exits 1 (saying what to do) when the shell's inputs changed since
#                                 shell.lock was written; prints the version otherwise (build.sh)
#   android/shell/lock.sh bump    the next version, for the inputs as they are now
#   android/shell/lock.sh version the version alone (release.yml's plan)
#
# The inputs: everything a phone only gets by installing an APK. The manifest (permissions,
# components, the factory), the resources, the shell's own code, and the native libraries and big
# assets build.sh pins (sherpa-onnx, the VAD model). The app's code (android/src, third_party's
# Java, the fonts and logos) isn't one: it ships as harbor-phone-code.zip.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
A=$(dirname "$HERE")
LOCK=$HERE/shell.lock
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
inputs() {
  ( cd "$A"
    find AndroidManifest.xml res shell/src -type f | LC_ALL=C sort | while read -r f; do sha "$f"; done
    grep -E '^(SHERPA|SHERPA_SHA|VAD_SHA|ABIS)=' build.sh
  ) | sha | cut -c1-64
}
have() { [ -f "$LOCK" ] || return 0; sed -n "s/^$1=//p" "$LOCK" | head -1; }
case "${1:-check}" in
  version) v=$(have version); echo "${v:?no version in $LOCK}" ;;
  check)
    v=$(have version) want=$(have inputs) now=$(inputs)
    if [ -z "$v" ] || [ "$want" != "$now" ]; then
      echo "the phone app's shell changed (manifest, res/, shell/src or build.sh's native pins) but its version didn't:" >&2
      echo "run android/shell/lock.sh bump and commit android/shell/shell.lock (phones then need the new APK once)" >&2
      exit 1
    fi
    echo "$v" ;;
  bump)
    v=$(have version); v=$(( ${v:-0} + 1 ))
    cat > "$LOCK" <<LOCK
# Hub for Android's shell version, and a hash of what the shell is made of (android/shell/lock.sh).
# android/build.sh refuses to build when the hash no longer matches: run \`android/shell/lock.sh bump\`.
version=$v
inputs=$(inputs)
LOCK
    echo "shell version $v" ;;
  *) echo "usage: $0 check|bump|version" >&2; exit 2 ;;
esac
