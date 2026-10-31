#!/bin/bash
# Run by smoke.yml on a boat.dev sandbox, with the release files in ~/dist: .github/smoke-install.sh
# in a container of each distro, all at once; aarch64 under qemu (binfmt in lib.sh). SMOKE_ARCH
# picks one architecture.
. "$(dirname "$0")/lib.sh"
cpu_mark
[ "${SMOKE_ARCH:-}" = x86_64 ] || binfmt
runs=()
[ "${SMOKE_ARCH:-}" = aarch64 ] || runs+=("ubuntu:22.04 x86_64" "debian:12 x86_64" "fedora:latest x86_64" "archlinux:latest x86_64")
[ "${SMOKE_ARCH:-}" = x86_64 ] || runs+=("ubuntu:22.04 aarch64" "debian:12 aarch64")
pids=()
for r in "${runs[@]}"; do
  read -r img arch <<< "$r"
  log="$HOME/out/smoke-${img/:/-}-$arch.log"
  if [ ! -f "$HOME/dist/harbor-$arch-linux.tar.gz" ]; then
    echo "no harbor-$arch-linux.tar.gz to test" > "$log"; pids+=(""); continue
  fi
  platform=linux/amd64; [ "$arch" = aarch64 ] && platform=linux/arm64
  ( s=$SECONDS; docker pull -q --platform "$platform" "$img" >/dev/null || true; p=$((SECONDS - s))
    docker run --rm --platform "$platform" -v "$PWD:/src:ro" -v "$HOME/dist:/dist:ro" "$img" \
      sh /src/.github/smoke-install.sh; c=$?; echo "$r: $((SECONDS - s))s (image $p s)"; exit $c ) > "$log" 2>&1 &
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
cpu_report
[ ${#failed[@]} = 0 ] || { echo "::error::smoke test failed on: ${failed[*]}"; exit 1; }
echo "all passed"
