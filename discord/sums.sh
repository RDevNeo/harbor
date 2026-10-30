#!/bin/sh
# Rewrites SHA256SUMS after changing the shell's files: Harbor checks the download against it.
cd "$(dirname "$0")" && sha256sum main.js preload.js scratch.js package.json tools.json page/harbor.js > SHA256SUMS
