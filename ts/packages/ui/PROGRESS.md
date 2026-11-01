# @harbor/ui: progress

The shell: design layer, sidebar, chat transcript with markdown, composer, app wiring. Slint markup in
`slint/`, TypeScript in `src/`, pure logic ported from the Rust modules in `src/logic/`.

## What runs

- `bun ts/harbor.ts` with no command (and `ts/run.sh`, see `ts/README.md`) opens the window on harbor.db:
  sidebar with projects, chats, statuses ("1h", Working, Done, Failed), Settled, search; the draft
  ("What should we work on?") with the project picker; a chat's transcript with markdown; the composer
  with model / effort / access menus and the `/`, `@file` and `$chat` menus. A message starts a real
  turn through `@harbor/agents`' Engine, which keeps chats, transcripts, turns and queues: its events
  stream into the transcript and are saved to harbor.db. Enter steers or queues while a turn runs (the
  Follow-ups setting), Esc undoes a send nothing came of yet or stops the turn, turns left running by
  an earlier Harbor (Rust or TypeScript) are picked up at start. Copy, Quote and Mention on a message's
  hover bar work; a theme switch in Omarchy follows within a second.
- Checked in the private compositor rig against the Rust app on the same synthetic db, dark and light
  (`shots/`: draft, chat, chat light, model picker; `-rust` and `-ts`): the draft screen, sidebar,
  top bar, composer, team panel and transcript match in layout, fonts, sizes and colours to a pixel
  or two. Known differences: markdown bold is drawn bold (see Decisions); transcript text can't be
  selected.
- `.slint` files, fonts and the Lucide icons load from source and from `bun build --compile` the same
  way: `src/assets.ts` imports each one as a file and writes them once into a folder named by their
  hash (`$XDG_RUNTIME_DIR/harbor-ui-<hash>`), which Slint loads. Checked by compiling the window's
  entry with `proto/build.ts` and running it in the rig; the compiled `harbor` runtime itself is the
  update package's to build.

## Modules

| Rust module | State | Rust tests ported |
| --- | --- | --- |
| theme | done: every token, both modes, Omarchy's mode file, density, presets (`src/theme.ts`, generated `slint/theme.slint`) | 0 of 0 (+3 new) |
| widgets | done: Btn (8 variants, 6 sizes), RoundButton, StopButton, MenuRow, Spinner, StatusView, Card, Well, Badge (10 tones), Dot, Separator, VSep, FocusRing, Input, SearchField, PopoverFrame, MenuLabel, MenuSeparator, MenuItem, AccountMark, Trigger, KeyCap, KbdCombo, FileChip, Meter, Tabs, Empty, Toggle, SettingRow, Tooltip (`slint/widgets.slint`) | 0 of 0 |
| icons | done: all 114 glyphs (`src/icons.ts`, generated `slint/icons.slint`) | 0 of 0 |
| logos | partial: provider marks (`src/logos.ts`); app logos (`mark_for`, `tile`) not yet | 0 of 0 |
| surface | not started (browser / terminal / devices panes) | 0 of 0 |
| sidebar | partial: tree, list, search, statuses, Settled, snooze presets, row menus (Rename, Settle, Delete, Remove project), empty states; not yet: workspace filter, drag to reorder, project avatars, worktree / PR marks, "Order and view" beyond Settled | 19 of 19 |
| chat | partial: draft, top bar (breadcrumb, sub-agent parent), transcript cards (user, reply, thinking, tool, tool runs, notices, messages, errors, fork and chat-link dividers), hover bar (Copy, Quote, Mention; Fork says it isn't ported), composer with attachments (the media package's picker); the model picker (rail, favourites, search, More models, Ctrl+1–9) and the effort menu (Default badge, Fast mode) as in the Rust app; not yet: images and media in the transcript, trust bar, mesh composer, dictation | 0 of 0 |
| view | done: the projection is `@harbor/net`'s (one port shared with the phone API), drawn by `src/cards.ts` | 9 of 9, in `@harbor/net` |
| usertext | done as logic; the window shows chat mentions as links, tags and commands blue; erase-whole keys not wired | 15 of 15 |
| slash | done as logic; the menu shows and inserts; Harbor commands model, effort, plan, default, new, settle, clear-queue run; fork isn't | 12 of 12 |
| tags | done as logic; `@file` menu works; `#issue` needs refs from `gh`, not wired | 9 of 9 |
| mentions | done as logic; message mention chips and excerpts not drawn yet | 5 of 5 |
| chatmention | done as logic; `$chat` menu works and the mention is kept on the message; the context sent to the agent (`fillChatMention`) waits for the agents Engine | 4 of 4 |
| keys | done as logic; the window handles Enter, Shift+Enter, Esc, Ctrl+B, Ctrl+N directly, not through custom keybindings yet | 1 of 1 |
| agentstrip | done as logic; not drawn yet | 4 of 4 |
| teamui | done: the team panel beside a lead chat (agents with Settle / Stop, wake-ups with Wake now / Cancel, webhooks with Copy / Delete, Settled); processes and earlier chats not drawn yet | 0 of 0 |
| app | partial: window, views, turns through the Engine, theme (following Omarchy), density, last chat; `ago`, `tilde`, `clipMiddle` and the rest of its pure functions in `logic/app.ts` | 2 of 2 |
| main | partial: `harbor` with no command opens the window (ts/harbor.ts calls `openWindow()` after `wire()`); the phone hub isn't started with it yet (`harbor --background` runs it alone) | 0 of 0 |
| pages, palette, addproject, terminal, browser, tray, background, remoteui, accountui, phonesui, secretsui, listdetail, prs, issues, prdetail, issuedetail | not started (the queue's "ui pages" item); their buttons say so in a dialog | 0 of 0 |

Rust tests of the shell's modules: 80 of 80 ported, all passing (71 here, view.rs's 9 in `@harbor/net`).
Package total: 88 tests (17 new: markdown, the safe db copy, theme and icon generation, `.slint`
compile, cards, cursors, scripted input).

## Decisions

- Markdown: the desktop parses replies with `@harbor/net`'s `blocks` (markdown-it), the same parse the
  phone gets. `src/markdown.ts` flattens them (lists and quotes with their depth) into Slint elements,
  and turns each run of spans back into inline markdown for Slint's `StyledText.fromMarkdown`, which
  renders bold, italic, code, links and strikethrough only. Tags and commands in a user message are drawn as links (Slint's StyledText can
  colour only links), so they are blue but underlined.
- The transcript is a Flickable with a VerticalLayout, not a ListView: ListView mis-measured rows whose
  height depends on wrapped text and drew them over each other. Long chats lay out every card.
- `slint.runEventLoop()` still crashes under Bun; `src/loop.ts` (from Phase 0) pumps `processEvents`.
- Slint has no line-height, no selectable Text and no rich text colouring beyond links: line heights
  come from the font; transcript text can't be selected yet.
- Window geometry: the sidebar and main column are placed by x/width, not a layout, and the composer's
  compact / tiny modes are computed from the column width: the layouts otherwise formed binding loops
  that crash the window at runtime.
- `HARBOR_POINTER` (as in the Rust app) drives the window by Slint's `dispatchEvent` for the rig:
  synthetic Wayland clicks don't reach Slint's buttons and `wtype` drops keys.
- Markdown bold is drawn bold. The Rust app's egui loads no bold face, so its bold reads as regular
  text; that one difference from today's look is on purpose.
- The window shows what isn't ported as disabled buttons or a dialog naming it; nothing pretends to work.

## How a new page plugs in

1. Markup: `slint/<page>.slint`, one exported component using `widgets.slint` (Btn, MenuRow, Card,
   Input, Tabs, Empty, SettingRow, PopoverFrame…), `Theme` and `Icons`. Add it to `FILES` in
   `src/assets.ts` (one import line) so it ships inside the compiled runtime.
2. In `slint/app.slint`: import it, add its data as `in property` and its actions as `callback` on
   `AppWindow`, and one line in `body`: `if root.view == "<page>": <Page> { … }`. Pages that replace
   the sidebar (Settings) put theirs next to `Sidebar` the same way.
3. In `src/window.ts`: the same properties and callbacks in `AppWindow` (dashes become underscores).
4. A controller `src/<page>.ts` that reads through `Data` (`src/data.ts`, the only place that touches
   `@harbor/store`) and sets the properties; `Shell` opens it by setting `win.view` (see `unported()`
   for where the sidebar's Settings / PRs / Issues buttons land today).
5. Screens are compared with the Rust app in the rig: `HARBOR_VIEW` and `HARBOR_POINTER` work in both.

## Blockers

- One warning ("rowData returned data type that cannot be represented in Rust") shows once when the
  first card of a new chat streams in; the screen is right. Not tracked down yet.
