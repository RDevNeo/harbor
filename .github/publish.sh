#!/bin/bash
# Run by release.yml (job package for a bundle-only release, job publish otherwise) from the checkout,
# with the signed release files in dist/: creates the GitHub release, then tells the account worker,
# which reads GitHub itself and answers every waiting PC (their long poll on /v1/release/wait).
set -eu
ver="${GITHUB_REF_NAME#v}"
# This version's CHANGELOG section, then GitHub's generated notes.
awk -v v="$ver" '$0 ~ "^## \\[?"v"\\]?" {on=1; next} on && /^## / {exit} on' CHANGELOG.md > "$RUNNER_TEMP/notes.md"
printf '\n**Install:** `curl -fsSL https://github.com/%s/releases/latest/download/install.sh | sh`\n' "$GITHUB_REPOSITORY" >> "$RUNNER_TEMP/notes.md"
printf '\n**Android:** download `harbor-android.apk` below, or scan the install QR code in Harbor › Settings › Phones.\n' >> "$RUNNER_TEMP/notes.md"
pre=""
case "$ver" in *-*) pre="--prerelease" ;; esac
gh release create "$GITHUB_REF_NAME" dist/* --title "Harbor $ver" --notes-file "$RUNNER_TEMP/notes.md" --generate-notes $pre
curl -fsS --retry 3 -X POST "$HARBOR_WORKER/v1/release" -H 'content-type: application/json' -d "{\"version\":\"$ver\"}" \
  || echo "::warning::the worker could not be reached, so PCs find the release on their own"
