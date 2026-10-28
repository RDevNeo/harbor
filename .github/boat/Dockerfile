# The x86_64 release build environment on a boat.dev sandbox (see build.sh). Ubuntu 22.04 so the
# binary links against glibc 2.35, the oldest base Harbor supports; the sandboxes run 24.04.
FROM ubuntu:22.04
# archive.ubuntu.com is slow from boat; boat's docs recommend the French mirror.
RUN sed -i 's#http://[a-z.]*archive.ubuntu.com#http://fr.archive.ubuntu.com#g' /etc/apt/sources.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential pkg-config libxkbcommon-dev libwayland-dev libx11-dev curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
