#!/bin/bash
# Run by scripts/boat/snapshot on a sandbox from a saved snapshot: where ~/cache lives and what it
# holds (Bun, its package cache, the images, the Android SDK), with sizes.
. "$(dirname "$0")/lib.sh"
findmnt -T "$cache" -o TARGET,SOURCE,FSTYPE,OPTIONS || true
df -hT "$cache"
echo "mounts: $(wc -l < /proc/self/mountinfo), /sys/fs/cgroup holds $(ls /sys/fs/cgroup 2>/dev/null | wc -l)"
du -sh "$cache"/* 2>/dev/null | sort -h
ls "$cache/bun" 2>/dev/null | sed 's/^/bun: /'
