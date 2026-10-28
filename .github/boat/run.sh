#!/bin/bash
# On the runner: run.sh <sandbox> [boat exec options] -- <command>. Off a terminal boat exec prints
# JSON frames; this prints their text and exits with the command's exit code.
set -uo pipefail
frames=$(mktemp)
boat exec --timeout 0 --stream --json "$@" | tee "$frames" | jq -j --unbuffered '
  if .type == "stdout" or .type == "stderr" then .data
  elif .event == "error" then "boat: \(.error)\n"
  else empty end'
code=$(jq -r 'select(.type == "exit") | .exitCode // 1' "$frames" | tail -1)
rm -f "$frames"
exit "${code:-1}"
