#!/bin/bash
# Stops what this rig started, found by its throwaway data folder (app-*), never by name: other agents run
# their own harbor-ref and proto processes on this PC.
for p in /proc/[0-9]*; do
  id=${p#/proc/}
  tr '\0' '\n' < $p/environ 2>/dev/null | grep -q "^XDG_DATA_HOME=$HOME/.cache/hts/tmp-p0/app-" && kill -9 "$id" 2>/dev/null
  c=$(tr '\0' ' ' < $p/cmdline 2>/dev/null)
  case "$c" in
    *rig/measure.py*) kill -9 "$id" 2>/dev/null ;;
  esac
done
exit 0
