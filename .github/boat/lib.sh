# Sourced by the scripts here, on a boat.dev sandbox. ~/cache is what the saved snapshots keep.
set -euo pipefail
cache="$HOME/cache"
mkdir -p "$cache" "$HOME/out"

# image <name> <dockerfile>: tagged by the Dockerfile's hash. A snapshot keeps only images that a
# container uses, hence the keep- container. Its images load in the background after the sandbox
# is ready, from seconds to many minutes later, and no docker command waits for them, so
# ~/cache/images lists the ones it should have. warm.sh therefore also saves each image as a plain
# folder in ~/cache/root: with one, there is nothing to wait for and run_in uses chroot.
image() {
  local img="$1:$(sha256sum "$2" | cut -c1-12)" root="$cache/root/$1:$(sha256sum "$2" | cut -c1-12)"
  [ ! -d "$root/usr" ] || { rootfs_up "$img"; echo "$img"; return; }
  docker_image "$1" "$2"
}
docker_image() {
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

# rootfs_save <name> <dockerfile>: the image as a folder, dropping older ones of that name.
rootfs_save() {
  local img="$1:$(sha256sum "$2" | cut -c1-12)" root c; root="$cache/root/$img"
  [ ! -d "$root/usr" ] || return 0
  docker_image "$1" "$2" >/dev/null
  find "$cache/root" -mindepth 1 -maxdepth 1 -name "$1:*" -exec rm -rf {} + 2>/dev/null || true
  mkdir -p "$root"
  c=$(docker create "$img")
  docker export "$c" | tar -x -C "$root" --anchored --exclude='dev/*' --exclude='proc/*' --exclude='sys/*' 2>/dev/null || true
  docker rm "$c" >/dev/null
  docker image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$root/.env"
}
# What a container gets from docker, for that folder, at /run/harbor/<image>: the same paths, so
# cargo's fingerprints hold. Outside ~/cache and private: mounts in the snapshot's tree leak into it.
rootfs_up() {
  local root="$cache/root/$1" m="/run/harbor/$1" d
  mountpoint -q "$m" && return
  mkdir -p "$root/src" "$root/c" "$root/out"
  sudo mkdir -p "$m"
  sudo mount --bind "$root" "$m"
  sudo mount --make-rprivate "$m"
  # rslave: these stay peers of the sandbox's own mounts otherwise, and rootfs_down's umount takes
  # /dev/pts, /dev/shm and /sys/fs/cgroup away from it too.
  for d in proc dev sys tmp; do sudo mount --rbind "/$d" "$m/$d"; sudo mount --make-rslave "$m/$d"; done
  sudo mount --bind "$PWD" "$m/src"
  sudo mount --bind "$cache" "$m/c"
  sudo mount --bind "$HOME/out" "$m/out"
  sudo cp /etc/resolv.conf "$m/etc/resolv.conf"
}
# Before a snapshot: src and out are about to go.
rootfs_down() {
  local m r
  for m in /run/harbor/*/; do ! mountpoint -q "$m" || sudo umount -R -l "$m"; done
  for r in "$cache"/root/*/; do rm -rf "${r}src" "${r}c" "${r}out"; done
  rm -rf "$cache/rootfs"  # from before tar's exclusions were anchored: no sys/ headers
}

# run_in <image> [docker options: only -e] -- <command>. The source is always mounted at /src:
# cargo's fingerprints include the path.
run_in() {
  local img="$1" opts=() root="$cache/root/$1"; shift
  while [ "$1" != -- ]; do opts+=("$1"); shift; done; shift
  if [ -d "$root/usr" ]; then
    # A clean environment, as in a container (tests notice LC_ALL), but for what was asked for.
    ( local i kv keep=" HOME PATH CARGO_TERM_COLOR "
      while IFS= read -r kv; do [ -z "$kv" ] || { export "$kv"; keep+=" ${kv%%=*} "; }; done < "$root/.env"
      for ((i = 1; i < ${#opts[@]}; i += 2)); do
        case "${opts[$i]}" in *=*) export "${opts[$i]}" ;; esac
        keep+=" ${opts[$i]%%=*} "
      done
      for kv in $(compgen -e); do [[ $keep == *" $kv "* ]] || unset "$kv"; done
      export CARGO_TERM_COLOR=${CARGO_TERM_COLOR:-always}
      # sudo -E: values stay off the command line (build.sh's Google secrets).
      # What sudo adds comes off again.
      local drop=()
      for kv in USER USERNAME LOGNAME SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND SUDO_HOME LANG LANGUAGE LC_ALL; do
        [[ $keep == *" $kv "* ]] || drop+=(-u "$kv")
      done
      exec sudo -E env "${drop[@]}" "PATH=$PATH" HOME=/tmp \
        chroot --userspec="$(id -u):$(id -g)" "/run/harbor/$img" /bin/sh -c 'cd /src && exec "$@"' sh "$@" )
    return
  fi
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_TERM_COLOR=always \
    -v "$cache:/c" -v "$PWD:/src" -v "$HOME/out:/out" -w /src "${opts[@]}" "$img" "$@"
}

# cpu_mark, then cpu_report: where this sandbox's CPU time went, to tell a slow run's cause. Busy
# for all of it is the work itself, idle means waiting (the lazy disk, the network; FUSE waits count
# as idle), steal is another VM on the machine.
cpu_mark() { cpu0=$(sed 1q /proc/stat); }
cpu_report() {
  local a b i t=0 d=(); read -ra a <<< "$cpu0"; read -ra b < /proc/stat
  for i in 1 2 3 4 5 6 7 8; do d[i]=$((b[i] - a[i])); t=$((t + d[i])); done
  echo "cpu: user $((100 * (d[1] + d[2]) / t))%, system $((100 * (d[3] + d[6] + d[7]) / t))%, idle $((100 * d[4] / t))%, iowait $((100 * d[5] / t))%, steal $((100 * d[8] / t))%"
}

binfmt() {
  docker run --privileged --rm tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64 >/dev/null
}

# Bun, the app's runtime and compiler, at the version ts/package.json pins: bun_get <image>
# <x64|aarch64> leaves it in ~/cache/bun/<version>-<arch>/bun, checked against Bun's
# SHASUMS256.txt (downloaded inside <image>, which has curl and python3), and prints that folder as
# a container sees it (/c/bun/…). Downloads once per version.
bun_version() { sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' ts/package.json; }
bun_get() {
  local img="$1" arch="$2" v; v=$(bun_version)
  [ -n "$v" ] || { echo "no bun version in ts/package.json" >&2; return 1; }
  if [ ! -x "$cache/bun/$v-$arch/bun" ]; then
    run_in "$img" -e V="$v" -e A="$arch" -- bash -euo pipefail -c '
      d=/c/bun/$V-$A z=bun-linux-$A.zip base=https://github.com/oven-sh/bun/releases/download/bun-v$V
      rm -rf "$d.tmp" && mkdir -p "$d.tmp" && cd "$d.tmp"
      curl -fsSL --retry 3 "$base/$z" -o "$z"
      curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o SHASUMS256.txt
      grep " $z\$" SHASUMS256.txt | sha256sum -c - >&2
      python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(\".\")" "$z"
      install -m755 "bun-linux-$A/bun" bun.bin
      mkdir -p "$d" && mv bun.bin "$d/bun" && cd / && rm -rf "$d.tmp"' >&2
  fi
  echo "/c/bun/$v-$arch"
}

# The Rust toolchain for Harbor's Slint addon (slint.sh), kept in ~/cache: run_in <image> "${rust[@]}" … -- cargo …
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

# android_sdk <image> [sdkmanager packages…]: the SDK in ~/cache/android/sdk with what android/build.sh
# needs (platform and build-tools 34), plus the packages given (phoneshot.sh: the emulator).
android_sdk() {
  local img="$1"; shift
  mkdir -p "$cache/android"
  run_in "$img" -- bash -euo pipefail -c '
    sdk=/c/android/sdk sm=/c/android/sdk/cmdline-tools/latest/bin/sdkmanager
    if [ ! -x "$sm" ]; then
      curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/clt.zip
      mkdir -p "$sdk/cmdline-tools" /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt && mv /tmp/clt/cmdline-tools "$sdk/cmdline-tools/latest"
    fi
    want=()
    [ -x "$sdk/build-tools/34.0.0/aapt2" ] || want+=("build-tools;34.0.0")
    [ -f "$sdk/platforms/android-34/android.jar" ] || want+=("platforms;android-34")
    for p in "$@"; do [ -f "$sdk/${p//;//}/package.xml" ] || want+=("$p"); done
    [ ${#want[@]} = 0 ] && exit 0
    yes | "$sm" --sdk_root="$sdk" --licenses >/dev/null || true
    "$sm" --sdk_root="$sdk" --install "${want[@]}" >/dev/null' bash "$@"
}

# apk_unsigned <image> <path under /out>: android/build.sh, unsigned, with the SDK in ~/cache. Its
# unit tests (android/test) run as part of it.
apk_unsigned() {
  android_sdk "$1"
  # HARBOR_GOOGLE_WEB_CLIENT_ID passes through when set (the release's repository variable): the
  # phone's Google account picker; unset, android/build.sh builds with it off.
  run_in "$1" -e ANDROID_BUILD=/c/android -e HARBOR_ANDROID_DEPS=/c/android/deps -e HARBOR_GOOGLE_WEB_CLIENT_ID \
    -e UNSIGNED=1 -e OUT="$2" -- bash -euo pipefail -c 'ANDROID_HOME=/c/android/sdk android/build.sh'
}
