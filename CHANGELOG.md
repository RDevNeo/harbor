# Changelog

All notable changes to Harbor. Versions follow [SemVer](https://semver.org/) (0.x: anything may
still change); the version in `Cargo.toml` is the source of truth, and a `vX.Y.Z` tag publishes it.

## [Unreleased]

### Changed
- The usage line under each agent turn ("Claude · Opus 5.5 · 6.3s · 158k in · 358 out · $0.85")
  no longer shows in the chat, on the desktop and the phone. Tokens and cost stay in the chat's
  header and in Usage.
- "from <PC or phone>" on a message written elsewhere now sits small in the bottom-right corner
  inside its bubble, instead of under it, on the desktop and the phone.

## [0.59.1] - 2026-10-27

### Fixed
- After "Mention selection" the cursor now really lands in that excerpt's note box (also for
  a second excerpt while another is waiting). Before, releasing the mouse on the button took
  focus away from the note box again, so what you typed didn't go into the note.

## [0.59.0] - 2026-10-27

### Added
- A note for each mention: every mention waiting in the composer (an excerpt or a whole message)
  has its own box to write about that one thing. The agent gets each quote with its note right
  under it, then your message; the sent message shows each note under its chip, on the desktop
  and the phone. Mentioning a selection puts the cursor in its note box; Enter there moves on to
  the message (Shift+Enter: a new line), so it never sends by surprise.

## [0.58.0] - 2026-10-27

### Changed
- Tool calls no longer fill the chat: each run of them (with the thinking between them) folds
  into one small row, "› 5 tool calls", closed until you click or tap it, on the desktop and
  the phone. It turns while a call runs and never opens by itself. Phone API: cards have an
  optional `group`.

## [0.57.1] - 2026-10-27

### Changed
- Esc leaves Settings and goes back to where you were (the chat or page you opened it from),
  like its Back button. An open menu, dialog, or a key being set in Keybindings still takes Esc
  first, and in a text field Esc only leaves the field. Desktop only: the phone's Back already
  does this.

## [0.57.0] - 2026-10-27

### Added
- Agents can open chats: a chat's agent can start a new chat in the sidebar (desktop and phone)
  with its `open_chat` tool, for an independent topic you want as its own thread; the new chat's
  agent starts on its first message at once. Both chats link to each other ("Opened by the agent
  of …" · Open chat). `list_chats` and `message_chat` let it follow up. A chat driven from
  another PC opens chats only on the PC it runs on, for the same person.

## [0.56.0] - 2026-10-27

### Added
- Live draft preview: while someone types in a chat on another device, the desktop and the
  phone show what they're writing above the composer ("✎ Galaxy A13: fix the build…", the end
  of the draft in two lines) instead of only "is typing…". Older phones still show as "is
  typing…". Hub API: `text` on `POST /v1/chats/{id}/typing` and on each chat's `typing`.
- Mention a piece of a message: select text in any message of a chat (yours or the agent's) and
  a "Mention selection" button appears by it. The chip holds just that excerpt, in quotes, and
  still points at its message (click it to see the message); the agent gets only the excerpt,
  quoted as "excerpt of a message from …". The phone shows excerpt chips in quotes too.

## [0.55.3] - 2026-10-27

### Changed
- Paired PCs share everything by default (shell, any file, GitHub); lower it per PC in Devices.

### Fixed
- A chat shared from another PC now shows its images on this PC's desktop: a picture you attach
  to such a chat (and anything its agent shows) is fetched from the PC the chat runs on, instead
  of a broken placeholder for everyone but that PC. The phone already did this.

## [0.55.2] - 2026-10-27

### Fixed
- The desktop sidebar no longer hides a project's oldest open chat behind the project row: every
  chat of a project now has its own row, as on the phone, so a chat no longer goes missing on the
  PC or seems to sit inside another chat. The phone takes the desktop's placement from the hub
  (snoozed chats stay hidden on both).

## [0.55.1] - 2026-10-27

### Fixed
- Phone: an automatic update that can't install by itself no longer just fails quietly. Google
  Play Protect refuses background installs of builds it hasn't scanned yet
  (`INSTALL_FAILED_VERIFICATION_FAILURE`), so the phone now shows a "Harbor X is ready: tap to
  install" notification once per version; tapping it installs it in front, where Play Protect can
  ask to scan it. After such a refusal, later versions skip the background try and come as that
  notification, until you ask Settings to try the background again (after turning on Play
  Protect's "Improve harmful app detection"). Settings shows Android's whole reason instead of
  cutting it off, and a tap shows it to copy.

## [0.55.0] - 2026-10-26

### Added
- Dictation now transcribes with NVIDIA Parakeet TDT 0.6B v3 (25 European languages, detects
  the language itself), built into Harbor through sherpa-onnx: faster and more accurate than
  Whisper, which stays as the fallback for other languages. Its model (670 MB) downloads by
  itself on the first dictation, with progress by the mic.
- The speech model loads while you speak, in a process of its own, and is freed after a few
  idle minutes (Settings › Voice › Keep speech model loaded, default 5 min): no memory or CPU
  while you don't dictate, and a crash or out-of-memory in the speech engine never takes Harbor
  down. Parakeet isn't loaded when less than 1.2 GB is free (Whisper or another PC instead).
- Each recording is transcribed on the PC of your mesh with the most free memory (this PC on a
  near tie; PCs that don't answer are skipped). Phones' recordings go the same way through
  their hub.
- Clean up dictation (Settings › Voice, on by default): filler words and false starts go,
  punctuation and capitals are fixed and spoken corrections ("no wait, I meant…") applied,
  through this PC's Claude account (Haiku, a few hundred tokens). The raw text when it fails.
- Hub API for the phone: `GET /v1/voice`, `PUT /v1/voice/settings`, `POST /v1/voice/cleanup`,
  and `cleanup`/`local` on `POST /v1/transcribe` (answers add `raw` and `host`).

### Changed
- The built-in Whisper now runs on the same engine as Parakeet (sherpa-onnx) instead of
  whisper.cpp: no AVX2 needed any more, and Harbor builds without cmake. Whisper models
  downloaded before need downloading again (Settings › Voice); `HARBOR_WHISPER` still runs an
  external `whisper-cli` with a ggml model.
- Phone dictation no longer uses Google's speech services. The phone records and cuts what you say
  into phrases at pauses (Silero VAD, on the phone); each phrase goes to your PC, which
  transcribes it, so the words appear while you talk and pauses never stop it. Tapping stop puts
  in the last phrase, and with "Clean up dictation" on the PC tidies the whole text once.
  Settings › Dictation on the phone mirrors that switch.
- Offline dictation on the phone: when the PC can't be reached or doesn't answer within a few
  seconds, the phone transcribes the phrase itself with sherpa-onnx (Parakeet TDT 0.6B v3 on
  phones with 6 GB of memory or more, Whisper small or base on others). The model downloads on
  Wi-Fi after the first dictation (Settings › Dictation › Offline dictation shows its progress,
  and removes it), and takes memory only while you dictate. The app is ~9 MB bigger for it.

## [0.54.1] - 2026-10-26

### Fixed
- Steering is reverted: a message sent while the agent works is queued again and delivered when
  the turn ends, as before 0.49.0, on the desktop and the phone. Queued messages can be edited
  and removed again (Esc, /clear-queue), and Ctrl+Enter queues. Steering mid-turn was unreliable.

## [0.54.0] - 2026-10-26

### Added
- The phone updates itself: Settings › Update automatically (it follows your PCs' Settings ›
  Updates until you choose on the phone). New versions download and install in the background,
  only while the screen is off or locked, never while you use Harbor, and the next time you open
  it you're back on the chat you had, draft included. If Android still wants you to confirm, a
  notification finishes it instead of a dialog popping up.
- Turn on automatic updates for your other PCs from one place: Settings › Devices has
  Auto-update per PC and "Auto-update all PCs"; on the phone, tap a PC in sidebar › PCs to pick
  Automatically or Ask me, or "Auto-update all". Each PC's line says when it updates
  automatically.

### Changed
- Automatic updates on the desktop no longer restart Harbor in front of you: the new version
  installs in the background with no toast and swaps in only while nobody sees it (the window
  closed, or focused and left alone for two minutes with nothing typed in the composer and the
  chat not scrolled back), instead of as soon as the window is focused, and comes back on the
  same screen. The Update ready button still swaps in at once.

## [0.53.1] - 2026-10-26

### Fixed
- Phone dictation keeps everything said across pauses: Google's speech services (what most
  phones, Samsung's included, use) start their words over after a pause and drop the earlier
  ones, so a sentence, a pause and the next sentence put in only the last; each phrase is kept
  now. Listening runs on one recogniser until you tap stop (no restart gaps or beeps between
  segments), a recogniser that goes silent is replaced, and only a minute without words ends it.

## [0.53.0] - 2026-10-26

### Added
- Voice input works out of the box: whisper.cpp is now built into Harbor, so dictation no longer
  needs a separate whisper.cpp install. With no speech model yet, the first dictation downloads
  Base (142 MB) by itself while you speak and shows its progress by the mic, then transcribes.
  Phones that send their recording to the PC get the same: no setup on the PC either.
  `HARBOR_WHISPER` still names an external `whisper-cli` to use instead.

### Changed
- Voice errors are short and say what to do; the mic only mentions a missing recorder when
  neither pw-record nor parecord is there.

## [0.52.0] - 2026-10-26

### Added
- Commit pills: a commit hash in an agent's reply (bare or in inline code) shows as a clickable
  chip with the git-commit icon and the short id instead of raw hex, on the desktop and the
  phone. Only hashes git confirms as commits of the chat's project become pills, so colours,
  fingerprints and the like stay text, and code blocks are left alone. The desktop shows the
  subject on hover. Clicking a pill on the desktop (or tapping it on the phone, as a bottom sheet)
  opens the commit's card: subject, message, author, date and changed files with their +/− counts,
  plus Open on GitHub, Copy SHA and Show diff.

## [0.51.0] - 2026-10-26

### Added
- Update your PCs from the phone: sidebar › PCs lists every PC your phone reaches with its
  Harbor version and status, an Update button on each one that's behind, "Update all" when
  several are, and "Check for updates". On the desktop, Settings › Devices shows the same per
  PC (this one included), with Update for each PC that's behind and "Update all PCs".

### Fixed
- Update from the phone (or another PC) no longer answers "Harbor is up to date" when a release
  is out but the PC hadn't checked yet (it checks only every 4 hours): it checks now, installs
  what it finds and reloads, and the phone's banner shows "Looking for the newest Harbor…".

## [0.50.0] - 2026-10-26

### Added
- Agents can show images and videos in their replies, inline in the chat on the desktop and the
  phone: a markdown image in the reply (`![caption](path)`, with an absolute path, a path in the
  project, `file://` or an https URL) or Harbor's new `show_media(path, caption)` tool, which every
  agent is told about. PNG, JPEG, GIF, WebP and SVG images show large in the reply and open the
  full-screen viewer (pinch to zoom on the phone); MP4, WebM and MOV videos show their first
  frame (with ffmpeg) and a play button: the desktop opens your video player, the phone plays it
  full screen. Only real image and video files are shown (checked by their contents, at most
  40 MB for an image and 200 MB for a video, never from key folders like `~/.ssh`); one that's
  missing or can't load says so with a Retry. Chats on another PC show theirs through it.

## [0.49.0] - 2026-10-26

### Changed
- A message sent while the agent works now steers it instead of waiting in a queue, on the
  desktop, the phone and from other PCs. Claude gets it at once and takes it in at its next
  tool call (or right after its reply); Codex, Cursor, Gemini, Grok, OpenCode and Meta, which
  take no input mid-turn, are interrupted and resume the same session with the message, told
  why they stopped. The message shows as your own bubble marked "Steering…" until the agent
  takes it in. The queued bubbles, their edit and remove buttons, Esc to unqueue and
  `/clear-queue` are gone; Ctrl+Enter does the same as Enter, and a Steer button sits next to
  Stop when something is typed. A message no longer waits while someone types on another
  device. Stop still hands back what the agent hadn't taken in.

## [0.48.2] - 2026-10-26

### Fixed
- Phone dictation: tapping the mic again stops it and puts in what was said (the last words
  heard when the recogniser's final ones don't come) instead of an error. It keeps listening
  through pauses until you tap stop (about 15 s without words ends it), never opens the
  system's dictation pop-up, and a phone whose recogniser fails falls back to its other
  recogniser, then to the PC's whisper.cpp. Leaving the chat keeps what was heard in the draft.

## [0.48.1] - 2026-10-26

### Fixed
- On the phone, the recap over the composer steps aside while you type (composer focused, keyboard
  up) so the transcript stays readable, and comes back when the keyboard closes.

## [0.48.0] - 2026-10-26

### Added
- A chat waiting at a usage limit offers **Continue on…** on the phone too: a chip under the
  limit line opens a sheet of the provider's other signed-in accounts that aren't blocked, and
  the chat moves to the one picked and continues there (also for chats on remote devices and
  chats whose home is another PC). The hub sends them as the limit's optional `targets` and
  takes the choice at `POST /v1/chats/{id}/continue_on`.
- When automatic switching is off but another account could take the chat, the limit
  notification says "Continue on <account> available".

### Fixed
- A limit reported twice in one turn (Claude's rate-limit event, then its message without a
  reset time) no longer replaces the known reset with a 15-minute guess: a chat at its weekly
  limit waits for the real reset instead of waking every 15 minutes, burning a turn and hitting
  the limit again.
- Claude's "You've hit your weekly limit · resets 12am (America/Sao_Paulo)" wording (also
  "resets 3:30pm (…)" and "resets Oct 30, 5pm (…)") is read as a limit with its reset time and
  window.

## [0.47.1] - 2026-10-26

### Fixed
- Harbor checks for updates on its own timer, not on window frames: a hidden or unfocused
  window (which may draw nothing for hours) or no window at all still notices new releases,
  installs them when updating automatically, and offers them to phones and other PCs.
- A version already installed on disk (by `harbor --update`, or while this one ran) is offered
  as "Harbor X is installed": the desktop pop-up, the phone's banner and `POST /v1/hub/update`
  (phone or another PC) restart into it instead of answering "Harbor is up to date". A remote
  Update replies first, then restarts, with or without a focused window.

## [0.47.0] - 2026-10-26

### Added
- Who is who fills itself in: each PC detects its owner's name and GitHub login from what it
  finds (git, gh, its agent accounts and phones, SSH hosts and key comments, CLAUDE.md, what the
  other PCs report), with one short Haiku question through the PC's own Claude account (plain
  rules without one). Never keys or tokens. The detection shows as "detected, not confirmed"
  until you confirm it: Settings › Devices › People and memory (Confirm, Edit, Detect again) on
  the desktop and the phone, plus a one-time "Is this you?" pop-up and phone banner. A name or
  login you typed always wins. It runs at startup while unconfirmed and again when a PC or phone
  pairs.

## [0.46.4] - 2026-10-26

### Fixed
- A lead chat shows as working while any of its sub-agents run or have work queued, on the phone
  too (its chat list spinner); the API gives it as `working`.
- Images in chats read through another PC of the mesh (a phone relayed via another PC) come from
  the PC the chat runs on instead of an empty tile; a tile that can't load says so and retries
  on tap.
- The agent strip keeps the agent's name and what it's doing readable: on the phone its tokens
  and cost go on a dim second line, on the desktop they only show when there's room (and on hover).
- Phone: while it talks to your PCs through another one, it tries its own PC again every minute
  and goes back to it, and it says when the PC answering runs an older Harbor than the app.
- Phone: an empty lead chat says "What should we work on?" like the desktop, and a chat's drawer
  shows the "Harbor isn't running" card too.

## [0.46.3] - 2026-10-26

### Fixed
- Issues: the Project filter lists the projects of every PC whose issues are on the page (with the
  PC as a hint), plus the other repos in the list, and filtering by another PC's project works, on
  the desktop and the phone. Before, it only offered the PC that answered.

## [0.46.2] - 2026-10-26

### Fixed
- Phone: the suggestion's "⇥ Use" chip no longer pushes the send button off the composer. It sits
  in the text box's top-right corner (where the desktop shows "⇥ Tab"), a tap on the grayed
  suggestion itself takes it too, and the model pill shortens with "…" before anything else moves,
  so send and mic always fit at any width or font size.

## [0.46.1] - 2026-10-26

### Fixed
- Phone: new cards no longer slide under the bars over the composer when the agent strip unfolds
  or grows: the chat keeps its end in view.
- Phone: a chat's token and cost total leads its header line, and an agent's leads its line in the
  Team panel, so they aren't the part cut off on a narrow screen.
- Phone: Harbor's notifications show its anchor in the status bar instead of a plain circle.
- Phone: Settings › Allow notifications and Only when I'm away wrap their explanation.

## [0.46.0] - 2026-10-26

### Added
- Every PC's files for every chat (#77): while the mesh has other PCs, agents get `machines` tools
  (list, bash, read, write, edit, glob, grep, github) that work on any PC by name, whichever PC the
  chat runs on. Each PC's owner chooses per PC what chats from there may do (Settings › Devices, the
  menu next to each PC): nothing, read their Harbor projects (the default), edit them, or everything
  (shell, any file, GitHub). The phone's Settings › People and memory shows and changes the same.
- GitHub through the PC a chat is driven from: such a chat can run `gh` on that PC with its owner's
  Harbor GitHub sign-in, so the issues and pull requests it makes are theirs (Settings › Devices ›
  My chats on other PCs may use my GitHub here, on by default; without full access it takes no
  file paths there).

## [0.45.0] - 2026-10-26

### Added
- Issues from every PC: the Issues page (desktop and phone) merges the issues of every connected PC
  of the mesh, each fetched with that PC's own GitHub login and projects, one row per issue. A new
  Account filter (the desktop's Filters menu, a chip on the phone) shows one login's issues, and
  Involvement (Assigned / Authored / Mentioned) follows the picked account. With several accounts
  each row names the ones that see it. Close / Reopen, the issue's details and Fix with… run on a
  PC whose account sees the issue (Fix with… on one that has the project). A PC that's off or not
  signed in to GitHub leaves a small note instead of blanking the page.

### Fixed
- Projects whose remote is an `ssh://git@github.com/…` URL were left out of the Issues and Pull
  requests pages (and their Open on GitHub links were wrong); `git@github.com:…` remotes and
  other forms are recognised everywhere too.

## [0.44.0] - 2026-10-26

### Added
- Chats driven from another PC run as that PC's person (#79): a message or new chat sent from one PC
  to a chat that runs on another carries the sender's global `CLAUDE.md`, their auto-memory of the
  project and their language settings, and the host runs the turn in an overlay profile with them
  instead of its own owner's instructions and memory. Memory the agent saves goes back to the PC that
  sent it. The host's GitHub and app sign-ins stay off for someone else's chat (unless both PCs say
  the same GitHub login). SSH devices likewise no longer load the device's own instructions and memory
  for this PC's chats. A notice in the chat says whose context it runs with, on the desktop and the
  phone. Settings › Devices › Send my instructions and memory turns it off.
- Who is who across the mesh (#78): each PC says its owner and GitHub login (Settings › Devices ›
  People and memory, guessed from the account and Harbor's GitHub sign-in), and every agent is told
  which PC, phones and accounts belong to whom. The phone's Settings › People and memory shows the
  same list and edits this PC's entries.

## [0.43.2] - 2026-10-26

### Fixed
- User messages in a chat are no longer cut off on the right (their text and the "from … via …"
  line under them): a long agent report or notice widened the transcript past its column, and the
  bubbles were laid out against that wider edge. Notices now end in "…" inside the column (whole on
  hover), bubbles keep to the column at any window or panel width, and a long sender line ends in "…".
- The composer's bottom row goes icon-only earlier, so the model, access and device pickers no
  longer run under the mic and attach buttons in a narrow window.

## [0.43.1] - 2026-10-26

### Fixed
- Phone: an unset effort shows and starts as the provider's default (High for Claude) instead of
  Low, as on the desktop.
- Phone: the branch chip under the composer gets its branch icon back after a switch (it kept the
  loading icon).
- Phone: lines under options in the workspace and branch sheets wrap instead of being cut off, and
  so does Settings › Sign-in.
- Phone: the "Harbor isn't running on <PC>" card no longer repeats its title in the text, and the
  update banners wait until the PC answers again (their buttons need it).

## [0.43.0] - 2026-10-26

### Added
- A keyboard-shortcut cheat sheet: Ctrl+/ anywhere (or ? outside a text field) lists every
  shortcut with the keys it has now, with a filter and a way to change them.
- Density: Settings › Appearance › Comfortable or Compact (shorter rows in the sidebar, menus and
  settings, less space between messages). The phone has its own Density in its Settings.

### Changed
- Dialogs follow rengaf (two widths, a close button, a darker backdrop); Theme, Updates and the
  voice language are segmented tabs; settings controls line up with the top of their title.

## [0.42.2] - 2026-10-26

### Fixed
- Tab on a grayed prompt suggestion fills it in and keeps typing in the composer: focus no longer
  jumps out of the input box.

## [0.42.1] - 2026-10-26

### Fixed
- `install.sh` no longer writes the launcher into a data directory outside `$HOME`: with `HOME` overridden
  but `XDG_DATA_HOME` still pointing at the real session, the real launcher got an `Exec=` into the
  temporary home. It now falls back to `$HOME/.local/share` and says so (#76).

## [0.42.0] - 2026-10-26

### Added
- Unread dots: a thread that finished while you were elsewhere shows a small blue dot in the sidebar
  (instead of a green "Done"), on the desktop and in the phone's chat list; opening it on either
  clears it. Empty lists (no projects, no pull requests or issues, nothing paired) show a proper
  empty state with what to do next, and the sidebar's Settled group and width follow rengaf.

## [0.41.0] - 2026-10-26

### Changed
- Design: Harbor's controls follow the rengaf design system's components. Buttons take rengaf's sizes
  (28, 32 and 36 px) and default to the outline style; menus and popovers are less rounded, with a
  lighter shadow and rengaf's hover colour; tooltips are inverted, small and dark-on-light (light on
  dark); switches are gray instead of blue; badges have their border; text keeps rengaf's line
  heights and heading tracking; scrollbars and key caps match.

## [0.40.0] - 2026-10-26

### Added
- Notifications for what matters, on the desktop and the phone: an agent needs you (a lead chat
  asks you something, or waits after a usage limit), a lead chat finished (sub-agents too if you
  want), checks failed on one of your PRs, a usage limit was hit or came back, another PC went
  offline. One notification per chat, updated instead of piling up. The phone gets them even with
  the app closed, with no Google push service: within about 15 minutes, within a minute for a while
  after you leave the app, or within seconds with the optional Instant notifications (a silent
  ongoing notification, a little more battery). Reply from the notification goes straight into the
  chat (three-factor phones unlock first), Continue resumes a chat after a limit, tap opens it. The
  desktop shows them only while Harbor's window isn't in front; click opens the chat. Settings ›
  Notifications on both: which events, quiet hours, only when you're away from the PC.

## [0.39.0] - 2026-10-26

### Added
- Tokens and cost per turn, thread and agent, on the desktop and the phone. The turn footer now
  splits out cached input and rounds the cost ("189k in (180k cached) · 304 out · $3.96"); the chat's
  header shows its total dim ("12.4k tok · $0.18", a lead's with its agents', the split on hover or
  tap); agent cards in the team panel and rows of the agent strip show each agent's. Settings ›
  Usage adds By project and By day (tokens and cost); the phone has the same under Settings ›
  Usage. The cost is the provider's own estimate (Claude Code reports the API-equivalent price,
  also for subscription accounts); Codex and Gemini report tokens only.

## [0.38.0] - 2026-10-26

### Added
- Voice input, on the desktop and the phone. Desktop: a mic in the composer (or Ctrl+Shift+Space,
  rebindable) records from the default input, shows a level meter and the time, and transcribes
  on this PC with whisper.cpp into the composer at the cursor, to edit before sending (it never
  sends by itself). Settings › Voice downloads a speech model (tiny 77 MB, base 147 MB, small
  487 MB), sets the language (detect, English, Portuguese) and says how to install whisper.cpp
  when it's missing. Phone: the composer's mic listens with the phone's own recogniser (on the
  phone where it can), with a meter, the time and the words as they come; phones without one
  send the recording to the PC to transcribe. Settings › Dictation language on the phone.

## [0.37.2] - 2026-10-26

### Fixed
- The workspace and branch bar no longer runs git on the UI thread: making a worktree, reading,
  switching and creating branches, and removing a deleted thread's worktree happen in the
  background, so a big repository never freezes the window. The bar shows what git is doing
  ("Creating worktree…", "Switching to main…") with a spinner, and the phone's chips show it too.
  A first message into a new worktree goes once it's ready; if it can't be made, a toast says why
  and the message stays in the composer.

## [0.37.1] - 2026-10-26

### Fixed
- Devices shows a paired phone online whenever it can reach the PC, not only while Harbor is open
  on it: the app checks in from the background every 15 minutes (a light Android job with any
  network; Android may run it later in Doze), authenticated with the pairing's secret but good
  for nothing else, without the screen lock. "Harbor open" while the app is in front, "online"
  while its last check-in is under 35 minutes old, else offline with when it was last seen.

## [0.37.0] - 2026-10-26

### Added
- A workspace and branch bar under the composer, on the desktop and the phone. Left: where the
  agent works, "Current checkout" or "New worktree" for a new chat (a git worktree of its own, in
  Harbor's data folder on a `harbor/…` branch, so parallel agents don't collide), or the thread's
  worktree by name. A thread in the checkout can move to a new worktree when it isn't running.
  Right: the branch, with a picker of local and remote branches (fuzzy filter) that switches it or
  creates a new one, and warns first about uncommitted changes. For a new worktree it picks the
  branch it starts from. Deleting a thread removes its worktree, unless it has uncommitted changes:
  then it's kept and Harbor says where. On the phone: two chips under the composer and on New
  chat, with bottom sheets.

## [0.36.0] - 2026-10-25

### Added
- Any PC can be a device that runs a chat's agent: Linux, macOS or Windows (OpenSSH Server), with or
  without Harbor and without Tailscale. Harbor finds each device's OS on its first connection and
  starts Claude Code there in the right shell (sh, or PowerShell on Windows, the prompt sent on stdin);
  the Test button shows the OS, and SSH hosts get their online dot by themselves.
- Settings › Devices offers your `~/.ssh/config` hosts and the PCs announcing ssh on your network
  (mDNS, through avahi) as one-click adds. The phone's device picker lists them like any device.

### Changed
- Devices that were Tailscale peers (not paired PCs) move to the `~/.ssh/config` alias of the same
  machine when there is one, with their chats, so they keep working with Tailscale off.

## [0.35.0] - 2026-10-25

### Added
- A command palette: Ctrl+K (rebindable), or the search button in the sidebar's header, opens one
  search over everything: projects, chats (settled ones too), agents, devices, the Issues and Pull
  requests pages, Settings sections, and actions (new chat in a project, settle or fork the open
  chat, fast mode, check for updates, sidebar, terminal, browser). Fuzzy-matched and grouped in
  sections with icons; with nothing typed, your recent picks come first. Arrows, Enter and Esc.
- The phone gets the same palette as a search screen (the search button in the chat list; a long
  press still filters the list): chats, agents, projects, pages and the actions the phone can do,
  ranked by the PC. Recent picks are shared between the desktop and the phone.

### Changed
- Stop all moved into the agent strip over a lead's composer (a stop icon in its corner, desktop
  and phone), and the old "Waiting for N sub-agents to finish" line under the transcript is gone:
  the strip shows the agents, and says how many messages wait for them ("· 2 queued").

## [0.34.1] - 2026-10-25

### Fixed
- Phones without a screen lock can pair and use Harbor again: they pair with two factors (the
  phone's key and the pairing secret, sessions and rotating keys unchanged) instead of failing on
  the presence key. The PC says so (Settings › Phones "2 factors" badge, the confirmation card,
  Devices "2-factor, no screen lock") and so does the phone (Settings › Sign-in). Setting a lock
  later adds the third factor on its own; removing it from a three-factor phone no longer bricks
  the app: it offers to go on with two factors once the code is confirmed on the PC (no re-pair).
  A three-factor pairing can't be talked down without the pairing secret and that confirmation.

## [0.34.0] - 2026-10-25

### Added
- Harbor keeps running in the background when its window is closed, so phones and other PCs keep
  reaching this PC, and the queue, automatic work, wake-ups, webhooks and update checks go on
  (Settings › General › Background, on by default; it's the same process, idle without a window).
  Running `harbor` again, or the tray icon, opens the window; the tray menu (and Settings) has
  Quit Harbor completely. The first close explains this in a desktop notification. Updates set to
  install automatically restart into the new version in the background; "Ask me" sends a
  notification once.
- Tray icon (StatusNotifierItem: waybar, KDE, GNOME's AppIndicator extension…) with Open Harbor and
  Quit Harbor completely. Without a tray host it simply isn't there.
- "Start Harbor when I log in" (Settings › General): an autostart entry that starts it without a
  window (`harbor --background`).
- When a PC doesn't answer, the other PCs' Devices and the phone say why: "Harbor isn't running"
  (the PC refused the connection) or "offline" (no answer), with when it was last seen. The phone
  shows a card with Try again over the chat list instead of a passing error, names the PC it
  moved away from when it fails over, and its PC list says the same.

## [0.33.1] - 2026-10-25

### Fixed
- The phone's New chat screen has the composer's `@` files, `#` issues and PRs and `/` commands
  too, as the desktop's new-chat composer does (the PC ranks them by the project picked there).

## [0.33.0] - 2026-10-25

### Added
- "Move to project…" in a chat's right-click menu in the sidebar: the chat goes to another project
  (or to No project) with its sub-agents, and its next turn runs in the new folder, resuming the
  same conversation (its Claude sessions are copied to the new folder's place; the old copies
  stay). Not while the lead's turn runs, and not for chats on a device or another PC's chats. The
  same from the API: `POST /v1/chats/{id}/move {"repo": id | path | null}`.
- `HARBOR_POINTER` takes several steps (`x,y[,click|rclick|wheel[,secs]]` joined by `;`), for
  headless screenshots of menus.

## [0.32.0] - 2026-10-25

### Added
- Session recap and prompt suggestions, as in Claude Code, on the desktop and the phone. Come back
  to a chat a few minutes after its turn ended and a dim "recap:" line over the composer says where
  it stands and what's next; after each turn the message you'd likely send next shows grayed in the
  empty composer: Tab or → takes it on the desktop, "⇥ Use" on the phone. Made on the PC with
  Claude Code's own prompts (Haiku, the chat's account; Claude chats only, not near a usage limit),
  gone once the next turn starts, and each can be turned off in Settings › General.

## [0.31.1] - 2026-10-25

### Fixed
- The 0.31.0 release built no downloads (the Android build script lost its executable bit);
  0.31.1 ships the composer tagging of 0.31.0.

### Changed
- Stop all moved into the agent strip over a lead's composer (a stop icon in its corner, desktop
  and phone), and the old "Waiting for N sub-agents to finish" line under the transcript is gone:
  the strip shows the agents, and says how many messages wait for them ("· 2 queued").

## [0.31.0] - 2026-10-25

### Added
- Tagging in the composer, on the desktop and the phone. `@` lists the project's files (tracked and
  untracked-not-ignored) with a file-type icon, the name and its dimmed folder, fuzzy-matched as you
  type; `#` lists the project's GitHub issues and pull requests by number and title. Arrow keys and
  Enter or Tab pick, Esc closes, a click or tap works too. The picked `@path` or `#123` shows
  highlighted in the text, and the agent gets each tagged file's full path and each issue's or PR's
  title, state and URL with the message. The phone gets the same lists, ranked by the PC.
- More Harbor commands in the `/` menu, on both: `/effort`, and in a chat `/new`, `/fork` (after the
  last reply), `/settle` and `/clear-queue` (while messages wait).

## [0.30.0] - 2026-10-25

### Added
- Two separate update pop-ups, on the desktop (top right) and the phone (banners in the chat list).
  Providers: "Updates available: 2 providers. Codex and Claude can be updated", with Update, which
  runs each CLI's own updater right there (`claude update`, `opencode upgrade`, `npm i -g …`), and
  Settings. Harbor: "Harbor X.Y.Z is available", with Update (installs and reloads in place) and
  What's new. Closing one hides it until the next version. Harbor now checks npm for newer Claude
  Code, Codex, Gemini, Grok and OpenCode versions every few hours; Settings › Providers lists them.

## [0.29.0] - 2026-10-25

### Added
- A live agent strip over a lead chat's composer while its sub-agents run, on the desktop and the
  phone: one row per agent with its provider mark, name, what it is doing right now ("running
  tests", "editing src/chat.rs", read from its latest step, no model calls) and how long it has
  run; three or more fold into "3 agents working" with expand. Click or tap a row to open the agent.
- When a sub-agent finishes, the lead's chat shows one line with the first sentence of its own
  report ("api finished: Added tests for the parser"), expandable to the whole report, on both.

## [0.28.0] - 2026-10-25

### Changed
- Projects no longer settle: they always stay in the sidebar's project list, on the desktop and
  on the phone. Settle / Unsettle and "Settle projects idle for 7 days" are gone for projects;
  chats still settle into the Settled section. Projects settled before come back on update.

## [0.27.1] - 2026-10-25

### Fixed
- install.sh with `HARBOR_INSECURE=1` installs a build that has no signature files (as it already
  did for an extracted folder) instead of stopping at the missing `.minisig`. Without it, an unsigned
  download is still refused.

## [0.27.0] - 2026-10-25

### Fixed
- Read only and Auto-edit now bind lead chats too: a lead on those levels runs without a shell
  (Claude Code in plan or accept-edits mode, no Bash, no commands on this PC for a remote chat),
  can't start processes, and spawns subagents with its own access, never more. A new chat keeps
  the access picked in the composer. GitHub fix and merge threads still run with full access.
- Harbor's automatic git status no longer runs a repository's own `core.fsmonitor` command.

### Changed
- A project cloned from a Git URL or GitHub starts untrusted: its agents run without the
  project's own agent settings and hooks (Claude Code's project settings, Cursor's workspace
  trust) until you press Trust project above the composer. Folders you add or create are
  trusted as before.

## [0.26.1] - 2026-10-25

### Fixed
- Without XDG_RUNTIME_DIR, Harbor's control socket and lock live in a folder only you can open,
  not in the shared /tmp.
- Settings › Webhooks warns when Tailscale Funnel still sends /hooks to a port that isn't Harbor's
  now, and offers to point it here.
- Tailscale devices with the same name (a machine shared in from another tailnet, or one
  without a DNS name) no longer stand in for each other: the one in your own tailnet keeps the
  name, the others go by their full name.
- Only this user's processes are taken for a chat's still-running turn; another account's
  process that only looks like one no longer blocks the chat or trims its transcript.
- A remote turn picked up after a restart no longer serves its MCP servers when another program
  has taken the bridge port its ssh forward points to (whoever holds it has seen the turn's token).

## [0.26.0] - 2026-10-25

### Added
- Linux aarch64 builds (`harbor-aarch64-linux.tar.gz`): install.sh and the updater pick the
  archive for the PC's architecture. The built-in browser engine is x86_64 only for now.
- Every release is installed and started on clean Ubuntu 22.04, Debian 12, Fedora and Arch images
  (and Ubuntu/Debian on aarch64) before it's published.
- The README lists what a fresh PC needs, required and optional, and install.sh names the optional
  programs that are missing.

### Fixed
- File pickers (Attach, project and device icons, Devices uploads) fall back to kdialog when
  zenity isn't installed, and say what to install when neither is, instead of doing nothing.
- Installing Codex, Grok or Gemini from Settings › Providers says that it needs Node.js when npm
  is missing, instead of "npm: command not found", and how to fix an npm folder that needs root.
- Removing a project revokes its webhooks right away: their URLs stop being accepted, and a late
  request can no longer crash Harbor or start a lead in another project.
- Harbor no longer crashes on odd text: a percent sign before a non-ASCII character in an app
  sign-in callback or a pasted file:// link, a usage-limit error with characters that change
  length when lowercased, or an empty or non-ASCII Harbor tool name in a transcript.
- Image previews refuse images whose header declares huge dimensions (over 16384 px a side or
  512 MB decoded) instead of allocating the whole buffer, so a tiny crafted file can't crash Harbor.

## [0.25.1] - 2026-10-25

### Fixed
- A chat in a project another PC shares (its folder is on that PC, not this one) no longer starts
  an agent whose every shell and file call fails: the chat says the folder isn't here and to pick
  that PC as its device. The same goes for a project whose folder was moved or deleted.
- Agents know where you are: a message sent from the phone or another PC tells the agent so, and
  so does the next one from the Harbor PC. An agent on a remote device no longer reads that you're
  at the Harbor PC for sure.
- A process an agent started that already ended still answers process_logs and list_processes
  (how it ended and its last output) instead of "no process named …".
- A PC's file browser (Devices › Files) now works when that PC's login shell is fish: file names
  with a backslash or quote could break out of the command Harbor runs there. Image previews stop
  at 25 MB whatever size the folder listing claimed, the preview cache folder can't be steered by
  a paired PC's id, and ssh never reads the PC's address as an option.
- The embedded browser's "Open in my browser" only hands http and https pages to the system.
- Release builds reuse the previous release's browser engine only when its signature checks out.
- On the phone, the pairing dialog lists every address the phone will try, and a PC can't take
  the name of another PC already paired.

## [0.25.0] - 2026-10-25

### Changed
- On the phone, the drawer groups the chats by project, in the desktop sidebar's order (by hand,
  or by last activity when it's set so): a small header per project with its name and how many
  chats it has, thin lines between projects, chats without a project under Threads, and settled
  chats and settled projects folded into Settled at the end, as on the desktop. Tap a project's
  header to fold it (the phone remembers); a folded project with a chat at work keeps a dot. The
  separate Running section is gone: a running chat keeps its dot in its project.

## [0.24.0] - 2026-10-25

### Added
- On the phone, Pull requests and Issues in the drawer, as on the desktop: the ones you wrote,
  review or are assigned, and those of your projects' GitHub repos, in the same groups, with the
  search, the state, Sort and the desktop's filters. A row opens the item: its state, branches
  and size, reviewers, labels, description, checks and comments, and a PR's timeline and diff.
  From there: Merge with… and Fix with… (a chat on the PC where the agent does it), Ready for
  review, Close and Reopen, Review with an agent, Open on GitHub, and copy the link, the number
  or the checkout command. The PC's GitHub CLI serves them (`/v1/prs` and `/v1/issues` in the
  phone API).

## [0.23.1] - 2026-10-25

### Fixed
- On the phone, the slash menu never opened while the app was talking to a PC of the mesh with
  an older Harbor (it has no menu to give). The app now asks the chat's own PC, or another PC it
  is paired with, for the menu. When none can give it, typing `/` says why: that PC's Harbor
  needs an update, or the phone's pairing needs its upgrade to three factors (tap to upgrade).

## [0.23.0] - 2026-10-25

### Added
- Slash commands on the phone: type `/` at the start of a word in a chat's message box and a
  menu above it lists the same commands and skills as the desktop's, filtered as you type, each
  with its description and a badge for where it comes from (Harbor, Built-in, Plugin, Personal or
  Project). Tap one to put it in the message; Back, a space or no match closes the menu, and
  after other words it offers skills only. `/model` opens the model picker, `/plan` and
  `/default` switch the chat to read only and back. Other agents get the command's text or the
  skill's instructions from the PC, as on the desktop. Long press an entry for its full
  description. The phone API has `GET /v1/chats/{id}/slash` and `POST /v1/chats/{id}/slash` for
  it; a chat that runs on another PC of the mesh gets that PC's list.

## [0.22.0] - 2026-10-25

### Added
- Phones need three factors to reach a PC: the phone's own key (as before), a pairing secret
  agreed when it pairs, and the phone's screen lock or fingerprint. Pairing now shows a 6-digit
  code on the phone and in Settings › Phones (with a desktop notice): it only completes when you
  confirm the code on the PC. A pairing code works once, for 10 minutes.
- Once connected, the phone's session key changes every 10 minutes and every call carries a
  signature under the current key, tied to its connection; nothing on the PC answers without it,
  including the app download from outside your network and relaying. Refusals are logged and
  shown in Settings › Phones; repeated failures lock the pairing for 15 minutes (Unlock there).
- Settings › Phones shows each phone's state: three factors, connected and when its key changes
  next, locked, or needs upgrade.

### Changed
- Phones paired before this version must upgrade: the app asks once ("Upgrade the pairing"), shows
  a code, and you confirm it on the PC. Until then they can only update the app.
- Your other PCs each get their own secret for a phone (derived from the pairing), sent by the
  phone through its session; none of them holds another's.

## [0.21.0] - 2026-10-25

### Added
- On the phone, a chat's team slides in from the right (swipe left, also from the edge, or the
  panel button at the top): its agents, processes, wake-ups and webhooks as the desktop's team
  panel shows them, kept up to date. Tap an agent to open its chat. The phone API has
  `GET /v1/chats/{id}/team` for it.
- On the phone, an image pasted into the message box (long press › Paste, or the keyboard's
  clipboard and image suggestions) is attached like a picked photo. Text pastes as before.
- On the phone, images waiting to be sent show as thumbnails in the message box, and any image
  (there or in the chat) opens full screen when tapped: pinch or double-tap to zoom, swipe to the
  next one, Back to close.

### Changed
- On the phone, the chat list is laid out like the Claude app's drawer: a smaller title, three
  short rows (Projects, PCs, Settings), then one-line chats with a chat icon under Running,
  Recents and Settled, and a smaller avatar and New session button. Update is a row when there
  is one.

### Fixed
- On the phone, attaching a photo or a file inside a chat failed with "bad chat id": the PC now
  takes the chat's id the way the app sends it.

## [0.20.0] - 2026-10-25

### Added
- Slash commands in the composer, as in T3 Code: type `/` at the start of a word and a menu above
  the composer lists commands and skills, filtered as you type, each with its description and
  where it comes from (Harbor, Built-in, Plugin, Personal or Project). Arrow keys move, Enter or
  Tab accepts, Esc closes, a click accepts. Claude chats list what Claude Code itself offers
  (built-in commands such as `/compact` and `/context`, bundled and plugin skills, and your own
  and the project's `.claude/commands` and `.claude/skills`); Claude Code runs them. Other agents
  get your `.claude` commands and skills too: Harbor puts the command's text, or the skill's
  instructions, into the message for them. Harbor's own `/model` opens the model picker, and
  `/plan` and `/default` switch the chat to read only and back.

### Fixed
- Commands and skills whose front matter writes the description over several lines (`description:
  >`) showed `>` as their description to agents on other devices.

## [0.19.0] - 2026-10-24

### Fixed
- A phone using Harbor through another of your PCs showed offline here. The PCs now tell each
  other where they saw your phones (every 15 s), so Devices shows it online "via" that PC, with
  its app version.
- A phone talking to a PC with an older phone app was never offered the update. PCs now pass the
  newest app to each other, and the app (from this version) checks every PC it knows and
  downloads from whichever has the newest.

### Added
- Devices and Settings › Phones show each phone's app version and say when it's out of date
  (or too old to take sends). On the phone, Settings › Update says where the update is and checks
  again when tapped.

## [0.18.0] - 2026-10-24

### Changed
- Devices no longer needs the separate Remote Devices app and is always offered. It lists what is
  paired with this Harbor: your other PCs (Settings › Devices) and phones running Harbor for
  Android (Settings › Phones), online or not. Nothing unpaired shows up.
- Send works for PCs as well as phones, over Harbor's own connections: text or an image onto the
  device's clipboard, images (opened there) and files (saved to its Downloads), with a
  notification on the PC that receives them. PCs keep the terminal and file browser, now over
  ssh through `harbor nc` with Settings › Devices' login.

### Removed
- Device screens (the eye button) and `harbor-stream`, the viewer they needed: they only worked
  through Remote Devices. Releases still ship a placeholder `harbor-stream` so older versions can
  update.

## [0.17.0] - 2026-10-24

### Added
- Devices › Send works for phones paired with Harbor's Android app: text or an image to the
  phone's clipboard, images (saved to Pictures/Harbor and opened) and files (saved to
  Download/Harbor, with a notification). Each item waits on the PC until the app picks it up (up
  to a day), and the transfer list shows when it was delivered. A phone that isn't in Remote
  Devices gets its own row.

### Removed
- The Control (pointer) button on device rows. The eye button still opens the screen.

## [0.16.2] - 2026-10-24

### Fixed
- A paired phone on mobile data couldn't update its app ("the PC has no app to send"): from the
  internet the app download is served to keys this PC knows (strangers still don't get past the
  handshake). Phones away from home also get more connections at once (images next to the
  long-poll).

## [0.16.1] - 2026-10-24

### Fixed
- Phones were handed another PC's forwarded address with the wrong port (the port it has
  outside was dropped), and the app then stopped trying that PC's other addresses. Each address
  keeps its own port now, and an address where another device answers is skipped, not final.

## [0.16.0] - 2026-10-24

### Added
- Port forwards set by hand on the router: Settings › Phones › From outside your network ›
  Port forward on my router (the external port), or `harbor net forward <port>`. Harbor learns
  this network's public IPv4 address (asked every 5 minutes over HTTPS) and hands phones and PCs
  `address:port` with the others, so the phone reaches the PC on mobile data.
- Public name: a dynamic DNS name for your home (`harbor net name <name>`), handed out too, so a
  phone that was away while the address changed still finds the PC.

## [0.15.1] - 2026-10-24

### Fixed
- From the internet (a public IPv6 address, a forwarded port) a connection now needs a key this
  PC already knows to finish its TLS handshake at all; strangers, plain HTTP, pairing and the APK
  get nothing, with tighter limits per address and for the internet as a whole.
- `harbor nc` stalled ssh sessions on a direct connection (its output waited for a newline).
- PCs and phones are given this PC's stable IPv6 address, not its short-lived privacy ones, and
  hear at once when its addresses change.
- The public webhook port stops answering an address after 20 misses a minute; network discovery
  ignores anything not from the local network.
- The phone says plainly when its network has no IPv6 and the PCs can't be reached from outside.

## [0.15.0] - 2026-10-24

### Added
- Webhooks from the internet without Tailscale Funnel: Settings › Webhooks › Reachable from the
  internet serves only /hooks/<token> over HTTPS on its own port (47911), with a certificate
  Harbor gets from Let's Encrypt by itself (TLS-ALPN-01, no web server, renewed 30 days before it
  runs out). The name is your public address as an sslip.io name, or one of your own. Harbor
  asks the router to send port 443 to it and says plainly when it can't.
- GitHub webhooks are checked: set the webhook's secret to its token and every delivery's
  X-Hub-Signature-256 must match (401 otherwise).

### Changed
- Tailscale Funnel is only offered while Tailscale is installed.

## [0.14.0] - 2026-10-24

### Added
- Harbor finds your other PCs on the network by itself: Settings › Devices lists the Harbors it
  hears with a Pair button, and `harbor mesh join <name> <code>` pairs by name.
- Your phone and PCs away from home can reach a PC: Harbor asks the router to open its port
  (UPnP, NAT-PMP or PCP, IPv4 and an IPv6 pinhole), uses global IPv6 addresses directly, and hands
  phones and PCs every address in order (network first, then public). Settings › Phones and
  Devices say plainly whether this PC is reachable from outside and why not, and note when a
  paired device actually got in from the internet; `harbor net` checks from a terminal.
- A PC that can't reach another one directly goes through a third PC of yours that can: the
  stream is relayed, still encrypted end to end with the far PC's key. Only paired PCs and phones
  may use a relay, only to PCs paired with it.
- `harbor nc`: remote devices that are your paired PCs are reached through it (their network
  address, or through another PC), in place of `tailscale nc`.

### Changed
- Settings › Devices lists your paired PCs as remote devices; Tailscale's list is only an extra
  while it's installed, and the Tailscale section is gone.
- The firewall fix also lets network discovery (UDP 47930) in, and Settings offers to let the
  internet in to Harbor's port where you want that.

## [0.13.1] - 2026-10-24

### Fixed
- On a PC whose firewall (ufw) drops incoming connections, phones and other PCs on the network
  couldn't reach Harbor once Tailscale is gone. Settings › Phones and Settings › Devices now say
  so and offer Allow on the local network (it lets the private address ranges in to Harbor's port,
  asking for your password in a terminal); `harbor mesh status` prints the same commands.
- PCs prefer each other's addresses on the shared network over Tailscale's while both work.

## [0.13.0] - 2026-10-24

### Added
- Harbor no longer needs Tailscale for your phone or your other PCs. Each Harbor and each phone
  makes its own key the first time it runs, and every connection that leaves the PC is mutual TLS
  pinned to those keys: a phone or PC answers only with the key it was paired with, and shows its
  own. Harbor listens on your network (port 47930) and answers nobody else: plain HTTP only on
  127.0.0.1.
- Pair two PCs with a one-time code: Settings › Devices › Show a code on one, Enter a code (with
  its address) on the other, or `harbor mesh pair` / `harbor mesh join <address> <code>` in a
  terminal. Both then allow each other. `harbor mesh allow <key>` takes a PC's key fingerprint
  (`harbor mesh status` shows it).
- The phone pairing QR carries the PC's key and its network addresses; the phone tries each and
  keeps its list up to date. Settings in the app show which keys the connection uses.

### Changed
- PCs and phones paired before upgrade switch to keys by themselves while Tailscale is still up:
  over the tailnet, PCs allowed by Tailscale node swap keys, and a phone learns its PC's key once
  and from then on only talks TLS with it. After that nothing needs the tailscale binary (it stays
  an extra address source while installed). A pairing that can't upgrade asks to pair again.
- The install QR in Settings › Phones links to the latest release instead of this PC.

## [0.12.2] - 2026-10-24

### Fixed
- The phone no longer moves to a PC whose phone access is off (it would drop the phone): such PCs
  get no phone key, and Settings › Devices shows "phone access off" next to them, and next to this
  PC, with an Enable phone access button.

## [0.12.1] - 2026-10-24

### Fixed
- Sharing chats between PCs works across Tailscale accounts and with tagged nodes: each PC lists
  the Harbors it sees on the tailnet in Settings › Devices with an Allow button, and two PCs share
  once each allows the other (by Tailscale node ID). Your own untagged devices on the same account
  still allow each other by themselves. Phone keys follow the same list. `harbor mesh status | on |
  off | allow <PC> | remove <PC>` does the same from a terminal, and a running Harbor picks it up.

## [0.12.0] - 2026-10-24

### Added
- One sender at a time across your PCs and phones: while someone types in a chat on another
  device, "<device> is typing…" shows everywhere and a message sent meanwhile waits in the chat's
  queue (Send says Queue) until they send or stop typing. The queue is shared: every PC and phone
  shows the same queued messages.
- Presence: the chat's top bar names the other PCs that have it open (dimmed when that PC's
  window isn't in front), and the sidebar marks chats another PC has open.

## [0.11.0] - 2026-10-24

### Added
- Harbor for Android pairs once with all your PCs: with chats shared between them, the PC you
  pair with hands the phone a key for each of the others. The app talks to the PC it used last
  and moves to another one by itself when that PC stops answering (the drawer shows "via <PC>"),
  so the phone keeps working while a PC is off. Removing the phone on one PC removes it on all.
- On the phone, a chat whose PC is off is read-only with "<PC> is off", the device picker for a
  new chat offers your other PCs that are on, and messages show where they were written.

## [0.10.0] - 2026-10-24

### Added
- Every PC is a hub: with Settings › Devices › "Share chats with my other PCs" on, each of your
  PCs running Harbor keeps a full copy of every chat and can write in any of them. A chat still
  runs on the PC it was started on; a message typed on another PC (or sent from the phone through
  it) goes to that PC, and every message shows where it was written ("from Pixel via desk").
  While a chat's PC is off its copies are read-only and catch up when it's back. Only your own
  devices on Tailscale (the same Tailscale account) are let in.
- New chats can start on any of your PCs that is on: they appear in the composer's device picker.

## [0.9.0] - 2026-10-23

### Added
- Typing presence: a chat shows who is writing in it and on which device. Phones (Harbor for
  Android) and this PC's own composer report it; the desktop shows "✎ <phone> is typing…" above
  the composer and a ✎ on the chat's sidebar row, and the phone sees the PC typing.
- Harbor for Android shows the waiting and usage-limit bars with Stop all, Continue now and
  Cancel, attached and agent-read images as thumbnails, and why a run setting can't change.
- Harbor for Android pairs by scanning the QR code with its own camera (no scanner app needed),
  takes photos with Camera, and has speech-to-text in the composer.
- Harbor for Android can change an open chat's account, model, effort, access, device and fast
  mode, with the same rules as the desktop composer (a started chat keeps its provider and
  device).

### Changed
- Harbor for Android looks like the Claude app: a warm light theme and a matching dark one that
  follows the phone (Settings › Color mode), the chat list as a drawer you swipe open inside a
  chat, a rounded composer with a model pill and an Add to session sheet (Camera, Photos, Files),
  and settings in grouped cards.

### Fixed
- A chat on the phone now shows exactly what the desktop shows: the same messages hidden (a
  lead's thinking and agent coordination), the same agent message cards, turn footers with
  the same numbers, attachments and fork dividers. Both draw from one projection of the chat.
- Harbor for Android's send button no longer cuts its icon at large font sizes.

## [0.8.7] - 2026-10-23

### Fixed
- Processes Harbor started before an update no longer linger as zombies after they end: the
  updated Harbor collects them.

## [0.8.6] - 2026-10-23

### Fixed
- A chat or project in the sidebar stays Working while its subagents still run, instead of showing
  Done as soon as the lead's own turn ends; it only turns Done (and notifies) once everything finished.

## [0.8.5] - 2026-10-23

### Security
- Harbor's files are private to your account: its data folder (harbor.db with the phone API's and
  webhooks' tokens, transcripts, uploads and pastes), its turn files (commands, output) and process
  logs are owner-only now, also on existing installs. App sign-in tokens no longer go into a turn's
  files: the turn's runner adds them itself.
- Auto-Fix and Auto-Merge only act on text from the repo's owner, members and collaborators:
  Auto-Fix only picks issues they opened, and unattended runs read only their comments and reviews
  (anyone can comment on a public repo). Issue and PR titles and webhook requests reach the agent
  fenced as untrusted data, not instructions. Fix / Merge started by you still read every comment.
- install.sh always checks the minisign signature of what it installs: without minisign installed it
  fetches the static minisign the release workflow uses (pinned by its SHA-256). Without either, or
  for an offline folder without a signed SHA256SUMS, it refuses unless `HARBOR_INSECURE=1`.

### Fixed
- Long sessions stay fast: saving a chat writes only its new or changed items instead of rewriting
  the whole transcript, huge tool inputs and outputs keep their start and end (64 KB), and chats not
  looked at for a while leave memory until they're opened again.
- Stopping a process started with start_process kills whatever of it is still running 5 seconds
  after asking it to stop, and a process's log keeps only its last megabyte once it passes 8 MB.
- Processes Harbor started before an update or reload (start_process's, MCP servers, helpers) are
  cleaned up once they end, instead of staying behind as zombie processes until Harbor quits.

## [0.8.4] - 2026-10-23

### Security
- Remote devices: the MCP bridge's key no longer appears on command lines (`ps`) on either PC.
  It reaches the device on the connection's input, in a file only you can read, removed when the turn ends.
- Keys and sign-in secrets (phone keys, webhook URLs, the MCP bridge's key, MCP sign-in state)
  come from the system's random source or not at all: a failure is an error, never a guessable key.
- Phone access, webhooks and the MCP bridge: each serves a limited number of connections at once,
  a request's head must arrive within 10 seconds, and answers time out when the other side stops
  reading, so a peer can no longer pile up connections and threads. The bridge checks its key
  before reading a request's body and caps it, so a crafted request can no longer make Harbor
  run out of memory and quit.
- Webhooks: each webhook takes up to 30 requests a minute (more get "429, retry later"), headers
  are size-limited before the URL key is checked, and while automatic turns are paused, at most
  100 automatic messages wait per chat.

### Fixed
- Project icons: website icons are only fetched from public addresses of the project's own site (no IP addresses, LAN, loopback or tailnet hosts; redirects only within the site; 2 MB and 8 s per request), and pages with non-ASCII text before an icon link no longer stop the lookup.
- Device files: big folders scroll smoothly; only the rows in view are laid out, and the listing is no longer copied every frame.
- PC screens (harbor-stream): replies from the PC's screen sharing are capped at 1 MB and a deadline, and malformed ones end the connection with an error instead of crashing the viewer.
- Device and browser screens: frame files (a live picture of the screen) and clipboard images being sent go to a private folder only you can open (`$XDG_RUNTIME_DIR/harbor`, mode 0700; files 0600), instead of world-readable files at guessable names in /dev/shm and /tmp.
- Device screens: each video frame reuses the previous frame's buffer and updates the GPU textures in place, instead of allocating a few MB on the UI thread and new texture storage per frame.
- Remote devices: the MCP bridge has its own port (47940) and no longer takes the phone API's
  (47930) when it starts first; turns started before the update keep being served.
- Remote devices working on this PC's files: a shell command keeps only the end of its output in
  memory, and returns when it ends even if it left a background process holding its output
  (that process is stopped, and the agent is told).
- Phone access: a phone following a long chat no longer makes Harbor re-encode the whole
  transcript several times a second; only what changed is looked at.

## [0.8.3] - 2026-10-23

### Fixed
- Browser panel: the engine paints a new frame only after Harbor took the previous one, and Harbor reads only the newest, so an animated page in a hidden tab no longer repaints Harbor at 60 fps or piles up frames.
- Device screens: a phone or PC view that stays out of sight for 15 s (another tab, a closed panel) ends its stream, so the device stops encoding and this PC stops decoding; it reconnects when shown again.
- Project and device icons: images with huge or extreme dimensions (say a 65535×1 PNG in a repo or on its website) are refused or shrunk before use instead of exhausting memory; device icons load off the UI thread.
- Settings › Usage no longer re-reads every chat's transcript from the database on every frame: the totals are summed on a background thread and only again when a chat changes (or after a minute), so the page stays smooth with many or long chats.
- Opening a chat, a turn ending and opening Pull Requests or Issues no longer freeze Harbor while `git status` runs: project git status is read in the background (one at a time per project, killed after 10 s), and the last known branch shows meanwhile.
- Pull Requests and Issues no longer redraw the whole window at the monitor's refresh rate while a list or a pull request loads; loading spinners step at 2 fps. The filtered and sorted list is kept until the list, filters, search or sort change, instead of being copied and sorted again on every frame. `gh` calls give up after 90 s with an error instead of loading forever.
- Pull request and issue panels stay smooth on big pull requests and long threads: the diff and the pull request are no longer copied on every frame, and comments far outside the view are not laid out.

### Security
- Terminal: pasted text loses ESC and other control characters (tab and line breaks stay), so a hidden `ESC[201~` in copied text can no longer end a bracketed paste early and run a command as soon as it's pasted.

## [0.8.2] - 2026-10-23

### Fixed
- Android: the app also reaches the PC (and updates itself) on phones where Tailscale isn't recognised as a VPN network: the request then goes over the default network, but still only to a tailnet address and only while Tailscale is up on the phone.

## [0.8.1] - 2026-10-23

### Fixed
- Android: unsent drafts belong to one PC's chat. With several PCs paired, a draft no longer shows up in another PC's chat that has the same number, and drafts are removed when their chat is deleted or the PC is unpaired.
- Android: only web links (http, https) in chat replies can be tapped; other link types, such as harbor://pair, show as plain text. The pairing prompt warns when a link uses the name of an already paired PC with a different address.
- Android: paired PCs and their tokens are stored encrypted with a key kept in the Android Keystore (existing pairings move over on first start).
- Android: long chats stay fast. A chat shows its last 120 messages ("Show earlier" loads more), each update only redraws what changed, and an oversized answer from the PC is refused instead of filling the phone's memory.
- Android: the chat list no longer downloads and redraws everything several times a second while a chat streams; it refreshes when the list itself changes.
- Android: the app only talks to a PC through Tailscale. Requests go over Tailscale's VPN to a tailnet address, so with Tailscale off (or a non-Tailscale address) the pairing token is never sent in the clear. The app download no longer carries the token.
- Sidebar: a project's row shows only its main thread's own status. While the main thread is idle it shows nothing, even when its sub-agents or other chats are working; those show on their own rows.

## [0.8.0] - 2026-10-23

### Added
- Settings › Phones: Harbor for Android, a chat client for your phone. Turn on phone access, pair
  a phone with a QR code (each phone gets its own key, revocable), and install the app from a
  second QR code. The phone lists, opens and starts this PC's chats over Tailscale (device,
  account, model, effort and access), sends messages and files, stops, renames, settles, forks
  and deletes them. Harbor listens on its tailnet address only, port 47930. Updates and
  install.sh fetch the app with each release.

## [0.7.0] - 2026-10-23

### Added
- Fix / Merge with instructions: the ▾ next to "Fix with …" and "Merge with …" (and the issue
  and PR right-click menus) opens a box for your own instructions or details; they go to the
  agent after the usual prompt, marked as important and taking priority. Ctrl+Enter starts.
- A "Copied to clipboard" notification (with a one-line preview, or "Image") when you copy a
  link, number, checkout command, message, image or a text selection with Ctrl+C.

## [0.6.2] - 2026-10-23

### Fixed
- The chat composer with a long paste now grows to 14 lines (or 45% of the window) before it
  scrolls, instead of stopping at about four, and shows the end of the paste where the cursor
  is; the new-thread screen moves up to keep it in view.

## [0.6.1] - 2026-10-23

### Fixed
- Pasting a long text into the chat composer no longer pushes it and its controls off-screen:
  it grows up to 14 lines (or 40% of the window) and then scrolls inside.

## [0.6.0] - 2026-10-23

### Added
- Fix with <provider> on an issue (its panel and right-click menu): a new thread in the issue's
  project where an agent fixes it on a `fix/issue-N` branch and opens a PR that says
  `Fixes #N`. Replaces Work on it.
- Merge with <provider> on a pull request (its panel and right-click menu): a new thread where
  an agent checks it out, rebases and resolves conflicts, makes the checks pass, answers the
  reviews and merges it with `gh pr merge`.
- Both buttons have a ▾ to pick the provider (any installed account; a non-Claude one does the
  work as the thread's subagent), and are off, with a tooltip, for repos that aren't Harbor
  projects.
- Settings → General → Auto-Fix and Auto-Merge (off by default): Harbor checks every 10 minutes
  and starts those threads by itself, for open issues assigned to you without an open PR (once
  per issue) and for your own ready PRs (not drafts, checks passing or none, no changes
  requested; once per head commit), only in your projects' repos and at most 2 at a time.

### Fixed
- The Pull requests and Issues pages know every project's GitHub repo, not only the ones opened
  since Harbor started: the Project filter, Check out and the agent buttons work for all of them.

## [0.5.0] - 2026-10-23

### Added
- An Issues page beside Pull Requests (the issue icon in the sidebar footer, or a project's
  menu): every issue assigned to you, that you opened or that mentions you, and those in your
  projects' GitHub repos, grouped Assigned / Authored / Mentioned / Others. Search them (with
  `label:`, `-label:`, `author:`, `assignee:`, `no:assignee`, `milestone:`, `no:milestone`),
  sort by update, age or comments, and filter by state, involvement, author, assignee, labels,
  milestone and project. Rows show the open / completed / not planned mark, labels, author,
  repo, comment count and age; clicking one opens it in the side panel, as PRs do, with its
  assignees, labels, milestone, description and comments, Close / Reopen, and Work on it
  (a thread asking an agent to resolve it).

## [0.4.2] - 2026-10-23

### Removed
- The Azure DevOps and Bitbucket placeholders in Add project (they were never set up); GitHub,
  Git URL, local folder and new project remain.

## [0.4.1] - 2026-10-23

### Fixed
- A pull request's description, comments and reviews no longer show raw HTML (`<!-- … -->`,
  `<div>`, `<a>`, `<img>`): comments are dropped and tags keep only their text, as on GitHub.

## [0.4.0] - 2026-10-23

### Added
- Pull Requests navigation after T3 Code's: clicking a PR opens it in a panel beside the list,
  as a tab (open several; close with ×, a middle click, Ctrl+W or the tab's menu). The panel
  shows the repo and number, title, author, base ← head, the checkout command and the diff
  size, with Summary (reviewers, labels, description, checks, comments), Timeline and Code
  (the diff) tabs, and Ready for review, Check out and a ⋯ menu (refresh, review with an agent,
  open, copy link / number). Maximize it over the list, hide and show it with the top-right
  button or Ctrl+Alt+B, and drag the divider to resize. Esc or the sidebar's Back leaves the
  page; Ctrl+F searches; the Sort, Filters and provider menus work with the arrow keys
  (→ opens a filter's submenu, ← comes back, Enter picks, Esc closes). The keys are in
  Settings → Keybindings.

## [0.3.0] - 2026-10-23

### Changed
- The Pull Requests page is rebuilt after T3 Code's: every PR you opened, were asked to review,
  or that is in one of your projects' GitHub repos, grouped into Authored / Review requested /
  Others. Search (with `label:`, `-label:`, `author:`, `draft:`, `review:`, `checks:`), Sort
  (merge readiness, blocked on me, recently updated, newest, oldest, largest, smallest) and
  Filters (state, involvement, author, labels, draft, review, checks, project). Clicking a PR
  opens it in the side panel; right-click to open on GitHub, copy, check out or review it.

## [0.2.3] - 2026-10-22

### Fixed
- The code-block copy icon is smaller and centred on one-line code blocks.

## [0.2.2] - 2026-10-22

### Fixed
- The copy button on chat code blocks shows a copy icon instead of a broken box, centred on the
  block's text.

## [0.2.1] - 2026-10-22

### Changed
- Usage moved into Settings › Usage: the account caps, what threads do at a limit, account
  switching and the token history are on one page. The sidebar's Usage button is gone.

## [0.2.0] - 2026-10-22

### Added
- Devices: run a chat's Claude Code agent on another PC over ssh. Settings › Devices finds your
  Tailscale PCs, adds others by SSH, and sets each one's name, icon, folder and access; the
  composer picks the device ("This PC" by default).
- The MCP bridge: agents on another PC use this PC's MCP servers, signed-in apps, Harbor's team
  tools and your slash commands and skills (and, if allowed, commands on this PC), through the
  same ssh connection; no credentials are copied to the device.
- Devices: agents on another PC work on this PC's files by default: their shell, git and file
  tools run here, in the chat's project (and its access mode), so edits and commits stay
  together. Turn off "Work on this PC's files" in the device's settings to use the device's copy.
- Usage Controller: the Usage page caps how much of each account's quota Harbor may use, per
  usage window, with a draggable marker and 50% / 80% / Unlimited presets.
- Add project: a palette with a built-in folder browser and sources that need setup.
- Updates wait for the Update button unless Harbor is set to update automatically.

### Changed
- Long chats only lay out the messages near the screen, so streaming in a long chat stays cheap.
- Terminal output and a streaming chat repaint at a capped rate, lower while the window is
  unfocused.

### Fixed
- A chat on another PC runs with the Claude account picked in Harbor, not the login of whoever
  is signed in on that PC. The account's login reaches the device on the agent's input, never
  on its command line, and is refreshed first when it is about to expire.
- Agents on another PC find Claude Code when it is only on the login shell's PATH of zsh or a
  user install folder (macOS), and say so clearly when it isn't installed. Settings › Devices
  › Test checks the same way.
- A focused text field no longer repaints at the refresh rate with an input method (fcitx5, ibus).
- Live turns whose folder vanished are picked up again at startup.

## [0.1.3] - 2026-10-21

### Added
- Offline install: `./install.sh` run from an extracted release archive installs the files
  next to it, checked against the signed `SHA256SUMS` now included in each archive; only
  `curl … | sh` downloads.

## [0.1.2] - 2026-10-21

### Fixed
- Harbor no longer redraws constantly while idle: chats with markdown tables kept it repainting
  about 30 times a second (high CPU and heat); spinners and counters now redraw only while
  visible, at most twice a second.
- After "Restore previous version", Harbor no longer installs the version you went back from
  by itself a few seconds later; it offers it under Settings › General instead.

## [0.1.1] - 2026-10-21

### Added
- `harbor --update` installs the latest release from a terminal, and `harbor --restore-previous`
  puts the version before the last update back (also when a new version won't start).

### Fixed
- The release archives now include the licences of every Rust crate in the remote-screen viewer
  and the browser engine (the licence report rejected one crate's WTFPL licence).
- The README describes the installer, updates and signatures.
- The release workflow uses the Node 24 versions of GitHub's actions.

## [0.1.0] - 2026-10-21

The first public release.

### Agents
- Chats with coding-agent CLIs, organised by project: Claude Code (one entry per account),
  Codex, Cursor, Grok, Gemini, Meta (Muse) and OpenCode, each run headless per message.
- Teams: one lead per project delegates to subagents, with messages between agents,
  long-running processes, snoozes, webhooks and a team panel.
- Agent turns run detached: they survive a Harbor reload, restart or update.
- Queue messages while a turn runs; Esc undoes a send that has produced nothing yet.
- Continue automatically after a usage limit, and optionally move a chat to another account.
- Fork a thread from any finished reply.

### Workspace
- Built-in terminal, browser (optional Servo engine) and Devices panes: your PCs and phones
  over Remote Devices, with files, send, and their screens inside Harbor.
- Image paste, thumbnails and a lightbox; system clipboard for Ctrl+C/X/V.
- Settings with General, Keybindings, Providers, Usage limits and more; a Usage page.

### Install and updates
- One build for Linux x86_64, installed per user without sudo:
  `curl -fsSL https://github.com/RDevNeo/harbor/releases/latest/download/install.sh | sh`.
- Harbor updates itself from GitHub Releases (signed with minisign), keeps the previous
  version for a one-click restore, and can be set to only notify (Settings › General).
- `harbor --version`.

[Unreleased]: https://github.com/RDevNeo/harbor/compare/v0.59.1...HEAD
[0.59.1]: https://github.com/RDevNeo/harbor/compare/v0.59.0...v0.59.1
[0.59.0]: https://github.com/RDevNeo/harbor/compare/v0.58.0...v0.59.0
[0.58.0]: https://github.com/RDevNeo/harbor/compare/v0.57.1...v0.58.0
[0.57.1]: https://github.com/RDevNeo/harbor/compare/v0.57.0...v0.57.1
[0.57.0]: https://github.com/RDevNeo/harbor/compare/v0.56.0...v0.57.0
[0.56.0]: https://github.com/RDevNeo/harbor/compare/v0.55.3...v0.56.0
[0.55.3]: https://github.com/RDevNeo/harbor/compare/v0.55.2...v0.55.3
[0.55.2]: https://github.com/RDevNeo/harbor/compare/v0.55.1...v0.55.2
[0.55.1]: https://github.com/RDevNeo/harbor/compare/v0.55.0...v0.55.1
[0.55.0]: https://github.com/RDevNeo/harbor/compare/v0.54.1...v0.55.0
[0.54.1]: https://github.com/RDevNeo/harbor/compare/v0.54.0...v0.54.1
[0.54.0]: https://github.com/RDevNeo/harbor/compare/v0.53.1...v0.54.0
[0.53.1]: https://github.com/RDevNeo/harbor/compare/v0.53.0...v0.53.1
[0.53.0]: https://github.com/RDevNeo/harbor/compare/v0.52.0...v0.53.0
[0.52.0]: https://github.com/RDevNeo/harbor/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/RDevNeo/harbor/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/RDevNeo/harbor/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/RDevNeo/harbor/compare/v0.48.2...v0.49.0
[0.48.2]: https://github.com/RDevNeo/harbor/compare/v0.48.1...v0.48.2
[0.48.1]: https://github.com/RDevNeo/harbor/compare/v0.48.0...v0.48.1
[0.48.0]: https://github.com/RDevNeo/harbor/compare/v0.47.1...v0.48.0
[0.47.1]: https://github.com/RDevNeo/harbor/compare/v0.47.0...v0.47.1
[0.47.0]: https://github.com/RDevNeo/harbor/compare/v0.46.4...v0.47.0
[0.46.4]: https://github.com/RDevNeo/harbor/compare/v0.46.3...v0.46.4
[0.46.3]: https://github.com/RDevNeo/harbor/compare/v0.46.2...v0.46.3
[0.46.2]: https://github.com/RDevNeo/harbor/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/RDevNeo/harbor/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/RDevNeo/harbor/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/RDevNeo/harbor/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/RDevNeo/harbor/compare/v0.43.2...v0.44.0
[0.43.2]: https://github.com/RDevNeo/harbor/compare/v0.43.1...v0.43.2
[0.43.1]: https://github.com/RDevNeo/harbor/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/RDevNeo/harbor/compare/v0.42.2...v0.43.0
[0.42.2]: https://github.com/RDevNeo/harbor/compare/v0.42.1...v0.42.2
[0.42.1]: https://github.com/RDevNeo/harbor/compare/v0.42.0...v0.42.1
[0.42.0]: https://github.com/RDevNeo/harbor/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/RDevNeo/harbor/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/RDevNeo/harbor/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/RDevNeo/harbor/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/RDevNeo/harbor/compare/v0.37.2...v0.38.0
[0.37.2]: https://github.com/RDevNeo/harbor/compare/v0.37.1...v0.37.2
[0.37.1]: https://github.com/RDevNeo/harbor/compare/v0.37.0...v0.37.1
[0.37.0]: https://github.com/RDevNeo/harbor/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/RDevNeo/harbor/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/RDevNeo/harbor/compare/v0.34.1...v0.35.0
[0.34.1]: https://github.com/RDevNeo/harbor/compare/v0.34.0...v0.34.1
[0.34.0]: https://github.com/RDevNeo/harbor/compare/v0.33.1...v0.34.0
[0.33.1]: https://github.com/RDevNeo/harbor/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/RDevNeo/harbor/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/RDevNeo/harbor/compare/v0.31.1...v0.32.0
[0.31.1]: https://github.com/RDevNeo/harbor/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/RDevNeo/harbor/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/RDevNeo/harbor/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/RDevNeo/harbor/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/RDevNeo/harbor/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/RDevNeo/harbor/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/RDevNeo/harbor/compare/v0.26.1...v0.27.0
[0.26.1]: https://github.com/RDevNeo/harbor/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/RDevNeo/harbor/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/RDevNeo/harbor/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/RDevNeo/harbor/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/RDevNeo/harbor/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/RDevNeo/harbor/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/RDevNeo/harbor/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/RDevNeo/harbor/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/RDevNeo/harbor/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/RDevNeo/harbor/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/RDevNeo/harbor/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/RDevNeo/harbor/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/RDevNeo/harbor/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/RDevNeo/harbor/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/RDevNeo/harbor/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/RDevNeo/harbor/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/RDevNeo/harbor/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/RDevNeo/harbor/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/RDevNeo/harbor/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/RDevNeo/harbor/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/RDevNeo/harbor/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/RDevNeo/harbor/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/RDevNeo/harbor/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/RDevNeo/harbor/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/RDevNeo/harbor/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/RDevNeo/harbor/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/RDevNeo/harbor/compare/v0.8.7...v0.9.0
[0.8.7]: https://github.com/RDevNeo/harbor/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/RDevNeo/harbor/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/RDevNeo/harbor/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/RDevNeo/harbor/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/RDevNeo/harbor/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/RDevNeo/harbor/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/RDevNeo/harbor/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/RDevNeo/harbor/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/RDevNeo/harbor/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/RDevNeo/harbor/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/RDevNeo/harbor/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/RDevNeo/harbor/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/RDevNeo/harbor/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/RDevNeo/harbor/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/RDevNeo/harbor/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/RDevNeo/harbor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/RDevNeo/harbor/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/RDevNeo/harbor/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/RDevNeo/harbor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/RDevNeo/harbor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/RDevNeo/harbor/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/RDevNeo/harbor/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/RDevNeo/harbor/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/RDevNeo/harbor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RDevNeo/harbor/releases/tag/v0.1.0
