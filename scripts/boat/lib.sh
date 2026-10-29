# Sourced by scripts/boat/check and scripts/boat/android, on the caller's PC.
set -euo pipefail
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
export BOAT_NO_UPDATE=1
boat=$(command -v boat || true)
[ -n "$boat" ] || boat=$HOME/.ascii/bin/boat
[ -x "$boat" ] || { echo "no boat CLI (not on PATH nor at ~/.ascii/bin/boat): see --help" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is needed: see --help" >&2; exit 1; }

user=$(id -un) host=$(hostname -s 2>/dev/null || cat /etc/hostname)
prefix="dev-harbor-$user-$host-"
name="$prefix$(date +%Y%m%d-%H%M%S)-$$"
id="" work=$(mktemp -d) started=$(date +%s) job="" color=never
[ -t 1 ] && [ -z "${quiet:-}" ] && color=always
log="$work/log"

say() { printf '\033[1m[boat] %s\033[0m\n' "$*" >&2; }
named() { "$boat" list --all --json | jq -r --arg n "$1" '.sandboxes[] | select(.name == $n) | .id'; }

# Deletes dev-harbor-* sandboxes left behind: this PC's whose script is gone, and anyone's older
# than 3 h (the TTL stops them by then anyway).
sweep() {
  local now; now=$(date +%s)
  "$boat" list --all --json | jq -r '.sandboxes[] | select(.name | startswith("dev-harbor-"))
      | "\(.id) \(.name) \(.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdate)"' |
  while read -r sid sname created; do
    if [ $((now - created)) -gt 10800 ] || { [[ $sname == "$prefix"* ]] && ! kill -0 "${sname##*-}" 2>/dev/null; }; then
      say "deleting the stale sandbox $sid ($sname)"
      "$boat" delete "$sid" --yes --json >/dev/null || say "could not delete $sid"
    fi
  done || true
}

finish() {
  local code=$? sid usage
  trap - EXIT INT TERM
  set +e
  [ -z "$job" ] || kill_tree "$job"
  # By name too: `boat new` can time out after it made the sandbox.
  for sid in $( { echo "$id"; named "$name" 2>/dev/null; } | sort -u); do
    usage=$("$boat" usage "$sid" --json 2>/dev/null | jq -r '"\(.seconds)s billed, $\(.dollars * 1000 | round / 1000)"' || echo "cost unknown")
    "$boat" delete "$sid" --yes --json >/dev/null 2>&1 || "$boat" delete "$sid" --yes --json >/dev/null ||
      say "COULD NOT DELETE $sid ($name): delete it with: $boat delete $sid --yes"
    say "deleted the sandbox $sid ($usage)"
  done
  if type summary >/dev/null 2>&1; then summary >&2; fi
  if [ -n "${quiet:-}" ] && [ -s "$log" ]; then cp "$log" "/tmp/$name.log"; say "full output: /tmp/$name.log"; fi
  say "$( [ "$code" = 0 ] && echo passed || echo "FAILED (exit $code)" ) in $(( $(date +%s) - started ))s"
  rm -rf "$work"
  exit "$code"
}
trap finish EXIT
trap 'say interrupted; exit 130' INT
trap 'say terminated; exit 143' TERM

# Runs a command in the background and waits for it, so that a signal is handled at once, not
# when the command ends.
waiting() { "$@" & job=$!; wait "$job"; local c=$?; job=""; return $c; }
kill_tree() { local c; for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }

sandbox() {
  sweep
  say "creating $name (large, from harbor-build)"
  local try
  for try in 1 2 3; do
    id=$(named "$name" | head -1)
    [ -z "$id" ] || break
    local from=(--from harbor-build); [ "$try" -lt 3 ] || from=()
    id=$(waiting "$boat" new --type large "${from[@]}" --no-env --ttl 10800 --name "$name" --json 2>"$work/new.err" |
      jq -r 'select(.event == "ready") | .id' || true)
    [ -n "$id" ] || { [ "$try" = 3 ] || sleep 10; continue; }
    break
  done
  [ -n "$id" ] || { cat "$work/new.err" >&2; say "could not create a sandbox"; exit 1; }
  for try in $(seq 30); do "$boat" exec "$id" --timeout 60 -- true >/dev/null 2>&1 && break; sleep 5; done
  say "sandbox $id ready after $(( $(date +%s) - started ))s"
}

# The working tree as it is: tracked files and new ones git doesn't ignore, to ~/src.
upload() {
  (cd "$root" && git ls-files -z -co --exclude-standard | tar --null -T - --ignore-failed-read -czf "$work/src.tgz" 2>/dev/null)
  "$boat" scp "$work/src.tgz" "$id:/home/user/src.tgz" >/dev/null
  "$boat" exec "$id" -- bash -c 'mkdir -p src && tar -xzf src.tgz -C src && rm src.tgz' >/dev/null
  say "copied the working tree ($(du -h "$work/src.tgz" | cut -f1))"
}

# remote <env…> -- <command…>: run in ~/src, streamed here (unless $quiet) and kept in $log; no
# time limit.
remote() {
  local env=(COLOR="$color"); while [ "$1" != -- ]; do env+=("$1"); shift; done; shift
  set +e
  waiting bash -c 'PATH="$(dirname "$0"):$PATH" "$1/.github/boat/run.sh" "$2" --cwd src -- "${@:5}" | if [ -n "$4" ]; then cat > "$3"; else tee "$3"; fi; exit "${PIPESTATUS[0]}"' \
    "$boat" "$root" "$id" "$log" "${quiet:-}" env "${env[@]}" "$@"
  local c=$?; set -e; return $c
}
