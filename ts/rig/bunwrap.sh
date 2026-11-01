#!/bin/bash
# BUN for run.sh under cost.py: the window's process gets $HTS_BUNFLAGS (profiler, preloads); `bun install` runs plain.
[ "$1" = install ] && exec "$BUNBIN" "$@"
exec "$BUNBIN" $HTS_BUNFLAGS "$@"
