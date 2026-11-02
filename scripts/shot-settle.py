# scripts/shot's eyes: finds the app's window on the rig's sway, waits until it has drawn and stopped
# changing (or until fixed times), and writes PNGs of it. Run with python3 -I; only scripts/shot calls it.
# Env: SHOT_SWAYMSG, SWAYSOCK, SHOT_GRIM, XDG_RUNTIME_DIR, WAYLAND_DISPLAY; SHOT_READYLOG: the app's log, when
# its HARBOR_VIEW says "harbor-view shown" once the page is up (a settings page loads after a blank frame).
# Args: PID START_EPOCH WAITS(auto|s,s,...) EARLIEST_EPOCH OUT_PREFIX TRACE(0|1)
# Stdout: "png PATH" per shot, then "times MAPPED SETTLED" (seconds from START). Exit 2: never mapped,
# 3: drew nothing, 4: the app exited.
import json, os, struct, subprocess, sys, time, zlib

pid, start, waits, earliest, prefix, trace = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3], float(sys.argv[4]), sys.argv[5], sys.argv[6] == "1"
MAP_LIMIT, SETTLE_LIMIT, QUIET, POLL, SMALL = 30.0, 12.0, 0.5, 0.1, 24
SWAYMSG, GRIM, READYLOG = os.environ["SHOT_SWAYMSG"], os.environ["SHOT_GRIM"], os.environ.get("SHOT_READYLOG", "")


def ready():
    if READYLOG == "":
        return True
    try:
        with open(READYLOG, "rb") as f:
            return b"harbor-view shown" in f.read()
    except OSError:
        return False


def log(m):
    print(f"shot: {m}", file=sys.stderr, flush=True)


def alive():
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def rect():
    out = subprocess.run([SWAYMSG, "-t", "get_tree"], capture_output=True).stdout
    try:
        tree = json.loads(out)
    except ValueError:
        return None
    todo = [tree]
    while todo:
        n = todo.pop()
        if n.get("pid") == pid and n.get("visible"):
            r = n["rect"]
            return r["x"], r["y"], r["width"], r["height"]
        todo += n.get("nodes", []) + n.get("floating_nodes", [])
    return None


def grab(r):
    """The window's rows as bytes, from a P6 ppm of the output."""
    d = subprocess.run([GRIM, "-t", "ppm", "-"], capture_output=True).stdout
    nl, at = 0, 0
    while nl < 3:  # "P6\nW H\n255\n": the pixels start after the third newline
        at = d.index(b"\n", at) + 1
        nl += 1
    w, h = map(int, d.split(b"\n")[1].split())
    x, y, rw, rh = r
    rw, rh = min(rw, w - x), min(rh, h - y)
    return [d[at + (j * w + x) * 3 : at + (j * w + x + rw) * 3] for j in range(y, y + rh)]


def colours(rows):
    seen = set()
    for row in rows[::3]:
        for i in range(0, len(row), 9):
            seen.add(row[i : i + 3])
    return len(seen)


def png(rows, path):
    w = len(rows[0]) // 3

    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b))

    raw = b"".join(b"\0" + r for r in rows)
    with open(path + ".new", "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, len(rows), 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 3)) + chunk(b"IEND", b""))
    os.replace(path + ".new", path)


def write(rows, path):
    c = colours(rows)
    if c < 40:
        log(f"FAILED: the window drew nothing ({c} colours)")
        sys.exit(3)
    png(rows, path)
    print(f"png {path}", flush=True)


r = None
while r is None:
    if not alive():
        sys.exit(4)
    if time.time() - start > MAP_LIMIT:
        sys.exit(2)
    r = rect()
    if r is None:
        time.sleep(0.05)
mapped = time.time()
log(f"window up {mapped - start:.1f} s after the start ({r[0]},{r[1]} {r[2]}x{r[3]})")

if waits != "auto":
    times = [float(t) for t in waits.split(",")]
    for t in times:
        time.sleep(max(0.0, max(mapped + t, earliest) - time.time()))
        if not alive():
            sys.exit(4)
        rows = grab(rect() or r)
        write(rows, f"{prefix}-{t:g}s.png" if len(times) > 1 else f"{prefix}.png")
    print(f"times {mapped - start:.2f} {time.time() - start:.2f}")
    sys.exit(0)

# Auto: the first moment after `earliest` the window has drawn and only small things (a caret, a spinner) moved for QUIET s.
prev, quiet_from, c, up = None, None, 0, False
while True:
    now = time.time()
    if not alive():
        sys.exit(4)
    r = rect() or r
    rows = grab(r)
    changed = len(rows) if prev is None or len(prev) != len(rows) else sum(a != b for a, b in zip(prev, rows))
    prev = rows
    up = up or ready()
    if changed > SMALL or quiet_from is None or not up:
        quiet_from = now
    if trace:
        log(f"  t={now - start:5.2f} changed rows {changed}{'' if up else ' (page not shown yet)'}")
    if now >= earliest and now - quiet_from >= QUIET:
        c = colours(rows)
        if c >= 40:
            break
        quiet_from = now
    if now - mapped > SETTLE_LIMIT:
        log(f"still changing {SETTLE_LIMIT:g} s after the window came up: shot as it is")
        break
    time.sleep(max(0.0, POLL - (time.time() - now)))
write(rows, f"{prefix}.png")
print(f"times {mapped - start:.2f} {time.time() - start:.2f}")
