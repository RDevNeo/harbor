#!/bin/sh
# Rewrites SHA256SUMS after changing the engine's files: Harbor checks the download against it.
cd "$(dirname "$0")" && sha256sum engine.mjs package.json bun.lock > SHA256SUMS
