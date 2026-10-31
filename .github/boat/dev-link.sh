#!/bin/bash
# The linker of a `quick` build (dev.sh). A gap after each of Harbor's own objects, to a 16 KB boundary
# for code and 4 KB for data, so what grows stays inside its gap and what follows doesn't move: the
# patch back to the caller stays small. Without it an edit that adds a line or a string moves
# everything after it and every reference from there changes: 12 MB against some 200 KB.
args=() first=1
for a in "$@"; do
  case "$a" in
    */deps/harbor-*.rcgu.o)
      [ -z "$first" ] || args+=(/c/target/dev-first.o)
      first=""
      args+=("$a" /c/target/dev-gap.o) ;;
    *) args+=("$a") ;;
  esac
done
exec cc "${args[@]}"
