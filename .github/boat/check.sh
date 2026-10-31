#!/bin/bash
# Run by scripts/boat/check on a boat.dev sandbox, from the copied working tree. Clippy only
# advises: the tree isn't clippy-clean.
. "$(dirname "$0")/lib.sh"
core=$(image harbor-builder .github/boat/Dockerfile)
toolchain "$core" ${CLIPPY:+--component clippy}
cargo_in() { run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target -e CARGO_TERM_COLOR="${COLOR:-always}" -- "$@" 2>&1 | tee "$HOME/step.log"; }
step() {
  local name="$1" s=$SECONDS profile=debug ok=; shift
  [ "$name" != release ] || profile=release
  echo "==> $name"
  if cargo_in "$@"; then
    ok=1
  elif grep -qE 'failed to link or copy|failed to run custom build command|could not (find|read) .*fingerprint' "$HOME/step.log"; then
    # The snapshot's warm target lost files its fingerprints still count on: the build scripts'
    # first (relink.sh), and only then that profile from clean (the summary shows it as "<step>
    # rebuilt clean").
    bash .github/boat/relink.sh "$cache/target/$profile"
    if cargo_in "$@"; then
      ok=1
    else
      echo "<== $name rebuilt clean (warm target broken: $profile wiped)"
      rm -rf "$cache/target/$profile"
      ! cargo_in "$@" || ok=1
    fi
  fi
  if [ -n "$ok" ]; then
    echo "<== $name ok $((SECONDS - s))s"
  else
    [ "$name" != clippy ] || { echo "<== clippy complains $((SECONDS - s))s"; return; }
    echo "<== $name FAILED $((SECONDS - s))s"; exit 1
  fi
}
bash .github/boat/relink.sh "$cache/target/debug" "$cache/target/release"
step test cargo test --locked -- "$@"
[ -z "${CLIPPY:-}" ] || step clippy cargo clippy --locked --all-targets
if [ "${RELEASE:-1}" = 1 ]; then
  step release cargo build --release --locked
  cp "$cache/target/release/harbor" "$HOME/out/harbor"
fi
