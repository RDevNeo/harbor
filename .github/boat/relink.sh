#!/bin/bash
# relink.sh [--split | --first] <profile dir>…: keeps a warm target's build scripts alive across a snapshot.
# A build script's binary has two names, and cargo links build_script_build-<hash> onto
# build-script-build on every build. boat's snapshot layers keep the hashed name as a tar hard link
# to build-script-build. Cargo, relinking on a sandbox that isn't fully loaded, rewrites only
# build-script-build, so that goes into a newer layer and the hard link is left pointing at it from
# an older one. The next restore drops the hashed name: until the disk has loaded, stat finds it and
# open blocks about two minutes and fails ("failed to link or copy": No such file), after that it's
# gone, cargo counts the build script as lost and compiles everything that depends on it.
#   --split     before a snapshot: a hashed name that is hard linked gets its own copy, so it is a
#               file in the newest layer and depends on nothing
#   otherwise   when a build failed: every hashed name not hard linked on disk gets its binary again
#               from build-script-build, the one that survives, which compiles nothing. A package
#               that lost both names starts over: its build dir and fingerprint go, and cargo
#               compiles what depends on it and nothing else.
#   --first     before a build, for one profile: the same, unless the first hashed name opens at
#               once. Cargo's links go in one burst, so a snapshot goes bad as a whole, and repairing
#               a good one costs 10 s.
set -euo pipefail
split=""
case "$1" in
  --split) split=1; shift ;;
  --first)
    shift
    for dep in "$1"/build/*/build_script_*.d; do
      ! timeout 5 head -c1 "${dep%.d}" >/dev/null 2>&1 || exit 0
      break
    done ;;
esac
reads() { head -c1 "$1" >/dev/null 2>&1; }
own() { cp -p "$1" "$2.new" && mv -f "$2.new" "$2"; }
fixed=0 missing=0 lost=()
for t in "$@"; do
  for dep in "$t"/build/*/build_script_*.d; do
    [ -e "$dep" ] || continue
    hashed=${dep%.d} dir=${dep%/*} plain=$dir/build-script-build
    if [ -z "$split" ]; then
      [ ! "$hashed" -ef "$plain" ] || continue
    elif [ -e "$hashed" ] && [ -e "$plain" ] && [ ! "$hashed" -ef "$plain" ]; then
      continue
    fi
    [ -e "$hashed" ] || missing=$((missing + 1))
    if reads "$plain"; then
      own "$plain" "$hashed"; fixed=$((fixed + 1))
    elif reads "$hashed"; then
      own "$hashed" "$plain"; fixed=$((fixed + 1))
    else
      lost+=("${dir##*/}")
      rm -rf "$dir" "$t/.fingerprint/${dir##*/}"
    fi
  done
done
if [ -n "$split" ]; then
  echo "$fixed build scripts split for the snapshot"
elif [ $((missing + ${#lost[@]})) != 0 ]; then
  echo "::warning::$*: the snapshot lost $missing build scripts' hashed names, ${#lost[@]} packages start over: ${lost[*]:-none}"
fi
