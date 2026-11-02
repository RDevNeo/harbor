#!/bin/bash
. ~/.cache/hts/tmp-p0/rig/env.sh
cd ~/.cache/hts/tmp-p0/rig
LD_LIBRARY_PATH=$LD_SWAY SWAYSOCK= setsid -f env -u SWAYSOCK $SWAY/bin/sway -c ~/.cache/hts/tmp-p0/rig/sway.conf > sway.log 2>&1
