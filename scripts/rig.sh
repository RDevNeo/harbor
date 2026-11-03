# Shared by scripts/shot and scripts/preview (sourced, not run). A rig runs on a PC someone is using:
# at the lowest CPU and disk priority, on at most two cores, so it never slows them down.

rig_base=$HOME/.cache/harbor-shots

# The CPUs a rig may use: HARBOR_RIG_CPUS (taskset's list, like "2,3"; "all" for no pinning), else the
# last two this process may run on.
rig_cpus() {
  if [ -n "${HARBOR_RIG_CPUS:-}" ]; then echo "$HARBOR_RIG_CPUS"; return; fi
  local list ids=() part i
  list=$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status)
  IFS=, read -ra parts <<< "${list:-0}"
  for part in "${parts[@]}"; do
    if [[ $part == *-* ]]; then for ((i = ${part%-*}; i <= ${part#*-}; i++)); do ids+=("$i"); done; else ids+=("$part"); fi
  done
  if [ ${#ids[@]} -ge 2 ]; then echo "${ids[-2]},${ids[-1]}"; else echo "${ids[0]}"; fi
}

# Runs the calling script again under nice 19, idle I/O and rig_cpus (once: its children inherit them).
# Usage, first thing in the script: rig_quiet "$0" "$@"
rig_quiet() {
  [ -z "${HARBOR_RIG_QUIET:-}" ] || return 0
  export HARBOR_RIG_QUIET=1
  local cpus pre=(nice -n 19)
  cpus=$(rig_cpus)
  ! command -v ionice > /dev/null || pre+=(ionice -c 3)
  [ "$cpus" = all ] || ! command -v taskset > /dev/null || pre+=(taskset -c "$cpus")
  exec "${pre[@]}" "$@"
}

# bun install in $2 (ts/) only when its lockfile changed since the last rig of this tree ($3: the tree).
rig_install() {
  local bun=$1 ts=$2 root=$3 stamp lock log
  stamp=$rig_base/.installed-$(printf %s "$root" | md5sum | cut -c1-12)
  lock=$(cat "$ts/bun.lock" "$ts/package.json" | md5sum | cut -c1-32)
  [ ! -d "$ts/node_modules" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$lock" ] || return 0
  mkdir -p "$rig_base"; chmod 700 "$rig_base"; log=$(mktemp "$rig_base/.install.XXXXXX")
  (cd "$ts" && "$bun" install --frozen-lockfile > "$log" 2>&1) || { cat "$log" >&2; rm -f "$log"; echo "rig: bun install failed" >&2; return 1; }
  rm -f "$log"; echo "$lock" > "$stamp"
}

# A cleaned copy of this PC's harbor.db (copydb.ts), shared by every rig: made again with $3=1, or once the
# real one changed and the copy is over 10 minutes old. Prints its path; nothing when there's no harbor.db.
rig_db() {
  local bun=$1 ts=$2 fresh=$3 real db key
  real="${XDG_DATA_HOME:-$HOME/.local/share}/harbor/harbor.db"
  [ -f "$real" ] || return 0
  db=$rig_base/.db/harbor.db
  key="$(stat -c '%Y %s' "$real" "$real-wal" 2>/dev/null | tr '\n' ' ')"
  if [ "$fresh" = 1 ] || [ ! -f "$db" ] || { [ "$(cat "$rig_base/.db/key" 2>/dev/null)" != "$key" ] && [ -n "$(find "$db" -mmin +10)" ]; }; then
    mkdir -p "$rig_base/.db"; chmod 700 "$rig_base" "$rig_base/.db"; rm -f "$db.new"
    (cd "$ts" && "$bun" packages/ui/src/copydb.ts "$real" "$db.new" > /dev/null) && mv "$db.new" "$db" && echo "$key" > "$rig_base/.db/key" ||
      { echo "rig: copying harbor.db failed" >&2; return 1; }
    echo "rig: copied harbor.db" >&2
  fi
  echo "$db"
}
