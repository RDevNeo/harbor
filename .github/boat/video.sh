#!/bin/bash
# Run by video.yml and scripts/boat/video on a boat.dev sandbox, from the source: Harbor's video
# engine (video/build.sh) into ~/out/video.
#   video.sh                     x86_64, aarch64, and its sources and licences
#   video.sh x86_64 [aarch64…]   only those, for trying a change
. "$(dirname "$0")/lib.sh"
img=$(image harbor-video-builder video/Dockerfile)
targets=("$@")
[ $# -gt 0 ] || targets=(x86_64 aarch64 source)
for t in "${targets[@]}"; do
  echo "==> video $t"
  run_in "$img" -- bash video/build.sh "$t"
  echo "<== video $t ok"
done
