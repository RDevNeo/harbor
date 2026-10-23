# Changelog

All notable changes to Harbor. Versions follow [SemVer](https://semver.org/) (0.x: anything may
still change); the version in `Cargo.toml` is the source of truth, and a `vX.Y.Z` tag publishes it.

## [Unreleased]

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

[Unreleased]: https://github.com/RDevNeo/harbor/compare/v0.8.6...HEAD
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
