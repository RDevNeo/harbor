# Harbor in TypeScript

The rewrite of Harbor on Bun, TypeScript and Slint (the plan and every package's state:
`ts/PROGRESS.md` and `ts/packages/*/PROGRESS.md`). It doesn't replace the installed Harbor yet.

## Try it on a PC

```bash
git clone --branch ts-rewrite https://github.com/RDevNeo/harbor.git harbor-ts
cd harbor-ts/ts
./run.sh
```

`run.sh` needs Bun 1.4.3 (bun.sh) and installs the packages the first time. It starts the window on a
copy of this PC's Harbor data and never touches the real files:

- A new temp folder (`/tmp/harbor-ts.XXXXXX`, printed at start) holds the data and state
  (`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`).
- `harbor.db` is copied with `VACUUM INTO` from a read-only handle. In the copy every chat starts a
  new agent session (a resumed one would add turns to the installed Harbor's chat), and the settings
  that reach other PCs, phones, the account service and secrets are dropped.
- No `identity.pem` is copied: the copy has a throwaway identity. It joins no mesh and connects to no
  relay or account service.
- Agent turns are real: they run with your own Claude Code login, in the chat's project folder, as
  the installed Harbor's would.

What works and what doesn't yet: `ts/packages/ui/PROGRESS.md`. Everything not ported says so when
clicked.

## For agents working on it

- `~/.cache/hts/check.sh [bun test args]` runs `tsc --noEmit` and `bun test` (on the PC, not boat.dev:
  see `CLAUDE.md` on this branch).
- `bun harbor.ts` with no command opens the window on whatever `XDG_DATA_HOME` points at.
  `HARBOR_VIEW=chat` opens the last chat, `HARBOR_POINTER` scripts clicks and keys (see
  `packages/ui/src/script.ts`), as in the Rust app.
- `bun packages/ui/src/gallery.ts [light]` shows every widget of the design layer.
- `bun packages/ui/src/gen.ts` regenerates `slint/theme.slint` and `slint/icons.slint`.
