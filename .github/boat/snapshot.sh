#!/bin/bash
# Run by scripts/boat/snapshot on a sandbox from a saved snapshot: what the warm target holds, on
# disk, for each profile. A build script's binary has two names, build_script_build-<hash> and
# build-script-build (relink.sh says why that matters). Reads each one, so a broken snapshot takes
# minutes here.
. "$(dirname "$0")/lib.sh"
findmnt -T "$cache" -o TARGET,SOURCE,FSTYPE,OPTIONS || true
df -hT "$cache"
echo "mounts: $(wc -l < /proc/self/mountinfo), /sys/fs/cgroup holds $(ls /sys/fs/cgroup 2>/dev/null | wc -l)"
for build in "$cache"/target*/release/build "$cache"/target/debug/build; do
  [ -d "$build" ] || continue
  linked=0 apart=0 lost=0 unreadable=0 first=""
  for d in "$build"/*/; do
    a=$(find "$d" -maxdepth 1 -name 'build_script_*' ! -name '*.d' -print -quit)
    b=$d/build-script-build
    [ -n "$a$(find "$d" -maxdepth 1 -name build-script-build)" ] || continue
    if [ -z "$a" ] || [ ! -e "$b" ]; then lost=$((lost + 1)); first=${first:-$d}
    elif ! head -c1 "$a" >/dev/null 2>&1 || ! head -c1 "$b" >/dev/null 2>&1; then unreadable=$((unreadable + 1)); first=${first:-$d}
    elif [ "$a" -ef "$b" ]; then linked=$((linked + 1))
    else apart=$((apart + 1)); fi
  done
  echo "$build: hard linked $linked, two copies $apart, one name lost $lost, unreadable $unreadable"
  [ -z "$first" ] || ls -la "$first"
done
