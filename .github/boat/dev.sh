#!/bin/bash
# Run by scripts/boat/dev on its warm sandbox, from the synced working tree in ~/src.
#   dev.sh setup                the first time: the build folder, the toolchain, a first build
#   dev.sh check                cargo check
#   dev.sh build <sha256|"">    a `quick` build, and the way back for the caller, who has the
#                               binary with that hash: a patch inline if it's small, else in ~/www
# Prints "@@ <key> <value>" lines for the caller, each phase's time in ms among them.
. "$(dirname "$0")/lib.sh"
mode=$1 base=${2:-}
builds="$HOME/builds" www="$HOME/www" port=8799
mkdir -p "$builds" "$www"
# One build at a time: the sandbox is shared by every PC of the account.
exec 9>"$HOME/dev.lock"
flock 9
now() { date +%s%3N; }
t=$(now)
lap() { local n; n=$(now); echo "@@ $1 $((n - t))"; t=$n; }

if [ "$mode" = setup ]; then
  rootfs_save harbor-builder .github/boat/Dockerfile
fi
core=$(image harbor-builder .github/boat/Dockerfile)
[ "$mode" != setup ] || toolchain "$core"
lap mount
cargo_in() { run_in "$core" "${rust[@]}" -e CARGO_TARGET_DIR=/c/target -e CARGO_TERM_COLOR=never -- cargo "$@"; }
# Warnings and errors, not the crates going by.
quietly() {
  local c=0
  "$@" > "$HOME/step.log" 2>&1 || c=$?
  grep -vE '^\s+(Compiling|Checking|Fresh|Downloading|Downloaded|Locking|Updating) ' "$HOME/step.log" || true
  return "$c"
}

if [ "$mode" = check ]; then
  quietly cargo_in check --locked
  lap check
  exit
fi

# 2 MB alignment: data growing in front of the code doesn't move it. dev-link.sh does the same
# between Harbor's objects. On this one crate only, so the dependencies are built once.
if [ ! -f "$cache/target/dev-gap.o" ]; then
  printf '.section .text.zzgap,"axR",@progbits\n.p2align 14\nnop\n' > "$cache/dev-gap.s"
  run_in "$core" "${rust[@]}" -- cc -c /c/dev-gap.s -o /c/target/dev-gap.o
fi
quietly cargo_in rustc --locked --profile quick --bin harbor -- -C linker=/src/.github/boat/dev-link.sh \
  -C link-arg=-Wl,-z,separate-code -C link-arg=-Wl,-z,max-page-size=0x200000
lap build
bin="$cache/target/quick/harbor"
sha=$(sha256sum "$bin" | cut -c1-64)
keep="$builds/$sha"
cp "$bin" "$keep"
ls -t "$builds" | tail -n +5 | while read -r old; do rm -f "$builds/$old"; done
echo "@@ sha $sha"
echo "@@ size $(stat -c %s "$keep")"
[ "$mode" != setup ] || exit 0

# A server for what's too large for a command's output. A service, not a child: it must not hold
# this script's lock or output, and a stop takes it along.
systemctl is-active -q harbor-dev-www || sudo systemd-run -q --unit=harbor-dev-www --working-directory="$www" --uid="$(id -u)" python3 -m http.server "$port"
if [ "$base" = "$sha" ]; then
  echo "@@ same 1"
elif [ -n "$base" ] && [ -f "$builds/$base" ]; then
  zstd -q -3 -T0 --long=28 -f --patch-from="$builds/$base" "$keep" -o "$www/patch"
  echo "@@ patch $(stat -c %s "$www/patch")"
  lap diff
  if [ "$(stat -c %s "$www/patch")" -le 1500000 ]; then
    echo "@@ inline $(base64 -w0 "$www/patch")"
  fi
else
  zstd -q -3 -T0 --long=28 -f "$keep" -o "$www/whole"
  echo "@@ whole $(stat -c %s "$www/whole")"
  lap pack
fi
