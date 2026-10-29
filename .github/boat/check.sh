#!/bin/bash
# Run by scripts/boat/check on a boat.dev sandbox, from the copied working tree. Clippy only
# advises: the tree isn't clippy-clean.
. "$(dirname "$0")/lib.sh"
core=$(image harbor-builder .github/boat/Dockerfile)
toolchain "$core" ${CLIPPY:+--component clippy}
step() {
  local name="$1" s=$SECONDS; shift
  echo "==> $name"
  if run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target -e CARGO_TERM_COLOR="${COLOR:-always}" -- "$@"; then
    echo "<== $name ok $((SECONDS - s))s"
  else
    [ "$name" != clippy ] || { echo "<== clippy complains $((SECONDS - s))s"; return; }
    echo "<== $name FAILED $((SECONDS - s))s"; exit 1
  fi
}
step test cargo test --locked -- "$@"
[ -z "${CLIPPY:-}" ] || step clippy cargo clippy --locked --all-targets
if [ "${RELEASE:-1}" = 1 ]; then
  step release cargo build --release --locked
  cp "$cache/target/release/harbor" "$HOME/out/harbor"
fi
