#!/bin/bash
# Run by release.yml's jobs quick (x86_64) and quick-aarch64 (an arm64 runner) on the GitHub runner
# itself, for a bundle-only release (plan's where=runner: the desktop runtime is unchanged).
# The phone app builds separately when needed (.github/runner/android.sh). These release jobs are
# exceptions to "every build runs on boat" (CLAUDE.md): Bun bundles and compiles JavaScript in seconds, while a
# boat sandbox costs a minute or more to start, fill and fetch from.
#
#   build.sh x86_64|aarch64|macos OUT
#
# The same steps as .github/boat/build.sh's build_ts, minus the runtime alone (a bundle-only release
# ships none): OUT/harbor-<arch>/harbor, and on x86_64 also OUT/harbor-x86_64/harbor-app.js and
# OUT/extra (the npm notices and the 256 px icon). Harbor's Slint addon, when slint/out/<arch> holds it.
# HARBOR_VERSION, HARBOR_MIN_RUNTIME, HARBOR_GIT_SHA and the HARBOR_GOOGLE_* clients come from the
# environment, as on boat.
set -euo pipefail
arch=$1 out=$(realpath -m "$2")
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
V=${HARBOR_VERSION:?} MIN=${HARBOR_MIN_RUNTIME:-$HARBOR_VERSION} SHA=${HARBOR_GIT_SHA:-}

# Bun at the version ts/package.json pins, the same build boat uses (bun-linux-<arch>.zip, not the
# baseline one), checked against Bun's SHASUMS256.txt.
bv=$(jq -r '.packageManager | sub("bun@"; "")' ts/package.json)
ba=x64; [ "$arch" != aarch64 ] || ba=aarch64
z=bun-linux-$ba.zip base=https://github.com/oven-sh/bun/releases/download/bun-v$bv
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 "$base/$z" -o "$tmp/$z"
curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp" && grep " $z\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
unzip -q "$tmp/$z" -d "$tmp"
export PATH="$tmp/bun-linux-$ba:$PATH"
bun --version
# macOS (Apple Silicon), cross-built from a copy of the tree: OUT/harbor-macos.
if [ "$arch" = macos ]; then
  V=$V SHA=$SHA bash "$root/.github/macos-build.sh" "$root" "$out"
  exit 0
fi

cd ts
bun install --frozen-lockfile
for a in "$root"/slint/out/"$arch"/slint-ui.linux-*-gnu.node; do [ ! -f "$a" ] || export HARBOR_SLINT_ADDON=$a; done
if [ -z "${HARBOR_SLINT_ADDON:-}" ] && [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
  echo "::error::a release needs Harbor's Slint addon"; exit 1
fi
o=$out/harbor-$arch
mkdir -p "$o"
bun scripts/build.ts single "$o/harbor" --version "$V" --sha "$SHA"
[ "$arch" != x86_64 ] || bun scripts/build.ts app "$o/harbor-app.js" --version "$V" --min-runtime "$MIN" --sha "$SHA"
"$o/harbor" --version
[ -z "${HARBOR_SLINT_ADDON:-}" ] || grep -qa SLINT_KEEP_COMPILER_STATE "$o/harbor" \
  || { echo "::error::the executable lacks Harbor's Slint addon (slint/)"; exit 1; }
# The single executable is this release's runtime: the bundle must start on it.
[ ! -f "$o/harbor-app.js" ] || [ "$("$o/harbor" smoke-bundle "$o/harbor-app.js")" = "harbor $V" ]
[ "$arch" = x86_64 ] || exit 0

# What build.sh's licences and npm_notices make. A failure never stops a release.
mkdir -p "$out/extra/lic"
bun scripts/notices.ts "$out/extra/lic/third-party-harbor.txt" || echo "::warning::the npm packages' notices failed"
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 256 -h 256 "$root/packaging/harbor.svg" -o "$out/extra/harbor-256.png"
else
  # sharp's libvips draws SVG with librsvg too.
  SVG="$root/packaging/harbor.svg" PNG="$out/extra/harbor-256.png" bun -e '
    const sharp = (await import("sharp")).default;
    await sharp(process.env.SVG, { density: 384 }).resize(256, 256).png().toFile(process.env.PNG);'
fi
