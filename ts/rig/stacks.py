#!/usr/bin/python3
"""eu-stack attaches from inside the app's user namespace: ptrace_scope 1 lets only a tracer with CAP_SYS_PTRACE there.
A stack topped by a wait (epoll, poll, futex) is the thread sleeping."""
import collections, re, subprocess, sys, time

pid, n, gap = int(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 60, float(sys.argv[3]) if len(sys.argv) > 3 else 0.25
incl, top, samples = collections.Counter(), collections.Counter(), 0
frame = re.compile(r"^#\d+\s+0x[0-9a-f]+\s+(.*)$")


SKIP = {"i_slint_core", "slint_interpreter", "core", "alloc", "std", "i_slint_compiler", "i_slint_renderer_femtovg", "femtovg"}


def short(name):
    """Rust v0 symbols (_R...) shown as their path words, e.g. `properties PropertyHandle update`."""
    if not name.startswith("_R"):
        return re.sub(r"<[^<>]*>", "<>", name)[:140]
    words, i = [], 2
    while i < len(name):
        m = re.match(r"(\d+)_?", name[i:])
        if m and int(m.group(1)) > 0 and i + m.end() + int(m.group(1)) <= len(name) + 1:
            n = int(m.group(1))
            w = name[i + m.end(): i + m.end() + n]
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", w):
                if w not in SKIP and not re.fullmatch(r"Cs[0-9A-Za-z_]+", w):
                    words.append(w)
                i += m.end() + n
                continue
        i += 1
    return " ".join(words[:6])[:140]


for _ in range(n):
    out = subprocess.run(["nsenter", "-U", "--preserve-credentials", "-t", str(pid), "eu-stack", "-1", "-p", str(pid), "-n", "80"],
                         capture_output=True, text=True).stdout
    names = [short(m.group(1)) for line in out.splitlines() if (m := frame.match(line.strip()))]
    if names:
        samples += 1
        top[names[0]] += 1
        for x in set(names):
            incl[x] += 1
    time.sleep(gap)

print(f"{samples} samples")
print("== top of stack ==")
for k, v in top.most_common(25):
    print(f"{v * 100 / samples:5.1f}%  {k}")
print("== anywhere in stack ==")
for k, v in incl.most_common(70):
    print(f"{v * 100 / samples:5.1f}%  {k}")
