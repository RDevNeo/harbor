#!/bin/bash
# Run by prune.yml on a sandbox from the snapshot `harbor-browser`: drops what belongs to the other
# engines' snapshots, which forced branch runs once saved into it (they restore for nothing).
. "$(dirname "$0")/lib.sh"
du -sh "$cache"; ls -la "$cache"
rm -rf "$cache/target-browser-aarch64" "$cache/target-android" "$cache/ndk" "$cache"/android-ndk-*
img=$(image harbor-browser-builder .github/boat/Dockerfile.browser)
echo "$img" > "$cache/images"
docker ps -a --format '{{.Names}}' | grep -vx keep-harbor-browser-builder | xargs -r docker rm -f
docker image prune -af >/dev/null
docker images
du -sh "$cache"
