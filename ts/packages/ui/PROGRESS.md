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
  selected text is tinted where egui keeps it white (the highlight lies over the words), and a selection stays within one block; Slint draws an inline `code` span boxed where egui draws it
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
| surface | done for terminals: the right and bottom panes (`slint/surface.slint`, `src/surface.ts`), opened from the top bar, Ctrl+` and Ctrl+Shift+B, resized by their edge, maximized; tabs, the "Open a surface" chooser (B, T, M, the dev-servers menu), a terminal in a tab (the terminal port's `TerminalView` and PTY), the project menu's Open terminal. the Devices tab (`slint/devices.slint`): paired PCs and phones from the hub, Send (text into a box, files, images, an image onto the clipboard) with its transfers, a PC's terminal over ssh and its file browser (`slint/files.slint` over net's FileBrowser: folders, hidden files, image thumbnails, downloads, uploads; drawn from devices.rs and checked with a stand-in ssh, not side by side: the Rust app offers Files only for an online PC, which the no-network rig has none of); not yet: dropping files on a device (Slint 1.18 takes no file drops), an image onto the clipboard only from PNGs (no JPEG conversion); the Browser tab (`slint/browser.slint`, `src/browser.ts`): Servo's `harbor-browser` starts when the tab shows and stops when its pane hides, frames from the run dir at 1:1 device pixels, back/forward/reload, the URL field, Open in my browser, pointer, wheel and keys, the page's title on its tab, recent URLs, the "Can't reach" page with local servers, and the engine-missing screens (stopped, starting, not built with Build engine, not found) | 0 of 0 (+5 new) |
| sidebar | partial: tree, list, search, statuses, Settled, snooze (presets and typed times), order by hand or by activity, project icons (the media package's favicon lookup), a project's page that starts its main chat, row menus (Rename, Settle, Make main chat, Move to project…, Move to PC… (net's MovePc: the mesh's PCs, greyed with why; the outcome as a toast), Delete; Open remote, Rename / Settle main chat, Remove project); worktree and PR marks (chatpr: looked up while shown, swept now and then; never offline); the workspace filter (account workspaces from the hub; checklist menu, "Nothing here"), dragging projects into order by their grip (manual order only); not yet: Open terminal / PRs / Issues in the project menu (pages) | 19 of 19 |
| chat | partial: draft, top bar (breadcrumb, sub-agent parent), transcript cards (user, reply, thinking, tool, tool runs, notices, messages, errors, fork and chat-link dividers), hover bar (Copy, Quote, Fork, Mention) and `/fork` through the Engine's `forkFrom`, Copy on code blocks, composer with attachments (the media package's picker); the model picker (rail, favourites, search, More models, Ctrl+1–9) and the effort menu (Default badge, Fast mode) as in the Rust app; images in the transcript (a reply's images inline with their caption, attachments and named files as thumbnails, decoded by the media package; a click opens Harbor's lightbox on the message's images (← →, Esc, Copy image, Copy path)); videos as images.rs `video` and video.rs draw them (`slint/video.slint`, `src/videopane.ts` over media's `Viewer`): a reply's video is its poster (a dark card without ffmpeg) under a play button with its name; a click plays it full-window in the lightbox from libmpv's software renderer (Harbor's `libmpv-harbor.so` beside the install, else the system's; none: the desktop's player and the Rust toast), its poster until the first frame, the controls bar (play/pause, clock, seek drag, mute, volume, full screen) fading 2.5 s after the pointer stops unless it rests on the bar or the video is paused, the name, gallery counter and side buttons, Copy path and Close; Space, ← → (seek 5 s), ↑ ↓ (volume), M, F, Page Up/Down, Esc (also in full screen, giving the window its size back); "Getting the player ready…", "Can't play this video: …" with Open in your video player; the volume is kept in kv `video_volume`; top bar branch and "N changed" from git; the trust bar over a cloned project's composer; an image pasted into the composer is attached with its `[Image #N]` token; dictation (the mic, its meter and timer, "Transcribing…", Ctrl+Shift+Space, a spoken "press enter" sending, other PCs transcribing through the hub); a chat homed on another PC (`logic/meshchat.ts` over the hub's `windowmesh.ts`): send, steer, Ctrl+Enter queue, Esc and Stop, settle, model and effort, fork and a draft started on another PC go to its home PC, "Runs on" and the read-only note while it is off, the red "Couldn't …" line with the text and mentions back on a failed send, typing and viewing leases both ways and who else types; checked against Rust 0.109.0 both ways (`rig/meshwindow.sh`); not yet: the shared draft of a copy, viewers' badges in the top bar | 0 of 0 |
| view | done: the projection is `@harbor/net`'s (one port shared with the phone API), drawn by `src/cards.ts` | 9 of 9, in `@harbor/net` |
| usertext | done as logic; the window shows chat mentions as links, tags and commands blue; erase-whole keys not wired | 15 of 15 |
| slash | done as logic; the menu shows and inserts; Harbor commands model, effort, plan, default, new, settle, fork, clear-queue run | 12 of 12 |
| tags | done as logic; `@file` menu works; `#issue` needs refs from `gh`, not wired | 9 of 9 |
| mentions | done: Mention from a message's hover bar (and "@" on tool calls, notices and messages) adds a chip over the composer with its tooltip and remove; the message goes to the agent quoted; text selected in a reply's paragraph gets "Mention selection" and goes as an excerpt (its button sits above the paragraph's start: Slint doesn't say where the drag ended; a selection stays within one paragraph); each waiting mention has its note box (Enter goes on to the message, Shift+Enter a new line), focused when a selection was just mentioned; the button waits 0.6 s and goes after 5 s unless the pointer is on it (0.109). Not done: a sent message's mention chips (and so pointing at a message and lighting up just its excerpt): `locate`, `merged`, `scrollTarget` are ported as logic, nothing calls them yet | 13 of 13 |
| chatmention | done as logic; `$chat` menu works and the mention is kept on the message; the context sent to the agent (`fillChatMention`) waits for the agents Engine | 4 of 4 |
| keys | done: the window's shortcuts go through `Keys` with the user's kv `keybindings` (send, send the other way, steer with the oldest queued, stop, sidebar, new thread, team, palette, settings) | 1 of 1 |
| agentstrip | done as logic; not drawn yet | 4 of 4 |
| teamui | done: the team panel beside a lead chat (agents with Settle / Stop, processes with their URL, Stop and output, wake-ups with Wake now / Cancel, webhooks with Copy / Delete, Settled, Earlier chats); a process's URL opens in the desktop's browser, not Harbor's | 0 of 0 |
| app | partial: window, views, turns through the Engine, theme (following Omarchy), density, last chat, desktop notifications when a chat off screen finishes or needs you (`@harbor/net`'s notifier; a click opens the chat); `ago`, `tilde`, `clipMiddle` and the rest of its pure functions in `logic/app.ts` | 2 of 2 |
| main | partial: `harbor` with no command opens the window (ts/harbor.ts calls `openWindow()` after `wire()`); the phone hub isn't started with it yet (`harbor --background` runs it alone) | 0 of 0 |
| pages (Settings) | done: all 14 tabs in the window (footer gear, palette "Settings" items), saved through the store the window's `Data` holds; Back/Esc return to the chat it was opened from (`slint/settings*.slint`, `src/logic/settings*.ts`, `src/pages/settings.ts`) | 2 of 2 |
| palette | done: Ctrl+K and the sidebar's magnifier open it over the window; picks run through the Shell (`slint/palette.slint`, `src/logic/palette.ts`, `src/pages/palette.ts`) | 5 of 5 |
| addproject | done: the sidebar's folder-plus and the composer's "Add project…" open it; new, local, Git URL and GitHub sources (`src/addproject.ts`) | 0 of 0 |
| prs, prdetail | done: footer button and a GitHub project's menu open the page; list, filters, panel with Summary/Timeline/Code (`src/prs.ts`, `src/pages/prs.ts`) | in mcp |
| issues, issuedetail | done: footer button and a GitHub project's menu open the page (`src/issues.ts`, `src/pages/issues.ts`) | in mcp |
| listdetail | done: the split, tabs, divider and menu keys of the PR and Issues pages (`src/logic/listdetail.ts`, `slint/listdetail.slint`) | 4 of 4 |
| accountui, secretsui, remoteui, phonesui | done as Settings tabs (Account, Secrets, Devices, Phones); mesh actions run on the hub, not in the window yet | 0 of 0 |
| terminal | done: in the surface panes' tabs (`slint/terminal.slint`, `src/terminal.ts`, a Bun PTY parsed by @xterm/headless) | 1 of 1 |
| tray, background | tray: started with the window (Open raises it, Quit closes it); Settings' Quit and "Start Harbor when I log in" work. Background (window closed, Harbor stays): not wired; Slint can't unmap a window on Wayland (`hide()` ends the loop but the window stays drawn until its handle is collected, and the Shell's closures keep it), and the Reloader can't restart a source run (`cfg.exe` is bun). Needs: a restart into `--background` on close and back on focus, for compiled and source runs (`src/tray.ts`, `src/background.ts`) | see `test/tray.test.ts`, `test/background.test.ts` |
| browser | done: the Browser tab of the surface panes runs the Servo engine (`src/browser.ts`, `slint/browser.slint`; see the surface row) | 0 of 0 |

The "isn't in the TypeScript app yet" dialog is gone: nothing opens it any more. The window reaches the
hub running beside it through `ShellHub` (`gh`: the Issues list merged with the mesh's PCs and Fix on
another PC; `checkUpdates`: the palette's "Check for updates"; `funnel` and `hookPort`: Settings ›
Webhooks; `moveTargets` / `movePc`: the chat menu's "Move to PC…", a submenu of the PCs with why each
can't take the chat). Providers' Update runs `provupdate.updateAll`; the Discord card's
email-and-password button asks the Discord host for its window. A Fix on another PC and Discord's window
need a second PC and the Discord host, so they are covered by tests and not shown in the rig. Terminal
entries (project menu, palette, Providers' Sign in / Install / Add Claude account, Webhooks' Funnel
steps, a PR's Check out) open a terminal tab in the bottom pane.

The composer's "Runs on" menu (remoteui.rs `device_menu`) lists this PC, the devices of Settings ›
Devices and the PCs running Harbor, each greyed out with why it can't be picked; a draft keeps its pick
(kv `default_device`), and a started chat moves there with its sessions (relocate.rs, `ts/runon.ts`;
the phone's `PATCH /v1/chats/{id}` with `device` does the same). A turn of a chat on a device runs there
over ssh (`remoteSpec` in `ts/hub.ts`). Checked in `packages/net/rig/runon.sh`: a started chat moves to
an SSH device, a turn runs there, and it comes back with its session. The composer's chip keeps the house
icon for every place (Rust draws the device's glyph and online dot).

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
- Elided sidebar titles can keep one letter fewer than the Rust app's: egui 0.37 measures with
  skrifa's advances and Slint's elide reserves more room, and the worktree/PR marks after an elided
  title sit up to 4px further right. Accepted rather than matching epaint's layout letter by letter.
- The window shows what isn't ported as disabled buttons or a dialog naming it; nothing pretends to work.

## Rust 0.109.0 (ca83ee7), ported on 2026-11-01

- chat.rs: the round "Scroll to bottom" button over the transcript while reading back; PageUp, PageDown,
  Home and End scroll the transcript when no text field holds them and no viewer is open. The composer swallows
  PageUp/PageDown and keeps Home/End, as egui's focused field does; a reply's text, once clicked, passes all four
  on, but Slint's read-only field keeps Home and End to itself (seen in the rig: PageUp scrolls, Home and End
  don't from there). A read-only chat has nothing focused, so no key arrives. Not done: egui's
  `line_scroll_speed` 60 (Slint's wheel step is its own) and theme.rs's scroll bar style (no bar in Slint).
- widgets.rs `menu_pad` and theme.rs `menu_margin` 6: the sidebar's chat and project menus (the egui-style
  `native` rows). The other context menus here are rengaf MenuItems with 8px of their own already.
- images.rs: the Esc that closes the lightbox reaches nothing else while it repeats (`Images.heldEsc`).
- mentions.rs: see the row above.
- Seen in a private sway (synthetic db, from source): the button over a scrolled-up transcript, PageUp from a
  reply's text, the project menu's padding. Not compared pixel by pixel with Rust 0.109.0; the selection
  button's timing and the Esc of the lightbox were tested as logic only.

## How a new page plugs in

1. Markup: `slint/<page>.slint`, one exported component using `widgets.slint` (Btn, MenuRow, Card,
   Input, Tabs, Empty, SettingRow, PopoverFrame…), `Theme` and `Icons`. Add it to `FILES` in
   `src/assets.ts` (one import line) so it ships inside the compiled runtime.
2. In the page's .slint file: an exported global `<Page>Bus` with every property and callback; the
   page component aliases them (`in-out property <T> x <=> <Page>Bus.x;`), so any host just writes
   `<Page> { }`. `slint/app.slint` re-exports the bus and places the page: `if root.view == "<page>":
   <Page> { }`.
3. A controller `src/pages/<page>.ts` (`mount(bus, deps)`) fills the bus and answers its callbacks;
   `src/pages/host.ts` builds the deps from the Shell, and the standalone runner (`src/<page>run.ts`)
   uses the same controller.
4. `Shell` opens it with `openPage("<page>")`; Esc and the page's close return through `leavePage()`.
5. Screens are compared with the Rust app in the rig: `HARBOR_VIEW` and `HARBOR_POINTER` work in both.

## Blockers

- None open. (The "rowData … cannot be represented in Rust" warning was `blankStatus()`'s `#00000000`:
  Slint's JS binding takes `#rrggbb`, colour names and `rgba()`, not 8-digit hex. Fixed.)
