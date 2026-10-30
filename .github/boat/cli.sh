#!/bin/bash
# On the runner: the boat CLI, on PATH for the rest of the job.
set -eu
[ -n "${BOAT_API_KEY:-}" ] || { echo "::error::BOAT_API_KEY is not set"; exit 1; }
mkdir -p "$HOME/.local/bin"
curl -fsSL --retry 3 "https://boat.dev/api/boat/cli/download?platform=linux-x64&channel=prod" -o "$HOME/.local/bin/boat"
chmod +x "$HOME/.local/bin/boat"
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
