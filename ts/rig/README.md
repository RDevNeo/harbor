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

## Running cost of the real app

- `cost.py STAGE...` (`idle`, `chat`, `stream`): starts `run.sh` from this clone inside `unshare -Urnm` on its own
  headless sway, with a scrambled db (`HTS_TMP=DIR` holding `stripped.db` from `HTS_TMP=DIR strip.py`) and the
  fake `claude`; prints CPU, wakeups (voluntary context switches of every thread), the busiest threads and
  `smaps_rollup` Rss + Swap. `stream` sends a message with HARBOR_POINTER and samples the reply, its end and after.
  `HTS_LOOPSTATS=1` splits the window's CPU into Slint's `processEvents`, `setProperty` and the rest
  (`loopstats.ts`); `HTS_PROFILE=1` writes Bun's CPU profile; `HTS_RUNTIME=node` runs the same app under Node.
  Settings: `HTS_TMP` (default `~/.cache/hts/tmp-cpu`), `HTS_SECS` sampled (25), `HTS_SETTLE` before sampling (20),
  `HTS_STREAM_S` the fake reply's length (40), `HTS_ENV` extra `KEY=VALUE` pairs for the app.
- `stacks.py PID [N] [GAP]`: native stacks of the window's thread with eu-stack, the Slint and Skia frames by name.
- `bench.sh [VAR=...]`: `streambench.ts`, the window alone with a reply streaming into it, ms per update.
  `HTS_OLD` earlier replies above it (0), `HTS_SECS` (30), `HTS_HZ` updates a second (20), `HTS_LIVE=0` sends the
  reply's blocks in its row instead of the live model.
- `layoutbench.ts VARIANT [BLOCKS]`: which Slint layout construct keeps a growing column cheap.
