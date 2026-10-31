# The video engine's build environment on a boat.dev sandbox (.github/boat/video.sh). Ubuntu 22.04,
# the oldest base Harbor supports, so it needs nothing newer than glibc 2.35. The system libraries
# here give only headers: build.sh links none of them. boat has no arm64 machines, so aarch64 is
# cross-compiled.
FROM ubuntu:22.04
RUN sed -i -e 's#http://[a-z.]*archive.ubuntu.com#http://fr.archive.ubuntu.com#g' -e 's#^deb http#deb [arch=amd64] http#' /etc/apt/sources.list \
 && for s in jammy jammy-updates jammy-security; do echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $s main universe" >> /etc/apt/sources.list; done \
 && dpkg --add-architecture arm64 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential pkg-config nasm curl ca-certificates xz-utils patch python3-pip \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu binutils-aarch64-linux-gnu \
      libva-dev libegl-dev libdrm-dev libpulse-dev libasound2-dev \
      libva-dev:arm64 libegl-dev:arm64 libdrm-dev:arm64 libpulse-dev:arm64 libasound2-dev:arm64 \
 && pip3 install -q meson==1.9.1 ninja==1.13.0 jinja2==3.1.6 \
 && rm -rf /var/lib/apt/lists/*
