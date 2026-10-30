#!/bin/bash
# On the runner, in an `if: always()` step: deletes this job's sandbox by its name, so also one whose
# id never came back, and any other ci-harbor-<run>-… sandbox whose GitHub run has ended.
set -uo pipefail
command -v boat >/dev/null || exit 0
# boat's API can be away for a minute (the sandboxes' --ttl stops them anyway): that fails no job.
for try in 1 2 3 4 5 6; do
  list=$(boat list --all --json 2>/dev/null | jq -er '.sandboxes') && break
  list=""; sleep 10
done
[ -n "$list" ] || { echo "::warning::could not list the sandboxes: delete ${BOAT_SANDBOX:-this job's} by hand if it stays"; exit 0; }
jq -r '.[] | select(.name | startswith("ci-harbor-")) | "\(.id) \(.name)"' <<<"$list" |
while read -r id name; do
  run=${name#ci-harbor-}; run=${run%%-*}
  if [ "$name" = "${BOAT_SANDBOX:-}" ] || [ "$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq .status 2>/dev/null)" = completed ]; then
    echo "deleting $id ($name)"
    boat delete "$id" --yes --json >/dev/null || echo "::warning::could not delete $id ($name)"
  fi
done
