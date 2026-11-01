#!/usr/bin/python3
"""Rss + Swap of a process by mapping (file, or [heap]/[anon]), largest first: maps.py PID [N]."""
import collections, sys

pid, n = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 25
size, name = collections.Counter(), "?"
for line in open(f"/proc/{pid}/smaps"):
    head = line.split()
    if "-" in head[0] and len(head) >= 5 and ":" not in head[0]:
        name = head[5] if len(head) > 5 else "[anon]"
    elif head[0] in ("Rss:", "Swap:"):
        size[name] += int(head[1])
total = sum(size.values())
print(f"total {total / 1024:.1f} MB")
for k, v in size.most_common(n):
    print(f"{v / 1024:8.1f} MB  {k}")
