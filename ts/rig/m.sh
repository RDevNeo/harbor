#!/bin/bash
# m.sh LOG APP STAGE...: one measuring run in the background.
. ~/.cache/hts/tmp-p0/rig/env.sh
export PATH=$HOME/.cache/hts/tmp-p0/fake:$PATH
cd ~/.cache/hts/tmp-p0/rig
log=$1; shift
python3 ~/.cache/hts/harbor/ts/rig/measure.py "$@" >> $log 2>&1
echo "END $(date +%T)" >> $log
