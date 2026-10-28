#!/bin/bash
# Run by release.yml (job core-x86_64) on a boat.dev sandbox, from the extracted source; ~/cache
# is what the saved snapshot `harbor-build` keeps between builds.
set -euo pipefail
cache="$HOME/cache"
mkdir -p "$cache/rustup" "$cache/cargo" "$cache/target" "$HOME/out"

# The image is kept in the snapshot by a container that uses it; a changed Dockerfile makes a new one.
img="harbor-builder:$(sha256sum .github/boat/Dockerfile | cut -c1-12)"
if ! docker image inspect "$img" >/dev/null 2>&1; then
  docker build -q -t "$img" .github/boat
  docker rm -f keep-harbor-builder >/dev/null 2>&1 || true
  docker create --name keep-harbor-builder "$img" >/dev/null
fi

# The source is always mounted at /src: cargo's fingerprints include the path.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e RUSTUP_HOME=/c/rustup -e CARGO_HOME=/c/cargo -e CARGO_TARGET_DIR=/c/target \
  -e CARGO_TERM_COLOR=always -e HARBOR_GIT_SHA \
  -v "$cache:/c" -v "$PWD:/src" -w /src "$img" bash -euo pipefail -c '
    export PATH=/c/cargo/bin:$PATH
    [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
    rustup toolchain install stable --profile minimal >/dev/null && rustup default stable >/dev/null
    rustc --version
    s=$(date +%s); cargo test --locked -- update::; echo "::notice::tests $(( $(date +%s) - s ))s"
    s=$(date +%s); cargo build --release --locked; echo "::notice::release build $(( $(date +%s) - s ))s"
    ldd --version | sed -n 1p
    ldd /c/target/release/harbor
    /c/target/release/harbor --version'
cp "$cache/target/release/harbor" "$HOME/out/harbor"
