#!/bin/bash
# Download sizes and the software video path, each under the check lock.
L=~/.cache/hts/tmp-p0/extras.log
. ~/.cache/hts/tmp-p0/rig/env.sh
D=~/.cache/hts/tmp/dist
lock() { flock ~/.cache/hts/check.lock "$@"; }
echo "BEGIN $(date +%T)" >> $L
# Same packing as release.yml: tar -I gzip
S=$(mktemp -d ~/.cache/hts/tmp-p0/size.XXXX)
mkdir -p $S/runtime/lib
cp $D/harbor-runtime $S/runtime/; cp $D/harbor-app.js $S/runtime/; cp $D/lib/*.so $S/runtime/lib/
for what in "harbor-runtime alone:$D/harbor-runtime" "runtime + bundle + sherpa libs:$S/runtime"; do
  name=${what%%:*}; path=${what#*:}
  dir=$(dirname $path); base=$(basename $path)
  b=$(lock bash -c "tar -C $dir -I gzip -cf - $base | wc -c")
  echo "SIZE $name tar.gz $b raw $(du -sb $path | cut -f1)" >> $L
done
rm -rf $S
echo "SIZE rust 0.108.0 release tar.gz $(stat -c %s ~/.cache/hts/tmp-p0/dl/h.tgz)" >> $L
V=~/.cache/hts/harbor/ts/proto/video-sw.ts
C=~/.cache/hts/tmp/clips/c1080p60.mp4
run() { # label libmpv size hwdec
  echo "VIDEO $1 $(cut -d' ' -f1-3 /proc/loadavg)" >> $L
  lock env HTS_LIBMPV=$2 HTS_HWDEC=$4 timeout 60 $HOME/.bun/bin/bun $V $C 12 $3 >> $L 2>&1
}
run "system libmpv 1080p60 1920x1080 auto-copy" libmpv.so.2 "1920 1080" auto-copy
run "system libmpv 1080p60 1400x788 auto-copy" libmpv.so.2 "1400 788" auto-copy
run "system libmpv 1080p60 1920x1080 no hwdec" libmpv.so.2 "1920 1080" no
run "harbor libmpv 1080p60 1400x788 no hwdec" $HOME/.local/lib/harbor/libmpv-harbor.so "1400 788" no
echo "DONE $(date +%T)" >> $L
