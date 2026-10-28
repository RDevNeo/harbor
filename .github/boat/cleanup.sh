#!/bin/bash
# On the runner, in an `if: always()` step: deletes this job's sandbox by its name, so also one whose
# id never came back, and any other ci-harbor-<run>-… sandbox whose GitHub run has ended.
set -uo pipefail
command -v boat >/dev/null || exit 0
boat list --all --json | jq -r '.sandboxes[] | select(.name | startswith("ci-harbor-")) | "\(.id) \(.name)"' |
while read -r id name; do
  run=${name#ci-harbor-}; run=${run%%-*}
  if [ "$name" = "${BOAT_SANDBOX:-}" ] || [ "$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq .status 2>/dev/null)" = completed ]; then
    echo "deleting $id ($name)"
    boat delete "$id" --yes --json >/dev/null || echo "::warning::could not delete $id ($name)"
  fi
done
