#!/bin/bash
# On the runner: run.sh <sandbox> [boat exec options] -- <command>. Starts the command detached on
# the sandbox, follows its output as text and exits with its exit code. The command doesn't hang on
# this connection: when boat's stream ends without an exit frame (its API restarted, say), this
# attaches again and goes on from the last byte printed. Only a command that really failed, or a
# sandbox that stays out of reach for 10 minutes, ends in a failure.
# boat's own failures (the command never started, the sandbox lost for 10 minutes) exit 75, apart
# from the command's codes; with RUN_RETRY=1 (a command that can simply run again, like a build or
# the install tests) such a failure starts the command once more.
set -uo pipefail
id=$1 frames=$(mktemp)
trap 'rm -f "$frames"' EXIT

once() {
  local pid= try last size now code
  : > "$frames"
  for try in 1 2 3 4 5 6; do
    pid=$(boat exec --detach --json "$@" | jq -r '.processId // empty')
    [ -z "$pid" ] || break
    sleep 10
  done
  [ -n "$pid" ] || { echo "boat: could not start the command on $id"; return 75; }

  last=$SECONDS size=0
  while :; do
    # A replay starts at byte 0: skip what is printed already, by each stream's byte offsets. A cut
    # inside a frame counts characters, so non-ASCII text may show a few letters twice.
    boat exec "$id" --attach "$pid" --json | tee -a "$frames" | jq -Rrj --unbuffered \
      --argjson out "$(jq -Rn '[inputs | fromjson? | select(.type == "stdout").nextOffset] | max // 0' "$frames")" \
      --argjson err "$(jq -Rn '[inputs | fromjson? | select(.type == "stderr").nextOffset] | max // 0' "$frames")" '
      def after($seen): if .nextOffset <= $seen then empty
        else .data[([$seen - (.nextOffset - (.data | utf8bytelength)), 0] | max):] end;
      fromjson? | if .type == "stdout" then after($out) elif .type == "stderr" then after($err)
      elif .event == "error" then "boat: \(.error)\n" else empty end'
    code=$(jq -Rr 'fromjson? | select(.type == "exit") | .exitCode // 1' "$frames" | tail -1)
    [ -z "$code" ] || return "$code"
    now=$(stat -c %s "$frames")
    [ "$now" = "$size" ] || { size=$now last=$SECONDS; }
    [ $((SECONDS - last)) -lt 600 ] || { echo "boat: lost $id for 10 minutes"; return 75; }
    echo "boat: stream ended without an exit code, attaching again"
    sleep 15
  done
}

once "$@"
code=$?
if [ "$code" = 75 ] && [ "${RUN_RETRY:-}" = 1 ]; then
  echo "::warning::boat failed us (not the command): running it once more"
  sleep 20
  once "$@"
  code=$?
fi
exit "$code"
