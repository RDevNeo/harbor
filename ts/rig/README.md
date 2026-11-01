Phase 0 measuring rig. Everything runs on one PC, inside `unshare -Urn` (no network) on a private headless
sway, against a scrambled copy of a harbor.db (`strip.py`), with a fake `claude` that streams 40 deltas a
second. Nothing here touches the real data or the mesh.

- `up.sh` starts the compositor; `app.sh WHICH` starts one app on throwaway state (`rust`, `proto`, `runtime`, `bun`, `node`).
- `measure.py WHICH STAGE...` prints one JSON line per stage: `startup`, `idle`, `twenty`, `stream`.
- `m.sh LOG WHICH STAGE...` runs it with the rig's environment; `final.sh` is the table run, `extras.sh` the
  download sizes and the video path. Both hold `~/.cache/hts/check.lock` for each stage.
- `clean.sh` stops what the rig started, found by its data folder and never by name.

The paths in the scripts are the layout used on the desk PC: `~/.cache/hts/tmp-p0` (rig, fake claude, state),
`~/.cache/hts/tmp` (the compiled prototype in `dist/`, `stripped.db`). The Rust reference is the 0.108.0 release binary,
copied to `tmp-p0/rs/harbor-p0` so that another agent's `pkill harbor-ref` cannot hit it.
