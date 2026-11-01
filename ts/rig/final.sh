#!/bin/bash
# Phase 0 table, final run: every stage holds the check lock on its own (under 5 minutes), so no tsc or bun test runs during a reading.
L=~/.cache/hts/tmp-p0/final.log
M=~/.cache/hts/tmp-p0/rig/m.sh
echo "BEGIN $(date +%T) rust $(~/.cache/hts/tmp/rs/harbor-ref --version) bun $(~/.bun/bin/bun --version) node $(~/.local/share/mise/installs/node/26.7.0/bin/node --version)" >> $L
stage() { # app stage [ENV=value...]
  local app=$1 st=$2; shift 2
  echo "WAIT $app $st $(date +%T) load $(cut -d' ' -f1-3 /proc/loadavg)" >> $L
  env "$@" flock ~/.cache/hts/check.lock $M $L $app $st
}
for round in 1 2; do
  E=(HTS_RUNS=7 HTS_SETTLE=30 HTS_SECS=60 HTS_SETTLE20=15 HTS_STREAM_S=30)
  for app in rust proto; do
    stage $app startup "${E[@]}"
    stage $app idle "${E[@]}"
    stage $app twenty "${E[@]}"
    stage $app stream "${E[@]}"
  done
  for app in bun node; do
    for mode in visible hidden; do
      echo "MODE $mode" >> $L
      stage $app idle HTS_SETTLE=15 HTS_SECS=60 HTS_MODE=$mode
    done
  done
done
echo "DONE $(date +%T)" >> $L
