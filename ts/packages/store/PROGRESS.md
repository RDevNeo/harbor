# @harbor/store

| Rust module | State | Tests ported |
| --- | --- | --- |
| store.rs | done: schema, migrations, repos, chats, items, kv, timers, procs, webhooks, digest | 8 of 8 |
| settingsync.rs | done (the service call is injected: `sync(store, token, pull, call)`) | 5 of 5 |
| secrets.rs | done except the UI card state (`State`, `Card`, `Keep`) which belongs to `ui`; `run` takes the agent env and PATH as options | 15 of 15 |
| single.rs | done (flock through `bun:ffi`, no tests in Rust; covered by 1 new test) | 0 of 0 |
| cost.rs | done, with `Totals`/`sumResults` from pages.rs (data only) | 3 of 3 (+ pages.rs `sum_results` test) |
| usage_ctl.rs | done except the egui card/bar drawing (`ui`) | 0 of 0 (3 new) |
| limits.rs | done except the egui line/settings drawing; `Limits` takes a `LimitsHost` for chats, accounts, turns and notices | 3 of 3 (+ 5 new) |

## Decisions
- `Store` is synchronous (`bun:sqlite`); types are camelCase, `Item` keeps its stored snake_case form.
- Item JSON is written by hand in serde_json's field order and f64 spelling, so the FNV digests peers compare match the Rust app. All 59,696 items of a real db copy parse and serialise to the same bytes (older results without `cached` gain the field, as the Rust save does).
- f64 spelling follows ryu as remembered (`1e16`, `0.00001`, `1e-6`); not checked against Rust, only matters for costs under 0.0001.
- `settingsync` keeps `AT`/`DIRTY` in module state; change tracking is off under `bun test` (like `cfg!(test)`), `sync_state.track` turns it on.
