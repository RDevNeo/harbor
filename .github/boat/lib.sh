# Sourced by the scripts here, on a boat.dev sandbox. ~/cache is what the saved snapshots keep.
set -euo pipefail
cache="$HOME/cache"
mkdir -p "$cache" "$HOME/out"

# image <name> <dockerfile>: tagged by the Dockerfile's hash. A snapshot keeps only images that a
# container uses, hence the keep- container.
image() {
  local img="$1:$(sha256sum "$2" | cut -c1-12)"
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    docker build -q -t "$img" -f "$2" "$(dirname "$2")" >/dev/null
    docker rm -f "keep-$1" >/dev/null 2>&1 || true
    docker create --name "keep-$1" "$img" >/dev/null
  fi
  echo "$img"
}

# run_in <image> [docker options] -- <command>. The source is always mounted at /src: cargo's
# fingerprints include the path.
run_in() {
  local img="$1" opts=(); shift
  while [ "$1" != -- ]; do opts+=("$1"); shift; done; shift
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_TERM_COLOR=always \
    -v "$cache:/c" -v "$PWD:/src" -v "$HOME/out:/out" -w /src "${opts[@]}" "$img" "$@"
}

binfmt() {
  docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64 >/dev/null
}
