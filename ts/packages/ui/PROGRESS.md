# @harbor/ui: progress

The shell: design layer, sidebar, chat transcript with markdown, composer, app wiring. Slint markup in
`slint/`, TypeScript in `src/`, pure logic ported from the Rust modules in `src/logic/`.

## What runs

- `bun ts/harbor.ts` with no command opens the window on the hub (`ts/run.ts`): the window's Engine is
  the hub's, so phones, the mesh, the control socket, webhooks and GitHub pages see what it does.
  `ts/run.sh` runs the same on a copy of the data with `HARBOR_OFFLINE=1` (see `ts/README.md`).
  The window shows harbor.db:
  sidebar with projects, chats, statuses ("1h", Working, Done, Failed), Settled, search; the draft
  ("What should we work on?") with the project picker; a chat's transcript with markdown; the composer
  with model / effort / access menus and the `/`, `@file` and `$chat` menus. A message starts a real
  turn through `@harbor/agents`' Engine, which keeps chats, transcripts, turns and queues: its events
  stream into the transcript and are saved to harbor.db. Enter steers or queues while a turn runs (the
  Follow-ups setting), Esc undoes a send nothing came of yet or stops the turn, turns left running by
  an earlier Harbor (Rust or TypeScript) are picked up at start; an undone send goes back into the
  composer. Queued messages show under "Working…" as "Up next" (queue.rs): Steer / Send now, Edit in
  the composer (pencil or Alt+↑, ✓ or Enter saves, Esc cancels), Remove, move up or down, folded past
  three, "· paused" after Stop with Resume on the send button; steers on their way in show as
  "Steering…" over the status line. Checked against the Rust app in the rig, hover and edit states
  included. Copy, Quote and Mention on a message's
  hover bar work; a theme switch in Omarchy follows within a second.
- Checked in the private compositor rig against the Rust app on the same synthetic db, by measuring
  pixel rows and columns of both screenshots (`shots/*-rust.png` and `*-ts.png`), not by eye: an
  earlier eyeball pass missed 2-26px gaps. Within a pixel or two, most to the pixel: the draft page,
  sidebar (rows, search, hover buttons, Settled), top bar, composer, model picker, effort and access
  popovers, the /, @ and $ menus, chat and project right-click menus (egui's own), snooze, dialogs,
  team panel, transcript (replies block by block, user bubbles with files, tool runs and cards,
  thinking, errors, the status line, "Up next"), read-only chats, both themes. Known differences:
  transcript text can't be selected; Slint draws an inline `code` span boxed where egui draws it
  plain; Slint's line height is 20.7px for a 16px reply against egui's 21 and 17 for 13px text
  against egui's 16 (long paragraphs drift a pixel every few lines); egui's spinner dashes turn at
  other angles.
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
| surface | done for terminals: the right and bottom panes (`slint/surface.slint`, `src/surface.ts`), opened from the top bar, Ctrl+` and Ctrl+Shift+B, resized by their edge, maximized; tabs, the "Open a surface" chooser (B, T, M, the dev-servers menu), a terminal in a tab (the terminal port's `TerminalView` and PTY), the project menu's Open terminal. Browser and Devices tabs say they aren't in the TypeScript app yet | 0 of 0 (+5 new) |
| sidebar | partial: tree, list, search, statuses, Settled, snooze (presets and typed times), order by hand or by activity, project icons (the media package's favicon lookup), a project's page that starts its main chat, row menus (Rename, Settle, Make main chat, Move to project…, Delete; Open remote, Rename / Settle main chat, Remove project); not yet: workspace filter, dragging projects into order, worktree and PR marks, Open terminal / PRs / Issues in the project menu (pages) | 19 of 19 |
| chat | partial: draft, top bar (breadcrumb, sub-agent parent), transcript cards (user, reply, thinking, tool, tool runs, notices, messages, errors, fork and chat-link dividers), hover bar (Copy, Quote, Fork, Mention) and `/fork` through the Engine's `forkFrom`, Copy on code blocks, composer with attachments (the media package's picker); the model picker (rail, favourites, search, More models, Ctrl+1–9) and the effort menu (Default badge, Fast mode) as in the Rust app; images in the transcript (a reply's images inline with their caption, attachments and named files as thumbnails, decoded by the media package; a click opens the file with the desktop's viewer, not Harbor's lightbox); top bar branch and "N changed" from git; the trust bar over a cloned project's composer; an image pasted into the composer is attached with its `[Image #N]` token; dictation (the mic, its meter and timer, "Transcribing…", Ctrl+Shift+Space, a spoken "press enter" sending, other PCs transcribing through the hub); not yet: video, mesh composer | 0 of 0 |
| view | done: the projection is `@harbor/net`'s (one port shared with the phone API), drawn by `src/cards.ts` | 9 of 9, in `@harbor/net` |
| usertext | done as logic; the window shows chat mentions as links, tags and commands blue; erase-whole keys not wired | 15 of 15 |
| slash | done as logic; the menu shows and inserts; Harbor commands model, effort, plan, default, new, settle, fork, clear-queue run | 12 of 12 |
| tags | done as logic; `@file` menu works; `#issue` needs refs from `gh`, not wired | 9 of 9 |
| mentions | done: Mention from a message's hover bar (and "@" on tool calls, notices and messages) adds a chip over the composer with its tooltip and remove; the message goes to the agent quoted; not yet: a note per mention, mentioning a selected excerpt (transcript text can't be selected) | 5 of 5 |
| chatmention | done as logic; `$chat` menu works and the mention is kept on the message; the context sent to the agent (`fillChatMention`) waits for the agents Engine | 4 of 4 |
| keys | done: the window's shortcuts go through `Keys` with the user's kv `keybindings` (send, send the other way, steer with the oldest queued, stop, sidebar, new thread, team, palette, settings) | 1 of 1 |
| agentstrip | done as logic; not drawn yet | 4 of 4 |
| teamui | done: the team panel beside a lead chat (agents with Settle / Stop, processes with their URL, Stop and output, wake-ups with Wake now / Cancel, webhooks with Copy / Delete, Settled, Earlier chats); a process's URL opens in the desktop's browser, not Harbor's | 0 of 0 |
| app | partial: window, views, turns through the Engine, theme (following Omarchy), density, last chat, desktop notifications when a chat off screen finishes or needs you (`@harbor/net`'s notifier; a click opens the chat); `ago`, `tilde`, `clipMiddle` and the rest of its pure functions in `logic/app.ts` | 2 of 2 |
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
  height depends on wrapped text and drew them over each other. So that long chats still open at
  once, it builds the latest 80 cards and offers "Show earlier messages" (the Rust app culls what's
  off screen instead and scrolls through the whole chat).
- `slint.runEventLoop()` still crashes under Bun; `src/loop.ts` (from Phase 0) pumps `processEvents`.
- Slint has no line-height, no selectable Text and no rich text colouring beyond links: line heights
  come from the font; transcript text can't be selected yet.
- Window geometry: the sidebar and main column are placed by x/width, not a layout, and the composer's
  compact / tiny modes are computed from the column width: the layouts otherwise formed binding loops
  that crash the window at runtime.
- `HARBOR_POINTER` (as in the Rust app) drives the window by Slint's `dispatchEvent` for the rig:
  synthetic Wayland clicks don't reach Slint's buttons and `wtype` drops keys.
- Markdown bold is drawn regular, as the Rust app draws it (egui_commonmark gives it the strong
  colour, not a bold face), so the screens match. One line in `markdown.ts` `span` brings bold back
  if the owner wants it.
- Rename's button reads "Save changes". Rust bug: the Rust app's says "Salvar Alterações"
  (pages.rs `Dialog::Rename`), Portuguese in an English window.
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

- None open. (The "rowData … cannot be represented in Rust" warning was `blankStatus()`'s `#00000000`:
  Slint's JS binding takes `#rrggbb`, colour names and `rgba()`, not 8-digit hex. Fixed.)
