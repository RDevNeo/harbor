#!/usr/bin/python3
"""The real app's running cost, one JSON line per stage. Refuses to start the app unless only `lo` is visible."""
import fcntl, glob, json, os, signal, subprocess, sys, time

HZ = os.sysconf("SC_CLK_TCK")
HERE = os.path.dirname(os.path.abspath(__file__))
TS = os.path.dirname(HERE)
TMP = os.path.expanduser(os.environ.get("HTS_TMP", "~/.cache/hts/tmp-cpu"))
RT = f"{TMP}/rt"
SWAY = os.path.expanduser("~/.cache/hts/tmp/sway/root/usr")
SECS = float(os.environ.get("HTS_SECS", "25"))
SETTLE = float(os.environ.get("HTS_SETTLE", "20"))
STREAM = float(os.environ.get("HTS_STREAM_S", "40"))
SEND = os.environ.get("HTS_SEND", "800,240,click,3;800,240,key:hello,5;800,240,key:Return,6")
MARK = "HTS_COST_RUN"

INNER = r"""
set -e
[ "$(ls /sys/class/net)" = lo ] || { echo "cost.py: network visible, refusing" >&2; exit 3; }
ip link set lo up
T=$1; shift
rm -rf "$T/app"; mkdir -p "$T/app/data/harbor" "$T/app/home" "$T/app/tmp"
cp --reflink=auto "$T/stripped.db" "$T/app/data/harbor/harbor.db"
export HOME=$T/app/home XDG_DATA_HOME=$T/app/data XDG_CONFIG_HOME=$T/app/home/.config TMPDIR=$T/app/tmp
export PATH=$FAKE:$(dirname "$BUNBIN"):/usr/bin
unset DISPLAY DBUS_SESSION_BUS_ADDRESS
if [ "$HTS_RUNTIME" = node ]; then
  d=$T/app/tmp/n; mkdir -p "$d/data/harbor" "$d/state" "$d/cache"
  cp "$T/app/data/harbor/harbor.db" "$d/data/harbor/harbor.db"
  export XDG_DATA_HOME=$d/data XDG_STATE_HOME=$d/state XDG_CACHE_HOME=$d/cache
  export HARBOR_OFFLINE=1 HARBOR_SOCK=$d/harbor.sock HARBOR_LISTEN=127.0.0.1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1
  cd "$TSDIR"; exec "$NODE" --experimental-strip-types --no-warnings harbor.ts
fi
exec "$TSDIR/run.sh"
"""


def guard_free_lock():
    f = open(os.path.expanduser("~/.cache/hts/check.lock"), "w")
    fcntl.flock(f, fcntl.LOCK_EX)
    return f


def sway_up():
    os.makedirs(RT, mode=0o700, exist_ok=True)
    if glob.glob(f"{RT}/sway-ipc*.sock") and os.path.exists(f"{RT}/wayland-1"):
        if subprocess.run(swaymsg(["-t", "get_version"]), capture_output=True).returncode == 0:
            return
    for s in glob.glob(f"{RT}/*"):
        os.remove(s) if not os.path.isdir(s) else None
    conf = f"{TMP}/sway.conf"
    out = os.environ.get("HTS_OUTPUT", "")
    text = open(f"{HERE}/sway.conf").read()
    open(conf, "w").write(text.replace("resolution 1400x900", out) if out else text)
    env = dict(os.environ, XDG_RUNTIME_DIR=RT, WLR_BACKENDS="headless", WLR_LIBINPUT_NO_DEVICES="1",
               LD_LIBRARY_PATH=f"{SWAY}/lib", DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent")
    for k in ("DISPLAY", "WAYLAND_DISPLAY", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE"):
        env.pop(k, None)
    # Started through a link of our own: other rigs stop their sway by its path.
    link = f"{TMP}/sway-bin"
    if not os.path.islink(link):
        os.symlink(f"{SWAY}/bin/sway", link)
    subprocess.Popen([link, "-c", conf], env=env, stdout=open(f"{TMP}/sway.log", "w"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        if glob.glob(f"{RT}/sway-ipc*.sock") and os.path.exists(f"{RT}/wayland-1"):
            return
        time.sleep(0.1)
    raise SystemExit("sway did not start")


def swaymsg(args):
    sock = glob.glob(f"{RT}/sway-ipc*.sock")
    return ["env", f"LD_LIBRARY_PATH={SWAY}/lib", f"SWAYSOCK={sock[0] if sock else ''}", f"{SWAY}/bin/swaymsg"] + args


def bun_link():
    """Bun through a link of our own, so other rigs' `pkill -f ".../bun harbor.ts"` passes this app by."""
    link = f"{TMP}/bun"
    if not os.path.islink(link):
        os.symlink(os.path.expanduser("~/.bun/bin/bun"), link)
    return link


def start(extra):
    run_id = f"{os.getpid()}-{time.monotonic_ns()}"
    env = dict(os.environ, XDG_RUNTIME_DIR=RT, WAYLAND_DISPLAY="wayland-1", FAKE=f"{HERE}/fake",
               BUNBIN=bun_link(), TSDIR=TS, HTS_STREAM_S=str(STREAM),
               NODE=os.environ.get("HTS_NODE", os.path.expanduser("~/.local/share/mise/installs/node/26.7.0/bin/node")),
               HTS_RUNTIME=os.environ.get("HTS_RUNTIME", "bun"), **{MARK: run_id})
    env.update(extra)
    flags = []
    if os.environ.get("HTS_PROFILE"):
        os.makedirs(f"{TMP}/prof", exist_ok=True)
        flags += ["--cpu-prof", "--cpu-prof-md", "--cpu-prof-interval=500", f"--cpu-prof-dir={TMP}/prof", f"--preload={HERE}/exit.ts"]
    if os.environ.get("HTS_LOOPSTATS"):
        flags += [f"--preload={HERE}/loopstats.ts"]
        env["HTS_LOOPSTATS_OUT"] = f"{TMP}/loopstats.jsonl"
        open(f"{TMP}/loopstats.jsonl", "w").close()
    env["BUN"] = env["BUNBIN"]
    if flags:
        env["BUN"], env["HTS_BUNFLAGS"] = f"{HERE}/bunwrap.sh", " ".join(flags)
    for kv in os.environ.get("HTS_ENV", "").split():
        k, v = kv.split("=", 1)
        env[k] = v
    log = open(f"{TMP}/app.log", "w")
    p = subprocess.Popen(["unshare", "-Urnm", "sh", "-c", "mount -t sysfs sysfs /sys && exec bash -c \"$0\" inner \"$1\"",
                          INNER, TMP], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(300):
        pid = app_pid(run_id)
        if pid:
            return p, pid
        if p.poll() is not None:
            raise SystemExit(f"app exited: {open(f'{TMP}/app.log').read()[-2000:]}")
        time.sleep(0.05)
    raise SystemExit("no app process")


def app_pid(run_id):
    """The Bun (or Node) process that carries this run's mark: the window's process, not run.sh."""
    for e in glob.glob("/proc/[0-9]*/environ"):
        try:
            if f"{MARK}={run_id}".encode() not in open(e, "rb").read().split(b"\0"):
                continue
            pid = int(e.split("/")[2])
            exe = os.readlink(f"/proc/{pid}/exe")
            cmd = open(f"/proc/{pid}/cmdline", "rb").read()
            if exe.endswith(("/bun", "/node")) and b"harbor.ts" in cmd:
                return pid
        except OSError:
            pass
    return None


def ticks(pid):
    try:
        s = open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1].split()
        return int(s[11]) + int(s[12])
    except OSError:
        return 0


def threads(pid):
    out = {}
    for t in glob.glob(f"/proc/{pid}/task/*"):
        try:
            st = open(f"{t}/stat").read().rsplit(") ", 1)[1].split()
            v = next(int(l.split()[1]) for l in open(f"{t}/status") if l.startswith("voluntary_ctxt_switches"))
            out[f"{os.path.basename(t)}:{st[19]}"] = (int(st[11]) + int(st[12]), v, open(f"{t}/comm").read().strip())
        except (OSError, StopIteration):
            pass
    return out


def mem(pid):
    out = {}
    for line in open(f"/proc/{pid}/smaps_rollup"):
        k = line.split(":")[0]
        if k in ("Rss", "Anonymous", "Swap"):
            out[k] = round(int(line.split()[1]) / 1024, 1)
    out["Rss+Swap"] = round(out.get("Rss", 0) + out.get("Swap", 0), 1)
    return out


def maps(pid, n=8):
    size, name = {}, "?"
    for line in open(f"/proc/{pid}/smaps"):
        head = line.split()
        if "-" in head[0] and ":" not in head[0] and len(head) >= 5:
            name = os.path.basename(head[5]) if len(head) > 5 else "[anon]"
        elif head[0] == "Rss:":
            size[name] = size.get(name, 0) + int(head[1])
    return [[k, round(v / 1024, 1)] for k, v in sorted(size.items(), key=lambda x: -x[1])[:n]]


def marked(pid):
    """Every other process of this run (run.sh, the turn runner, the fake claude): they carry the mark."""
    want = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    want = next(x for x in want if x.startswith(MARK.encode()))
    out = []
    for e in glob.glob("/proc/[0-9]*/environ"):
        try:
            if want in open(e, "rb").read().split(b"\0") and int(e.split("/")[2]) != pid:
                out.append(int(e.split("/")[2]))
        except OSError:
            pass
    return out


def sample(pid, secs):
    kids0 = {k: ticks(k) for k in marked(pid)}
    t0, a = time.monotonic(), threads(pid)
    time.sleep(secs)
    t1, b = time.monotonic(), threads(pid)
    kids1 = {k: ticks(k) for k in marked(pid)}
    dt = t1 - t0
    per = {k: (v[0] - a.get(k, (0, 0, ""))[0], v[1] - a.get(k, (0, 0, ""))[1], v[2]) for k, v in b.items()}
    main = next((v for k, v in per.items() if k.startswith(f"{pid}:")), (0, 0, ""))
    kids = sum(kids1[k] - kids0.get(k, 0) for k in kids1)
    return {
        "cpu_pct": round(sum(v[0] for v in per.values()) / HZ / dt * 100, 2),
        "main_thread_cpu_pct": round(main[0] / HZ / dt * 100, 2),
        "wakeups_s": round(sum(v[1] for v in per.values()) / dt, 1),
        "main_thread_wakeups_s": round(main[1] / dt, 1),
        "top_threads": [[v[2], round(v[0] / HZ / dt * 100, 2), round(v[1] / dt, 1)] for v in
                        sorted(per.values(), key=lambda v: (v[0], v[1]), reverse=True)[:5]],
        "other_processes_cpu_pct": round(kids / HZ / dt * 100, 2),
        "secs": round(dt, 1),
        "load1": os.getloadavg()[0],
    }


def stop(p, pid=None):
    if pid and os.environ.get("HTS_PROFILE"):
        os.kill(pid, signal.SIGUSR2)
        for _ in range(100):
            if not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1][0] == "Z":
                break
            time.sleep(0.1)
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()
    time.sleep(0.5)


def shot(path):
    subprocess.run(["grim", path], env=dict(os.environ, XDG_RUNTIME_DIR=RT, WAYLAND_DISPLAY="wayland-1"))


def keys(pid):
    """From just before each wtype to the app reading the key, and to its next commit (WAYLAND_DEBUG stamps UTC)."""
    env = dict(os.environ, XDG_RUNTIME_DIR=RT, WAYLAND_DISPLAY="wayland-1")
    log = f"{TMP}/app.log"
    start = os.path.getsize(log)
    sent = []
    for _ in range(15):
        # wtype drops its first key: F13 goes first, x 300 ms later (wtype's own start is in every number).
        t = time.time() + 0.3
        subprocess.run(["wtype", "-k", "F13", "-s", "300", "x"], env=env)
        sent.append(t)
        time.sleep(1.2 + 0.1 * (len(sent) % 5))
    time.sleep(1)
    day = time.time() // 86400 * 86400
    events = []
    for l in open(log, errors="replace").read()[start:].splitlines():
        if not l.startswith("[") or len(l) < 17:
            continue
        h, m, sec = l[1:16].split(":")
        t = day + int(h) * 3600 + int(m) * 60 + float(sec)
        if ".key(" in l and l.rstrip().endswith(", 1)"):
            events.append((t, "key"))
        elif "wl_surface" in l and ".commit()" in l:
            events.append((t, "commit"))
    read, frame = [], []
    for t0 in sent:
        k = next((t for t, e in events if e == "key" and t >= t0), None)
        if k is None:
            continue
        c = next((t for t, e in events if e == "commit" and t >= k), None)
        read.append(round((k - t0) * 1000, 1))
        if c is not None:
            frame.append(round((c - t0) * 1000, 1))
    med = lambda v: sorted(v)[len(v) // 2] if v else None
    return {"send_to_read_ms": sorted(read), "send_to_frame_ms": sorted(frame), "median_read_ms": med(read), "median_frame_ms": med(frame)}


def stage(name):
    if name == "keys":
        p, pid = start({"WAYLAND_DEBUG": "client"})
        try:
            time.sleep(SETTLE)
            return keys(pid)
        finally:
            stop(p, pid)
    if name == "idle":
        p, pid = start({})
    elif name == "chat":
        p, pid = start({"HARBOR_VIEW": "chat"})
    elif name == "stream":
        p, pid = start({"HARBOR_POINTER": SEND})
    elif name == "spin":
        p, pid = start({"HARBOR_POINTER": SEND, "HTS_FAKE_TOOL": "1", **({"HARBOR_VIEW": "chat"} if os.environ.get("HTS_VIEW") == "chat" else {})})
    else:
        raise SystemExit(f"unknown stage {name}")
    try:
        t0 = time.monotonic()
        time.sleep(SETTLE if name != "stream" else 10)
        if name == "stream":
            fake = [x for x in marked(pid) if b"fake/claude" in open(f"/proc/{x}/cmdline", "rb").read()]
            if not fake:
                raise SystemExit("stream: the fake claude isn't running, the message wasn't sent")
        r = sample(pid, SECS if name != "stream" else STREAM - 15)
        r["mem_mb"] = mem(pid)
        r["maps_mb"] = maps(pid)
        r["threads"] = len(os.listdir(f"/proc/{pid}/task"))
        shot(f"{TMP}/{name}.png")
        if name == "stream":
            time.sleep(max(0, t0 + STREAM + 1 - time.monotonic()))
            r["late"] = sample(pid, 3)
            time.sleep(max(0, t0 + STREAM + 14 - time.monotonic()))
            r["after"] = sample(pid, 8)
            r["after"]["mem_mb"] = mem(pid)
            shot(f"{TMP}/{name}-after.png")
        return r
    finally:
        stop(p, pid)


if __name__ == "__main__":
    sway_up()
    for name in sys.argv[1:]:
        lock = guard_free_lock()
        try:
            out = stage(name)
        finally:
            lock.close()
        print(json.dumps({"stage": name, "runtime": os.environ.get("HTS_RUNTIME", "bun"), **out}), flush=True)
