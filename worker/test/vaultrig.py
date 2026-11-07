#!/usr/bin/env python3
"""The account vault end to end: the fake Clerk and the real Worker (as test/run.py starts them),
then ts/rig/vaultrig.ts with two PCs of one account and the real vault client and sources.

usage: BUN=<Harbor's pinned bun> python3 test/vaultrig.py   (default `bun`)
"""
import os, subprocess, sys

bun = os.environ.get("BUN", "bun")
sys.argv = sys.argv[:1]  # run.py reads argv[1] as the Worker folder

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run  # noqa: E402

ts = os.path.join(os.path.dirname(run.WORKER), "ts")
code = 1
try:
    run.serve()
    code = subprocess.run([bun, os.path.join(ts, "rig", "vaultrig.ts"), run.W, run.CLERK], cwd=ts).returncode
finally:
    run.stop_all()
    try:
        os.remove(os.path.join(run.WORKER, ".dev.vars"))
    except OSError:
        pass
sys.exit(code)
