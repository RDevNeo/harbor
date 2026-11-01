#!/bin/bash
# install-one.sh install BINARY [--wait S] [--no-trigger] | trigger | undo [--restore-db] [--wait S] | restart | status
# Puts the TypeScript Harbor (one executable) where the Rust one is installed, and back.
set -uo pipefail

EXPECT_RUST=${HARBOR_EXPECT_RUST:-0.109.0}
DB_VERSION=8
LIB=${HARBOR_LIB:-$HOME/.local/lib/harbor}
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/harbor
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/harbor
BACKUPS=${XDG_STATE_HOME:-$HOME/.local/state}/harbor-switch
EXE=$LIB/harbor
WAIT=30
RESTORE_DB=0
TRIGGER=1

say() { printf '%s\n' "$*"; }
die() { printf 'install-one: %s\n' "$*" >&2; exit 1; }

version_of() { "$1" --version 2>/dev/null | sed -n 's/^harbor \([^ ]*\).*/\1/p' | head -1; }
is_ts() { case "$1" in *-ts*) return 0 ;; *) return 1 ;; esac; }
is_elf() { [ -f "$1" ] && [ "$(head -c 4 "$1" | od -An -c | tr -d ' ')" = '177ELF' ]; }
inode() { stat -L -c %i "$1" 2>/dev/null; }

sql() {
  if command -v sqlite3 > /dev/null; then sqlite3 -readonly "$1" "$2"
  else python3 -I -c 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); [print("|".join(map(str,r))) for r in c.execute(sys.argv[2])]' "$1" "$2"
  fi
}
vacuum_into() {
  if command -v sqlite3 > /dev/null && [[ $2 != *"'"* ]]; then sqlite3 -readonly "$1" "vacuum into '$2'"; return; fi
  python3 -I -c 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); c.execute("vacuum into ?",(sys.argv[2],)); c.close()' "$1" "$2"
}

app_pids() {
  local p exe args
  for p in /proc/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    [ "${exe% (deleted)}" = "$EXE" ] || continue
    args=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | sed 's/ *$//')
    case "${args#* }" in
      "$args" | --background) echo "${p#/proc/}" ;;
    esac
  done
}

turn_pids() {
  local p exe
  for p in /proc/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    [ "${exe% (deleted)}" = "$EXE" ] || continue
    [ "$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null | sed -n 2p)" = turn ] && echo "${p#/proc/}"
  done
}

wait_exec() {
  local want=$1 pid=$2 i
  for ((i = 0; i < WAIT * 2; i++)); do
    [ -d "/proc/$pid" ] || return 2
    [ "$(inode "/proc/$pid/exe")" = "$want" ] && return 0
    sleep 0.5
  done
  return 1
}

wait_app() {
  local want=$1 i p
  for ((i = 0; i < WAIT * 2; i++)); do
    for p in $(app_pids); do [ "$(inode "/proc/$p/exe")" = "$want" ] && { echo "$p"; return 0; }; done
    sleep 0.5
  done
  return 1
}

restart_now() {
  local pid=$1 env_file args_file cwd
  env_file=$(mktemp) && args_file=$(mktemp) || die "no temp file"
  tr '\0' '\n' < "/proc/$pid/environ" | grep -v '^HARBOR_RELOADED_PID=' > "$env_file"
  tr '\0' '\n' < "/proc/$pid/cmdline" | tail -n +2 > "$args_file"
  cwd=$(readlink "/proc/$pid/cwd") || cwd=$HOME
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 40); do [ -d "/proc/$pid" ] || break; sleep 0.25; done
  [ -d "/proc/$pid" ] && { kill -KILL "$pid" 2>/dev/null; sleep 0.5; }
  (cd "$cwd" && mapfile -t E < "$env_file" && mapfile -t A < "$args_file" && rm -f "$env_file" "$args_file" &&
    exec setsid -f env -i "${E[@]}" "$EXE" "${A[@]}" < /dev/null > /dev/null 2>&1)
}

# A pairing token from before accounts works in full over loopback: the phone's Update, which restarts the Rust app in place.
legacy_token() {
  sql "$DATA/harbor.db" "select v from kv where k='api_tokens'" 2>/dev/null |
    python3 -I -c 'import json,sys
try: ts=json.loads(sys.stdin.read() or "[]")
except Exception: ts=[]
print(next((t["token"] for t in ts if isinstance(t,dict) and t.get("token") and not t.get("account")), ""))'
}

api_port() {
  local p
  p=$(sql "$DATA/harbor.db" "select v from kv where k='api_port'" 2>/dev/null)
  echo "${p:-47930}"
}

trigger() {
  local tok port i code
  command -v curl > /dev/null || { say "No curl: can't press Update for Harbor."; return 1; }
  tok=$(legacy_token)
  [ -n "$tok" ] || { say "No pairing token from before accounts on this PC: can't press Update for Harbor from here; click Update in Harbor, or Update on the phone's banner."; return 1; }
  port=$(api_port)
  sleep 3.5
  for ((i = 0; i < 15; i++)); do
    code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" -X POST -d '{}' "http://127.0.0.1:$port/v1/hub/update")
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || { say "Harbor's phone API on port $port answered ${code:-nothing} to Update."; return 1; }
  say "Pressed Update in the running Harbor (the phone's Update over loopback): it restarts in place and keeps its screen."
}

check_layout() {
  [ "$(stat -c %u "$LIB" 2>/dev/null)" = "$(id -u)" ] || die "run it as the user who owns $LIB"
  [ -d "$LIB" ] || die "no Harbor install folder at $LIB"
  [ -f "$LIB/.managed" ] || die "$LIB has no .managed marker: it wasn't installed by install.sh"
  [ -e "$LIB/.staging" ] && die "$LIB/.staging exists: an update is being installed; try again in a few minutes"
  is_elf "$EXE" || die "$EXE is not a program"
  [ -f "$DATA/harbor.db" ] || die "no $DATA/harbor.db"
  [ -f "$STATE/identity.pem" ] || die "no $STATE/identity.pem"
  local p
  for p in /proc/[0-9]*; do
    [ "$(readlink "$p/exe" 2>/dev/null | sed 's/ (deleted)$//')" = "$LIB/harbor-preview" ] && die "a live preview runs (pid ${p#/proc/}): go back to the release first (harbor preview off)"
  done
}

backup() {
  local when dir uv
  uv=$(sql "$DATA/harbor.db" "pragma user_version") || die "can't read $DATA/harbor.db"
  [ "$uv" = "$DB_VERSION" ] || die "harbor.db is at schema $uv; this app reads $DB_VERSION"
  when=$(date -u +%Y%m%dT%H%M%SZ)
  dir=$BACKUPS/$when
  (umask 077 && mkdir -p "$dir") || die "can't make $dir"
  chmod 700 "$BACKUPS" "$dir"
  vacuum_into "$DATA/harbor.db" "$dir/harbor.db" || die "the database backup (VACUUM INTO) failed"
  [ "$(sql "$dir/harbor.db" "pragma integrity_check")" = ok ] || die "the database backup in $dir fails integrity_check"
  cp -p "$STATE/identity.pem" "$dir/identity.pem" || die "can't copy identity.pem"
  for f in "$DATA/secrets.json" "$STATE/account.json"; do
    [ -f "$f" ] && { cp -p "$f" "$dir/" || die "can't copy $f"; }
  done
  sql "$dir/harbor.db" "select k from kv order by k" > "$dir/kv-keys.txt" || die "can't list the kv keys"
  if [ -d "$LIB/.previous" ]; then cp -a "$LIB/.previous" "$dir/previous" || die "can't keep $LIB/.previous"; fi
  cp -p "$LIB/VERSION" "$dir/VERSION" 2>/dev/null
  chmod -R go-rwx "$dir"
  ln -sfn "$when" "$BACKUPS/latest"
  BACKUP=$dir
}

install_cmd() {
  local new=$1 nv rv tmp want pid pids
  [ -n "$new" ] || die "usage: install-one.sh install /path/to/harbor"
  new=$(readlink -f "$new")
  is_elf "$new" || die "$new is not a program"
  nv=$(version_of "$new")
  is_ts "$nv" || die "$new says it is '${nv:-nothing}', not the TypeScript Harbor"
  [ "$("$new" runtime-version 2>/dev/null)" = "$nv" ] || die "$new doesn't answer runtime-version as $nv"
  "$new" --check-native > /dev/null 2>&1 || die "$new --check-native fails: its native parts don't load here"
  check_layout
  rv=$(version_of "$EXE")
  if is_ts "$rv"; then
    if cmp -s "$new" "$EXE"; then say "Already installed: $EXE is $rv. Nothing to do."; exit 0; fi
    [ -f "$LIB/.previous/harbor" ] && ! is_ts "$(version_of "$LIB/.previous/harbor")" || die "$EXE is another TypeScript build ($rv) and .previous holds no Rust Harbor to go back to"
    say "Replacing TypeScript $rv with $nv; .previous keeps the Rust Harbor."
  else
    [ "$rv" = "$EXPECT_RUST" ] || die "$EXE is Harbor ${rv:-unknown}; this switch is for Rust $EXPECT_RUST (HARBOR_EXPECT_RUST=... to override)"
    [ "$(cat "$LIB/VERSION" 2>/dev/null)" = "$rv" ] || die "$LIB/VERSION says '$(cat "$LIB/VERSION" 2>/dev/null)', but $EXE is $rv: an update is half done"
  fi
  pids=$(app_pids)
  backup
  say "Backup: $BACKUP (harbor.db by VACUUM INTO, identity.pem, secrets.json, account.json, kv keys, .previous), mode 0700."
  tmp=$LIB/.harbor-ts.new
  cp "$new" "$tmp" && chmod 755 "$tmp" || die "can't copy $new into $LIB"
  cmp -s "$new" "$tmp" || die "the copy in $tmp differs from $new"
  if ! is_ts "$rv"; then
    rm -rf "$LIB/.previous" && mkdir -p "$LIB/.previous" || die "can't make $LIB/.previous"
    printf '%s' "$rv" > "$LIB/.previous/VERSION"
    ln "$EXE" "$LIB/.previous/harbor" 2>/dev/null || cp -p "$EXE" "$LIB/.previous/harbor" || die "can't keep the Rust harbor in .previous"
    say "Kept Rust $rv in $LIB/.previous/harbor (Restore previous version puts it back)."
  fi
  printf '%s' "$nv" > "$LIB/VERSION.new" && mv -f "$LIB/VERSION.new" "$LIB/VERSION" || die "can't write $LIB/VERSION"
  rm -f "$LIB/.skip"
  mv -f "$tmp" "$EXE" || die "can't move the new harbor into place"
  want=$(inode "$EXE")
  local swapped_at=$SECONDS
  say "Swapped: $EXE is now $nv (Rust $EXPECT_RUST was $rv)."
  if [ -z "$pids" ]; then say "Harbor wasn't running: the next start opens the TypeScript app."; exit 0; fi
  if is_ts "$rv"; then
    if pid=$(wait_app "$want"); then say "Harbor restarted into $nv (pid $pid); turns running: $(turn_pids | wc -w)."
    else say "The running TypeScript Harbor didn't restart within ${WAIT}s: 'install-one.sh restart' does it now."; fi
    exit 0
  fi
  [ "$TRIGGER" = 1 ] && trigger
  for pid in $pids; do
    if wait_exec "$want" "$pid"; then
      say "Harbor (pid $pid) restarted in place into $nv $((SECONDS - swapped_at)) s after the swap; turns running: $(turn_pids | wc -w)."
    elif [ -d "/proc/$pid" ]; then
      say "Harbor (pid $pid) hasn't restarted yet. It switches by itself when nobody sees it (window closed, or focused and untouched for 2 minutes, updating automatically), or when Update is clicked in it. 'install-one.sh restart' restarts it now (turns keep running; the screen and unsent queue are not kept)."
    else
      say "Harbor (pid $pid) exited instead of restarting; start Harbor again (it is $nv now)."
    fi
  done
}

undo_cmd() {
  local rv pv want pid pids b
  [ -f "$LIB/.managed" ] || die "$LIB has no .managed marker"
  rv=$(version_of "$EXE")
  b=$BACKUPS/latest
  if ! is_ts "$rv"; then
    say "Already Rust: $EXE is Harbor ${rv:-unknown}."
  else
    [ -f "$LIB/.previous/harbor" ] || die "$EXE is the TypeScript Harbor ($rv) but $LIB/.previous/harbor is gone; the Rust binary is in the release archive"
    pv=$(version_of "$LIB/.previous/harbor")
    ! is_ts "$pv" && [ -n "$pv" ] || die "$LIB/.previous/harbor is '${pv:-unreadable}', not a Rust Harbor"
    pids=$(app_pids)
    cp -p "$LIB/.previous/harbor" "$LIB/.harbor-rust.new" || die "can't copy the Rust harbor"
    printf '%s' "$pv" > "$LIB/VERSION.new" && mv -f "$LIB/VERSION.new" "$LIB/VERSION" || die "can't write $LIB/VERSION"
    mv -f "$LIB/.harbor-rust.new" "$EXE" || die "can't move the Rust harbor into place"
    want=$(inode "$EXE")
    rm -f "$LIB/starting.json" "$LIB/rolled-back.json" "$LIB/RUNTIME"
    case "$(cat "$LIB/.skip" 2>/dev/null)" in *-ts*) rm -f "$LIB/.skip" ;; esac
    rm -rf "$LIB/.previous"
    [ -d "$b/previous" ] && cp -a "$b/previous" "$LIB/.previous"
    say "Swapped back: $EXE is Rust $pv again."
    if [ -n "$pids" ] && [ "$RESTORE_DB" = 0 ]; then
      if pid=$(wait_app "$want"); then say "Harbor restarted into Rust $pv (pid $pid); turns running: $(turn_pids | wc -w)."
      else say "The TypeScript Harbor didn't restart into Rust within ${WAIT}s: 'install-one.sh restart' does it now."; fi
    fi
  fi
  if [ "$RESTORE_DB" = 1 ]; then
    [ -f "$b/harbor.db" ] || die "no database backup in $b"
    [ -f "$b/restored" ] && die "harbor.db was already restored from $(readlink -f "$b") ($(cat "$b/restored")); not again, as that would drop the chats made since"
    pids=$(app_pids)
    local saved=""
    for pid in $pids; do saved=$pid; done
    [ -n "$saved" ] && { tr '\0' '\n' < "/proc/$saved/environ" > "$BACKUPS/.env.$$"; tr '\0' '\n' < "/proc/$saved/cmdline" | tail -n +2 > "$BACKUPS/.args.$$"; }
    for _ in $(seq 60); do
      pids=$(app_pids)
      [ -z "$pids" ] && break
      kill -TERM $pids 2>/dev/null
      sleep 0.25
    done
    [ -z "$(app_pids)" ] || die "Harbor is still running; the database was not restored"
    cp -p "$DATA/harbor.db" "$BACKUPS/harbor.db.before-restore.$(date -u +%Y%m%dT%H%M%SZ)" || die "can't keep the current harbor.db"
    rm -f "$DATA/harbor.db-wal" "$DATA/harbor.db-shm"
    cp -p "$b/harbor.db" "$DATA/harbor.db.restore" && mv -f "$DATA/harbor.db.restore" "$DATA/harbor.db" || die "can't put the backup in place"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$b/restored"
    chmod -R go-rwx "$BACKUPS"
    say "Restored harbor.db from $(readlink -f "$b"); the one it replaced is kept in $BACKUPS. Chats made since the backup are gone from it."
    if [ -n "$saved" ]; then
      (mapfile -t E < "$BACKUPS/.env.$$" && mapfile -t A < "$BACKUPS/.args.$$" && rm -f "$BACKUPS/.env.$$" "$BACKUPS/.args.$$" && exec setsid -f env -i "${E[@]}" "$EXE" "${A[@]}" < /dev/null > /dev/null 2>&1)
      pid=$(WAIT=$WAIT wait_app "$(inode "$EXE")") && say "Harbor started again (pid $pid)." || say "Start Harbor again: it didn't come up within ${WAIT}s."
    fi
  fi
}

trigger_cmd() {
  local pids pid want
  check_layout
  want=$(inode "$EXE")
  pids=$(app_pids)
  [ -n "$pids" ] || die "Harbor isn't running"
  trigger || exit 1
  for pid in $pids; do
    wait_exec "$want" "$pid" && say "Harbor (pid $pid) restarted in place into $(version_of "$EXE")." || die "Harbor (pid $pid) didn't restart within ${WAIT}s"
  done
}

restart_cmd() {
  local pids pid want
  pids=$(app_pids)
  [ -n "$pids" ] || die "Harbor isn't running"
  want=$(inode "$EXE")
  for pid in $pids; do
    [ "$(inode "/proc/$pid/exe")" = "$want" ] && { say "Harbor (pid $pid) already runs $(version_of "$EXE")."; continue; }
    restart_now "$pid"
  done
  pid=$(wait_app "$want") && say "Harbor runs $(version_of "$EXE") (pid $pid); turns running: $(turn_pids | wc -w)." || die "Harbor didn't come back within ${WAIT}s"
}

status_cmd() {
  say "install folder: $LIB"
  say "harbor: $(version_of "$EXE") ($(is_ts "$(version_of "$EXE")" && echo TypeScript || echo Rust))"
  say "VERSION: $(cat "$LIB/VERSION" 2>/dev/null)"
  [ -f "$LIB/.previous/harbor" ] && say ".previous/harbor: $(version_of "$LIB/.previous/harbor")"
  say "running: $(app_pids | tr '\n' ' ')"
  say "turns: $(turn_pids | wc -w)"
  [ -e "$BACKUPS/latest" ] && say "latest backup: $(readlink -f "$BACKUPS/latest")"
  if [ -n "$(legacy_token)" ]; then say "Update from here: yes (a pairing token from before accounts, phone API port $(api_port))"
  else say "Update from here: no (no pairing token from before accounts): the switch waits for Update in Harbor or on a phone"; fi
}

cmd=${1:-}; shift || true
arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=${2:?--wait needs seconds}; shift ;;
    --restore-db) RESTORE_DB=1 ;;
    --no-trigger) TRIGGER=0 ;;
    -*) die "unknown option $1" ;;
    *) arg=$1 ;;
  esac
  shift
done
case "$cmd" in
  install) install_cmd "$arg" ;;
  undo) undo_cmd ;;
  restart) restart_cmd ;;
  trigger) trigger_cmd ;;
  status) status_cmd ;;
  *) die "usage: install-one.sh install BINARY [--wait S] [--no-trigger] | trigger | undo [--restore-db] [--wait S] | restart | status" ;;
esac
