#!/bin/bash
# Run by smoke.yml on a boat.dev sandbox, with the release files in ~/dist: .github/smoke-install.sh
# in a container of each distro, all at once; aarch64 under qemu (binfmt in lib.sh).
. "$(dirname "$0")/lib.sh"
binfmt
runs=("ubuntu:22.04 x86_64" "debian:12 x86_64" "fedora:latest x86_64" "archlinux:latest x86_64"
      "ubuntu:22.04 aarch64" "debian:12 aarch64")
pids=()
for r in "${runs[@]}"; do
  read -r img arch <<< "$r"
  log="$HOME/out/smoke-${img/:/-}-$arch.log"
  if [ ! -f "$HOME/dist/harbor-$arch-linux.tar.gz" ]; then
    echo "no harbor-$arch-linux.tar.gz to test" > "$log"; pids+=(""); continue
  fi
  platform=linux/amd64; [ "$arch" = aarch64 ] && platform=linux/arm64
  ( s=$SECONDS; docker run --rm --platform "$platform" -v "$PWD:/src:ro" -v "$HOME/dist:/dist:ro" "$img" \
      sh /src/.github/smoke-install.sh; c=$?; echo "$r: $((SECONDS - s))s"; exit $c ) > "$log" 2>&1 &
  pids+=($!)
done
failed=()
for i in "${!runs[@]}"; do
  [ -z "${pids[$i]}" ] || wait "${pids[$i]}" || failed+=("${runs[$i]}")
done
for r in "${runs[@]}"; do
  read -r img arch <<< "$r"
  echo "=== $img $arch ==="; cat "$HOME/out/smoke-${img/:/-}-$arch.log"
done
for r in "${runs[@]}"; do read -r img arch <<< "$r"; tail -1 "$HOME/out/smoke-${img/:/-}-$arch.log"; done
[ ${#failed[@]} = 0 ] || { echo "::error::smoke test failed on: ${failed[*]}"; exit 1; }
echo "all passed"
