#!/usr/bin/python3
"""Phase 0 numbers for one app on the private compositor: measure.py APP STAGE..., one JSON line per stage.
Run from the rig folder with env.sh sourced. APP is a word for app.sh, or a command with HTS_CMD."""
import glob, hashlib, json, os, signal, subprocess, sys, time

HZ = os.sysconf("SC_CLK_TCK")
RIG = os.path.expanduser(os.environ.get("HTS_RIG", "~/.cache/hts/tmp-p0/rig"))
OUT = os.path.dirname(RIG)


def start(app, env=None):
    e = dict(os.environ, **(env or {}))
    return subprocess.Popen(["unshare", "-Urn", f"{RIG}/app.sh", app], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def children(pid):
    out = [pid]
    for t in glob.glob(f"/proc/{pid}/task/*/children"):
        try:
            for c in open(t).read().split():
                out += children(int(c))
        except OSError:
            pass
    return out


def tree(p):
    return [x for x in children(p.pid) if os.path.exists(f"/proc/{x}")]


def named(pids, word):
    found = []
    for x in pids:
        try:
            if word in open(f"/proc/{x}/cmdline", "rb").read().split(b"\0")[0].decode(errors="replace"):
                found.append(x)
        except OSError:
            pass
    return found


def app_pid(p, app):
    word = {"rust": "harbor-p0", "proto": "dist/proto", "runtime": "harbor-runtime", "node": "node", "bun": "bun"}.get(app, app)
    for _ in range(100):
        got = named(tree(p), word)
        if got:
            return got[0]
        time.sleep(0.02)
    raise SystemExit(f"no {word} process")


def cpu_ticks(pid):
    s = open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1].split()
    return int(s[11]) + int(s[12])


def switches(pid):
    """Per thread (tid:start time, so a reused tid is not mistaken for the old thread): (voluntary, involuntary, name)."""
    out = {}
    for t in glob.glob(f"/proc/{pid}/task/*"):
        try:
            v = n = 0
            for line in open(f"{t}/status"):
                if line.startswith("voluntary_ctxt_switches"):
                    v = int(line.split()[1])
                elif line.startswith("nonvoluntary_ctxt_switches"):
                    n = int(line.split()[1])
            start = open(f"{t}/stat").read().rsplit(") ", 1)[1].split()[19]
            out[f"{os.path.basename(t)}:{start}"] = (v, n, open(f"{t}/comm").read().strip())
        except OSError:
            pass
    return out


def thread_ticks(pid):
    out = {}
    for t in glob.glob(f"/proc/{pid}/task/*"):
        try:
            st = open(f"{t}/stat").read().rsplit(") ", 1)[1].split()
            out[f"{os.path.basename(t)}:{st[19]}"] = (int(st[11]) + int(st[12]), open(f"{t}/comm").read().strip())
        except OSError:
            pass
    return out


def mem(pid):
    out = {}
    for line in open(f"/proc/{pid}/smaps_rollup"):
        k = line.split(":")[0]
        if k in ("Rss", "Pss", "Private_Dirty", "Anonymous", "Swap"):
            out[k] = round(int(line.split()[1]) / 1024, 1)
    return out


def sample(pid, secs):
    t0, c0, s0, k0 = time.monotonic(), cpu_ticks(pid), switches(pid), thread_ticks(pid)
    time.sleep(secs)
    t1, c1, s1, k1 = time.monotonic(), cpu_ticks(pid), switches(pid), thread_ticks(pid)
    busy = sorted(((v[0] - k0.get(t, (0, ""))[0]) / HZ / (t1 - t0) * 100, v[1]) for t, v in k1.items())[::-1][:4]
    dt = t1 - t0
    per = {t: (v[0] - s0.get(t, (0, 0, ""))[0], v[1] - s0.get(t, (0, 0, ""))[1], v[2]) for t, v in s1.items()}
    top = sorted(per.values(), reverse=True)[:4]
    main_v = per.get(f"{pid}:{open(f'/proc/{pid}/task/{pid}/stat').read().rsplit(') ', 1)[1].split()[19]}", (0, 0, ""))[0]
    return {
        "cpu_pct": round((c1 - c0) / HZ / dt * 100, 2),
        "vol_cs_s": round(sum(v[0] for v in per.values()) / dt, 1),
        "invol_cs_s": round(sum(v[1] for v in per.values()) / dt, 1),
        "vol_cs_main_thread_s": round(main_v / dt, 1),
        "top_threads_vol_s": [[round(v[0] / dt, 1), v[2]] for v in top],
        "top_threads_cpu_pct": [[round(c, 2), n] for c, n in busy],
        "secs": round(dt, 1),
        "load1": os.getloadavg()[0],
    }


def stop(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()
    time.sleep(0.4)


def shot():
    return hashlib.sha1(subprocess.run(["grim", "-t", "ppm", "-"], capture_output=True).stdout).hexdigest()


def startup(app, runs):
    maps, contents = [], []
    for _ in range(runs):
        sub = subprocess.Popen(["swaymsg_sub"], stdout=subprocess.PIPE, text=True)
        time.sleep(0.3)
        t0 = time.monotonic()
        p = start(app)
        for line in sub.stdout:
            if '"change":"new"' in line.replace(" ", ""):
                break
        t_map = time.monotonic() - t0
        sub.kill()
        seen = []
        while time.monotonic() - t0 < t_map + 2.5:
            seen.append((time.monotonic() - t0, shot()))
        final = seen[-1][1]
        t_content = next(t for t, h in seen if h == final)
        maps.append(round(t_map * 1000))
        contents.append(round(t_content * 1000))
        stop(p)
    med = lambda v: sorted(v)[len(v) // 2]
    return {"first_frame_ms": med(maps), "content_ms": med(contents), "all_first": maps, "all_content": contents}


STREAM = float(os.environ.get("HTS_STREAM_S", "30"))
ROW = lambda i: (100, 145 + 34 * i)


def clicks(rows, spacing=1.0, begin=3.0):
    return ";".join(f"{ROW(r)[0]},{ROW(r)[1]},click,{begin + spacing * i:.1f}" for i, r in enumerate(rows))


def open_env(app, rows):
    if app == "rust":
        return {"HARBOR_POINTER": clicks(rows)}
    return {"HTS_OPEN": str(len(rows)), "HTS_OPEN_AT": str(rows[0])}


def idle(app, settle, secs):
    p = start(app, open_env(app, [0]))
    pid = app_pid(p, app)
    time.sleep(settle)
    r = sample(pid, secs)
    r["mem_mb"] = mem(pid)
    r["threads"] = len(os.listdir(f"/proc/{pid}/task"))
    stop(p)
    return r


def twenty(app, settle):
    p = start(app, open_env(app, list(range(20))))
    pid = app_pid(p, app)
    t0 = time.monotonic()
    views = set()
    while time.monotonic() - t0 < 3 + 21 + settle:
        views.add(shot())
        time.sleep(0.9)
    r = {"mem_mb": mem(pid), "distinct_screens_while_opening": len(views)}
    r.update(sample(pid, 20))
    stop(p)
    return r


def stream(app, settle):
    p = start(app, dict(open_env(app, [7]), HTS_STREAM_S=str(STREAM + 12)))
    pid = app_pid(p, app)
    time.sleep(settle)
    subprocess.run(["wtype", "-k", "F13"])
    time.sleep(0.3)
    subprocess.run(["wtype", "-s", "80", "-k", "F13", "-k", "F13", "-d", "20", "go", "-s", "150", "-k", "Return"])
    time.sleep(4)
    pids = tree(p)
    fake = len(named([int(x) for x in os.listdir("/proc") if x.isdigit()], "claude"))
    every = [int(x) for x in os.listdir("/proc") if x.isdigit()]
    runs = [x for x in named(every, "harbor-p0") if x != pid and b"\0turn\0" in open(f"/proc/{x}/cmdline", "rb").read()]
    rc = cpu_ticks(runs[0]) if runs else 0
    t = time.monotonic()
    r = sample(pid, STREAM)
    r["runner_cpu_pct"] = round((cpu_ticks(runs[0]) - rc) / HZ / (time.monotonic() - t) * 100, 2) if runs else 0
    r["fake_running"] = fake
    r["mem_mb"] = mem(pid)
    subprocess.run(["grim", f"{OUT}/stream-{app}.png"])
    stop(p)
    return r


app = sys.argv[1]
for stage in sys.argv[2:]:
    if stage == "startup":
        out = startup(app, int(os.environ.get("HTS_RUNS", "7")))
    elif stage == "idle":
        out = idle(app, float(os.environ.get("HTS_SETTLE", "30")), float(os.environ.get("HTS_SECS", "60")))
    elif stage == "twenty":
        out = twenty(app, float(os.environ.get("HTS_SETTLE20", "15")))
    elif stage == "stream":
        out = stream(app, float(os.environ.get("HTS_SETTLE_STREAM", "8")))
    else:
        raise SystemExit(stage)
    print(json.dumps({"app": app, "stage": stage, **out}), flush=True)
