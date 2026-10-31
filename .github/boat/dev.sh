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
  # What the snapshot keeps for other builds. After a long stop the whole disk loads again and every
  # build crawls until it's done: 130 s against 4 s. 6 GB instead of 31.
  rm -rf "$cache/target-aarch64" "$cache/android" "$cache/target/debug" "$cache/target/release"
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

# Code and data stay in place between builds, for a small patch: 2 MB alignment against what grows
# in front of them, dev-link.sh between Harbor's objects, no unwind tables (panic=abort doesn't need
# them, and they shift with every function), and enough codegen units that rustc doesn't merge any:
# merging by size moves functions between objects on any edit. On this one crate only: dependencies
# build once.
for g in gap first; do
  [ "$cache/target/dev-$g.o" -nt ".github/boat/dev-$g.s" ] || run_in "$core" "${rust[@]}" -- cc -c "/src/.github/boat/dev-$g.s" -o "/c/target/dev-$g.o"
done
quietly cargo_in rustc --locked --profile quick --bin harbor -- -C linker=/src/.github/boat/dev-link.sh \
  -C codegen-units=4096 -C force-unwind-tables=no -C link-arg=-Wl,-z,separate-code -C link-arg=-Wl,-z,max-page-size=0x200000
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
