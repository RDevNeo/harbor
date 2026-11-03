#!/bin/bash
# Compiles Harbor's Slint addon (slint-ui 1.18.1's native module, with keep-compiler-state.patch
# applied to slint-interpreter) in slint/Dockerfile's image, from /src, with Rust from /c:
#   build.sh lock                -> /out/slint/Cargo.lock (resolves the crates; commit it as slint/Cargo.lock)
#   build.sh <x86_64|aarch64>    -> /out/slint/<arch>/slint-ui.linux-<x64|arm64>-gnu.node
#   build.sh source              -> /out/slint/harbor-slint-source.tar.gz and /out/slint/licenses
#
# The addon replaces the one `bun install` brings (ts/scripts/build.ts, HARBOR_SLINT_ADDON): the same
# JavaScript API, but a compiled UI keeps only what it runs, not the compiler's state (~100 MB for
# Harbor's app.slint). SLINT_KEEP_COMPILER_STATE=1 at run time brings upstream's behaviour back.
set -euo pipefail
what=$1
recipe=/src/slint
dl=/c/slint-dl
mkdir -p "$dl" /out/slint

each_source() { grep -v -e '^#' -e '^$' "$recipe/sources"; }
file_of() { awk -v n="$1" '$1==n {print $3}' "$recipe/sources"; }

while read -r name version file sum url; do
  [ "$(sha256sum "$dl/$file" 2>/dev/null | cut -d' ' -f1)" = "$sum" ] || curl -fsSL --retry 3 -o "$dl/$file" "$url"
  echo "$sum  $dl/$file" | sha256sum -c --quiet -
done < <(each_source)

# The workspace, laid out as Slint's repository (the addon's build.rs reads
# ../../internal/core/platform.rs): the addon's crate from the npm package at api/node, beside the
# patched interpreter.
work=/tmp/slint-$what
rm -rf "$work" && mkdir -p "$work/api" "$work/internal/core"
tar -xzf "$dl/$(file_of slint-ui)" -C "$work/api" && mv "$work/api/package" "$work/api/node"
tar -xzf "$dl/$(file_of slint-interpreter)" -C "$work"
tar -xzf "$dl/$(file_of i-slint-core)" -C /tmp i-slint-core-1.18.1/platform.rs
mv /tmp/i-slint-core-1.18.1/platform.rs "$work/internal/core/platform.rs" && rmdir /tmp/i-slint-core-1.18.1
patch -p1 --quiet -d "$work/slint-interpreter-1.18.1" < "$recipe/keep-compiler-state.patch"
cat > "$work/Cargo.toml" <<'EOF'
[workspace]
members = ["api/node"]
resolver = "3"

# slint-node names this one from upstream's workspace (Windows only).
[workspace.dependencies]
windows = { version = "0.62" }

[patch.crates-io]
slint-interpreter = { path = "slint-interpreter-1.18.1" }

# As upstream's npm binaries (publish_npm_package.yaml): fat LTO, one codegen unit, abort on panic.
[profile.release]
panic = "abort"
lto = "fat"
codegen-units = 1
EOF

if [ "$what" = lock ]; then
  # Seeded with the interpreter's own published lock, so shared crates stay at the versions upstream tested.
  cp "$work/slint-interpreter-1.18.1/Cargo.lock" "$work/Cargo.lock"
  (cd "$work" && cargo update --workspace --quiet)
  cp "$work/Cargo.lock" /out/slint/Cargo.lock
  echo "<== lock: $(grep -c '^name = ' /out/slint/Cargo.lock) crates"
  exit 0
fi
lock=$recipe/Cargo.lock
[ -f "$lock" ] || { lock=/out/slint/Cargo.lock; echo "slint/Cargo.lock is missing: using the one this run resolved"; }
[ -f "$lock" ] || { echo "no slint/Cargo.lock: run build.sh lock first (scripts/boat/slint lock)" >&2; exit 1; }
cp "$lock" "$work/Cargo.lock"

if [ "$what" = source ]; then
  # Published with every release (and all the GPL would ask for): Slint's sources as built (the npm
  # package, every Slint crate it uses, the patch; slint-interpreter is the pinned crate above) and
  # how to build them again. The other crates are permissively licensed, on crates.io at the
  # versions Cargo.lock pins.
  (cd "$work" && cargo fetch --locked --quiet)
  s=/tmp/harbor-slint-source
  rm -rf "$s" && mkdir -p "$s/crates"
  cp -r "$recipe" "$s/recipe"
  cp "$lock" "$s/recipe/Cargo.lock"
  while read -r name version file sum url; do cp "$dl/$file" "$s/"; done < <(each_source)
  n=0
  while read -r crate; do
    f=$(find "${CARGO_HOME:-/c/cargo}/registry/cache" -name "$crate.crate" | head -1)
    [ -n "$f" ] || { echo "no $crate.crate in cargo's cache" >&2; exit 1; }
    cp "$f" "$s/crates/"; n=$((n + 1))
  done < <(awk '/^name = /{gsub(/"/,"",$3); n=$3} /^version = /{gsub(/"/,"",$3); v=$3} /^source = "registry/ {if (n ~ /^(i-slint-|slint)/) print n "-" v}' "$work/Cargo.lock" | sort -u)
  echo "$n Slint crates"
  tar -C /tmp -czf /out/slint/harbor-slint-source.tar.gz harbor-slint-source
  rm -rf "$s"
  mkdir -p /out/slint/licenses
  cp "$work/api/node/LICENSE.md" /out/slint/licenses/Slint-LICENSE.md
  cp "$work/api/node/LICENSES/"* /out/slint/licenses/
  cp "$recipe/NOTICE.txt" /out/slint/licenses/README.txt
  ls -la /out/slint/harbor-slint-source.tar.gz /out/slint/licenses
  exit 0
fi

arch=$what
case "$arch" in
  x86_64) t=x86_64-unknown-linux-gnu node=x64 tool="" ;;
  aarch64) t=aarch64-unknown-linux-gnu node=arm64 tool=aarch64-linux-gnu- ;;
  *) echo "no addon for $arch" >&2; exit 1 ;;
esac
s=$SECONDS
echo "== $arch build"
rustc --version
(cd "$work" && cargo build --release --locked --target "$t" -p slint-node)
so=${CARGO_TARGET_DIR:-$work/target}/$t/release/libslint_node.so
out=/out/slint/$arch
mkdir -p "$out"
cp "$so" "$out/slint-ui.linux-$node-gnu.node"
f=$out/slint-ui.linux-$node-gnu.node

echo "== $arch check"
"${tool}readelf" -d "$f" | grep NEEDED
new=$("${tool}objdump" -T "$f" | sed -n 's/.*GLIBC_\([0-9.]*\).*/\1/p' | sort -uV | tail -1)
echo "needs glibc $new"
[ "$(printf '%s\n2.35\n' "$new" | sort -V | tail -1)" = 2.35 ] || { echo "needs a glibc newer than 2.35" >&2; exit 1; }
"${tool}nm" -D --defined-only "$f" | grep -q ' napi_register_module_v1$' || { echo "it exports no napi module" >&2; exit 1; }
grep -qa SLINT_KEEP_COMPILER_STATE "$f" || { echo "the patch isn't in it" >&2; exit 1; }
[ "$(stat -c %s "$f")" -gt 10000000 ] || { echo "far too small: something got dropped" >&2; exit 1; }
ls -la "$out"
echo "== $arch done in $((SECONDS - s)) s"
