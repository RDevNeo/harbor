# The release build environment on a boat.dev sandbox (see build.sh). Ubuntu 22.04 so the binaries
# link against glibc 2.35, the oldest base Harbor supports; the sandboxes run 24.04. boat has no
# arm64 machines, so aarch64 is cross-compiled.
FROM ubuntu:22.04
# archive.ubuntu.com is slow from boat; boat's docs recommend the French mirror. arm64 packages
# only exist on ports.ubuntu.com.
RUN sed -i -e 's#http://[a-z.]*archive.ubuntu.com#http://fr.archive.ubuntu.com#g' -e 's#^deb http#deb [arch=amd64] http#' /etc/apt/sources.list \
 && for s in jammy jammy-updates jammy-security; do echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $s main universe"; done > /etc/apt/sources.list.d/arm64.list \
 && dpkg --add-architecture arm64 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential pkg-config libxkbcommon-dev libwayland-dev libx11-dev curl ca-certificates git \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu binutils-aarch64-linux-gnu \
      libxkbcommon-dev:arm64 libwayland-dev:arm64 libx11-dev:arm64 \
 && rm -rf /var/lib/apt/lists/*
