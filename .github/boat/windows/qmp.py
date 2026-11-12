#!/usr/bin/env python3
# Talks to the Windows test VM's QEMU over QMP (windows.sh): the screen as a PNG, keys, typed text and
# the mouse (a USB tablet, so positions are the screen's pixels).
#   qmp.py SOCK shot OUT.png
#   qmp.py SOCK key ctrl-alt-delete [ret …]      QEMU key names joined by "-" for a chord
#   qmp.py SOCK type 'text'                      US layout
#   qmp.py SOCK click X Y [left|right|middle] [2 for a double click]
#   qmp.py SOCK move X Y
#   qmp.py SOCK scroll X Y N                     N > 0 down, N < 0 up
#   qmp.py SOCK powerdown | quit | status
import json, os, socket, sys, time

def connect(path):
    s = socket.socket(socket.AF_UNIX)
    s.connect(path)
    f = s.makefile("rw")
    json.loads(f.readline())  # greeting
    def call(cmd, **args):
        f.write(json.dumps({"execute": cmd, "arguments": args} if args else {"execute": cmd}) + "\n")
        f.flush()
        while True:
            r = json.loads(f.readline())
            if "return" in r:
                return r["return"]
            if "error" in r:
                raise SystemExit(f"qmp {cmd}: {r['error'].get('desc')}")
    call("qmp_capabilities")
    return call

SHIFTED = {'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
           '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right', '|': 'backslash', ':': 'semicolon',
           '"': 'apostrophe', '<': 'comma', '>': 'dot', '?': 'slash', '~': 'grave_accent'}
PLAIN = {' ': 'spc', '\n': 'ret', '\t': 'tab', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
         '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'dot', '/': 'slash', '`': 'grave_accent'}

def keys_for(ch):
    if ch.isascii() and ch.isalpha():
        return (['shift'] if ch.isupper() else []) + [ch.lower()]
    if ch.isdigit():
        return [ch]
    if ch in PLAIN:
        return [PLAIN[ch]]
    if ch in SHIFTED:
        return ['shift', SHIFTED[ch]]
    raise SystemExit(f"can't type {ch!r} (US layout, ASCII only)")

def send(call, names, hold=60):
    call("send-key", keys=[{"type": "qcode", "data": n} for n in names], **{"hold-time": hold})

def pointer(call, x, y):
    w, h = screen_size(call)
    ev = lambda axis, v, size: {"type": "abs", "data": {"axis": axis, "value": int(v * 32767 / max(size - 1, 1))}}
    call("input-send-event", events=[ev("x", x, w), ev("y", y, h)])

_size = None
def screen_size(call):
    global _size
    if _size is None:
        p = f"/tmp/qmp-size-{os.getpid()}.ppm"
        call("screendump", filename=p)
        with open(p, "rb") as f:
            f.readline()
            line = f.readline()
            while line.startswith(b"#"):
                line = f.readline()
            _size = tuple(int(v) for v in line.split())
        os.unlink(p)
    return _size

def button(call, b, down):
    call("input-send-event", events=[{"type": "btn", "data": {"down": down, "button": b}}])

def main():
    sock, cmd, *a = sys.argv[1:]
    call = connect(sock)
    if cmd == "shot":
        call("screendump", filename=a[0], format="png")
    elif cmd == "key":
        for chord in a:
            send(call, chord.split("-"))
            time.sleep(0.05)
    elif cmd == "type":
        for ch in a[0]:
            send(call, keys_for(ch), hold=20)
            time.sleep(0.02)
    elif cmd in ("click", "move"):
        pointer(call, int(a[0]), int(a[1]))
        if cmd == "click":
            b = a[2] if len(a) > 2 else "left"
            for _ in range(int(a[3]) if len(a) > 3 else 1):
                time.sleep(0.05)
                button(call, b, True)
                time.sleep(0.05)
                button(call, b, False)
    elif cmd == "scroll":
        pointer(call, int(a[0]), int(a[1]))
        n = int(a[2])
        for _ in range(abs(n)):
            b = "wheel-down" if n > 0 else "wheel-up"
            button(call, b, True)
            button(call, b, False)
            time.sleep(0.03)
    elif cmd == "powerdown":
        call("system_powerdown")
    elif cmd == "quit":
        call("quit")
    elif cmd == "status":
        print(call("query-status")["status"])
    else:
        raise SystemExit(f"unknown command {cmd}")

main()
