# The Slint addon's build environment on a boat.dev sandbox (.github/boat/slint.sh). Ubuntu 22.04,
# the oldest base Harbor supports, as upstream's own npm build (glibc 2.35). boat has no arm64
# machines, so aarch64 is cross-compiled against the arm64 packages. Rust comes from ~/cache
# (lib.sh `toolchain`); Skia comes prebuilt (skia-bindings downloads it).
FROM ubuntu:22.04
RUN sed -i -e 's#http://[a-z.]*archive.ubuntu.com#http://fr.archive.ubuntu.com#g' -e 's#^deb http#deb [arch=amd64] http#' /etc/apt/sources.list \
 && for s in jammy jammy-updates jammy-security; do echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $s main universe" >> /etc/apt/sources.list; done \
 && dpkg --add-architecture arm64 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential clang pkg-config python3 curl ca-certificates git xz-utils patch \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu binutils-aarch64-linux-gnu \
      libxkbcommon-dev libudev-dev libinput-dev libgbm-dev libfontconfig-dev libfreetype-dev libwayland-dev \
      libxkbcommon-dev:arm64 libudev-dev:arm64 libinput-dev:arm64 libgbm-dev:arm64 libfontconfig-dev:arm64 \
      libfreetype-dev:arm64 libwayland-dev:arm64 \
 && rm -rf /var/lib/apt/lists/*
