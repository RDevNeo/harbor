# Sourced by the scripts here, on a boat.dev sandbox. ~/cache is what the saved snapshots keep.
set -euo pipefail
cache="$HOME/cache"
mkdir -p "$cache" "$HOME/out"

# image <name> <dockerfile>: tagged by the Dockerfile's hash. A snapshot keeps only images that a
# container uses, hence the keep- container. Its images load in the background after the sandbox
# is ready and no docker command waits for them, so ~/cache/images lists the ones it should have.
image() {
  local img="$1:$(sha256sum "$2" | cut -c1-12)" i=0
  until docker info >/dev/null 2>&1; do sleep 1; done
  if grep -qx "$img" "$cache/images" 2>/dev/null; then
    for i in $(seq 300); do docker image inspect "$img" >/dev/null 2>&1 && break; sleep 1; done
  fi
  echo "image $img: $i s of waiting for it" >&2
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    docker build -q -t "$img" -f "$2" "$(dirname "$2")" >/dev/null
    docker rm -f "keep-$1" >/dev/null 2>&1 || true
    docker create --name "keep-$1" "$img" >/dev/null
  fi
  grep -qx "$img" "$cache/images" 2>/dev/null || echo "$img" >> "$cache/images"
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

# The Rust toolchain, kept in ~/cache: run_in <image> "${rust[@]}" … -- cargo …
rust=(-e RUSTUP_HOME=/c/rustup -e CARGO_HOME=/c/cargo -e PATH=/c/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
# toolchain <image> [rustup toolchain install options]: stable, installed or brought up to date.
# Asks the network once a week: /c/rustup/synced lists the options done since.
toolchain() {
  local img="$1"; shift
  mkdir -p "$cache/rustup" "$cache/cargo"
  run_in "$img" "${rust[@]}" -- bash -euo pipefail -c '
    m=/c/rustup/synced new=$(find "$m" -mtime -7 2>/dev/null || true)
    if [ -n "$new" ] && { [ $# = 0 ] || grep -qxF -- "$*" "$m"; } && rustc --version; then exit 0; fi
    [ -x /c/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain none
    rustup toolchain install stable --profile minimal "$@" >/dev/null
    rustup default stable >/dev/null
    if [ -n "$new" ]; then echo "$*" >> "$m"; else echo "$*" > "$m"; fi
    rustc --version' bash "$@"
}

# apk_unsigned <image> <path under /out>: android/build.sh, unsigned, with the SDK in ~/cache. Its
# unit tests (android/test) run as part of it.
apk_unsigned() {
  mkdir -p "$cache/android"
  # HARBOR_GOOGLE_WEB_CLIENT_ID passes through when set (the release's repository variable): the
  # phone's Google account picker; unset, android/build.sh builds with it off.
  run_in "$1" -e ANDROID_BUILD=/c/android -e HARBOR_ANDROID_DEPS=/c/android/deps -e HARBOR_GOOGLE_WEB_CLIENT_ID \
    -e UNSIGNED=1 -e OUT="$2" -- bash -euo pipefail -c '
    sdk=/c/android/sdk sm=/c/android/sdk/cmdline-tools/latest/bin/sdkmanager
    if [ ! -x "$sm" ]; then
      curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/clt.zip
      mkdir -p "$sdk/cmdline-tools" /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt && mv /tmp/clt/cmdline-tools "$sdk/cmdline-tools/latest"
    fi
    if [ ! -x "$sdk/build-tools/34.0.0/aapt2" ] || [ ! -f "$sdk/platforms/android-34/android.jar" ]; then
      yes | "$sm" --sdk_root="$sdk" --licenses >/dev/null || true
      "$sm" --sdk_root="$sdk" --install "platforms;android-34" "build-tools;34.0.0" >/dev/null
    fi
    ANDROID_HOME=$sdk android/build.sh'
}
