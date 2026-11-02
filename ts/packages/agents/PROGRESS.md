# @harbor/agents: progress

Phase 1. Rust modules of this package and where they stand. Rust tests: 72 of 78 ported under
their Rust names (PARITY.md counts them); the 6 left are four `#[ignore]` real-ssh tests (three
agent, one detach), the phone block model's (net's spans) and the exec reload's. 124 TypeScript
tests in all.

| Module | State | Rust tests ported |
| --- | --- | --- |
| detach | done | 10 of 11; `remote_turn_ends_over_ssh` is `#[ignore]` (real ssh + mcp's bridge) |
| agent | done; remote turns build through net's `remoteLaunch` and mcp's bridge once `ts/wire.ts` runs (not yet run against a real device) | 6 of 9; the two remote ones run in `ts/test/wire.test.ts` against net's and mcp's real code; the 3 left are `#[ignore]` real-ssh tests |
| providers | done | 1 of 1 |
| oauth | done | 6 of 6 |
| provupdate | done (status as data + `onChange`) | 2 of 2 |
| queue | done in `Engine`: follow-ups, steer with every fallback, Codex restart, held queue, snapshot/restore, `queueJson`; the desktop's edit-in-composer belongs to ui | 5 of 5 |
| team | done in `Engine` (tools in tools.ts) for this PC: triggers, hourly auto-turn limit, sub-agent slots, reports, spawn/message/read/stop/retire, processes, snooze, webhooks (local URL); not yet: `handle_hook` (webhook requests arrive through mcp's control socket), secrets tools (host `tool` hook), retiring another PC's agent | 5 of 5 |
| openchat | done in `Engine` for this PC: open_chat, list_chats, find_chats, message_chat; another PC's chats through `EngineHost.openElsewhere` (net) | 5 of 5; `opened_chats_link_back_on_both_sides` covers this package's half (the notice), the card half is ui's/net's |
| movechat | done (`Engine.movable`/`moveChat`, session copies) | 2 of 2 |
| fork | done (`Engine.forkFrom`, Claude session cut, preamble otherwise) | none in Rust |
| undo | done (`Engine.esc`/`tryUndo`/`stopAll`; the draft goes back through `EngineHost.restoreDraft`) | none in Rust |
| worktree | partial: every git operation (head, branches, rank, switch, create, make with Haiku names, rename on GitHub or remote, folder moves, remove); the bar, menus, `ws_*` App state and API calls not yet | 9 of 9 |
| git | done | 2 of 2 |
| commits | done but the phone block model (`mark`/`split`: net's api.rs spans) and the desktop card; `sites` is a small scanner instead of pulldown-cmark | 5 of 6 |
| chatpr | done (`ChatPrs`: lookup, kv `chat_prs`, sweep) | 3 of 3 |
| recap | done: Claude Code's prompts, filters, transcript condensing, `ask`, and `Recaps` (suggestion after each turn, recap after 3 min away, kv `recap:`/`suggestion:`) driven by `Engine.tick()` | 4 of 4 |
| procs | done except `reap_inherited` (an exec reload's zombies; Bun reaps its own children) | 2 of 3 |
| waiting | done: `subsRunning`, `Engine.subsQueued`/`runningSubs`; the status line is ui's | none in Rust |
| autowork | done: Auto-Fix/Auto-Merge selection, the fix and merge prompts (untrusted text fenced, user instructions win), `Work` (launch, fix, merge, the auto tick, kv `auto_handled`); the button, dropdown and instructions dialog are ui's | 5 of 5 |

## What runs

- `bun ts/harbor.ts turn <dir>` (and the compiled `harbor turn <dir>`) is the detached runner:
  `cmd.json`, `in`/`in.closed`, `out`, `err`, `pid`, `exit`, `stopped`, guest logins lent and
  taken back, ssh retries and the lingering-ssh cut. Compiled, its command line is
  `harbor turn <dir>`, the shape the Rust app's `runners()` looks for.
- Pickup of a Rust runner's turn: `test/rust-pickup.rig.ts` starts the installed Rust
  `harbor turn` (0.108.0) inside `unshare -Urn` with temp HOME/state/data; the TypeScript side
  finds it in `runners()` and `leftovers()`, follows it, writes a message mid-turn, closes the
  input and sees it end well. PASS.
- A real turn: `test/real-turn.rig.ts` runs Claude Code (Haiku, scratch folder, temp turns and
  data folders); the process that started it quits mid-turn, a new one picks it up from its
  folder and sees it to the end ("pong", ~2.7 s). PASS.
- `Engine` (engine.ts) is the headless owner of chats, transcripts, running turns, waiting
  prompts, the follow-up queue, team tools and automatic-turn limits. ui renders it; mcp and net
  call into it; other packages plug in through `EngineHost`. Tested end to end with a fake
  Claude CLI: send, steer, queue, stop and resume, busy chats, a CLI that isn't there, pickup by
  a new engine, cut-off restart, a lead spawning a subagent whose report wakes it, open_chat and
  message_chat, the hourly pause, snooze, Esc-undo, fork.

## Decisions

- The turn folder is the contract and is matched byte for byte: `cmd.json` has serde_json's
  sorted keys (the Rust build has no `preserve_order`), `env` sorted and deduplicated the way
  Rust's `Command` keeps it; `meta.json` in the struct's field order; `bridge.json` likewise.
  `meta.json` is read only when every field has the right type, as serde does.
- From source, Harbor starts itself as `bun ts/harbor.ts …`; `runnerChat` also accepts that
  form. Only the compiled form is seen by a Rust Harbor, which is the shipped form.
- What other packages own is plugged in, not copied: `setAgentEnv` (mcp.rs `agent_env_as`),
  `integrate({ servers, bridge, remote, workspace })`, `EngineHost`. `ts/wire.ts` plugs mcp and
  net in (`harbor turn` calls it; the app must too). Without it the runner hides every sign-in, a
  turn's MCP config holds only Harbor's own servers and remote turns throw a plain error.
- autowork reads mcp's GitHub data through its own structural types, so agents never imports
  mcp (mcp's control socket will call into `Engine`).
- `Engine.send` defaults to Queue when no mode is given, as Rust's `send_to` does; the composer
  passes kv `follow_up` (`followDefault()`).
- Each turn's events are bound to its own entry, so a stopped turn's late exit can't end the
  next turn even while that one's runner is still starting (a race Rust doesn't have: its spawn
  is synchronous).
- A forked Claude session keeps each line's key order with only `sessionId` changed (Rust
  re-serializes the lines with sorted keys); Claude Code reads either.
- flock for `.credentials.json.lock` goes through libc with `bun:ffi` (Bun has no file locks).
- Paths, `now`, `randomHex`, `newUuid`, `writePrivate` come from `@harbor/store`.
- Queries that took a thread in Rust (git, worktree, chatpr, commits, provupdate, recap's ask)
  are async; npm's registry is asked with `fetch` instead of curl.
- tags.rs's `rank_files` and prs.rs's `github_repo` are copied here (`rank.ts`, `worktree.ts`):
  the branch picker needs them and ui/net own the originals.
- Tests that run git set `core.hooksPath=/dev/null`: this PC's global commit and push hooks
  would otherwise run (and spend tokens) on every test repository.

## Missing

- Remote turns: wired, but never run against a real device (needs a key-based ssh rig).
- `Engine` doesn't schedule itself: the app calls `Engine.tick()` (queue, wake-ups, recaps) and
  `ChatPrs.sweep` on its tick. Webhook requests (`handle_hook`), usage-limit holds (store's limits through
  `limitGuard`/`limitEvent`) and notifications are host hooks not wired yet.
- worktree's App side (the bar, its menus and the API calls).

## Blockers

- The `reviewers` comments check times out (300 s) on large commits while the PC is loaded:
  commits are split small to get a verdict.
