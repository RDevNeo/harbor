#!/bin/bash
# The linker of a `quick` build (dev.sh). A gap after each of Harbor's own objects, up to a 16 KB
# boundary, so code that grows stays inside its gap and what follows doesn't move: the patch back to
# the caller stays in the kilobytes. Without it an edit that adds a line moves everything after it
# and every reference from there changes: 12 MB against 220 KB.
args=()
for a in "$@"; do
  args+=("$a")
  case "$a" in */deps/harbor-*.rcgu.o) args+=(/c/target/dev-gap.o) ;; esac
done
exec cc "${args[@]}"
