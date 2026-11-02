# Harbor in TypeScript

Harbor on Bun, TypeScript and Slint: the app releases ship since the Rust app was retired after
0.109.0 (how it was ported, and every package's state: `ts/PROGRESS.md` and
`ts/packages/*/PROGRESS.md`).

## Try it on a PC

```bash
git clone https://github.com/RDevNeo/harbor.git
cd harbor/ts
./run.sh
```

`run.sh` needs Bun 1.4.3 (bun.sh) and installs the packages the first time. It starts the window on a
copy of this PC's Harbor data and never touches the real files:

- A new temp folder (`/tmp/harbor-ts.XXXXXX`, printed at start) holds the data and state
  (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`).
- `harbor.db` is copied with `VACUUM INTO` from a read-only handle. In the copy every chat starts a
  new agent session (a resumed one would add turns to the installed Harbor's chat), and the settings
  that reach other PCs, phones, the account service and secrets are dropped.
- No `identity.pem` is copied: the copy has a throwaway identity.
- It runs offline (`HARBOR_OFFLINE=1`): no mesh, discovery, relay, account service, port mapping or
  update check, nothing listening for phones or webhooks, no project icons fetched from websites.
- Nothing from the copy acts on its own: wake-ups, usage-limit waits, recaps, Auto-Fix and
  Auto-Merge don't run, and turns the installed Harbor left running aren't picked up. A turn starts
  only when you send a message (and what you queue behind it). `test/offline.test.ts` checks this on
  a db with due wake-ups, a waiting prompt, peers and webhooks: no turn starts and no connection is
  attempted.
- Agent turns you start are real: they run with your own Claude Code login, in the chat's project
  folder, as the installed Harbor's would.

What works and what doesn't yet: `ts/packages/ui/PROGRESS.md`. Everything not ported says so when
clicked.

## For agents working on it

- `bunx tsc --noEmit && bun test [args]` here, on the PC (see `CLAUDE.md`); `scripts/boat/check` runs
  the same on a clean sandbox and builds the release executable.
- `bun harbor.ts` with no command opens the window on whatever `XDG_DATA_HOME` points at.
  `HARBOR_VIEW=chat` opens the last chat (`chat:ID`, `settings:TAB`, `prs`, `issues` too),
  `HARBOR_POINTER` scripts clicks and keys (see `packages/ui/src/script.ts`), as in the Rust app;
  `scripts/shot` uses both for screenshots.
- `bun packages/ui/src/gallery.ts [light]` shows every widget of the design layer.
- `bun packages/ui/src/gen.ts` regenerates `slint/theme.slint` and `slint/icons.slint`.
