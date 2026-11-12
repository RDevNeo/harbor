# Changelog

All notable changes to Harbor. Versions follow [SemVer](https://semver.org/) (0.x: anything may
still change); the version in `ts/package.json` is the source of truth, and a `vX.Y.Z` tag publishes it.

## [Unreleased]

## [0.181.0] - 2026-11-12

### Added
- Double-click installs on every release, linked from the website: `harbor-x86_64-windows-setup.exe` (Windows:
  for your user, no administrator; Start menu, optional desktop shortcut, uninstall in Settings › Apps) and
  `harbor-x86_64-linux.deb` / `harbor-aarch64-linux.deb` (Debian, Ubuntu: each user runs their own copy, which
  updates itself), beside the macOS `.dmg` and the Android `.apk`. Both also install Git, Claude Code, Codex and
  ripgrep when they're missing.

### Fixed
- Windows: install.ps1 runs Claude Code's installer in a PowerShell of its own, so a failure there can't end
  Harbor's install.
- A worktree cleanup test that sometimes failed (it raced the cleanup's own retry).

## [0.180.21] - 2026-11-12

### Fixed
- macOS: Harbor starts at login again after an update (macOS refused the first launch of the updated
  program); its login item opens Harbor.app and is listed as Harbor. Older entries are fixed at the next start.

## [0.180.20] - 2026-11-12

0.180.19 was tagged but never published (its build failed fetching the new Bun): its changes come with this one.

### Fixed
- Windows: renaming or moving the Projects folder (or a folder holding projects) works while Harbor runs: Harbor
  watched those folders, and Windows won't move a folder being watched; a moved worktree or chats folder is
  followed there too.
- Windows: a script on PATH without an extension (a `gh` or `claude` wrapper) runs, as in Git Bash.
- Windows: "Clone here" takes a Windows folder, a process an agent starts in a folder of its own starts there,
  a chat's folder is told to other PCs, and a video file of this PC plays as a file.
- Windows: stopping the Discord app's shell ends it and what it started.

## [0.180.19] - 2026-11-12

### Added
- `harbor api METHOD PATH [JSON]` calls the running Harbor's own API from a terminal; `harbor api transcribe
  FILE.wav` dictates a recording through it.

### Fixed
- Less CPU while idle, most on macOS: folders that are on another PC are no longer looked at again and again
  (each look costs milliseconds under macOS's /home), project icons aren't searched for in them, the sidebar
  redraws only the running chats' rows each second, and a running chat copied from another PC saves only
  what's new.

### Changed
- Harbor runs on Bun 1.4.4 (was 1.4.3): on Windows Bun 1.4.3 could crash when a connection to another PC closed
  while data was still coming (seen in the mesh's TLS and relay tests); 1.4.4 doesn't.

### Fixed
- Windows: this PC's own files open in the Files pane (it needed Python), and going up a folder works there.
- Windows: Discord's shell gets what a Windows program needs to start; `gh` and a stand-in Electron that are
  scripts run; an agent's `bash` tool keeps the folder it `cd`s into.
- Windows: a project moved to or from another PC keeps its links, a project of another PC's home is recognised
  (C:\Users\… too, and on Linux and macOS from a Windows PC), and device files over ssh don't ask for shared
  connections Windows' ssh doesn't have.

## [0.180.18] - 2026-11-12

### Fixed
- Projects whose folder is on another PC show their icon from that PC soon after the start (they waited 10
  minutes), and from whichever PC holds the folder.
- A Next.js project's icon in a route group's folder (`app/(app)/icon.png`) is found.
- macOS: the start no longer stalls on other PCs' paths under /home: follow-main takes only a checkout that's on
  this PC, and missing project folders are looked for every 30 s.

## [0.180.17] - 2026-11-12

### Fixed
- Windows: Claude Code (Anthropic's installer, or npm) and Codex from npm are kept up to date, as on Linux and
  macOS; Harbor couldn't tell how they were installed.
- Windows: renaming a worktree's folder keeps git's link to it; a moved worktree is found again by its git folder.
- Windows: a turn's tools reach Harbor only on a port this user's process listens on (Windows can say whose it is).

## [0.180.16] - 2026-11-12

### Fixed
- A PC that just signed in, or moved to another workspace, shows the chats and projects of the account's other
  PCs at once (they only showed after a restart).
- A PC signing in for the first time lands in the account's own workspace when the account is in several.
- macOS: Harbor no longer keeps a core busy (19-33 % idle) looking for other PCs' project folders under /home.
- Projects whose folder is on another PC show their icon, from that PC, instead of their letter.
- The Parakeet speech model downloads again: its source changed its files, so new downloads were refused.

## [0.180.15] - 2026-11-12

### Fixed
- Windows: Attach files, a project's icon and the Projects folder open Windows' own file and folder dialogs; they
  only said to install zenity.
- Windows: a Projects folder typed with a trailing `\` or as `~\…` is read as meant.

## [0.180.14] - 2026-11-12

### Fixed
- Windows: a terminal pane opens Git Bash (cmd without Git); it tried /bin/bash.
- Windows: Add project's folder step goes to a full `C:\…` path typed in, and `harbor hot` follows saves there.

## [0.180.13] - 2026-11-12

### Fixed
- Windows: Harbor built on a Windows PC itself (Follow main there) shows images: its build missed the step that
  points sharp at Harbor's own copy, so sharp couldn't load.

## [0.180.12] - 2026-11-12

### Added
- The installers (install.sh, install.ps1) also install ripgrep when it's missing: the agents' file search
  needs it.

### Fixed
- Windows: runtime updates are no longer refused while Windows checks the new harbor.exe on its first start
  (about 20 s, mostly Defender). The updater waits for it in the background, and install.ps1 starts Harbor
  once before it finishes, so the first open after installing takes a fraction of a second.

## [0.180.11] - 2026-11-12

### Fixed
- Windows: a start that fails from the Start menu or a shortcut leaves its errors in `failed-start.log` beside
  harbor.exe, as on Linux and macOS: what Harbor and its native parts printed, and the error that ended it.

## [0.180.10] - 2026-11-12

### Fixed
- Windows: the Discord app's idle freeze suspends its shell and lets it go again (it signalled processes Windows
  can't signal), and a command Harbor runs for an agent is stopped with what it started.
- Windows: other PCs' agents can read and edit this PC's project files at the level you gave them (Windows
  paths were refused), and file tools take `C:\…` paths.

## [0.180.9] - 2026-11-12

### Fixed
- Windows: Stop on a process an agent started (a dev server, a watcher) stops it and what it started; it kept
  running before.

## [0.180.8] - 2026-11-12

### Fixed
- Windows: Harbor knows when each process started, so a turn or process is told from another that later got its
  number, and a turn picked up after a restart keeps its place in the chat and its agent (Codex too).

## [0.180.7] - 2026-11-12

### Fixed
- Windows: what a shell command an agent starts prints (Git Bash's `sh`, `bash` and the programs they run)
  reaches its log and the chat: the turn's log files were opened write-at-end only, which those programs
  refuse ("Bad file descriptor"), so their output was lost.

## [0.180.6] - 2026-11-12

### Fixed
- Windows: folders under your profile read `~/…` in Add project, Settings, the palette and worktree notes, and
  checks of "is this inside that folder" read Windows paths: a project folder moved on disk keeps its chats, a
  terminal open in a project is seen, the phone's files of a chat open, a project moved to another PC keeps its
  place under the home, and a remote turn from Windows finds your Claude profile.

## [0.180.5] - 2026-11-12

### Fixed
- Windows: images and videos an agent names in its reply show in the chat (`C:\…` paths, `file:///C:/…` links,
  paths in the text); a chat moved from another PC finds its images under this PC's profile.
- Windows: any program Harbor starts that is a `#!` script or an npm `.cmd` runs as it would in Git Bash, with
  its arguments as they are.
- Windows: two turns starting at once no longer fail writing the same file; a secret-holding command that runs
  too long is stopped with everything it started, as is a transcription; stall log lines name what was running.

## [0.180.4] - 2026-11-12

### Fixed
- Windows: an agent CLI or a tool that is a script with a `#!` line (a wrapper in `~/.local/bin`) runs, with its
  interpreter as Git Bash would run it (Git's own `sh`/`bash`, `/usr/bin/env bun`); Windows can't start one itself.

## [0.180.3] - 2026-11-12

### Fixed
- Windows: a `.env` file Harbor writes for an agent must be inside the project. The check read only "/", so
  any path was taken as the project's top folder (a `.env` in a linked folder outside the project passed,
  and `apps/web/.env` was written at the top). Adding it to `.gitignore` works there too.
- Windows: project names, folder chips, attachment names and image checks read Windows paths (a project was
  named by its whole path).
- Windows: Harbor's database file is let go when it closes (a statement of an old migration held it).

## [0.180.2] - 2026-11-12

### Fixed
- Windows: Codex (and Claude Code) installed with npm run their turns: npm's `codex.cmd` can't take an argument
  with a quote, `&` or `%` (a prompt, a JSON config), so Harbor runs the node script behind it directly.
- Windows and macOS: opening a file, a link, a non-image attachment or a voice recording from Harbor's window
  uses the system's own opener (it called `xdg-open`, Linux's), and pasting into a terminal pane reads the
  system's clipboard.

## [0.180.1] - 2026-11-12

### Fixed
- Windows: Harbor's window no longer opens bigger than the screen on a scaled display (1400x900 at 150 % was
  2100x1350 on a 1920x1080 screen); it's fitted and centred on the screen it opens on.
- Windows: Harbor's icon in its window's title bar and in Alt+Tab, instead of a blank one.

## [0.180.0] - 2026-11-12

### Added
- Harbor for Windows (x64, Windows 10 1809 or newer), a preview: `harbor-x86_64-windows.zip` and an installer,
  `irm https://github.com/RDevNeo/harbor/releases/latest/download/install.ps1 | iex`. It installs Harbor for
  your user (Start menu, Settings > Apps, `harbor` on PATH) and what Harbor needs when it's missing: Git for
  Windows, Claude Code and Codex. Harbor updates itself afterwards, as on Linux and macOS.
- On Windows: Harbor's icon by the clock with its menu, Windows' own notifications (a click opens the chat),
  copy and paste with images and files, start at login, and the microphone for dictation.

## [0.179.5] - 2026-11-12

### Added
- Harbor builds for Windows x64 (`ts/scripts/build.ts --target windows-x64`) and starts there: its window,
  the native modules (images, local transcription, the UI) with the Visual C++ runtime they need, processes,
  file locks and Windows' own folders. A preview for developers; there's no Windows download yet.
- `scripts/boat/windows`: a Windows 11 VM on boat.dev for building, running and testing Harbor on Windows.

### Changed
- File locks (one Harbor per session, the Discord and WhatsApp hosts, Claude Code's credentials) are taken
  by path; nothing changes on Linux or macOS.

## [0.179.4] - 2026-11-12

### Fixed
- Two turns starting at the same moment (a lead starting its sub-agents, messages sent to several chats at
  once) could end one of them at once with "The agent exited with an error": both wrote the same app file
  through one shared temporary name, and the second write failed and took its turn's runner down. Every
  writer now has its own temporary file.
- A turn whose runner fails before the agent starts says why in its chat instead of failing with no reason.

## [0.179.3] - 2026-11-12

### Added
- `harbor quit` quits the running Harbor as its tray's Quit does (turns stop, its data is saved) and waits
  until it's gone. Uninstalling with install.sh uses it first.

## [0.179.2] - 2026-11-12

### Fixed
- A turn that answered very fast could stay "Working" forever: its result came in before Harbor had the
  turn in hand, so its input was never closed. Now the result always ends it.
- A message sent just as a turn ended no longer waits on that turn's finishing runner: the turn's reply
  stays in the chat and isn't followed by "The agent exited with an error".

## [0.179.1] - 2026-11-12

### Changed
- macOS (Harbor.app): "Start Harbor when I log in" is a login item macOS lists as Harbor, with its icon,
  and desktop notifications are macOS's own, shown as Harbor's; clicking one opens its chat.

## [0.179.0] - 2026-11-12

### Added
- Harbor for macOS (Apple Silicon, macOS 13 or newer), a first preview: the same install line puts
  Harbor.app in ~/Applications (`harbor-aarch64-macos.tar.gz`), and it updates itself like on Linux.
  Not signed by Apple yet: install it with the command below rather than from a browser download.
- The installer brings what Harbor needs when it's missing, on Linux and macOS: Claude Code, Codex and
  git (on macOS, Apple's Command Line Tools ask once; on Linux your package manager asks for your
  password once).

## [0.178.4] - 2026-11-11

### Fixed
- Harbor's log no longer starts with over a hundred "Warning: [object Object]" lines: Slint's compile
  warnings stay out of it, and a test lists them readably instead.

## [0.178.3] - 2026-11-11

### Fixed
- A desktop notification on a PC without `notify-send` no longer raises an unhandled error.
- Offline runs (and `HARBOR_NO_PROVIDER_UPDATES`) never update Claude Code or Codex by themselves.

### Changed
- macOS groundwork, nothing changes on Linux: the window comes to the front when asked, the Discord app
  runs Electron's macOS build without a Dock icon, and the window's loop costs ~1 % of a core when idle.

## [0.178.2] - 2026-11-11

### Changed
- macOS groundwork, nothing changes on Linux: copy with images on macOS's pasteboard, Harbor's icon in the
  menu bar, start at login as a LaunchAgent, and the microphone for dictation (`harbor record-mic`).

## [0.178.1] - 2026-11-11

### Changed
- macOS groundwork: the macOS build brings its own libintl for Slint's addon instead of needing
  Homebrew, and works on macOS 13 and newer. `harbor --check-native` also loads Slint's addon.

## [0.178.0] - 2026-11-11

### Added
- Projects folder (Settings › General › Projects; on the phone, Settings › Projects): one folder per PC where
  new projects and clones go. Once you pick one, new worktrees go in its `.worktrees` folder and new chats
  without a project run in its `chats` folder. Without one, nothing changes: `~/Projects`, Harbor's data
  folder and the home folder, as before; chats without a project that already ran stay where they ran.
- Moving or renaming a folder no longer breaks Harbor. A project, a worktree, a chats folder or the
  Projects folder itself moved or renamed anywhere under your home folder is found again within seconds
  (or before the next message's turn starts) and followed: the project keeps its place in the sidebar, its
  chats go on in the new folder with their sessions, worktrees are linked to their checkout again
  (`git worktree repair`), and each chat says where it went. A folder moved to the Trash counts as gone,
  and its chat says so; restored, it's found again. Other PCs follow the project's new path too.

## [0.177.6] - 2026-11-11

### Fixed
- Usage-limit reset times ("resets 12am (America/Sao_Paulo)") are read without GNU `date`, in the
  limit's own time zone, so they're right on every system.
- Hot reload works from a checkout reached through a link, and builds each save once.

### Changed
- Groundwork for Harbor on macOS, nothing changes on Linux: processes, memory, Claude Code logins in
  the keychain, turns that outlive Harbor, a window loop for systems without an fd to wait on, a
  UTF-8 locale and Homebrew's tools for what Harbor starts, and `build.ts --target darwin-arm64`.

## [0.177.5] - 2026-11-11

### Fixed
- Split panes: a chat started from the New thread screen opens in the focused pane, as a chat clicked in
  the sidebar does, and the other panes keep theirs. Both panes used to go blank, with the new chat in
  neither. A chat on screen that no pane holds now always shows as the usual view, never as empty panes.

## [0.177.4] - 2026-11-11

### Fixed
- Switching chats no longer leaks: every image the window read (a logo, an owner photo, an image's
  placeholder) left a reference behind in the JavaScript engine that was never let go, about a dozen
  per switch. Images are now handed over in the form the window reads without one.

## [0.177.3] - 2026-11-11

### Fixed
- Harbor no longer freezes ("not responding") while agents run heavy builds and tests: turns now get a fifth
  of the CPU an app gets when both want it (their weight was set where it had no effect), and Harbor's own
  window gets more CPU and keeps up to 512 MB (8% of RAM on small PCs) from being swapped out or evicted,
  so a click doesn't wait on the disk.
- Switching chats no longer writes to the database each time: the last chat and the split layout are
  written once the switching stops, and unchanged settings aren't written at all. Under a busy disk one
  such write held the window for up to 3 seconds.
- Typing `@` in the composer lists the project's files without holding the window while git reads them.

### Added
- The log says when Harbor's window stopped answering for a quarter second or more, and why: what it was
  doing (drawing, a database query, a program it waited for), whether it waited on the disk, CPU or memory,
  and the file it was reading (`journalctl --user -u 'app-harbor*' | grep 'main thread'`).

## [0.177.2] - 2026-11-11

### Fixed
- Images no longer flash gray when switching chats. Split panes and the usual view now share one store of
  decoded images: a chat opened into a pane, moved to another pane or opened again finds its images
  decoded (each pane used to decode its own and drop them when its chat changed).
- A chat opened from the sidebar comes on screen once the images its first frame shows are decoded (off
  the main thread, waiting 150 ms at most), and the images of the chats beside it in the sidebar are
  decoded ahead once switching stops.

## [0.177.1] - 2026-11-11

### Changed
- Internal, nothing changes on screen: what Harbor asks of the operating system (processes, memory,
  file locks, opening links, raising its window, its folders) now goes through one package,
  `@harbor/os`, the first step towards Harbor on Windows and macOS. A test keeps new Linux-only
  calls out of the rest of the code.

## [0.177.0] - 2026-11-11

### Removed
- The built-in browser, on the desktop and on the phone. Links in chats, PR and issue pages, a
  process's URL and patch panels with a `url` open in the system's default browser (`xdg-open`), on
  the phone in its own browser. Gone with it: the panes' Browser tab and its "Dev servers and recent
  pages" menu, Ctrl+Shift+B and the palette's "Open or close the browser", "Open in Harbor's
  browser" in the PR and issue menus, the Servo engine (`browser/`, the phone's `android/servo` and
  its `:browser` process), its release archives and CI (browser.yml, prune.yml), and the installer's
  engine download (`--no-browser` and `--with-browser` are still accepted and do nothing).
- The phone app download goes from about 104 MB to about 18 MB without the engine.

### Changed
- An updated Harbor deletes the old engine (`harbor-browser`, about 45 MB, with its rollback copy
  and marks) from `~/.local/lib/harbor` when it starts; install.sh does the same.

## [0.176.4] - 2026-11-11

### Fixed
- Split panes: giving another pane the keyboard builds neither transcript again. Every pane keeps its own
  transcript (the focused one included), so only the focus moves: the title's brightness and which composer
  is the window's. The Agents column stays docked while any pane on screen is a lead's.
- A maximized split pane is the usual single-chat view: the title bar with project, chat and branch, the
  memory pill, the full composer with its model row, agents strip and footer, and the Agents column. A
  button in the title bar shows every pane again.
- Side panes stay live and cheap while they stream: a pane's cards no longer lay out again whenever its
  header changes (its status, a draft, the focus), and a chat in a pane on screen counts as seen (no
  unread mark or notification for a turn that ends there).
- Zooming in several steps quickly no longer leaves an image drawn from an earlier step's decode: a decode
  that lands after the scale moved on rests instead of replacing the one on the screen (0.176.3).

## [0.176.3] - 2026-11-11

### Fixed
- Switching back to a chat with images shows them in its first frame instead of gray boxes filling in again:
  images still being decoded when a chat is left are kept (they were thrown away), and recently shown
  chats keep up to 64 MB of decoded images (was 32 MB).
- The title bar's branch and the composer's footer show a chat's worktree and branch in its first frame,
  read from its folder until the PC answers, instead of the checkout's branch for a moment.
- The line between split panes and the Agents column runs the full height and no longer flickers: it sits
  on a whole physical pixel over the panes; the dividers between panes snap the same way at any zoom.

## [0.176.2] - 2026-11-11

### Fixed
- Switching chats (sidebar, Alt+Up/Down, split panes) goes from the old chat to the new one in one
  frame: the last chats left stay ready (no reload or re-parse), the newest messages are drawn first
  and the rest just after, and only the changed rows of the transcript are rebuilt.
- A chat opens at its end even after scrolling up in the one before, with no jump; a reader who
  scrolls up while it opens stays where they are.
- Images keep their place at their final size (a gray box) while they load, so the messages
  around them no longer move; images are read off the main thread and recently seen ones stay
  decoded.
- The sidebar's selection and the composer's footer update in place instead of blinking.

## [0.176.1] - 2026-11-11

### Fixed
- Images, image cards and image grids in a narrow split pane scale down to the pane's width,
  keeping their shape, instead of being cut off at the pane's edge.
- Every split pane's composer is the real one, the same as the focused pane's: logo, border, send
  button, footer row and agents strip.
- A long message in a compact composer takes the full width, grows to 4 lines, then scrolls with
  the caret kept in view.
- The 1px lines at the top of the window and under pane headers no longer flicker or vanish at
  fractional zoom: they sit on whole physical pixels.
- The composer's footer row shows under every chat: a project without Git, an SSH device chat or a
  chat with no project shows the folder it runs in.

### Changed
- The Agents panel in split mode is a column beside the panes, aligned with their headers, titled
  "Agents · <focused chat>".
- The layout buttons and the pane count are gone from the top bar: panes are arranged by dragging.

## [0.176.0] - 2026-11-11

### Changed
- Split chat panes take any layout of up to 4: each split side by side or stacked, nested (3
  columns, 2 + a full-width row, 1 + 2 stacked, 4 rows, 2x2, ...). Drop a chat on any side of a
  pane, or near the very edge of the center for a full-width row or full-height column; dividers
  resize at every level. Drag a pane by its header onto another pane to swap them, or onto a side
  or the outer edge to move it there. Every split pane has a slim one-line composer (model, mic,
  attach, send) with where the agent works and its branch under it. Headers show only the chat's
  name and status; no pane numbers or blue focus border (the focused pane's name is just
  brighter), and the sidebar marks open chats with a small two-column glyph. Layout buttons:
  columns, rows, one + stack, 2x2.

## [0.175.0] - 2026-11-11

### Added
- Split chat panes: drag a chat from the sidebar into the center to see it beside the open one, up
  to 4 at once. With one pane the drop goes to the left or right half; with more, to an edge of the
  pane under the pointer, and its middle replaces that pane. Layouts 1, 2, 1+2 and 2x2 from the top
  bar (which then shows "N of 4" in place of the breadcrumb), dividers you can drag, and a header per
  pane with its status, maximize and close (the chat keeps running). Click a pane, press Ctrl+1..4
  or click a sidebar chat to type there; Ctrl+W closes the focused pane. Sidebar rows show their pane
  number, short panes get a one-line composer, and the layout survives restarts.

## [0.174.2] - 2026-11-11

### Fixed
- The memory pill of a chat that runs on a device reached over SSH (Runs on) now speaks of the
  device: its popover says "on <device>", the agent's row is what it holds there (read over SSH,
  Linux and macOS), this PC's end shows apart as "SSH link on <PC>", and the RAM bar is the device's.
  The device's card in the PCs popover lists those chats too. Turns started before the update say
  "No numbers" for the device part until their next turn.

## [0.174.1] - 2026-11-11

### Fixed
- A chat with no project that someone else starts on your PC (from their phone, or from their PC)
  now goes in their workspace, so the sidebar's workspace filter shows it under theirs, not under
  yours; desktop and phone alike. Chats started that way before are placed once, on the update.
  Move to workspace… still puts one wherever you want.

## [0.174.0] - 2026-11-11

### Added
- When the PC a chat runs on is off, Harbor carries on on another PC of the mesh by itself, on the
  desktop and the phone alike. Over the composer: "Tower is off. Next message runs on Desk." The
  next message moves the chat to that PC: a new session with the conversation so far (the old
  session and any unpushed work stay on the PC that is off), and the chat says "Tower is off: moved
  to Desk". The PC picked is one that is on, has a Claude account and has the project (or can clone
  it from its Git remote), the one with its folder first, then the most free memory. A new chat in
  a project whose PC is off starts on such a PC. When none can run it, an amber line says so and
  messages wait until a PC is back, then go out by themselves. A PC that comes back hands the chat
  to the PC that took it over, unless it went on there too.

## [0.173.1] - 2026-11-10

### Fixed
- On the phone, a sub-agent's chat opens again (from the Agents panel, a fork's "Open source
  conversation", or right after the agent was spawned) instead of saying "This chat was deleted"
  and closing. A retired agent's chat opens to read, as on the desktop.

## [0.173.0] - 2026-11-10

### Added
- Harbor comes back exactly where it was after a restart (an update, a build of main, `harbor restart`):
  the same chat at the same place in its transcript, the same Settings page with what was typed in its
  fields (passwords never), the same panes, sidebar search and scroll, model picks and an open Rename,
  and every composer with its text, cursor, mentions and files.
- The new window shows before the old one closes, so there's no moment without Harbor; on Hyprland it
  opens on the same workspace and takes the focus only if the old one had it.
- What's typed in a composer survives a crash or a forced kill too: it's saved a moment after each change.
- `harbor restart` restarts the running Harbor that way.

## [0.172.2] - 2026-11-10

### Fixed
- The model picker no longer shows someone's photo on another person's account. A PC can hold
  someone else's sign-in; its photo was filed under that PC's owner and could appear on the owner's
  other entries, and an account nobody is known to own was told with its PC owner's photo. A photo
  now comes only from the account's own sign-in (or the person its email names); otherwise initials.

## [0.172.1] - 2026-11-10

### Changed
- Settings › Workspace: each phone reads by its device name, the one the Devices panel shows (just
  "Phone" when none is known), with "Phone" below it instead of its key. PCs there show the Harbor
  they really run, as the Devices panel does, not the version they advertise to old PCs.

## [0.172.0] - 2026-11-10

### Added
- Parts of the phone's screens are drawn from rows the PC sends, so new or reworded settings reach
  the phone with a PC release, without a new app. First: Settings' Voice and Worktrees sections,
  which look exactly as before. The phone says which kinds of rows it can draw and the PC fits the
  screen to it; PCs before 0.172 keep showing the app's own rows.

### Changed
- The phone app updates itself within seconds of a release, with no PC and no sign-in involved: it
  hears of new releases from Harbor's public release news (the same long poll PCs use, now with a
  longer hold for phones), downloads and checks the new app at once, and installs it as soon as
  Harbor is out of sight for a few seconds (or the screen is off), back on the same chat. GitHub's
  latest release every few minutes stays the fallback; a phone whose Play Protect blocks background
  installs gets the "tap to install" notification as soon as the download is checked, and the tap
  installs at once.

## [0.171.4] - 2026-11-10

### Fixed
- The model picker has one OpenCode entry, period: OpenCode has no account, so it's the same tool on
  every PC, with no owner's badge or photo. It runs on this PC when this PC has OpenCode, otherwise on
  the PC Auto would pick (on, most free memory). 0.171.3 still showed one per PC owner, and could show
  another person's photo on one. Favorites starred on any OpenCode move to the one entry.

## [0.171.3] - 2026-11-10

### Fixed
- The model picker lists one person's OpenCode once, however many of their PCs have it (it has no
  sign-in to compare, so its PC's owner says whose); different people's stay apart. Favorites starred
  on another PC's OpenCode move to the merged entry.

## [0.171.2] - 2026-11-10

### Changed
- The sidebar looks like T3 Code's, on the desktop and the phone: projects fold under a chevron, and
  chats hang off a guide line with their status first, how long ago they were active on the right, and
  the owner of someone else's chat.
- Every chat in the sidebar names its branch: its worktree's, else its project checkout's, also for
  copies of chats from other PCs.
- New worktrees get short task-like names from Sonnet, asked on any Claude account under 90% of its
  quota; the fallback name drops filler words.

### Fixed
- Stopping Harbor no longer lets a turn that was still starting, or a runner's late output, write to the
  closed database: no turn starts once Harbor stops, one still starting is left to its runner for the
  next Harbor to pick up, and running turns stop being followed. This was behind "Cannot use a closed
  database" failures in the test suite.
- Tests that start real turn processes (engine, chat state, `harbor mesh status`, offline mode) wait for
  what they check instead of failing on budgets that only a quick machine met.

## [0.171.1] - 2026-11-10

### Fixed
- Claude's models are the ones Claude Code itself offers in /model, in its order: Opus 5.5, Fable 5.2,
  Sonnet 5.5 and Haiku 5.5 up front (Ctrl+1..4), its "More models" (Fable 5.1, Haiku 4.5, Opus 4.8, …)
  behind More models. Read from the CLI, so a new model shows without a Harbor release; chats on
  Fable 5.1 keep it.

### Changed
- A model's second line in the picker is whose workspace the account is ("Sam's Workspace"), without
  the provider's name (its icon stays).

## [0.171.0] - 2026-11-10

### Changed
- A new chat's project picker is a compact dropdown under the project's name ("No project" under
  "What should we work on?"), on the desktop and the phone: a search field, then each project with
  its icon or tinted initials and where it is, "No project" first and "Add project" last. Typing
  filters; arrow keys and Enter pick, Esc or a click outside closes.

## [0.170.1] - 2026-11-10

### Fixed
- Devices removes superseded phone registrations and phones inactive for seven days from stored
  records, preserving recent outages and activity reported by other PCs. Phone workspace labels
  and photos now follow the account signed in on each phone.
- New TLS identities always get a certificate serial in minimal DER form: about 1 in 128 used to
  be refused (INVALID_INTEGER) and could not be used.

### Changed
- A workspace's default name reads "Sam's Workspace" on the desktop and the phone (Devices,
  Workspace page, menus, invitations); new workspaces are created with it. Other names are shown
  as they are.

## [0.170.0] - 2026-11-10

### Added
- Every PC keeps its Claude Code and Codex CLIs on the latest version by itself, with no setting:
  Harbor finds what installed each one (mise, Claude's or Codex's own installer, global npm or
  Homebrew) and updates it with that tool. A CLI's update waits only for that CLI's turns on the
  PC (Codex updates while Claude turns run), and turns that start meanwhile wait for it. Phones
  get a notification and the PC a toast or desktop pop-up, e.g. "Codex updated to 0.167.0 on
  <PC>", one per PC for the updates done together. An install Harbor can't place is left alone;
  a failure is a log line only.

## [0.169.4] - 2026-11-10

### Fixed
- The test harness keeps spawned scripts on the same Bun executable as the test suite. Fake CLIs
  name their interpreter directly; child Bun commands use its directory first in PATH, avoiding
  different installed versions and mise shims after tests isolate HOME and XDG folders.

## [0.169.3] - 2026-11-10

### Fixed
- Jobs started with `start_process` keep running through a Harbor restart or follow-main update, in
  their own systemd scope as turns do. Harbor finds them again with their logs and original owner;
  jobs that finish during the restart still report their real exit status to the chat that started
  them. Stop ends the whole job, including children in other process groups.

## [0.169.2] - 2026-11-10

### Fixed
- The direct push-notification test waits for the notification instead of assuming the PC can finish
  its Git work within one second, so it remains reliable while the full test suite runs under load.

## [0.169.1] - 2026-11-10

### Changed
- Follow main no longer waits on GitHub's webhook, which sometimes arrives half a minute late (a push
  of main right before a tag, as every release does): the PC that pushed tells the account worker
  itself as soon as its checkout's `origin/main` moves (`POST /v1/main`, with that PC's Harbor
  token). The worker never takes its word: it reads main from GitHub (at most once a second, a few
  tries while GitHub still shows the previous commit) and only then tells the other PCs. The webhook
  stays as the backup for pushes from elsewhere.
- Devices shows each device's owner's workspace and photo below its name, with a green dot for
  online devices and dimmed offline rows. Rows keep their size as state and photos change; the
  panel keeps the online count and hover actions and no longer opens fullscreen.

## [0.169.0] - 2026-11-09

### Added
- A lead's subagent can move to another provider account with its conversation: the lead's new
  `switch_agent_account(agent, account, model?, effort?)` tool, the account line (or a right click) on
  an agent card in the Agents panel, and the subagent's own account picker (desktop and phone). On the
  same provider its Claude session goes along to the new account's folder and resumes there; Claude ↔
  Codex starts a new session that begins with the conversation so far. A subagent waiting at a usage
  limit, or with messages waiting, goes on at once on the new account; one running a turn moves when
  that turn ends.
- A subagent that hits a usage limit tells its lead: a notice when it switches by itself (the automatic
  switch chats already have, with the same opted-in accounts), and otherwise a message with why it
  didn't move and which accounts could take it. `list_agents` names each agent's account id and says
  when one is paused at a limit.

### Fixed
- An agent card in the Agents panel never said "paused · usage limit" (it looked at the wrong pause):
  it does now, with the continue time when there is one.

## [0.168.0] - 2026-11-08

### Changed
- Follow main runs on every installed Harbor, not only on PCs with a Harbor checkout: a push to
  Harbor's main is running on each PC about 5–15 s later. A PC without a checkout (or with a stale
  one) keeps a small partial clone of the public repository (`https://github.com/RDevNeo/harbor.git`,
  HTTPS only, the PC's git config left out) in Harbor's data folder and builds there, as before:
  app-only commits, the same checks, `+commit` versions, crash rollback, run health. A local checkout
  still wins when it's ahead (commits not pushed yet). It is ready before the first push (clone and
  `bun install` once, at idle priority).
- Pushes are heard at once: GitHub's push webhook reaches the account worker (`POST /v1/github`,
  signature checked), which answers every PC's long poll (`GET /v1/main/wait`); without it,
  `git ls-remote` looks every 3 minutes. After a restart, news brings the first look forward to 10 s.
- Only forward: a commit of the public main is built only when it descends from the commit the PC
  runs, so a force-push that rewrites main builds nothing and releases keep coming. `harbor follow-main
  off` still turns it off; `status` names the main followed and, after a push, "ran N s after its push".
  build.log times each step.

## [0.167.3] - 2026-11-08

### Fixed
- Esc right after sending, then sending again at once, could leave the chat stuck on Working: the
  new turn's events were dropped while the undone turn hadn't reported its exit yet.

## [0.167.2] - 2026-11-08

### Added
- The Devices panel (bottom or right side panel) lists this PC first, labelled "This PC", with its
  Terminal and Files buttons: both open here, with no ssh.
- Device rows show the Harbor each PC really runs (e.g. `0.167.1+abc1234` on a PC that follows main),
  not the older version PCs advertise to each other for compatibility; a PC before this release still
  shows the advertised one.

### Fixed
- A pull request lookup that finished after Harbor stopped no longer touches its closed database
  (the cause of the occasional "Cannot use a closed database" failure in the test runs).

## [0.167.1] - 2026-11-08

### Changed
- Follow main is on by default on every PC with a Harbor checkout (a project whose remote is Harbor's
  repository), and its row is gone from Settings › General › Updates. A PC without a checkout keeps
  taking releases, with nothing to say about it. `harbor follow-main off` still turns it off for that
  PC and stays off (`on` and `status` too); 0.166's opt-in setting isn't read, so every PC starts on.

## [0.167.0] - 2026-11-08

### Added
- Patches: small TypeScript files in a project's `.harbor/patches/` (or `~/.harbor/patches/` for every
  project) add buttons over the composer (run a command in a terminal pane, send a message, open a
  page) and side panels (a page such as localhost:3000 in Harbor's browser, or a list). They show up
  within a couple of seconds of being saved, with no restart. A patch is code, so it runs only once
  you trust it from the "Patch to trust" chip, for that exact content: an edit asks again. Agents
  know the format (`~/.harbor/patches/README.md`), so "add a button that runs the tests" just works.
- Dev hot reload: `harbor hot on DIR` makes the running Harbor follow a checkout. A save to the
  transcript's cards, the team tools or the agents' instructions is live in well under a second,
  with no restart and nothing lost; a broken save keeps the running version and says why.

## [0.166.0] - 2026-11-08

### Added
- Follow main (Settings › General › Updates, or `harbor follow-main on [--checkout DIR]`; off unless turned
  on, per PC): a PC where Harbor is developed builds Harbor's main branch whenever it moves (the newer of
  `main` and `origin/main` in the checkout) and runs it a few seconds later, as `0.x.y+commit`. Built in
  Harbor's own clone under its data folder, niced, never the checkout's working tree; tsc and the
  installer's bundle check must pass; a commit that changes only tests or docs builds nothing, one that
  needs a new runtime waits for the release and says so. A build that doesn't start, or crashes twice in
  its first minutes, is rolled back and not built again until main moves. A newer release whose commit
  the running build already has is ignored; any other installs as usual.
- Soak-gated releases: `bun ts/scripts/soaked.ts [status|gate|release]` cuts a release only for a commit
  that ran on this PC through Follow main for 6 hours (`--hours`) without a crash, with its checks passed
  and `scripts/boat/check` green on the release commit. Run health per commit is kept in
  `follow-main/health.json` in Harbor's data folder. Tagging by hand works as before.

## [0.165.1] - 2026-11-07

### Changed
- Agents (lead and subagents) are told to do platform actions (deploying, publishing, infra on Vercel,
  Convex, etc.) through the service's connected MCP integration, and to tell the user and stop when there
  is none, instead of falling back to CLIs, logins or credential files on the PC.

## [0.165.0] - 2026-11-07

### Changed
- Your integrations, saved keys and WhatsApp/Discord sessions follow your account with nothing to set
  up: any PC you sign in on gets them on its first sync, even with every other PC of yours off. The
  account service keeps your vault's key (sealed with a secret of its own) and gives it only to PCs
  signed in to your account; the items stay AES-256-GCM encrypted. This replaces end-to-end
  encryption: the service could technically decrypt the vault (the privacy page says so).
- The Vault section is gone from Settings › Workspace: no recovery code, no unlock, no start over.
  Vaults made by 0.162-0.164 move over on their own: the first PC that has the key hands it to the
  service, and the per-PC key wraps, requests and the recovery code are dropped.

## [0.164.1] - 2026-11-07

### Fixed
- The model picker's account badges show the owner's workspace photo even when the workspace knows them
  by a nickname: an account is matched to the member who signs in with the same email (another PC's by
  the hash of its sign-in; emails never cross the mesh), and names only last. This covers this PC's own
  profiles that belong to someone else too. The label uses the workspace name, and the tooltip adds the
  name Harbor detected when it differs ("Patty's (Pat Lee), runs on this PC"); the phone's Account
  sheet shows the same.

## [0.164.0] - 2026-11-07

### Changed
- WhatsApp's card in Settings › Integrations is a sign-in row like GitHub's: "Sign in" shows only a QR
  to scan from WhatsApp › Settings › Linked devices › Link a device, with Cancel; once linked it reads
  "Signed in as +1 555 123 4567" with Sign out. No warning step before the QR, and no pairing codes
  (the number field, Get a code, Try without the 9 and Other number are gone). The phone's WhatsApp
  sheet is the same row, and its QR can be scanned from another phone or by this one off the PC's screen.
- Signed-in app rows lose their green "Signed in" pill and show Sign out in red (desktop and phone);
  Discord's line is just "Signed in as <name>".
- Settings › Integrations takes the whole window width, always in two columns, so each card's line
  shows in full.

### Fixed
- Phone: a tap on the WhatsApp sheet could be lost to a redraw; it now redraws only when something changed.

## [0.163.0] - 2026-11-07

### Fixed
- The model picker's provider rail scrolls when its accounts don't fit (mouse wheel and touchpad), with
  faded edges where more are, under the favourites star. The picked account is scrolled into view when the
  picker opens, and Tab / Shift+Tab step through the rail.

### Changed
- Another person's account shows their workspace photo (as Settings › Workspace has it), round in the
  logo's corner, instead of their initials: on the picker's rail, the composer's model chip and the phone's
  account list, where its name now reads "Claude · Dana Reyes". A PC tells its accounts' owners' photos to
  the others (the address only, never an email). Only someone with no photo keeps their initials, and the
  tooltip says so.

## [0.162.0] - 2026-11-07

### Added
- Sign out of a PC and sign in on another: everything but your agent accounts comes along. Your
  integrations' sign-ins (Gmail, GitHub for gh, Convex, Vercel, Linear, Sentry, Supabase, Context7),
  the keys you saved for agents, and WhatsApp's and Discord's sessions follow your account in an
  end-to-end encrypted vault: Harbor's account service only stores ciphertext. Agents still ask you
  before using a saved key on each PC.
- A new PC opens the vault as soon as one of your other PCs is on (you're notified when it does), or
  with your recovery code when none is: Settings › Workspace shows the code on any PC that has the
  vault, and opens a locked one with it.
- WhatsApp and Discord run on one of your PCs at a time (two copies of a linked device get it dropped
  or banned): your other PCs' agents use them through that PC, and Settings shows "Runs on <PC>".
  Linking or signing in on a PC moves them there; signing out hands them on with the newest session.
- Signing out of an integration on one PC signs it out on all of them; a refreshed sign-in reaches the
  others within a minute.

### Changed
- Signing out of a PC takes your sign-ins, keys and sessions off it (they stay in the vault).
- Your settings follow your account again (they hadn't since the TypeScript app), and so do your name
  and GitHub login for who-is-who, the browser's recent pages, the video volume and the team view.

## [0.161.0] - 2026-11-07

### Changed
- Snoozing a chat or a project no longer moves it: it stays where it was in the sidebar and the phone's
  list, its title muted and, where its status goes, a clock with when it wakes ("Tomorrow, 9:00"). It
  used to leave the list (a chat) or hide (a project) until a search. Waking still marks the chat unread.

## [0.160.2] - 2026-11-07

### Fixed
- Phone: a message copied with its images attaches them when pasted into Harbor's composer from the
  keyboard's clipboard (Samsung's and Gboard's give back only the text), from a clipboard app that
  kept just the text, and after Android closed Harbor between the copy and the paste. A copy whose
  images couldn't be fetched from the PC says so instead of quietly copying only the text.

## [0.160.1] - 2026-11-07

### Changed
- The worktree and branch tray under the composer has the composer's outline colour, brighter while you type,
  as the composer's is.

## [0.160.0] - 2026-11-07

### Added
- Every PC's agent accounts in the workspace are offered on every other PC and phone: the model
  picker's rail and the phone's account list show them, each sign-in once (this PC's own when it has
  it), with its owner's initials as the badge (two people with the same ones are told apart, e.g. FS
  and FiS). A PC that is off shows its accounts greyed, with why.
- Picking another PC's account starts the chat on that PC, which runs it with its own login: keys and
  sign-ins never leave the PC that has them. Another PC that has the same sign-in takes over when the
  first is off. What that PC lets your PC's chats do there (Settings › Workspace) caps the chat's
  access, and it refuses when it shares nothing.
- A started chat switches to another PC's account too: it moves there (as Move to PC does) and goes on
  with that account. A Claude session that stays on Claude comes along; any other switch goes on in a
  new session with the conversation so far, as switching providers on one PC does. On the phone too.

### Changed
- The who-is-who agents are told lists each account once, under the PC that runs it, and each phone
  once.

## [0.159.1] - 2026-11-07

### Changed
- Dialogs that open with text already in their field (Rename worktree, Rename branch, Rename chat) put the
  cursor at the end of it, not the start.

## [0.159.0] - 2026-11-07

### Changed
- The worktree and branch under the composer sit in a slim tray tucked under its bottom edge, a little
  narrower than the composer: where the agent works on the left ("Current checkout" or the chat's
  worktree), its pull request and branch on the right, in small muted text with a chevron where a click
  opens a menu. On the phone too.
- The sidebar's Settled header reads "Settled (N)" with a thin line to the edge and a chevron (up while
  open, down while folded); the phone's drawer the same.

### Fixed
- The memory gauge in the sidebar's bottom row is centred on the row like your photo and the other
  buttons: its icon no longer sits above its figure and bar.

## [0.158.0] - 2026-11-07

### Added
- Copying a message takes its images along, on the PC and the phone: the message's Copy, and Copy
  (Ctrl+C) on text selected in it. A paste gives the text and the images where the app takes them.
  On the PC (Wayland) one copy offers the text, HTML with the text and its images, the image itself
  when there is one (PNG, and its own type) and the image files, so editors, terminals and plain
  boxes get the text, and mail, chat and image apps the images too. On the phone the clip holds the
  text and the images (WhatsApp, Telegram, Gmail take them); a plain text box still gets only the
  text. Pasted back into Harbor's composer, the images are attached and a user message's
  `[Image #N]` names its image again. A message without images copies as before; on X11, or a
  compositor without data-control (GNOME), the text alone.

## [0.157.1] - 2026-11-07

### Fixed
- A message that mentions another message with a note under it: the bubble now grows with the note
  when the note takes two lines or more, so the message's last lines no longer spill out below it.

## [0.157.0] - 2026-11-07

### Changed
- Phone app updates come straight from Harbor's GitHub releases, not from your PCs: the app looks at
  the latest release (every 5 minutes, also in the background), downloads the
  APK from GitHub and installs it only when its signature checks out with Harbor's release key, the
  one PCs check theirs with. No more "Checking every PC…". Settings › App's row no longer does
  anything when tapped: it says "X · up to date", or shows Update by itself when a newer version is
  out, and Update installs it at once.
- The update sheet reads "Harbor", then installed → new version ("0.156.0 → 0.157.0"), and on phones
  that install by themselves "Or it installs by itself next time the screen is off." Bottom sheets
  slide up without fading in, so nothing shows through them while they open.

## [0.156.2] - 2026-11-07

### Changed
- Your photo in the sidebar's bottom row is bigger, in a ring, so it stands out.

## [0.156.1] - 2026-11-07

### Changed
- The sidebar's bottom row no longer has the Pull requests and Issues buttons, and the phone's drawer
  no longer has their rows. Both pages still open from the search (Ctrl+K) and from a project's menu.

## [0.156.0] - 2026-11-07

### Changed
- Phone app updates: a newer app shows a sheet ("Update available", the new version and yours) with
  Later and Update, once per version, instead of the drawer's "Update available" row. Update
  downloads and installs it at once, as does Settings › App's Update button, which now shows the
  version on offer as soon as Settings opens, without checking every PC first. Installing by itself
  while the screen is off is unchanged.

## [0.155.1] - 2026-11-07

### Fixed
- WhatsApp: linking by code ("Get a code") failed with "Couldn't link device" on the phone. Harbor
  now connects as the WhatsApp Web version WhatsApp serves today (Baileys' own had gone stale) and
  as a browser WhatsApp knows (Chrome), and each code gets a fresh link of its own that lasts about
  six minutes (before, the code died with the QR codes, two to three minutes after Link, often
  before it was typed). The card and the phone's sheet show the time a code has left, say when it
  ran out (a new QR and number field come back), and offer Other number. For a Brazilian (+55)
  mobile they also offer the number's other form, with or without the 9 after the area code (some
  accounts are on WhatsApp without it), and try it by themselves when WhatsApp refuses the first.
  host.log now records the link's steps (version, QR ready, code asked for a masked number, the
  phone taking it, close codes), never a whole number or a code.

## [0.155.0] - 2026-11-07

### Added
- WhatsApp app (desktop and phone): agents can read and send on your personal WhatsApp, as a device
  linked to your phone like WhatsApp Web. Settings › Integrations › WhatsApp › Link shows a warning
  (an unofficial client, against WhatsApp's terms), then a QR code to scan from WhatsApp › Linked
  devices, or a code to type there for a number ("Link with phone number instead"); the phone's
  Settings › Apps › WhatsApp does the same and shows the code large. Chats, contacts and messages
  are stored on that PC only, so reads don't wait on the network; unlinking deletes them. Tools:
  status, list_chats (unread counts, a query), history (oldest first, pages back, asks the phone
  for older), search, download_attachment (a photo comes back inline), send (a reply to a message,
  files), mark_read, wait_for_message (chat, sender, words, timeout) and find_contact. Sends are
  paced (3 s apart, 6 a minute, 40 an hour, 200 a day), a number you never wrote to needs the
  user's explicit ask and at most 5 new chats a day, and the same text to several chats is refused
  as bulk. The engine (Baileys, GPL) lives in `whatsapp/` and is downloaded and checked by hash on
  first link, not shipped inside Harbor. A linked PC keeps its link running with Harbor; a link
  that ends (unlinked from the phone) is a notification.

## [0.154.0] - 2026-11-07

### Added
- Merged worktrees clean themselves up (desktop and phone), like T3 Code's "Delete merged
  worktrees": once a chat's PR is merged on GitHub (squash and rebase merges included: the PR's
  state decides, not git) and nothing works in its worktree, Harbor removes the worktree and its
  local branch, on the PC that holds the folder. It only does when nothing would be lost: no
  uncommitted changes and no commit the PR's head didn't have; otherwise the chat says once why it
  stayed. The chat stays and works in the project's checkout from then on, with a notice
  "Worktree removed: <branch> was merged (PR #N)". Settings › General › Worktrees (and the phone's
  Settings › Worktrees): Delete merged worktrees (on), Also delete their branches (on), Also
  delete their branches on GitHub (off; only when the remote branch is still at the PR's head).
  The project menu's new "Clean up merged worktrees" does it for every chat of a project at once
  and says how many went and why any stayed.

## [0.153.0] - 2026-11-06

### Added
- OpenCode (and Codex) can be a chat's main model, on desktop and phone: a new chat runs on the
  OpenCode model picked (it was switched to Claude Opus), and an existing chat's picker offers every
  provider under Account. A started chat that changes provider continues in a fresh session that
  gets the conversation so far; later turns continue that provider's session (`--session` for
  OpenCode). An OpenCode-led chat works as a plain agent: no subagents or team tools. `open_chat`
  and Fix/Merge threads run on OpenCode or Codex too when that's the account asked for. Only Claude
  runs on another device, so a lead that started there stays on Claude.

## [0.152.0] - 2026-11-06

### Added
- OpenCode is a provider again (desktop and phone): Settings › Providers lists it when `opencode`
  is installed (also from `~/.opencode/bin`, where its installer puts it), and the model picker
  offers "Default" plus every model `opencode models` lists, those your OpenCode config names up
  front (e.g. `nvidia/z-ai/glm-5.3-flash`); the list is fetched in the background and kept for the
  next start. Turns run `opencode run --format json` with the chosen model, continue by OpenCode's
  session id and run with full access (its only level); OpenCode can't be steered, so messages
  sent mid-turn queue.

## [0.151.0] - 2026-11-06

### Changed
- Light or dark is one round button beside your photo at the bottom of the sidebar (desktop) and
  of the drawer (phone): a sun in dark, a moon in light; a click or tap flips it at once. Your
  photo alone opens Settings. On the desktop, the bottom bar starts with your photo (your initial
  without one, the gear when signed out) and Refresh moved up beside Search.
- Settings has no Appearance page anymore, and Follow Omarchy is gone: a PC that followed Omarchy
  keeps what it showed. Density is gone too: rows are always the comfortable ones.
- PCs say where they come from: a machine added over SSH says "SSH", a PC someone else added says
  "<first name>'s Workspace", yours "Your Workspace". A PC tells its peers and phones the machines
  it added over SSH, listed under it; the phone's PCs also list your other workspaces' PCs.

## [0.150.1] - 2026-11-06

### Changed
- Releases that rebuild the phone app build its unsigned APK on a GitHub runner, beside the
  desktop bundle builds, then add the cached browser engine and sign it in packaging as before.

## [0.150.0] - 2026-11-06

### Changed
- The phone draws a chat's cards as the PC decides them: icons, colors, tool-run rows ("5 tool
  calls"), which notices open, Discord captcha lines, sender rows and dividers come with each card
  from the PC (the same code the desktop draws with), instead of being worked out again in the app.

### Fixed
- On the phone, a "wake" notice has the desktop's alarm icon (not a clock), a "lock" notice its lock,
  captcha outcome lines the desktop's icons, dividers their icon, and a sub-agent's report opens as
  formatted markdown instead of raw text; a notice whose detail is a web address no longer opens to it.

## [0.149.2] - 2026-11-06

### Fixed
- A release reaches running PCs within seconds also when GitHub still names the previous one at
  the moment it is published: the account worker's quick rereads were overwritten by its 10-minute
  recheck (0.149.1 waited for a second ping).

## [0.149.1] - 2026-11-06

### Changed
- Releases that only change the app bundle build on GitHub's runners instead of a boat sandbox and
  are published straight from packaging: such a release goes out in about two minutes instead of
  three to four.

### Fixed
- Release runs no longer fail when a fresh build sandbox unpacks the source or Harbor's Slint addon
  slower than boat's 30-second command limit; copies and downloads to and from boat are retried, and
  a command boat never started (or lost) runs once more.
- The install tests no longer fail now and then at "--uninstall": what Harbor left running after
  the start test is stopped first.
- PCs hear of a release even when GitHub still names the previous one at the moment the release
  workflow tells the account worker: the worker keeps looking for a few minutes.

## [0.149.0] - 2026-11-05

### Added
- A "Waiting" status, amber, for a chat whose turn is done but that something will wake again: a
  process its agent started (start_process) that reports when it exits (one serving a URL doesn't
  count), its sub-agents still running or with work queued, a wake-up it asked for, or a key it
  asked you for. The desktop's sidebar rows and project rows show an amber dot and "Waiting", the
  chat's status line says what for ("Waiting · 2 processes · wake 14:30"), and the phone's drawer
  and chat show the same. It ends when nothing is left or a turn starts. Agents' list_chats and
  list_agents say it too.

### Changed
- "Working" is now the chat's own turn: a lead whose own turn is done while its sub-agents run
  shows Waiting for them.

### Fixed
- Processes agents started before Harbor restarted are picked up again: their exit wakes the agent
  that started it, as before the restart.

## [0.148.0] - 2026-11-05

### Added
- Profile photos: people show their photo instead of initials, by default their Google account's.
  On the phone, Settings › Account and Members show them round, and the drawer's round button is
  your own; tap your Account row (or your own Members row) for "Your photo": choose one from the
  gallery (cropped square) or remove it for your initials, for everyone in your workspaces. The
  desktop's Settings › Workspace shows each member's photo in place of the person icon. Photos are
  fetched once over HTTPS and kept by address (a new photo is a new address).

### Removed
- The phone drawer's Browser row (a link in a chat still opens the browser) and its PCs row with
  the PCs sheet (Settings lists the workspace's PCs, and PCs update themselves). Issues stays.

## [0.147.0] - 2026-11-04

### Changed
- Phone Settings is shorter and in titled sections: the workspace (account, members with an Owner
  tag, invites, its PCs and who added each), Apps, Appearance (was General), Voice (the dictionary),
  Notifications, App and Sign out. The PC address, encryption, "Harbor on the PC", the built-in
  browser switch and the footnotes are gone, and so is the drawer's "older Harbor" warning.
- The phone's settings that became fixed values: updates always install by themselves, and one
  "Harbor for Android" row shows the version, asks Android for the install permission when needed
  (then installs) and explains Play Protect; notifications always arrive within seconds, also while
  you're at the PC; a running agent is always steered (holding send still queues); dictation is
  always the PC's (language detected, voice commands on).
- Phone dictation no longer has an on-phone model: every phrase goes to a PC's transcription, a
  model downloaded before is deleted, and with no PC answering it says so.
- "Clean up dictation" is one setting for the whole workspace: changed on any PC (Settings › Voice ›
  For the whole workspace), every PC and phone follows within seconds; the latest change wins.

## [0.146.2] - 2026-11-04

### Fixed
- An image or video in an agent's reply (`![caption](/path/shot.png)`) shows on every PC and phone,
  not only as a link: the chat's PC keeps a copy in the chat's uploads (by its contents) as the reply
  is written, and the reply names that copy, so it also still shows after a temp file is deleted.
  An image that couldn't show yet (its file not there, the chat's PC off) is tried again a little
  later while it's on the screen, instead of staying a link until the chat is reopened (#116).

## [0.146.1] - 2026-11-04

### Changed
- The composer no longer says which PC a chat runs on: the "Runs on <PC>" line over an open chat's
  composer is gone with its space, and so is "Starts on <PC>, where <project>'s folder is" over a
  new chat (desktop and phone). The device chip already names the PC; the lines that ask you to
  pick one (the folder isn't on this PC, or its PC is off) stay.

## [0.146.0] - 2026-11-04

### Added
- On the phone, sending with an empty composer is Resume, as on the desktop: the send button shows ▶
  in an idle chat with messages, and it or Enter (the keyboard's or a hardware one) asks the agent
  to go on from where it left off ("Resume queue" starts the messages a Stop held instead). The
  chat's home PC decides and writes the message, so it works for chats running on another PC too.

## [0.145.0] - 2026-11-04

### Added
- On the phone, a double tap on the left or right half of a video goes back or on 5 seconds, playing
  or paused, inline and full screen. Double taps in a row add up, and a small "−5 s" / "+5 s" mark
  shows on the tapped side. Single tap, the seek bar and swiping through the gallery work as before.
  On the desktop, ← and → still seek 5 seconds.

## [0.144.0] - 2026-11-04

### Added
- The lead agent can steer a running agent or chat, not only queue for it: message_agent and
  message_chat take a mode, "steer" or "queue". The lead's queued messages now wait in the same
  queue as yours and count in its "N queued" badge, and the new unqueue_message tool lets the lead
  take back the ones it queued.

### Changed
- Tooltips follow the theme: in dark mode a dark surface like the popovers', in light mode the same
  look as the popovers. Richer tips show a title, a muted subtitle and label/value rows, and no
  longer end with "click to…" hints.
- The Resume and Stop buttons have filled icons: a solid play triangle and a solid square.

## [0.143.0] - 2026-11-04

### Added
- Settings › Voice › Transcribe on can pick an SSH device from Settings › Devices (a machine added by
  hand, without Harbor: a Mac, a Linux box), as well as a PC of your mesh. Dictation on this
  PC, and from phones through it, is sent to the device over SSH and transcribed there by Parakeet
  TDT 0.6B v3: on an Apple Silicon Mac at full precision on its GPU (MLX; about 0.3-0.6 s for 10 s
  of speech on a busy Apple Silicon laptop, against 1-1.5 s for the int8 model on its CPU), elsewhere the
  int8 model on the CPU (sherpa-onnx). Words stay in the language they were spoken in, mixed
  Portuguese and English included.
- Picking the device sets it up the first time, over SSH, with nothing outside `~/.harbor-voice`
  there: uv, its own Python, the speech packages and the model (about 3 GB; no sudo, no Homebrew;
  `rm -rf ~/.harbor-voice` removes it). Its steps show under the picker. A worker there keeps the
  model 5 minutes after the last dictation and loads it as soon as the recording starts.
- Other PCs of your mesh can use your SSH devices too: Transcribe on lists theirs as
  "Name (SSH device, through PC)", and the recording goes through that PC.
- When the device is asleep, closed or off the network, Automatic takes over and a message says so
  once (as for a PC); an unreachable device isn't waited for again for 30 s.

## [0.142.0] - 2026-11-04

### Added
- Settings › Voice › Transcribe on: Automatic (the PC of your mesh with the most free memory, as
  before) or one PC of your mesh. Dictation on this PC, and from phones through it, goes straight to
  that PC; when it can't be reached or fails, Automatic takes over and a message says so once. A PC
  transcribing for another never forwards the recording, whatever it chose itself. Per PC, not synced.
- One log line per dictation: who dictated, seconds of audio, the PC that transcribed it, how long
  it took, whether the speech model was loaded, loading or loaded for it, what the cleanup did, and
  the error shown, if any. The PC that transcribes for a peer logs its side too.

### Changed
- The speech model stays loaded 5 minutes after its last use again (at least 2), and starts loading
  when the recording starts, on the PC that will transcribe it: a PC chosen under Transcribe on is
  asked to load it then, and this PC no longer loads its own copy for nothing.
- Dictation cleanup is off by default, with its switch back on the Voice page (Clean up dictation,
  per PC), and never runs on fewer than 8 words: short mixed-language sentences were translated, and
  each cleanup added seconds.
- The microphone test says when the sound clips or is very low, with what to do about it, instead
  of "Microphone is working".

## [0.141.4] - 2026-11-04

### Removed
- The stop button on each sub-agent's row in the list over the composer: a row only opens its
  agent, and its name takes the room. Stop all in the list's header stays.

## [0.141.3] - 2026-11-04

### Added
- The image viewer zooms: click the image to zoom in on that spot (twice its fitted size, or 1:1
  when that's bigger) and click again to fit; the mouse wheel zooms around the pointer. Zoomed in,
  drag to pan; the image always keeps the window covered.

### Fixed
- Esc closes the image viewer from anywhere, even with the search field, a terminal or a menu
  focused, and nothing under the viewer takes that Esc too.

## [0.141.2] - 2026-11-03

### Changed
- Memory popover: a PC's chats open only from its "3 chats ▶" count and arrow (hovered or clicked),
  which lights up while its list is open; the rest of the card opens nothing, and moving onto another
  card closes the open list.

## [0.141.1] - 2026-11-03

### Fixed
- Images in a chat that moved between PCs, or in a project whose folder sits under another person's
  home on each PC, show again instead of plain links: a path under another home (`/home/sam/…`)
  is read from the same place under this PC's home. A chat that runs on another PC fetches an
  image this PC hasn't got from that PC and keeps it, on the desktop as the phone already did.

## [0.141.0] - 2026-11-03

### Fixed
- New chats no longer start with every MCP server that goes through Harbor (harbor, machines,
  gmail, discord, playwright…) timing out after 30 s. The bridge's port file now names the process
  serving it, the running Harbor takes it back within seconds when another process left a stale
  port there, and a turn's relay no longer trusts a port whose writer is gone.
- `bun test` no longer touches the user's own Harbor: every run gets its own home, data, state,
  config and runtime folders (a test had written the bridge's port file).

### Added
- When Claude reports MCP servers that didn't connect, the chat says which, on the desktop and the
  phone; the next turn connects them again.

## [0.140.0] - 2026-11-03

### Changed
- The sidebar gauge's Memory popover shows each PC as one card of one height, whether it's low,
  off or still asking: a low PC's RAM label turns red, and its chats (with how much each holds)
  and the swap in use open in a submenu beside the card on hover, in place of rows under it.

### Added
- A Default pill on each PC's card picks the PC whose RAM the sidebar gauge shows (refreshed every
  10 s; this PC's again while that one is off). The gauge's tooltip names the PC.

## [0.139.0] - 2026-11-03

### Changed
- A shared project has one main chat for everyone: the project row on the PCs it was shared or
  moved to opens its owner's main chat (marked shared, its messages run on the owner's PC), and
  another PC's project opens the main chat of the PC its folder is on. A main chat a PC had made
  for it on its own stays as a chat of the project when it has messages, or goes when it's empty.
  Desktop and phone alike.

### Fixed
- A new chat in a project whose folder is on another PC starts on that PC even when a default
  device is set (it used to start on the default device and stop at "folder isn't on this PC");
  a device picked for that project still wins. The phone's new chats do the same.
- A message to a project's main chat that lives on another PC, sent from the project's page or the
  phone, goes to that PC instead of sitting in this PC's copy.

## [0.138.0] - 2026-11-03

### Added
- The sidebar is resizable: drag its right edge, from 200px up to 480px (never more than 40% of
  the window). Each PC keeps its own width; double-click the edge for the default 256px again.

### Changed
- An empty composer's send button is Resume, in place of the Resume button beside the mic: it
  resumes a held queue, or else asks the chat's agent to go on where it left off. Enter does the
  same.

## [0.137.0] - 2026-11-03

### Changed
- Sharing a project with a workspace (or moving it to one) shares the project, not everyone's chats
  in it: each person sees their own chats in a shared project, and another person's chats show
  only where they are themselves (their PC's workspace, or where that chat was moved or shared on
  its own). Your chats on your other PCs still go along with your project.

### Fixed
- A project listed twice, once as another PC's and once as this PC's folder of it, is one row: the
  same Git remote, or for a project without Git the same name in the same place under the home
  folder (where Harbor would put a copy of it), makes it the same project. Rows listed twice
  already join at start (this PC's keeps its folder and takes every chat, and the other PC's
  sharing when it was shared with this PC's workspace); adding a folder of another PC's project
  gives that project its folder here instead of a second row.

## [0.136.1] - 2026-11-03

### Fixed
- The sidebar's workspace filter no longer shows another PC's projects under your own workspace
  (desktop and phone). A project that wasn't moved to a workspace is in the workspace of the PC its
  folder is on, as its chats are: until now it counted as this PC's, so the project row stayed,
  empty, after its chats were filtered out. A project whose PC is in no workspace you know shows
  only under All; one its own PC moved to a workspace shows there; Move to workspace… and Share
  with workspace… name the right owner for it too.

## [0.136.0] - 2026-11-03

### Changed
- Videos are much lighter on the window: frames are now drawn on a thread of their own, at the size
  the picture takes on screen (never above the video's own size, and fewer pixels for 60 fps
  videos; the window scales them up on the GPU), with a cheaper scaler, into two buffers that are
  reused instead of new memory per frame. A frame that can't be shown in time is skipped instead of
  queued. A 1080p 60 fps clip in a 1400x900 window: the window's thread went from 99 % of a core
  (the whole UI waiting on video) to about 39 %, dropped frames from 222 to 0, and the memory it
  took no longer grows while it plays; a small clip from 22 % to 6 %.

### Fixed
- A phone video filmed upright (stored turned a quarter) crashed Harbor when it played: the
  picture is now drawn as the file stores it and turned by the window.

## [0.135.0] - 2026-11-03

### Changed
- Harbor's window takes ~90 MB less memory from the start (on a 1400x900 window: 466 → 371 MB
  resident, glibc heap 204 → 109 MB). Harbor now ships its own build of Slint's native module
  (`slint/`: slint-ui 1.18.1 with one patch to slint-interpreter): a compiled UI keeps only what it
  runs, not the compiler's state that only Slint's live preview and language server read, and that
  freed memory goes back to the system right after the UI compiles. Nothing looks or behaves
  differently; `SLINT_KEEP_COMPILER_STATE=1` brings Slint's own behaviour back. Releases publish the
  patch and the module's complete source (`harbor-slint-source.tar.gz`; Slint is used under its
  Royalty-free License, notices in `licenses/slint/`, badge in the README), and
  `scripts/boat/slint` builds it on boat.dev for x86_64 and aarch64.

## [0.134.0] - 2026-11-03

### Changed
- Other PCs are yours to use only through a workspace you are a member of: a PC shows in Runs on,
  Auto, Move to PC, Settings › Workspace and the phone's PCs, and its chats and projects in the
  sidebar, only when its owner invited you into its workspace and you accepted. Inviting someone
  into your workspace lets them use your PCs, not you theirs (until now sharing went both ways
  as soon as two people shared any workspace). Their PCs can still reach yours: that is how they
  use it.

### Added
- The line under the composer is back on the desktop, as on the phone: where the agent works
  (Current checkout, New worktree for a new chat, or the chat's own worktree; "Worktree gone" in
  red) and its branch, with the branch's pull request. The worktree and branch chips of a chat's
  own worktree go straight to renaming it ("Switch branch…" in the form); elsewhere they open the
  workspace menu (Move to a new worktree) and the branch picker (switch, or a new branch). The
  title bar names a worktree's own branch, not the checkout's.
- An invitation to a workspace pops up in the top-right corner of Harbor's window ("Sam invited you
  to Team") with Accept and Decline; on the phone, as a dialog on any screen.

### Fixed
- Invitations show the moment they're made (they came with the directory, every 2 minutes): the
  account service pushes "something changed" to the account's PCs over a WebSocket that stays open
  (a Durable Object per account, idle at no cost) and to its phones while the app is open (a long
  poll). Accepting, declining, cancelling, removing a member and a PC joining a workspace are
  pushed the same way, so the inviter's PCs take the new member's PCs at once. Without the push
  (an older account service, no network) PCs check every minute.
- An accepted or declined invitation leaves Settings › Workspace at once, and the new workspace is
  in the workspace filter right away (Settings didn't redraw when the answer came, and an older
  answer from the account service could bring the invitation back).

## [0.133.2] - 2026-11-03

### Fixed
- `harbor --update` from a terminal knows which version is installed: it took every copy for a
  development build, so it always reinstalled the latest release and recorded "0.0.0-dev" as the
  version to fall back to, which a later rollback would then have named.

## [0.133.1] - 2026-11-03

### Removed
- Settings › Workspace's "Everyone here shares their PCs" card and "Take this PC out": the people
  and their devices come right under the workspace's name and your role ("Sam's workspace · Owner").
  Signing out stays in the account card.

## [0.133.0] - 2026-11-03

### Added
- Long Claude chats stay light: every message reloads the chat's whole Claude Code session, so once
  the part Claude reloads passes 15 MB, Harbor runs Claude Code's own `/compact` on it before the
  next turn, with the same account and model. That turn and the ones after it start from a summary
  of the earlier conversation instead of all of it (a 52 MB session: about 450 → 215 MB of memory
  and 1.6 → 0.5 s of CPU per message). The chat still shows every message, and a pill says what
  happened: "Compacting the session (52 MB) before this turn", then "Session compacted (52 MB →
  33 KB)". If the compaction fails, the pill says why and the turn goes on as before. Only chats
  that run on this PC compact; Codex chats don't change.
- When Claude Code compacts a conversation itself (`/compact` sent in the chat, or its automatic
  compaction near the context limit), the chat says so too: "Claude Code compacted the conversation
  (666k → 4k tokens)".

## [0.132.1] - 2026-11-03

### Fixed
- Harbor's windows group under the pinned Harbor icon in GNOME's dock (and other docks and
  taskbars) instead of showing as a separate "Unknown" app: they now carry the app id `harbor`,
  the same as harbor.desktop (Wayland app_id, X11 WM_CLASS). A `scripts/preview` window is
  `harbor-preview`, so it stays apart from the real Harbor.

## [0.132.0] - 2026-11-03

### Changed
- Settings › Workspace and Settings › Devices are one page, Workspace: a device is just another
  machine of the workspace. Under People each person has a card with their PCs (online or when last
  seen, their Harbor version; this PC with Rename) and their phones (Sign out for your own, or
  anyone's when you own the workspace). The invite field and pending invitations stay below; PCs you
  share through another workspace come next, and devices added by SSH before (with Remove) last,
  only when there are any. Links and menus that opened Devices open Workspace.
- The phone's "No other PCs" notes say to invite the PC's owner to your workspace instead of pairing.

## [0.131.1] - 2026-11-03

### Fixed
- An image waiting in the composer opens in the image viewer wherever its tile is clicked or
  tapped, its number and the edge around the picture included, and the viewer browses the
  composer's images; the × on its corner still only removes it. On the phone this also holds for
  images in a draft shared from another device.

## [0.131.0] - 2026-11-03

### Changed
- PCs trust each other through workspace membership: two PCs share chats (copies, Runs on, Auto,
  moving chats and projects, relaying) when their owners (the accounts that signed them in) are
  both members of at least one workspace. Inviting someone to your workspace is enough: their PCs
  and yours become peers without moving any PC, and removing them or leaving ends it. The account
  service works out each PC's peers (`GET /v1/directory` `peers`); it's the only thing a PC trusts.
- Settings › Devices lists this PC (Rename), those peer PCs with their owner, the shared workspace,
  whether they're online and their Harbor version, and the signed-in phones. Other PCs have no
  Remove: the membership decides.
- `harbor mesh` (status) lists the peers; `harbor nc` relays through them.

### Fixed
- Harbor's database keeps SQLite's temporary data in memory: with /tmp full, writes such as the
  workspace directory's refresh could fail, leaving a PC on a directory many minutes old.

### Removed
- Pairing PCs with a code: Settings › Devices' Pair a device (Show a code, Enter a code), the mesh's
  pairing call and `harbor mesh pair`, `join`, `allow`, `remove`, `on` and `off`. PCs paired that
  way are no longer trusted for it (the stored list is deleted at start); each PC keeps its key.
- The phone's "Pair another PC" row (it pointed at a page that no longer exists).

## [0.130.1] - 2026-11-03

### Fixed
- A chat that Auto moved to another PC says "Auto → <PC>" on that PC too (the composer's Runs on
  chip, the phone's Device row and chat header), not only on the PC it came from. The move tells
  the receiving PC that Auto chose it; a move picked by hand, or one from a PC that doesn't say,
  isn't Auto's. A chat Auto placed on the PC you're looking at is named by that PC's own name
  ("Auto → desk") on the desktop as on the phone, instead of "Auto → This PC".

## [0.130.0] - 2026-11-03

### Changed
- Codex turns get the same lazy MCP servers as Claude's: Harbor's bridge answers their handshakes and
  starts a server only when a tool is called, and stops it when unused. A waiting Codex turn with
  Harbor's usual set no longer runs any MCP server process (was 7, about 400 MB). The bridge's token
  reaches Codex in its environment, never on its command line. Your own servers in Codex's
  `config.toml` keep their settings (tool approvals, timeouts), and a server whose name has a space
  (`Roblox Studio`) now works in Codex turns at all; a few names differ in case for Codex (`omarchy`).
- The Roblox Studio MCP server is one process for every turn and chat that has the same entry,
  instead of one per turn that calls it: it already passed every call on to one main instance.
  Other servers (browsers among them) stay a turn's own.
- A tool call made while Harbor restarts (an update) waits for it to come back instead of failing,
  also when the new Harbor serves on another port: each turn reaches Harbor's MCP bridge through
  its own runner, which waits and finds the new port.

### Fixed
- A Codex turn no longer fails to start when an MCP server whose name has a space is turned off in
  Harbor.

## [0.129.0] - 2026-11-03

### Added
- Rename this PC: Settings › Devices › Rename, on this PC's row. Your other PCs, your phones, the
  workspace's directory and every place that names the PC (Runs on, chat headers, senders) show the
  new name as soon as they next hear from it; its id and keys stay the same, so pairing, chats'
  home PC and phone sign-ins carry on. An empty name goes back to the default.
- The speech model downloads by itself in the background when this PC doesn't have it (half a
  minute after Harbor starts, again after a failure with a growing pause up to an hour, never with
  less than 2 GB free), so the first dictation needn't wait. A failure of that background download
  isn't shown; a dictation waiting for it still hears why. While it comes, Settings › Voice says so
  under Microphone, and the composer says "Getting the speech model…" as before.

### Changed
- Settings › Voice has no Parakeet model row anymore: just the Microphone (pick and Test) and the
  dictionary.
- Settings › Workspace comes right below General.

### Fixed
- A Settings form that opens filled in (Devices' rename, a pairing address kept after a failed try)
  can be saved without editing it first.

## [0.128.0] - 2026-11-03

### Changed
- Settings is shorter: no description line under any page's title, and the choices that everyone
  left on one value are now simply that value.
  - General: Enter while the agent works always steers (Ctrl+Enter still queues one message),
    threads always continue after a restart, prompt suggestions are always on, and Harbor always
    keeps running when its window is closed (the tray icon still has Quit). Fast mode stays in the
    composer's reasoning menu; Order projects stays in the sidebar's menu. Start Harbor when I log
    in is on by default for installed copies that never turned it on. Updates are always automatic:
    the Updates card is just "Harbor <version>".
  - Voice: Parakeet only (no engine switch or Whisper models), the spoken language is always
    detected, and dictation is always cleaned up, understands voice commands and keeps the model
    loaded for 1 minute.
  - Notifications: only what to notify about (no Only when away, no quiet hours, no phone test).
  - Account is now Workspace, without Move this PC.
  - Webhooks and Phones are no longer pages: webhooks are always reachable, phone access is always
    on, and the router's port is opened automatically as before, without the "From outside your
    network" details. Signed-in phones (with Sign out) are listed under Devices.
  - Devices has only your devices (this PC, your other PCs, your phones) and pairing. Sharing chats
    with your other PCs is always on; the SSH defaults and Add a device by SSH are gone (devices
    added that way keep working).

### Added
- Settings › Voice › Microphone: pick the input dictation records from (PipeWire/PulseAudio
  sources), and Test it: 3 seconds with a level meter and whether any sound came through.

### Fixed
- Settings forms keep their fields on one line at full width: Secrets' Name, Value, What it's for
  and Save, and Devices' Enter a code (address, code and Pair inside the card's padding).
- Settings › Integrations: a tall app card (Gmail with its accounts) no longer leaves a hole beside
  it and pushes the next one down; the apps flow in two independent columns.

## [0.127.0] - 2026-11-03

### Changed
- Each turn on this PC runs in a systemd user scope of its own, under `harbor-turns.slice` (at most
  half the RAM for all turns together, throttled from 35%, lower CPU weight than the desktop). What
  a turn leaves running (background commands, servers its agent detached) now ends with the turn,
  and Stop ends all of it. Under memory pressure systemd-oomd stops one turn instead of all of
  Harbor, and Harbor itself asks oomd to be picked last. Turns still outlive a Harbor update. Where
  there is no systemd --user (macOS, containers), turns start as before; `HARBOR_TURN_SCOPE=0`
  turns the scopes off.
- Harbor and each turn's runner follow a turn's output and input through file-change events
  (inotify) instead of looking every 60 ms, with a look every half second all the same: about
  30 fewer wake-ups a second per running turn.
- Agents are told never to wait inside a turn for more than about 30 s (no sleep loops, no polling or
  `gh run watch`): a waiting turn holds hundreds of MB, so they start the slow thing with
  start_process and end the turn.

### Fixed
- The agents package's tests no longer leave fake Claude processes behind spinning at full CPU when
  a test run ends or dies: the fakes exit with their input or their parent, and each suite kills
  what it started.

## [0.126.0] - 2026-11-03

### Added
- Settings › Providers has an on/off switch on each account. An account that's off on this PC is
  never used: it isn't in the model menu, the phone's account list, list_models, spawn_agent or
  open_chat (asked for by name, they refuse it), automatic switching on usage limits, or the
  background jobs (dictation clean-up, worktree names, owner detection). Turning off the default
  account makes the next account that's on the default and says which; the last usable account can't
  be turned off. A chat already on an account that's off moves to the default account (or another
  of the same provider) with a notice when you next send; with none to move to, the notice says to
  turn it back on or pick another account. The switch is this PC's alone and never syncs.
- Remove on extra Claude accounts (~/.claudeN), after a confirm: Harbor stops listing the account and
  moves its folder to Harbor's data folder under removed-accounts, so Refresh doesn't bring it back
  and nothing is deleted. The main ~/.claude account has no Remove.

## [0.125.0] - 2026-11-03

### Changed
- MCP servers cost nothing until an agent calls one of their tools. Claude Code connects every
  server at the start of every turn; Harbor now answers that handshake (`initialize`, the tool,
  prompt and resource lists, the listen of the 2026 protocol) from what each server said last
  time, starts the server only for a tool call, and stops it after a minute without calls (five
  for a browser). A turn on this PC gets its stdio servers (Gmail, Discord, the team server and
  your own from `~/.claude.json`) through Harbor's MCP bridge, as turns on other devices already
  did. A waiting turn with the usual set went from about a dozen helper processes (~400 MB) to
  none, and its first request to the model no longer waits for them to start. Gmail and Discord
  run once for every chat that calls them (Discord once per chat), at most two servers start at
  once and eight stay up, the idle ones go first. The team server runs inside Harbor, with no
  process. Entries Claude Code expands itself (`${VAR}`) and Codex turns are as before; a chat
  commanded from another PC passes only the team server through the bridge.

## [0.124.5] - 2026-11-03

### Changed
- Harbor uses less memory the longer it runs. Its native libraries (the window, images, the
  database) no longer get a new memory pool for each thread that works for them, and the memory
  they free goes back to the system every 5 minutes and after a chat's earlier pages are let go,
  instead of staying with Harbor until it restarts. Linux with glibc only.
- The window's native library is written to `~/.cache/harbor/native-*` beside sharp and the speech
  engine, not to `/tmp`: where `/tmp` is in RAM, its 36 MB took RAM and could only go to swap.
- With swap, an idle Discord client that has been frozen for 30 minutes now quits instead of
  holding its memory until Harbor's next update. It still freezes after 2 idle minutes, and the
  day's login limit still applies: the next Discord call starts it again.
- The database writes with `synchronous=NORMAL` (it already uses WAL): fewer disk syncs. A power cut
  can lose the last moments of changes, never the database.

## [0.124.4] - 2026-11-03

### Changed
- An image pasted or attached in the desktop composer shows as a small picture above the text
  instead of its file name, like on the phone: cropped square and rounded, with its number (the
  `[Image #N]` of the text) and a remove button on its corner. Click it to open the image viewer.
  Other files keep their chips. Images and files wrap within the composer, long file names elide,
  and larger sets scroll above the text instead of overflowing the window.

## [0.124.3] - 2026-11-03

### Changed
- The memory pill shows on every chat now, reading "0 MB" while nothing of the chat runs (a dash
  while a chat's home PC hasn't answered yet). Its breakdown always lists the chat's own agent: a
  lead that ended its turn while its subagents work shows as "Lead · Claude" with "Idle" instead of
  being left out.

### Fixed
- The PCs popover of the sidebar's memory gauge left out the devices of Runs on that aren't Harbor
  PCs, like a Mac reached over SSH. They're listed now, marked SSH, with their RAM (read over SSH
  while the popover is open, Linux and macOS) and how many of this PC's chats run there.

## [0.124.2] - 2026-11-03

### Fixed
- An invitation to an address no Harbor account uses now says so under People (Settings and the
  phone), and when it differs by a typo from the address of someone already in one of your
  workspaces, it asks "did you mean …?". Such an invitation waits forever otherwise: it only
  reaches the Google account with exactly that address.

## [0.124.1] - 2026-11-03

### Added
- Auto in a chat that has already started, on the desktop and the phone: the Runs on menu (the
  phone's Device picker) has Auto there too. Picking it moves the chat right then to the PC with the
  most free memory, the same move as picking that PC by hand; when the chat is on that PC already,
  nothing moves. The composer then says "Auto → <PC>" while the chat stays there. When that PC
  can't take the chat now (it's working, say), the row is greyed with the reason.

### Fixed
- Auto names each PC as the Runs on menu does: a PC added in Settings › Devices goes by the name you
  gave it there, not the name its Harbor gives itself. That's in Auto's "Most free memory now" line,
  the composer's "Auto → <PC>", the phone's Device row and chat header, and the "Moving to <PC>"
  notices of a started chat's move.

## [0.124.0] - 2026-11-03

### Added
- Memory, per chat and per PC. A chat's top bar shows how much memory it uses (its agent, its
  subagents and the processes started for it, like dev servers) in a pill after the branch, hidden
  while nothing of it runs. Click the pill to see each of them and the RAM of the PC it runs on. A
  chat whose home is another PC gets its numbers from that PC.
- The sidebar's footer shows this PC's memory as a small gauge (amber from 80%, red from 90% or
  when it's swapping). Click it to see every PC of the mesh, this PC first: its RAM, how many chats
  are running and the chats using the most, with "Low on memory" in red when one runs short. A PC on
  an older Harbor shows without numbers. Numbers are read only while they're on screen.

### Removed
- Settings › Usage is gone, on the desktop and the phone. What Harbor does at a limit, the caps and
  the warnings keep the values they had; the sidebar's gauge still shows each Claude account's
  usage, and a phone app before this version still opens its Usage page.
- The sidebar's footer no longer says "N running" (the rows themselves show what's working).

## [0.123.0] - 2026-11-03

### Added
- "Auto" in the composer's Runs on menu, on the desktop and the phone: a new chat starts on the
  PC with the most free memory (MemAvailable, averaged over the last 10 minutes), among the PCs
  that can take it now. It's decided once, at the first message, and the chat stays there. The
  composer shows where it goes ("Auto → laptop") before and after. Each PC tells its peers its
  free memory with the chat lists they already poll.

### Changed
- The Runs on menu (desktop) and the Device picker (phone) show each place by its name only; a
  row that can't be picked still says why.

## [0.122.0] - 2026-11-03

### Added
- Share with workspace…: every chat's and every project's menu, on the desktop (right-click a row)
  and on the phone (a chat's menu, a project's sheet), has it right after Move to workspace…. It's
  a checklist of the signed-in account's workspaces: the one the chat or project is in shows as its
  owner and isn't a toggle, and ticking another makes it show there too, while it stays owned by its
  own workspace. The sidebar's workspace filter then shows it under its owner and under every
  workspace it's shared with. A project's chats get the project's shares (ticked and locked in a
  chat's list) plus their own; sub-agents go with their lead. Moving it to a workspace it was shared
  with drops that share. Shared rows carry a small link mark, on the desktop and the phone alike;
  its tooltip (a tap on the phone) and the menu say "Owned by X · shared with Y", and when the
  filter shows a row only because it's shared the mark turns blue and says so. Kept, carried and
  forwarded like the move: with the chat on its home PC (a project's on the PC whose folder it is),
  a change made on another PC goes there first, and the mesh carries it to every copy and phone at
  once. It's placement only: who and which PCs can reach a chat, and what the mesh copies, don't
  change. Greyed with why when nobody is signed in or the account has a single workspace.

## [0.121.7] - 2026-11-03

### Changed
- Discord: leaving servers is no longer paced either. Harbor used to space leaves 5 minutes apart
  and cap them at 3 an hour and 6 a day; now agents leave when asked (still only with `apply: true`,
  after a dry run). New DMs, uploads and bursts of messages are still paced as before.

## [0.121.6] - 2026-11-03

### Fixed
- The shared draft between the desktop and the phone works again. A message sent from any
  device empties the chat's composer on every device, open now or opened later (the phone no
  longer keeps the text of a message sent on the PC, and the PC empties when the phone sends).
- What the phone writes, mentions and attaches shows up in the desktop's composer, and the
  images attached on the desktop show up on the phone. Drafts are kept across a hub restart.

## [0.121.5] - 2026-11-03

### Changed
- The ▸ rows of a chat's or project's menu ("Move to project…", "Move to PC…", "Move to
  workspace…") open their options as soon as you hover them, in a submenu beside the menu
  instead of on top of it: to the right of the row, or to the left at the window's edge, and
  kept inside the window at its bottom. Moving the pointer across to it keeps it open; hovering
  another row closes it.

## [0.121.4] - 2026-11-03

### Fixed
- Settling or unsettling a project now reaches your other PCs and phones at once. Before, its
  chats stayed as they were there (settled after an unsettle, or the other way round) until some
  later full sync, minutes later. The same went for a chat settled from the desktop or the
  phone's composer, for "Make main chat", and for new activity bringing a settled project back.
- A project whose folder is on another PC of yours now says which: its sidebar row shows that
  PC's name, and so do its tooltip, its menu, the command palette and, on the phone, the drawer,
  the project sheet and the project pickers. Two projects with one name can be told apart (one of
  this PC's own shows the folder it's in). A new chat in such a project starts on that PC, on the
  desktop and the phone, and the composer says so before you send; when that PC is off or not
  known, the composer says where the project lives instead of the chat failing after the message.

### Changed
- No more "N changed" badge beside the branch name in the chat's top bar, nor "· N changed"
  after the branch on the phone: the branch shows alone. Reading a project's git status no longer
  walks its untracked files.

## [0.121.3] - 2026-11-03

### Fixed
- Desktop: a message with more images than fit across its card (four from the phone, say) drew the
  last thumbnails past the card's right edge. Thumbnails now wrap into rows inside the card, in your
  messages and in replies alike, at any window width.

## [0.121.2] - 2026-11-03

### Fixed
- Discord: an update could lose a captcha that was waiting for you: the join didn't happen, and
  neither the card nor `discord_status` said anything. An update now waits until the captcha ends
  (joined, closed or given up after 10 minutes) before it replaces Discord's background host. And
  if a captcha is lost anyway (a crash, a reboot, a host from an older version), Harbor notices
  within about two minutes: its card in the chat ends as "Captcha expired", and `discord_status`
  says so too, even with Discord not running. That includes cards left waiting from before.

## [0.121.1] - 2026-11-03

### Fixed
- An Ultra account no longer shows a "5-hour 0%" row: an older usage monitor (and older turns)
  still report a 5-hour window for it, which Harbor showed. The Ultra plan has only weekly limits,
  so its 5-hour window is left out everywhere: the usage read-out, Settings › Usage (no 5-hour cap
  either), the phone and `list_models`. Pro and Max keep theirs. Settings › Usage also takes the
  monitor's read over an older turn's, as the read-out does.

## [0.121.0] - 2026-11-03

### Added
- Move to PC… for whole projects, on the desktop (the project row's menu) and the phone (the
  project sheet). Pick another PC of yours; Harbor says first where the project will go there,
  what it copies (everything in the folder, also hidden files like `.env`) and what stays. Then
  its folder goes over: a git project with a remote is cloned there, and the commits, branches
  and files that are only on this PC (uncommitted, untracked and ignored ones) come along; any
  other folder is copied whole as a stream, in pieces, so big folders and slow links work and a
  broken link says how far it got. A PC that already has the project uses its own copy without
  touching its files, and the work from here arrives there as `moved-from-<PC>/…` branches. Then
  every chat of the project moves with the chat handoff (leads, sub-agents, settled ones, the
  main chat, chats with their own worktree), and its name, icon, settled state and snooze follow.
  The folder stays on this PC's disk (Harbor says where, to delete it yourself); the project's
  chats here become copies of the other PC's and don't run in the old folder any more. Progress
  shows in the toast on the desktop and in a sheet on the phone, and the result says what moved
  and what didn't (a chat that couldn't move stays here with why; moving again takes the rest).
  A phone or another PC asking about a project that is a third PC's gets that PC's answer.

### Fixed
- Move to PC… of a chat said "its's Claude session isn't on this PC" when the session was missing.

## [0.120.3] - 2026-11-03

### Fixed
- Discord: a captcha's challenge (the bigger frame hCaptcha opens after its checkbox, such as "drag
  the letter to the place where it fits") was squeezed into the checkbox's shape, which combed its
  picture and cut it off. The card now follows the challenge itself and takes each frame's shape,
  fitted to the card and kept on screen whole (scaled down, never stretched), on the desktop and
  the phone. Captchas are drawn at twice the page's resolution, so their small text stays sharp.
- Discord: dragging in a captcha works: a press, moves and a release go through as a drag, and a
  drag past the captcha's edge stays on its edge instead of being dropped.

## [0.120.2] - 2026-11-03

### Changed
- Claude usage follows Anthropic's 2026-10-30 plans: "Max 20x" shows as Ultra and "Max 5x" as Max
  (also from an older usage monitor that still says the old names, and from the login's own tier
  when there is no monitor). An account the provider reports no 5-hour window for (a verified Ultra
  account) shows no 5-hour row anywhere: the usage read-out, Settings › Usage, the phone and
  `list_models`, whose line now reads "Ultra · Weekly 100% used (resets in 3d 1h)" instead of
  "5-hour 0% used, Weekly 100% used". A 5-hour window an older turn reported is dropped once a newer
  monitor read no longer lists it. Per-model weekly limits from the monitor ("Fable Weekly") show
  as "Weekly · Fable". Picking the account with the most quota left counts a missing or already
  reset window as unused.

### Fixed
- A Claude profile folder that was removed (~/.claude4) stayed in the window's Claude usage, the
  agent menus and the model picker until Harbor restarted: the window kept the list of accounts it
  read at start. It now shares the hub's list, read again every minute and whenever usage or
  `list_models` is asked for.
- A Claude profile that was never signed in no longer shows as a usage entry, in the mesh's
  "agent accounts" line or among the accounts other PCs may run a chat as; Settings › Providers and
  the composer's account rail still offer its sign-in.

## [0.120.1] - 2026-11-03

### Fixed
- A steer sent while a Claude turn was still starting (or just as it ended) reached the agent twice
  and showed twice in the chat. Claude Code takes a steer written before its request is out into the
  turn and then runs it again as the next one, so Harbor now holds such a steer (it shows as
  "Steering…") until the request is out, or sends it as the next message if the turn ends first. A
  steer Claude echoes twice shows once, and one whose first echo Harbor took for the turn's own
  prompt is no longer sent a second time.

## [0.120.0] - 2026-11-03

### Added
- Move to workspace…: every chat's and every project's menu, on the desktop (right-click a row) and
  on the phone (a chat's menu, a project's sheet), lists the signed-in account's workspaces with the
  one it's in ticked, and a way back to its PC's own workspace once it was moved. The sidebar's
  workspace filter then shows it under the workspace it was moved to: with the old one picked it
  disappears at once, and a notice ("Moved to Team workspace") says so even under All. A project's
  chats follow it unless a chat was moved on its own; sub-agents stay with their lead. The choice is
  the same on every PC and phone: it's kept with the chat on its home PC (a project's on the PC
  whose folder it is), a move made on another PC goes there first, and the mesh carries it to every
  copy. It's placement only: who and which PCs can reach a chat, and what the mesh copies, don't
  change. Greyed with why when nobody is signed in or the account has a single workspace.

## [0.119.7] - 2026-11-03

### Changed
- Discord: joining servers is no longer paced. Harbor used to space joins 5 minutes apart and cap
  them at 3 an hour and 6 a day; now agents join when asked. New DMs, uploads, leaving servers and
  bursts of messages are still paced as before.

### Fixed
- Discord: an update didn't reach the Discord app until it was restarted by hand: its background
  host kept running the old code and page while only the app bundle changed (most updates). The
  host now makes way for a new Harbor as soon as no tool call, captcha or repair is in flight, and
  Harbor retires a host from an older version the same way when it starts. The next tool call runs
  the new one. That's why `discord_guilds` still showed `orphans` after 0.119.3.
- Discord: a captcha lost to a restart is marked expired when Harbor starts, even before Discord is
  used again (0.119.3 only did it when Discord next started).
- Discord: `discord_join`'s description still told agents a captcha was for the user's own Discord
  app; it now says Harbor shows it in the chat.

## [0.119.6] - 2026-11-03

### Fixed
- The sidebar's workspace menu can pick an account's only workspace, or tick every one, on the
  desktop and the phone: checking them all no longer turned straight back into All (All also shows
  the PCs that are in no workspace).

## [0.119.5] - 2026-11-02

### Fixed
- Chat links (`harbor://chat/…`) in agents' replies work again, on the desktop and the phone: a bare
  link or a markdown link to one reads as the chat's title (or the link's text) and a click or tap
  opens that chat, a sub-agent's or a copy of another PC's chat too. A chat this PC doesn't have
  says "Chat not found" (or that its PC is offline). Links name the chat's own PC again.

## [0.119.4] - 2026-11-02

### Changed
- Discord: a captcha card in a chat is fluid. The card asks for the next frame and gets it as soon as
  the captcha changes, instead of asking on a timer: on one PC a click shows in about 60 ms instead
  of about 300 ms, and a moving captcha plays at up to 20 frames a second on the desktop and 15 on
  the phone, instead of about 2. Nothing is sent while nothing changes. Frames come straight from
  what the hidden page draws, sized to the card, and the phone decodes them off its screen thread.

### Fixed
- Discord: "Don't join" could do nothing after a click inside the captcha (the keyboard stayed in
  the captcha's frame, where Discord's dialog never heard it).

## [0.119.3] - 2026-11-02

### Fixed
- Discord: a join whose captcha was solved was reported "closed without joining" when the server
  took a moment to arrive after the captcha closed. Harbor now waits for the join's own answer (up to
  30 s) and checks membership before saying how it went.
- Discord: a server joined since Discord last saved the sidebar's layout was listed apart, as an
  orphan; `discord_guilds` now lists it first (`newlyJoined`), as Discord's own sidebar shows it, so
  a layout passed back to `discord_organize` keeps it.
- Discord: a captcha lost to a restart now ends as "Captcha expired" in its chat, instead of a card
  that stays live.
- Discord: a chat whose agent started its Discord connection before Harbor passed chats along (an
  older version, still running after an update) gets the captcha card too, when it's the one chat
  waiting on a join; otherwise the full-window view shows it, as before.

## [0.119.2] - 2026-11-02

### Changed
- Chats: who wrote a message is shown relative to the device you look on. A phone, or another PC
  showing a chat that runs elsewhere, now labels the messages typed on the chat's PC with a PC icon
  and that PC owner's name. Only the messages written on the device you're using have no label.
  Runs of quick messages group the same way.

### Fixed
- Phone: an image in an agent's reply shows for a chat that runs on another PC. The phone's PC
  now fetches it, and videos, from the PC where the file is.
- Phone: an image or file you attach to a chat that runs on another PC no longer disappears from
  the composer before you send it, so it reaches the agent.

## [0.119.1] - 2026-11-02

### Fixed
- A message sent from the phone app now tells the agent it came from your phone, also when the
  phone reaches the PC directly or through another PC. It said "another PC" with the phone's name.

## [0.119.0] - 2026-11-02

### Added
- Discord: a captcha now shows inside the chat whose agent hit it, as a card you can solve from
  anywhere that chat is open: the desktop of the PC running Discord, the desktop of any other PC of
  your mesh, or the phone. The card shows just the captcha, live while you look at it; one device
  solves at a time (the others see who), and Don't join closes it. When it's done the card becomes
  a one-line outcome (joined, closed, or given up), with nothing of the captcha kept. The
  notification opens that chat. A captcha whose chat isn't known still opens the full-window view.

## [0.118.0] - 2026-11-02

### Added
- A gauge in the sidebar's footer, and "Claude usage" in the phone's + sheet, show each Claude
  account's 5-hour and weekly usage and when they reset. The numbers are read when you open them,
  and not otherwise.

### Fixed
- Usage limits: a turn's report no longer beats the usage monitor's newer numbers.
- A chat or sub-agent that runs on another PC of the mesh shows as working on the desktop again,
  with how long it has been running: in the Agents panel, the agent strip above the composer, the
  sidebar, the "Working…" line and the status bars, as the phone already showed it. It read
  "idle" while it worked.

## [0.117.0] - 2026-11-02

### Added
- Chats: a message written on the phone app or on another PC now says who wrote it and where, in a
  small row over the bubble: a phone or PC icon and the person's name (their Google account on a
  phone, the PC owner's on a PC), instead of "from <device>" inside the bubble. A steer shows its
  Steer mark in the same row. Older messages get the same row from their device's name.
- Chats: messages sent one after another from the same place (within 5 minutes, nothing between
  them) sit close together as one run, WhatsApp-style: only the first shows who wrote it, and the
  joined corners are tighter. Same on the desktop and the phone.

### Fixed
- `harbor app discord` answers a tool list it's still preparing (the first one downloads Discord's
  shell) even when its input has already ended, as with `printf … | harbor app discord`.

## [0.116.2] - 2026-11-02

### Fixed
- Discord: installed copies listed no Discord tools at all. The app fetched its Discord shell at the
  runtime's version (which can be older than the app, and isn't a release tag), got nothing, and
  showed agents an empty list. It now fetches the shell at the commit the app was built from. If the
  shell still can't be fetched, agents get `discord_status`, which says why, and half-finished
  downloads are cleaned up.

## [0.116.1] - 2026-11-02

### Fixed
- The composer's footer no longer pushes the send button out of its frame at some window widths
  and zoom levels: the model, effort, access and device chips shorten their names (the device's
  first), then show just their icons, and the frame's right edge has the same room as its left.
- A chat that runs on another PC no longer says "This PC" on its device chip: it names that PC.

## [0.116.0] - 2026-11-02

### Added
- Discord: when joining a server needs a captcha, Harbor shows it to you to solve, on the desktop
  (over the window, with Hide and Don't join) and on the phone (a notification opens it; taps go
  through). Only the captcha itself takes your clicks or taps, and Harbor never answers it for you.
  You hear how it ended (joined, closed, or given up after 10 minutes), and so does the agent.
  To make it work, the hidden Discord page runs without site isolation, and in exchange it may only
  hold frames from Discord and hCaptcha: anything else a message embeds is blocked. It can be
  turned off with a `no-captcha-view` file in the app's folder; then a captcha is for your own
  Discord app, as before.
- Phone: Discord in Settings › Apps, as on the desktop card: who's signed in, how the client is
  (running, frozen while idle, Discord changed), Sign out, and the sign-in QR code with Cancel while
  someone signs in on the PC.
- Discord: `discord_find_user` finds people by username, display name or nickname among those the
  account already knows. It sends nothing, so it never adds anyone or sends a friend request.
- Notifications: a Discord kind (a captcha, a session Discord ended, tools a repair couldn't fix).

### Fixed
- Discord: `discord_open` and `discord_dm_open` really go to the channel (they only moved a store),
  and say whether its messages are showing. `discord_unread` uses the real read marker and counts
  unread messages Discord hasn't loaded, saying "unknown" where it can't.
- Discord: `discord_mute_guild` read a store that says "not muted" for every server; it now reads the
  server settings, sends nothing when the server is already that way, and reports a change only when
  Discord shows it.
- Discord: `discord_react` failed with "Reaction actions module not found". Discord loads that code
  with a chat, which a send doesn't show, so the self-test never judged it: it now tries again until
  a chat was on the page, react opens the chat first, and a tool that finds something gone runs the
  self-test at once so repair can start.
- Discord: `discord_dm_open` called an old DM new (and paced it) when it was closed in the sidebar.
- Discord: its notices (a session Discord ended, a repair that failed) never reached you, and repair
  never had a Claude account to run on.
- Discord on a PC with swap but no cgroups: an idle client quits after 30 minutes (at most 8 logins a
  day), as without swap, instead of being stopped with signals, which kept all its memory.

## [0.115.1] - 2026-11-02

### Fixed
- The desktop composer erases picked tokens whole again, as the phone does: an `@file`, `#12` or
  `/command` picked from the composer's menu, or a mentioned chat's title, goes in one Backspace or
  Delete (lost in the TypeScript rewrite). Tokens typed by hand still erase one character at a time.

## [0.115.0] - 2026-11-02

### Added
- Alt+Up and Alt+Down open the previous and next chat in the desktop sidebar, one row at a time
  in the order it shows them (project rows open their main chat; Settled only while it's open),
  as a click would, and scroll the sidebar to keep it in view. They stop at either end; from a
  page that isn't a chat, Alt+Down opens the first and Alt+Up the last. They work from the
  composer too without typing anything; Alt+Up still edits the latest queued message when there
  is one and the caret is at the start. Both are in Settings › Keybindings.

## [0.114.3] - 2026-11-02

### Fixed
- Removing an image from the desktop composer (the × on its chip) also takes its "[Image #N]" out
  of the text, and the later images' numbers move down to match what's sent. Erasing the token
  takes its image along, and Backspace or Delete erases an image's token whole, as on the phone.

## [0.114.2] - 2026-11-02

### Fixed
- Zooming the desktop, or moving the window to a screen with another scale, no longer turns a chat's
  images into their links for a moment: the picture stays while a sharper (or smaller) copy is
  made for the new size, and swaps in when it's ready. Zoomed out, inline images also keep their
  size instead of shrinking twice.
## [0.114.1] - 2026-11-02

### Changed
- Zooming the desktop (Ctrl+=, Ctrl+-, Ctrl+0) no longer shows the brief "110%" bubble under
  the header: the zoom itself works as before.

## [0.114.0] - 2026-11-02

### Added
- Settle project, on the desktop and the phone: the project menu (right-click on the desktop, the
  project's sheet on the phone) settles a project with all its chats. It leaves the list for
  Settled, where it shows above the settled chats with Unsettle project (the desktop row's
  Unsettle button, or its menu; a long press on the phone), which brings it back with the chats
  it settled. A new chat or new activity in a settled project brings it back by itself. It's kept
  by the PC that has the project, so the desktop and the phones agree.

## [0.113.0] - 2026-11-02

### Added
- Desktop: browser-style zoom. Ctrl+= or Ctrl++ (keypad + too) zooms the whole window in, Ctrl+-
  out, Ctrl+0 back to 100%, on Chrome's steps (50% to 300%); a small "110%" shows for a moment in
  the corner. Text, icons and images are drawn again at the new size (nothing is stretched) and
  the layout reflows to the window, like a page in a browser. The keys work wherever the focus is
  (the composer, a terminal, a dialog) and type nothing. Each PC keeps its own level across
  restarts; it isn't synced to the account.

## [0.112.2] - 2026-11-02

### Fixed
- Phone: a project in the drawer has the desktop's project options. A long press on it (or its new
  `⋯`) did nothing for a project without chats, and for one with a main chat showed only that
  chat's menu. It now opens the project's sheet, the same list the desktop's project row offers in
  the same order: New chat in this project, Snooze, then Open terminal (greyed: it's the PC
  window's), Pull requests and Issues of that repo, Open remote, Rename and Settle main chat,
  Refresh icon, Choose icon… (an image from the phone), Use website icon and Remove from Harbor.
  A tap still opens the main chat (or starts it). The desktop's menu and the phone's sheet now come
  from one list.

## [0.112.1] - 2026-11-02

### Fixed
- Phone: a message you send shows in the chat at once. It used to appear only after the PC had
  answered and the chat had been read again, which took about 10 seconds when the way to the PC
  stalled: each address of the PC was tried in turn, and an address that no longer works (the
  Wi-Fi's after the phone moved to mobile data) cost its whole 3-6 s timeout before the next was
  tried; a chat read that hung on a dropped connection also held back every later one. Now a PC's
  addresses are tried side by side (the next after 0.7 s), a send that doesn't get its answer is
  sent again with the same id (the PC runs it once, also through another PC), a message that
  can't be sent stays in the chat with "Tap to try again", Edit and Delete, and a stalled read
  no longer blocks the next.

## [0.112.0] - 2026-11-02

### Added
- Phone: Add project, as on the desktop. The folder-plus button over the chat list (and Add
  project… in the Projects and new-chat project pickers) makes a new project with or without Git,
  adds a folder on the PC (browsed from the phone), or clones a Git URL or one of your GitHub
  repositories. With several PCs, pick which one gets it. Then the project's main chat opens; its
  first message starts it. Errors (the folder exists, the clone failed, the PC is off or runs an
  older Harbor) are shown on the screen.
- Phone: projects without chats show in the chat list, as on the desktop; tapping one starts its
  main chat.

## [0.111.1] - 2026-11-02

### Fixed
- Phone: no more "Connected through <PC>" on a flaky network. The phone moved to another PC of
  the workspace after a single failure (a long-poll that took a few seconds too long, one
  connection the PC turned away while a chat's images loaded) and went back a minute later, with
  a toast each way. Now the PC in use stays until it fails twice in a row (or refuses: Harbor
  isn't running there), a single call it can't take goes to another PC that once, the way back
  to the workspace's first PC is tested quietly in the background (and less often when it keeps
  dropping out), images download four at a time, and a blip no longer flashes the offline card.

## [0.111.0] - 2026-11-02

### Removed
- Cursor, Grok, Gemini, Meta (Muse) and OpenCode: Harbor drives Claude Code and Codex only. Chats
  and settings from them stay readable; a default saved on one opens with Claude's defaults, and
  sending to such a chat asks you to switch it to a Claude or Codex account.
- The provider update offers ("Updates available: N providers" on the phone, the Update card in
  Settings > Providers). They couldn't update a CLI installed through mise, Homebrew or a
  distribution package, so the offer never went away; Claude Code updates itself.

## [0.110.2] - 2026-11-02

### Fixed
- Phone: the agents strip's "Stop all" has its padding back and lines up with the agents' stop
  buttons, and the model and effort badges above the composer have room around them.

## [0.110.1] - 2026-11-02

### Fixed
- An update that brings a new runtime no longer restarts Harbor halfway through: it fetched the
  browser engine, video player and phone app after putting the new runtime in place, and Harbor
  restarted into it before the app bundle was there, failed, rolled back and tried again.

## [0.110.0] - 2026-11-02

### Changed
- Harbor is rewritten in TypeScript: it runs on Bun, compiled into one executable, with a native
  Slint window (still no Electron or WebView). Your chats, settings, pairings and phones carry over
  as they are, and it works beside PCs that still run 0.109.0. Installed copies update from a small
  app bundle; the runtime comes along only when it changed.
- A long chat keeps its last 15 messages loaded. Scrolling up loads earlier ones, and they're let
  go again after a while at the end of the chat. Images are decoded once, at the size they're drawn.
- The session recap is gone. Suggested next messages stay.
- The phone shows a suggestion only as its Use chip, not as gray text in the composer.

### Added
- A Resume button in the composer asks the agent to continue what it was saying or doing.


## [0.109.0] - 2026-11-01

### Added
- A "Scroll to bottom" button floats over the transcript while you read further up, on the desktop
  and the phone. A click goes to the end and the chat follows new output again.
- PageUp, PageDown, Home and End move the transcript on the desktop when no text field has focus.

### Changed
- The phone app no longer shows the recap (the desktop still does). The suggested next message
  stays in the empty composer.
- The phone shows the chat's model and effort as two badges over the composer, with the provider's
  logo and the same names as the desktop, also for chats that run on another PC. A tap opens each
  one's picker. The other run settings stay in the + sheet.
- The phone's agent bar is cleaner: one agent has exactly one stop, every stop is red, rows are
  taller with a 44 dp stop, and Stop all sits in the title row from two agents on.
- Scrollbars are easier to grab on the desktop: wider under the pointer, with a longer and clearer
  handle, and a wheel notch moves further.
- Menus have more room around and between their items on the desktop.
- "Mention selection" waits until the selection has rested for 0.6 seconds and goes away after 5,
  while the text stays selected.

### Fixed
- Esc closes a full-screen video at once, instead of only leaving full screen, and holding it
  after closing an image reaches nothing behind it.
- A message of only mentioned messages, sent to a chat that runs on another PC, no longer fails
  with "nothing to send" (that PC must run this version), and a mention left unsent from a failed
  send comes back into the composer.
- Clicking an excerpt's chip scrolls to the excerpt and highlights just its text, not the whole
  message, also across lines, list items and formatted text. A folded tool call opens for it. If
  the text can't be found the whole message lights up, as before.

## [0.108.0] - 2026-10-31

### Added
- A lead agent can retire a subagent whose job is done, with the new `retire_agent` tool: a
  running turn stops, the agent leaves the Agents panel on every PC and phone, and it can't be
  messaged or woken again. Its chat stays readable, read-only, through its link, the palette and
  `find_chats`. Processes it started keep running and report to the lead. Leads are told to do
  this when a job is finished.
- Images are part of what you write. Paste, drop or pick one and `[Image #1]` goes in the text at
  the cursor, marked, and the thumbnail wears the same number. Erase the token and the image goes;
  remove the image and its token goes, and the later numbers move down. Ctrl+Z brings both back,
  and a token you cut or copy takes its image along when you paste it, on the desktop and (paste
  only) the phone. A `[Image #1]` that comes from anywhere else, like a quoted message, stays as
  `[Image 1]`, so it can't name an image of this message by accident. The agent gets the token
  where you wrote it and is told which image each number is, on every provider. A message in the
  chat shows them the same way.

### Changed
- Agents' replies read larger in the chat, on the desktop and the phone: 16 px instead of 14 on
  the desktop and 18 sp instead of 16 on the phone, with their code, lists, tables and headings
  in step. Your own messages keep their size.
- A project's main chat now shows what the agent says and what you need to know, not how the work
  got done: tool calls, the "started", "finished" and "Sent to" cards of its agents and
  processes, its agents' messages to it, wake-ups and webhooks are gone from it. Nothing is lost:
  a sub-agent's chat shows all of it as before, and the Agents panel and the bar over the composer
  still show what's running. Problems, usage limits and moves still appear in the chat.
- Agent cards stop showing tokens and price, and an agent at work reads blue.
- What stops something is red with a white icon wherever it is, and tooltips are one white panel.

### Fixed
- "Image #1" in a message is no longer taken for GitHub issue #1: it isn't tagged and doesn't open
  the `#` menu, on the desktop or the phone.
- A chat or agent running on another PC shows as running here too: the "Working…" line, its team's
  cards and the Agents panel go by what that PC says, not only by turns on this one.
- A very long model id no longer pushes the send button out of the composer: it's cut, and its
  tooltip has all of it.

## [0.107.0] - 2026-10-31

### Changed
- Harbor brings its own video player, so videos play inside it with nothing to install: mpv is no
  longer needed. It arrives by itself with this update, a download of about 5 MB that comes again
  only when the player itself changes, and if you open a video before it's there Harbor shows
  "Getting the player ready…" and starts as soon as it is. It plays mp4, mov and webm with H.264,
  HEVC, VP8, VP9 and AV1 and the usual audio. It decodes on the graphics card where the system has
  VA-API, and it uses less CPU than a system mpv did; where it doesn't, it decodes on the CPU. A
  system mpv is only the fallback now, and the external player comes after that.
- `harbor --check-video` says which player Harbor loads and tries it without a window or sound.

## [0.106.1] - 2026-10-31

### Fixed
- In a chat driven from another PC or its phone, a `claude` started by a command, script or
  commit hook no longer stops at "Not logged in". It signs in with the chat's account while
  the turn runs: its access token alone, never the refresh token, removed when the turn ends
  or is stopped.

### Removed
- The token and cost counter is gone from the chat header on the desktop and the phone. The
  phone's header now shows just the PC and the account. Settings › Usage still has the totals,
  and the agent cards still show their own.

## [0.106.0] - 2026-10-30

### Added
- Videos have the same player on the phone as on the desktop: just the picture, with play and
  pause, the time, a seek bar, mute and full screen, which fade while it plays; a tap brings them
  back. They browse together with the images of the message you opened, by swipe or the side
  buttons, and a video you browse onto waits at its start. A video now starts right away instead
  of after its whole download, and a seek goes straight there: it plays while it arrives and
  fetches only a little ahead of what you watch, so one you stop early costs little data. It
  stops when you leave and picks up paused where it was when you come back, and watched videos
  are kept in a cache of at most 300 MB. A video in a reply now shows at its own shape, a tall
  one narrow, as on the desktop.

### Changed
- Videos of a chat on another PC of your mesh reach the phone in parts, so the old 64 MB limit
  there is gone and they stay within the usual 200 MB.
- The chat on the phone keeps its place when the phone turns.

## [0.105.0] - 2026-10-30

### Added
- Videos play inside Harbor, on the desktop. A click on a video in a reply, or on a link to a video
  on this PC, opens it in the viewer, which browses a message's images and videos together. It
  shows just the picture, with play and pause, a seek bar, the time, volume and full screen, and
  these fade while it plays. Space pauses, ← → seek 5 seconds, ↑ ↓ change the volume, M mutes, F
  goes full screen, Esc leaves, Page Up and Page Down go to the previous or next item. It decodes
  on the graphics card when it can, costs nothing while paused, and pauses when the window is out
  of sight. Videos of another PC's chat play here too. It needs mpv (`libmpv`): without it a video
  opens in your video player as before, with a short hint.

## [0.104.0] - 2026-10-30

### Added
- Discord, as an app next to Gmail: agents can read and send on your personal account, once you
  sign in under Settings › Integrations › Apps. Discord's rules forbid automating personal accounts
  and an account can be banned for it, so sign-in says so first. It runs a real Discord page in the
  background, with no window. It starts on the first tool call and freezes after 2 idle minutes,
  using almost no RAM until the next call wakes it; tools that read live data wait for it to
  reconnect, so they never answer from old data. Past 20 full logins a day it stops freezing and
  stays running. On a PC with no swap freezing saves little, so an idle client quits instead, after
  30 minutes and at most 8 logins a day. Sign in by scanning a QR code with the Discord app, or in
  Discord's own window for a password, 2FA or a captcha. Harbor paces joins, new DMs and uploads,
  checks the tools against Discord at every start, and repairs them by itself when Discord changes,
  telling you what changed. Sign out ends the session and removes its profile. The page, tools and
  Electron are a separate GPL program (`discord/`) that Harbor downloads on first use; Harbor stays
  MIT. A signed-in Discord app replaces your own `discord` MCP server for agents. This first version
  hasn't been tried with a real Discord account yet.

## [0.103.0] - 2026-10-30

### Added
- Live previews: a change reaches your PC within seconds, for the PCs that turn it on (Settings ›
  Updates › Live previews, off by default). `scripts/boat/dev` builds the working tree on a warm
  boat.dev sandbox and Harbor restarts into the result at once, keeping what's on screen and running
  agents. Other PCs with it on get the same build over the mesh, from PCs that have full access to
  them. It's an unoptimised, untested test build, and it shows in Settings › Updates and Devices;
  "Back to the release" returns in one click, a build that fails to start falls back by itself, and
  the next signed release replaces it. Nothing changes on a PC that leaves it off.

## [0.102.1] - 2026-10-30

### Changed
- The image viewer browses only the message you opened it from, on the desktop and the phone: ← →,
  swipes and the "3 / 7" counter go through that one message's images, not the rest of its turn.

## [0.102.0] - 2026-10-30

### Changed
- The image viewer browses only what belongs with the image you opened, on the desktop and the
  phone. An image in an agent's reply goes through the images of that agent's turn; an image in
  your message goes through that message's images. ← →, swipes and the "3 / 7" counter work as
  before. Before, they went through every image the chat had ever named, even files of other
  projects that a tool call only mentioned.

## [0.101.1] - 2026-10-30

### Changed
- Releases get out faster: one build per release, on boat.dev, in a third of the time. The app itself
  is built with ThinLTO now: it starts and runs the same, and its download is about 10% larger.

## [0.101.0] - 2026-10-30

### Changed
- A new release reaches your PCs within about 5 minutes instead of up to 4 hours. Each PC looks
  every 5 minutes with one small request, and when one of them finds a release the others of the
  mesh hear of it and look too, within about a minute and a half. When it installs is as before:
  automatically while nobody is looking, or on the Update button with "Ask me". An install that
  fails waits longer each time (5 minutes up to 6 hours) instead of downloading again every check.

## [0.100.0] - 2026-10-30

### Changed
- The workspace filter takes several workspaces at once, on the desktop and the phone. Its menu is
  a checklist that stays open while you tick: All, then each workspace. All clears the picks,
  ticking every workspace is All, and unticking the last goes back to All, so the sidebar never
  ends up with nothing selected. A choice made in 0.99.0 carries over.

## [0.99.0] - 2026-10-30

### Added
- A workspace filter in the sidebar, next to Order and view, on the desktop and in the phone's
  list: All, or one of your account's workspaces, to see only the chats of that workspace's PCs
  and its projects. The button is tinted while a workspace is picked, each device remembers its
  own choice, the sidebar's search stays inside it, and chats of PCs in no workspace show only
  under All. A workspace you've left goes back to All.

## [0.98.0] - 2026-10-30

### Changed
- In a chat's own worktree, the Worktree and branch labels under the composer go straight to
  renaming it, without a menu first, on the desktop and the phone. Switching or creating a branch
  is the "Switch branch…" row in the rename form. A new chat, the project's checkout and a
  worktree that's gone still open their menus: there's nothing to rename there.

## [0.97.2] - 2026-10-30

### Fixed
- Phone: adding a Gmail account no longer opens the browser after you pick the account. The
  account comes from the same sheet as Harbor's sign-in, then Google's own consent screen shows
  in the app. The browser is only the last resort now, and the Gmail sheet says why it was used.

## [0.97.1] - 2026-10-29

### Changed
- Phone: adding a Gmail account starts with the same sheet Harbor's own sign-in uses (your
  Google accounts with their names and pictures) instead of Android's plain account list. When
  Android lets Harbor use the picked account directly, Google's consent screen follows; otherwise
  Google's page opens in the browser with that account already chosen.

## [0.97.0] - 2026-10-29

### Changed
- A new worktree is named by Claude after what the chat asks for: a few words like
  `inline-chat-mention-links` for its branch (`harbor/inline-chat-mention-links`) and folder,
  instead of the first words of the message. Haiku is asked through your Claude login while the
  worktree is checked out; when there's no Claude login, it's offline or it takes long, the
  worktree starts with the message's words and its branch is renamed when the name comes (the
  folder follows once nothing works in it). Folders you renamed are left alone. From the phone too.
- The workspace menu under the composer only renames the worktree's folder; the branch is renamed
  from the branch menu next to it (desktop and phone).

## [0.96.1] - 2026-10-29

### Fixed
- 0.95.0's and 0.96.0's releases didn't build (a broken build cache on the build servers) and
  were never published; this release brings their features. Release builds now start over once
  when the cache is broken.

## [0.96.0] - 2026-10-29

### Changed
- What you pick from the composer's menus goes in one erase: a chat from `$`, an issue or pull
  request from `#`, a file from `@`, a command or skill from `/`. Backspace at its end (or just
  after the space that follows it), Delete at its start, or any erase inside it takes all of it,
  on the desktop and the phone (the on-screen keyboard's backspace included). Text you type by
  hand still erases a character at a time.

## [0.95.0] - 2026-10-29

### Added
- Several Gmail accounts at once: the Gmail card lists each connected account with its own Sign
  out, Add account (Google's account chooser) and Make default. Agents' Gmail tools take an
  `account` (an address; the default one when left out), `accounts` lists them, and `search`
  can look in all of them. A sign-in from before moves over as it is.
- Connect Gmail from the phone: Settings › Apps › Gmail lists the PC's accounts, signs one out,
  sets the default, and adds one with Android's own account sheet (tap, pick, approve). The PC
  keeps the sign-in, since agents run there. Where the sheet can't be used, Google's page opens
  in the browser. Hub API: `/v1/apps/gmail` (android/PROTOCOL.md).

## [0.94.0] - 2026-10-29

### Changed
- A chat mentioned with `$` is now just its title in your message, written where you typed `$`,
  highlighted in the composer and a link once sent: a click (a tap on the phone) opens that chat,
  on whichever PC it is. No more card with a note box in the composer, nor a chip on the message;
  to drop the mention, delete its title. Older messages show the chat they mentioned as a link
  on a line of its own, before their text.
- `@file` and `#123` tags and `/commands` (slash commands and skills) are blue in your messages,
  on the desktop and the phone, and `/commands` are highlighted in the composer too.

## [0.93.0] - 2026-10-29

### Changed
- Gmail signs in with one click: the Gmail card's "Sign in with Google" uses Harbor's own Google
  client, so there's no Google Cloud project to set up. Google may first say it hasn't verified
  the app (Advanced › Go to Harbor). Your own OAuth client is still an option (the settings button
  on the card) and is used whenever you saved one. Desktop only: phones have no app sign-ins.

## [0.92.0] - 2026-10-29

### Added
- Rename a chat's worktree folder on its own, from the workspace menu under the composer (the
  left "Worktree · …" chip › Rename worktree…) on the desktop, and the same place on the phone.
  It stays where it is; a name with "/" or spaces, starting with "." or "-", or already taken is
  refused in plain words. As with a branch rename, the folder moves at once when nothing works in
  it, else as soon as nothing does; the chat's Claude sessions come along, the chat shows a line
  and its agents are told. Once you've named the folder, renaming the branch leaves it be.
- "Rename branch…" is in the workspace menu too (and the phone's workspace sheet), so both
  renames are reachable from either chip.

### Fixed
- A worktree folder still waiting to follow its renamed branch is renamed after a restart too
  (the plan is kept, not only in memory).

## [0.91.1] - 2026-10-29

### Fixed
- Phone: after you pick your Google account in Android's sheet, sign-in never opens the browser.
  A Google account that never used Harbor gets its Harbor account right there, and any problem
  shows in the app with Try again. The browser is only for phones where the sheet can't run.

## [0.91.0] - 2026-10-29

### Changed
- Phone sign-in uses Android's own Google account picker (Android 14+): pick your account in
  the system sheet inside Harbor, no browser. Older Android and Google accounts that never signed
  in to Harbor still sign in in the browser once.

## [0.90.0] - 2026-10-29

### Changed
- Phone: a project picked in the search opens the project's main chat, as on the desktop, or the
  project's page (where the first message starts its main chat) while it has none. "New chat in
  …" still starts one more chat. With an older Harbor on the PC it opens New chat there as
  before.

## [0.89.0] - 2026-10-29

### Changed
- Settling a chat takes you to its project's main chat, on the desktop (its menu, the row's
  Settle, the search, `/settle`) and on the phone (a long press, `/settle`, the search). Settling
  the main chat itself frees the project: its page opens, where the next message starts a new
  main chat. A chat of no project lands on New chat. Settling on one device doesn't move the
  others.

## [0.88.0] - 2026-10-29

### Added
- Each project has a main chat again, and now it stays put. Clicking the project opens it and the
  project's row shows its status (working, done, waiting on a limit); writing on the project's
  page starts it the first time and goes to it after that, instead of starting one more chat each
  time. The project's other chats are rows under it, and the project's + still starts a separate
  one. Any chat of a project can become its main chat: Make main chat in its menu (a long press
  on the phone). It never changes by itself: other chats settling or snoozing leave it be.
  Settled (Settle main chat in the project's menu), moved or deleted, the project's next message
  starts a new one; Unsettle brings it back while none was started. Webhooks wake the main chat.
  The phone shows it the same way: the project's header opens it and shows its status, and its
  count and chevron fold the other chats.

## [0.87.0] - 2026-10-29

### Added
- A chat's worktree is named for what it's about: its title or first message, a few words of
  it, so "Main thread per project" works in `<project>-main-thread-per-project` on branch
  `harbor/main-thread-per-project` instead of `harbor/3c88d2` (accents folded, filler words left
  out; "-2", "-3"… when the name is taken here or on a remote; 6 hex as before when the message
  has no words to use). Also for "Move to a new worktree" (the chat's title) and chats a phone
  starts.
- Rename a worktree's branch at any time, on the desktop (the branch menu under the composer ›
  Rename branch…) and the phone (the branch sheet, the same place): names git won't take or
  that are taken are refused in plain words. A pushed branch is renamed on its remote too (on
  GitHub through its API, so its pull requests follow; elsewhere the new name is pushed and the
  old one left), or, with that switched off, stops tracking the old remote branch. The
  worktree's folder follows the new name at once when nothing works in it, else as soon as
  nothing does (no turn, process or terminal there): moving it under a working agent or a dev
  server would pull the folder from under them. The chat's Claude sessions come along, the chat
  shows a line for each change, and its agents are told on their next turn.

## [0.86.0] - 2026-10-29

### Added
- Phone: sign in with Android's own Google account picker, inside Harbor: tap Sign in, pick an
  account in the system sheet, done. No website, no redirect (Android 14+, once Harbor's Google
  Cloud client is set up; until then, and on older Android, the browser sign-in stays, now in a
  Custom Tab). It's the same account as on your PCs (matched by the verified email).

### Changed
- Desktop: after signing in in the browser (Harbor's account, or an app like Gmail), Harbor comes
  back to the front by itself, and the browser shows a small Harbor page instead of a blank one.
  Also for `harbor account login` while Harbor runs.

## [0.85.1] - 2026-10-29

### Changed
- Agents show images and videos only with markdown in their reply, `![caption](path)`, next to
  the sentence it illustrates: the `show_media` tool is gone, so a lead no longer drops pictures
  into the middle of a turn. The path is absolute, relative to the project, or an https URL
  (PNG, JPEG, GIF, WebP, SVG, MP4, WebM, MOV); the alt text shows as a caption under it. The
  agents' instructions say so. An image on its own line is drawn right there in the reply, on
  the desktop and the phone, instead of after all of its text. An old chat's `show_media` call
  shows as a tool card with its file.
- Release workflow: the aarch64 and Android browser engines compile on boat.dev sandboxes too
  (aarch64 cross-compiled, Android with the NDK), like everything else; GitHub's runners only look
  up the cached engines, sign and publish.

### Fixed
- A reply's images and videos show on every PC and phone of the mesh: a path relative to the
  project now resolves in another PC's copy of the chat too (each PC tells the others the
  chat's folder), a video of another PC's chat plays on the desktop (fetched from there first),
  and a chat of another PC asks that PC for a file even when this PC has one at the same path
  (two `/tmp/screenshot.png`s were mixed up).
- An image or video a reply shows still shows after the agent deletes the file (a screenshot in
  /tmp): when the reply ends Harbor keeps a copy (in its data folder, `media/kept`), and the
  desktop, other PCs and phones read that copy once the file is gone.
- A chat on a device added by hand no longer dies on a brief network hiccup: when ssh can't
  connect (no route to host, timed out, refused, unreachable, name not resolved), the turn tries
  again for about 30 s, resolving the device's name anew each time (a Mac whose `.local` address
  changed is found at its new one). Nothing ran there yet, so it's safe; a refused login isn't
  tried again. If the device still can't be reached, the chat says so in plain words on the
  desktop and the phone ("Couldn't reach My-Mac (my-mac.local): no route to host. Is it on and
  on the same network?") instead of ssh's raw line.

## [0.85.0] - 2026-10-28

### Added
- Google accounts (through Clerk) on every PC and phone. Harbor opens on "Sign in with Google";
  the sign-in runs in the browser (PKCE, no secret in the app) and `harbor account login` does it
  from a terminal. Each account gets its own workspace, and a PC you sign in on joins it (you
  pick one when you're in several). Settings › Account (desktop) and Settings (phone) show the
  workspace's people and PCs; owners invite people by email (no email is sent). The invited person finds the
  invitation in Harbor once they sign in with that address, on a PC (a pop-up and Settings ›
  Account) or a phone (the start screen and Settings), and only Accept joins: then they control
  all of the workspace's PCs and chats; Decline turns it down. Owners remove people, anyone
  leaves a workspace that isn't their own.
- Settings follow the account: theme, density, keybindings, run defaults, notifications, voice,
  recaps and suggestions, limits and caps, follow-up, updates… are the same on every PC you sign
  in on. Machine-bound settings stay on each PC (network, ports, router, mesh keys, phones,
  windows and sidebars, the last chat, tokens). Nothing is lost: at a PC's first sign-in its own
  settings stay and go up to the account, and any value a later sync replaces is kept on the PC.
  Updating, signing in, accepting an invitation, switching workspace or signing out never touch
  chats, projects or history, and never stop a running agent.
- `worker/`: the account service, a Cloudflare Worker (free tier) holding Clerk's secret key:
  workspaces, invitations, settings and each workspace's PC directory, and the Harbor tokens
  every PC checks offline. Deploy steps in `worker/README.md`.

### Changed
- Phones sign in with Google instead of pairing: no QR code, 6-digit code, screen-lock factor or
  rotating sessions. The phone gets its workspaces' PCs from the account service and connects to
  them directly, pinned to each PC's key as before; every call carries a token signed by the
  account service and bound to the phone's own key, which each PC checks itself, also while the
  service can't be reached. Phones from before this version update the app, then sign in.
- PCs of one workspace share chats without pairing codes; PCs paired by hand keep working.
- A PC's owner is the signed-in account's name (detection only runs on PCs nobody signed in on).
- An expired sign-in or an unreachable account service stops nothing: the hub and agents keep
  running with what the PC has cached, and Settings › Account asks to sign in again.
- Settings › Phones lists the signed-in phones (with whose account) and can sign a lost one out.

### Removed
- Phone pairing (three factors, the presence key, `/v1/pair/*`, `/v1/session/*`,
  `/mesh/v1/mint`) and the in-app QR scanner.

## [0.84.1] - 2026-10-28

### Fixed
- On Ubuntu 22.04 (and other systems with procps-ng 3.3.17), a command an agent ran through
  Harbor (from a phone or another PC, or the GitHub and shell tools) that timed out or left
  background processes running could stop Harbor itself instead of only that command.
- Phone: the built-in browser works on phones with a 32-bit Android too (the Galaxy A13 and other
  budget phones run one on a 64-bit processor): the APK now carries the Servo engine for
  armeabi-v7a as well as arm64-v8a. Links there opened in the phone's own browser. The APK grows
  by about 40 MB.

## [0.84.0] - 2026-10-28

### Fixed
- Phone: when web links can't open in the built-in browser, the phone says why, once, and
  Settings › Built-in browser keeps saying it: phones with a 32-bit Android (the Galaxy A13 and
  other budget phones run one on a 64-bit processor) or Android older than 9 open links in the
  phone's own browser, because the engine is built for 64-bit Android only.
- Phone: a notice line too long for the screen (an agent's report, a hand-off) wraps instead of
  pushing its expand arrow off the pill.

### Added
- The phone tells its PCs what it is (maker and model, Android version, ABIs, whether its
  built-in browser runs): agents see it in the versions list (`GET /v1/versions`, the
  `machines` list), so a phone-only problem can be diagnosed from the PC.
- A lead that hands work off now always leaves a line in the chat, so a message answered only by
  starting agents still shows what happens: "api started: PR status in the composer footer"
  per agent it starts, and "Sent to api: …" when it passes your words to one. Click or tap the
  line for the whole task. Desktop and phone. Leads give each agent a short title for it, and
  their own reply when they hand off is one short line.

### Changed
- Claude's default effort is Medium (it was High, or Claude Code's own setting): new chats,
  chats left on the default and agents started without an effort run at Medium, on the desktop
  and the phone. Chats with a chosen effort keep it; a new-chat pick still on the old default
  (High) moves to Medium once.

## [0.83.0] - 2026-10-28

### Added
- A chat's pull request shows under its composer: the footer row says "PR #123 · Open" (Draft,
  Merged or Closed) left of the branch, with the state's icon in its colour, and a click opens
  it on GitHub. A chat in its own worktree gets the same icon on its sidebar row. Harbor finds
  the PR of the branch the chat works on with the GitHub CLI, in the background: when the chat
  is shown, after each of its turns, and every few minutes for open ones, so a merge on GitHub
  shows up too. Nothing shows without `gh`, for the default branch or a branch never pushed.
  The phone shows it the same way in its footer chips (tap opens it, long-press shows the
  title) and its chat list.

## [0.82.0] - 2026-10-28

### Added
- The image viewer goes through every image of the chat, not only the ones of the message you
  opened: ← → (or the side buttons) on the desktop, a swipe or the side buttons on the phone,
  with a "3 / 7" counter. The buttons hide at the first and last image; on the phone a swipe
  only turns the page when the image isn't zoomed.

### Fixed
- → in the desktop's image viewer no longer fills the composer with the suggested prompt.

## [0.81.0] - 2026-10-28

### Added
- Phone: a built-in browser. Web links in chats (and Browser in the drawer) open in Servo, the
  engine of the desktop's browser pane, drawing straight into the screen: no WebView, Chromium or
  GeckoView. URL bar, back, forward, reload, touch scrolling, taps, the soft keyboard and
  rotation; ↗ opens the page in the phone's own browser. It runs in a process of its own, so its
  memory goes when it closes and a crash there leaves the chats running. On 64-bit ARM phones
  with Android 9+ (the APK grows by about 40 MB); elsewhere links open in the phone's browser as
  before.

## [0.80.0] - 2026-10-28

### Added
- Secrets (Settings › Secrets): keys such as `BOAT_API_KEY` that agents use without seeing
  them. Add one as a name and a value; the list shows only names, and a saved value can be
  replaced or deleted, never shown again. Values stay on this PC, in an owner-only file
  outside Harbor's database: never in a chat, never synced to other PCs or phones.
- Every use of a key needs your approval. An agent asks with `request_secret_access(names,
  reason, minutes)`; a card in the chat says who wants which keys, why and for how long
  (15 minutes when it doesn't say, a day at most), and you Allow it as asked or for less (5
  min, 1 h), or Deny. What's allowed shows under the chat and in
  Settings › Secrets › Allowed now ("BOAT_API_KEY allowed · 12m left"), each with Revoke.
  The agent is told when it's allowed, denied, revoked or over.
- `run_with_secrets(command, secrets)` runs a command on this PC with allowed keys in its
  environment (never the agent's own) and returns its output with their values hidden, as
  they are and in common encodings (base64, URL, hex, JSON); without an approval it's
  refused. Hiding them stops accidental leaks only: a command made to change a key can
  still get it out, and Settings says so. `list_secrets` gives the names, what each is
  for and what the chat may use now.
- Agents ask for keys you don't have yet with `request_secret(name, reason, how_to_get)`:
  the card says where to get it (links open in the browser) and has a field for it (shown
  as dots, never in the transcript). Saving it can also let the agent use it right away,
  for the time it asked or less; "Save only, no access" keeps it without allowing any use.
  Your phone gets a notification.
- Keys in .env files: an agent may ask for a key to go into the project's `.env`,
  `.env.local`, `.env.production`… (`env_file` on request_secret, or
  `write_secret_to_env(name, file)` for a saved one). You pick Harbor, the file or both;
  Harbor writes the `VAR=value` line itself, quoted when needed, replacing the old one and
  keeping the rest, in a new file only you can read. Only files named `.env` or `.env.*`
  inside the chat's project (no symlinks out of it). The card warns when git doesn't ignore
  the file and adds it to .gitignore if you leave that on. A .env file is plain text the
  agent's own tools can read: writing one is your call.
- The agents' instructions say to ask for keys this way, never in the chat.
- Paste a key into the composer (`sk-`, `ghp_`, `github_pat_`, `boat_`, `AKIA`…) and a line
  over it offers to save it as a secret: the message then names the secret instead.

### Changed
- The running-agent strip over a lead's composer is quieter: each agent shows its logo, name and
  a soft pulsing green dot while it works; tokens, cost and what it's doing left the row (the
  hover still has its model, task and how long it has run). Each row's Stop shows on hover (or
  from the keyboard) and asks in place, "Stop api? Cancel / Stop"; Cancel, Esc or moving away
  leaves it running.
- A lead's reply when it hands work to its agents shows in the chat (it was hidden), and the
  lead says in a line or two what it understood and what happens next.
- Phone: the running-agent rows over a lead's composer match: logo, name and the pulsing green
  dot, no tokens, cost, activity or timer. Each row's stop icon asks in place first, "Stop api?
  Cancel / Stop"; it cancels itself after a few seconds or when another row is touched.
  Long-press a row for its model, task and how long it has run. Stop all asks first too.

## [0.79.0] - 2026-10-28

### Changed
- The built-in browser (Servo) is on by default: install.sh installs its engine wherever it runs
  (x86_64 and aarch64 with glibc 2.39+; elsewhere it says why in one line and skips it), and
  copies installed without it fetch it in the background after starting, or as soon as the
  browser pane opens, retrying by themselves after a failure. Updates install or refresh it too.
  To leave it out: `install.sh --no-browser` (`--with-browser` is still accepted and turns it
  back on). The pane's button stays only for failures and a turned-off engine, and on systems
  that can't run it the pane says why.
- The browser engine is built for aarch64 too (`harbor-browser-aarch64-linux.tar.gz`).

### Fixed
- A browser engine that quits right after starting (a missing library…) is no longer restarted
  on every frame: the pane shows its last error with "Try again".

## [0.78.0] - 2026-10-28

### Added
- Phone: snooze a chat. Long-press it in the list for Snooze…, a sheet with the desktop menu's
  presets (1 hour, 3 hours, Tomorrow 9:00, Next week), a field for a time of your own ("5h",
  "1h30m", "2d", "18:00") that says when it ends as you type, and Unsnooze. The snooze is the PC's:
  the chat leaves the phone's list and that PC's sidebar until it comes back unread, whichever
  side snoozed it. Times follow the phone's time zone.
- Searching the list (desktop and phone) also finds snoozed chats, back in their project, with
  the clock and when they wake ("Today, 23:40"); the desktop's search left them out.

### Changed
- Releases are built and tested on boat.dev sandboxes: Harbor for x86_64 and aarch64 (cross-compiled
  in Ubuntu 22.04), the phone app, the licence reports, the browser engine and the install tests
  on every distro. GitHub Actions only signs, attests and publishes them.

## [0.77.0] - 2026-10-28

### Added
- Ctrl+D shows or hides the team panel (agents, wake-ups, webhooks) in a lead chat. In a
  terminal Ctrl+D stays its own.

### Changed
- Ctrl+B shows or hides the sidebar (it was Ctrl+\); the browser pane moved to Ctrl+Shift+B.
  Keys you rebound in Settings › Keybindings stay as they are.

## [0.76.0] - 2026-10-28

### Added
- Dictation dictionary (desktop Settings › Voice › Dictionary, phone Settings › Dictionary): names
  and terms the speech model can't know ("SpokPay", "SpokPayCRM") come out spelled exactly, with
  optional "sounds like" spellings. One list on the PC serves its desktop dictation and its
  phones (kept on the phone for offline dictation too); the cleanup gets it as well.
- Voice commands, like Wispr Flow's "press enter": end a dictation with "press enter" (or
  "aperta enter"), or say just "send" / "enviar" as its last sentence, and the message is sent,
  without the command. "New line" / "nova linha" said on its own makes a line break. Anywhere
  else these words stay text. Settings › Voice › Voice commands turns them off.

### Changed
- The dictation cleanup has an example of mixed Portuguese and English to keep as spoken; when an
  answer still translates, the raw text is used (now logged).

## [0.75.0] - 2026-10-28

### Added
- Snooze a chat or project until a time you type (desktop): the snooze menu has a field under
  its presets for a duration ("5h", "90m", "1h30m", "1.5h", "2d", "1w"; a bare number is hours)
  or a clock time ("18:00", "6pm", "at 9": the next one, today or tomorrow). It shows when the
  snooze ends as you type ("until Thu, 14:00"); Enter or the check button applies it.

## [0.74.2] - 2026-10-28

### Fixed
- Dictation in two languages (desktop and phone): switching from Portuguese to English (or back)
  mid-dictation no longer turns what you said in one into the other. The cleanup keeps every word
  in the language it was spoken and is dropped when it translates anything; Whisper detects the
  language per phrase instead of once per recording. "Dictation language" / "Spoken language"
  start again from Detect (a picked language makes Whisper write everything in it).

## [0.74.1] - 2026-10-28

### Fixed
- Phone: no more worktree chip under the chat's title, ever. What only it said now shows in the
  bar under the composer, as on the desktop: "Worktree gone" in red (no branch) when the chat's
  worktree was removed, and a read-only "Worktree · <name>" for another PC's chat or one run on
  a device (a tap says where it runs).

## [0.74.0] - 2026-10-28

### Added
- Phone: message text is selectable, as on the desktop. Long-press a word, drag the handles, and
  the selection's menu offers Mention (just that part goes to your next message, the same excerpt
  the desktop's "Mention selection" makes) and More… for the message's actions (Quote, Fork…).
  Links and chat links still open with a tap.

## [0.73.0] - 2026-10-28

### Changed
- Desktop: the bar under the composer now looks like the phone's: quiet muted text with no
  boxes, "Worktree · harbor-a1b2c3" (or "Current checkout", "New worktree") on the left and the
  branch on the right, with "· 3 changed" when there are uncommitted changes. Clicking either
  still opens its menu. It also says "Worktree gone" when the chat's worktree was removed, and
  "Worktree · <name>" for another PC's chat. The header's worktree chip is gone, since the bar
  says the same thing.

## [0.72.3] - 2026-10-28

### Fixed
- Phone: the chat header no longer repeats "Worktree · branch" under the title when the bar under
  the composer already shows the worktree and branch. It still shows for another PC's chat and
  for a worktree that's gone. The desktop is unchanged.

## [0.72.2] - 2026-10-28

### Fixed
- Chats that run on another device over SSH no longer stay "Working" after the agent there
  has finished. The bridge that carries this PC's MCP servers to the device waited forever
  for answers that never come: Roblox Studio's server (on the newer MCP protocol) holds a
  `subscriptions/listen` request open on purpose, and every later request to it queued
  behind that one. The connections it kept open held the SSH session open, so the turn never
  ended. Each request to a stdio server now waits on its own, for a limited time (a
  subscription for as long as the agent listens) and only while the agent is still
  connected: a request the agent gave up on is cancelled at the server, a server that stops
  answering is restarted on the next request, and the notifications that come with a request
  (such as a subscription's acknowledgement or a tool call's progress) now reach the agent as
  an event stream. Http servers stop as soon as the agent hangs up. As a backstop, once the
  agent on the device has exited, an SSH session that is still open is closed after 5
  seconds, and the turn ends normally.
- Pressing Stop on a stuck remote turn and then sending a message no longer cuts the new
  turn off from every tool ("Error POSTing to endpoint: not found"). The stopped turn's
  cleanup could hang and leave its folder behind. After Harbor's next update or reload it
  was picked up instead of the chat's running turn, whose tools then stayed unserved. A
  stopped turn's late end also no longer ends the chat's next turn.

## [0.72.1] - 2026-10-28

### Fixed
- Phone: opening Settings (or the mic) no longer crashes the app on x86_64 Android devices and
  emulators. The APK carries the offline dictation library for ARM only, and Android ran it there
  through its ARM translation, where it crashed natively; on such devices offline dictation now
  just says it isn't available. Real ARM phones were not affected. Fixes #97.

## [0.72.0] - 2026-10-28

### Added
- Mention a whole chat with `$` in the composer, on the desktop and the phone (#96): `$` at the
  start of a word lists your chats (this project's first, active ones above settled ones, other
  projects and other PCs too, never the chat you're in), filtered as you type. Picking one adds
  it as a chip above the composer with its own note box. On send the agent gets a quoted block
  per mentioned chat: title, project, PC, status, recap, its last 6 prompts and final answers
  (about 8 KB at most), and the chat's id and link, so it can `message_chat` it. The sent
  message shows the chip; a click (or tap on the phone) opens that chat. On the phone a tap on
  the composer's chip opens the chat and a long-press removes it. Hub API: `trigger=$` on the
  tags lists, mention `kind: "chat"`.

## [0.71.0] - 2026-10-28

### Added
- Steer and Queue, side by side (modeled on T3 Code), on the desktop, the phone and from other
  PCs. While the agent works, a message either **steers** it (Claude takes it in at once, ending
  what it was doing; Codex is stopped and resumes its session with it) or is **queued** (it runs
  after the current turn, one message per turn, in order). Steer is the default; Settings ›
  General › "While the agent works, Enter…" (phone: Settings › While the agent is running)
  switches it to Queue. Ctrl+Enter (or Ctrl-click; long-press send on the phone) does the other
  for one message, and the send button's icon says which (holding Ctrl flips it). Agents that
  can't be steered (Cursor, Gemini, Grok, OpenCode, Meta) always queue.
- Queued messages show as dashed "Up next" bubbles under the turn. Each can be edited in place
  (it keeps its place; Alt+↑ edits the latest), moved (right-click the grip; phone: long-press),
  removed, or sent as a steer (Ctrl+Shift+Enter steers the oldest; "Send now" when idle). A
  steered message shows "Steering…" until the agent takes it in, then a small "Steer" caption.
  A steer is never lost: if the turn just ended it runs as the next turn, if it can't land it
  goes back to the top of the queue, said so.

### Changed
- Queued messages now wait for the turn to end instead of slipping into it at the next tool call
  (injecting mid-turn is Steer's job). Stop (and Esc) holds the queue instead of returning it to
  the composer: ▶ Resume queue (or the next message you send) runs it. Hub API: optional `mode`
  on send, queue ids and `queue/{id}` calls, `can_steer`/`held` in the status, `intent` on user
  items; older phones and hubs keep the plain queue.

## [0.70.0] - 2026-10-28

### Added
- Chat links: every chat, sub-agent chats included, has a link `harbor://chat/<id>` that agents
  can put in a reply. The desktop shows it as the chat's title and opens the chat on a click; the
  phone shows the title too and opens the chat in the app on a tap (only chat links: other
  harbor:// links stay plain text). A chat that's gone or on a PC that's off gets a short notice.
  Agents find chats with the new `find_chats` tool (by title or agent name, across projects and
  PCs), and `list_chats` / `list_agents` now give each chat's link (#84).

## [0.69.0] - 2026-10-28

### Added
- Phone: long-pressing a message offers what the desktop's hover bar does, in a bottom sheet with
  the message's time on top: Copy, Quote in reply (your messages), Fork from this response (a
  finished reply) and Mention in your next message, which adds the same mention chip the desktop's
  composer gets. Tool calls, notices and messages can be mentioned with a long-press too. The hub
  serves each card's actions, so the desktop and the phone always offer the same ones (#89).

## [0.68.0] - 2026-10-28

### Added
- Agents can see the Harbor version on every device (#85): the `machines` server's `list` now
  ends with each PC's Harbor version and update status (managed install or not, latest release,
  update ready / installing / checking, auto-update; offline PCs with the version they last ran)
  and each paired phone's app version, when and where it was last seen. The who-is-who note
  every chat gets lists each PC's version too ("desk: … Harbor 0.68.0 (latest, updates
  automatically); phones: Pixel (app 0.68.0)"). Settings › Devices shows each PC's version, and
  the phone's PCs sheet gets "Harbor on your phones" plus the last version of a PC that doesn't
  answer. The hub now keeps phones' last-seen time and app version across restarts. Old phones
  and hubs show "unknown". Hub API: `GET /v1/versions`.

## [0.67.2] - 2026-10-28

### Fixed
- Bare http/https URLs in agent replies are now tappable on the phone, matching the desktop.
  Existing links and inline/fenced/indented code stay intact on both screens. Fixes #87.

## [0.67.1] - 2026-10-28

### Fixed
- Terminal commands now stop quietly when piped to a reader that closes early, without a
  panic or core dump. The desktop/background hub and socket/stdio servers keep handling
  disconnects safely; MCP servers finish cleanly when their output closes. Fixes #86.

## [0.67.0] - 2026-10-28

### Changed
- Another PC in your mesh now gets "Everything" (shell, any file, your GitHub login) on this PC
  until you pick a level for it, instead of "Read my projects". Pick one per PC under Your PCs.

## [0.66.0] - 2026-10-27

### Added
- A chat that works in its own worktree now says so everywhere, on the desktop and the phone: a
  "Worktree · harbor/a1b2c3" chip next to the chat's title (its live branch; a click or tap
  opens the Workspace menu; red "Worktree gone" when the folder was removed), a folder-git mark
  on its row in the sidebar and the phone's chat list, and a line in the chat when the worktree
  is made: "Working in a new worktree · harbor-a1b2c3 on branch harbor/a1b2c3 (from main)" (or
  "Moved to a new worktree · …"). A new chat with New worktree picked shows "New worktree ·
  from main" in its header until the first message makes it. The header no longer shows the
  checkout's branch for a chat that works elsewhere. Another PC's copy of the chat shows the
  chip and mark too. Hub API: optional `worktree` on every chat, notice icon `worktree`.

### Changed
- The bar under the composer reads "Worktree · harbor-a1b2c3" instead of only the folder's name.

## [0.65.1] - 2026-10-27

### Fixed
- Shared composer draft: who's writing ("✎ Pixel 9") now has its own row in the desktop
  composer instead of being drawn over its top edge (it collided with a mentioned message),
  and another device's draft no longer leaves your cursor at the start: a cursor at the end
  of the text stays at the end.

## [0.65.0] - 2026-10-27

### Added
- Projects without Git: Add project › New project now also offers **Create “name” without Git**,
  a plain folder in ~/Projects with no repository and no GitHub, just to keep chats organized.
  Chats in it work as anywhere else on the desktop and the phone; Git-only parts stay out of the
  way: no workspace/branch bar, no Pull requests/Issues in the project's menu, and a phone that
  still has "New worktree" picked starts the chat in the folder instead of failing. `@` in the
  composer now lists the files of a folder without Git too (from disk, hidden folders and
  node_modules/target left out).

### Changed
- A project without a Git remote that another PC shares no longer offers to clone what can't be
  cloned: the line under the chat says so and offers **Use a folder here** (pick the folder that
  holds it; the waiting message then runs there) or Run on its PC, on the desktop and the
  phone. Starting a chat with such a project on another PC, or moving one there, says plainly
  that its folder must be added to Harbor there first.

## [0.64.1] - 2026-10-27

### Fixed
- Phone: the chat list (the drawer and the Chats screen) is back. Since 0.55.2 the hub sent the
  sidebar's placement with its own chat ids while the phone names chats by their global id, so
  no chat matched and the list stayed empty under Settings. The hub now sends the placement by
  global id too, and the app groups the chats itself when a PC still runs an older Harbor.

## [0.64.0] - 2026-10-27

### Changed
- One shared composer per chat: what someone types on another device now appears inside your
  composer, on the desktop and the phone, as if you were typing it: the text, attached images
  (with their thumbnails) and files, and mentioned messages. Whoever edits takes over and their
  draft goes out the same way (last writer wins; a composer edited in the last second isn't
  overwritten). Sending from any device, or emptying the composer, empties it everywhere. A
  small "✎ Galaxy A13" in the composer's corner says who's writing; the line above the composer
  is gone. The draft stays in the composer after they stop typing. A message sent while someone
  else was typing no longer waits for them. Chats on another PC share text and mentions, while
  their files stay on each device. Hub API: `draft` on `POST /v1/chats/{id}/typing` and on every
  chat.

## [0.63.1] - 2026-10-27

### Fixed
- Phone: the app installs again on phones with a 32-bit Android (it was missing the armeabi-v7a
  dictation library since 0.55, so Android refused it with INSTALL_FAILED_NO_MATCHING_ABIS). When
  an update doesn't install, the phone now says why in plain words when Android's reason isn't
  Play Protect (wrong processor, no space, a different signature).

## [0.63.0] - 2026-10-27

### Added
- Runs on, after the first message: a started Claude chat can switch where it runs from the
  composer's "Runs on" picker (desktop) or the Device row of its run settings (phone): this PC,
  another SSH device, or another PC of the mesh. Its Claude session goes along (fetched from the
  device or put on it over ssh), and the next turn resumes it there. Places it can't go to now
  are greyed out with the reason (a turn running, the device offline, an older Harbor there…),
  and when the agent's files change place, uncommitted changes in the folder it leaves stop the
  move ("commit or stash them first"). "Move to PC…" now also takes chats that run on an SSH
  device.

## [0.62.0] - 2026-10-27

### Added
- A project another PC shares is no longer a dead end on your PC: its git remote is shared with
  it, and the first chat you run in it here uses your own clone of the same repository, or
  clones it with this PC's git/gh login into the same place relative to your home ("Cloning…" in
  the chat; the message runs once it's there). Each PC keeps its own folder for the project.
- When the clone can't be made (no access, no remote), a line under the chat offers **Clone
  here** (pick a folder) and **Run on <owner>** (the message starts a chat on the PC that has the
  project), on the desktop and the phone (`status.folder`, `POST /v1/chats/{id}/clone` and
  `…/run_on`).

## [0.61.0] - 2026-10-27

### Added
- Move to PC: a finished chat can move to another PC of your mesh and go on there, with its
  sub-agents and their Claude sessions. Right-click a chat in the sidebar › "Move to PC…" on the
  desktop, or long-press it › "Move to PC…" on the phone; PCs that can't take it are greyed out
  with the reason. The other PC needs the project (matched by its git remote, then its name) and
  a Claude account; the chat must have no uncommitted changes where it works, and a chat in its
  own worktree has its branch pushed and checked out there. Claude chats only for now.

## [0.60.0] - 2026-10-27

### Added
- Gmail app: sign in to Gmail under Settings › Integrations › Apps with your own Google OAuth
  client (Desktop app; the card says how to create one) and the agents Harbor starts can search,
  read and send mail, reply in a conversation, keep drafts, download attachments, move mail
  between labels, archive, mark read or starred, trash, and manage labels and filters. Harbor
  serves it itself (`harbor app gmail`), so the token never leaves Harbor's store. Agents on
  every device get it; signing in is on the desktop, like the other apps.

## [0.59.2] - 2026-10-27

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

[Unreleased]: https://github.com/RDevNeo/harbor/compare/v0.109.0...HEAD
[0.109.0]: https://github.com/RDevNeo/harbor/compare/v0.108.0...v0.109.0
[0.108.0]: https://github.com/RDevNeo/harbor/compare/v0.107.0...v0.108.0
[0.107.0]: https://github.com/RDevNeo/harbor/compare/v0.106.1...v0.107.0
[0.106.1]: https://github.com/RDevNeo/harbor/compare/v0.106.0...v0.106.1
[0.106.0]: https://github.com/RDevNeo/harbor/compare/v0.105.0...v0.106.0
[0.105.0]: https://github.com/RDevNeo/harbor/compare/v0.104.0...v0.105.0
[0.104.0]: https://github.com/RDevNeo/harbor/compare/v0.103.0...v0.104.0
[0.103.0]: https://github.com/RDevNeo/harbor/compare/v0.102.1...v0.103.0
[0.102.1]: https://github.com/RDevNeo/harbor/compare/v0.102.0...v0.102.1
[0.102.0]: https://github.com/RDevNeo/harbor/compare/v0.101.1...v0.102.0
[0.101.1]: https://github.com/RDevNeo/harbor/compare/v0.101.0...v0.101.1
[0.101.0]: https://github.com/RDevNeo/harbor/compare/v0.100.0...v0.101.0
[0.100.0]: https://github.com/RDevNeo/harbor/compare/v0.99.0...v0.100.0
[0.99.0]: https://github.com/RDevNeo/harbor/compare/v0.98.0...v0.99.0
[0.98.0]: https://github.com/RDevNeo/harbor/compare/v0.97.2...v0.98.0
[0.97.2]: https://github.com/RDevNeo/harbor/compare/v0.97.1...v0.97.2
[0.97.1]: https://github.com/RDevNeo/harbor/compare/v0.97.0...v0.97.1
[0.97.0]: https://github.com/RDevNeo/harbor/compare/v0.96.1...v0.97.0
[0.96.1]: https://github.com/RDevNeo/harbor/compare/v0.96.0...v0.96.1
[0.96.0]: https://github.com/RDevNeo/harbor/compare/v0.95.0...v0.96.0
[0.95.0]: https://github.com/RDevNeo/harbor/compare/v0.94.0...v0.95.0
[0.94.0]: https://github.com/RDevNeo/harbor/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/RDevNeo/harbor/compare/v0.92.0...v0.93.0
[0.92.0]: https://github.com/RDevNeo/harbor/compare/v0.91.1...v0.92.0
[0.91.1]: https://github.com/RDevNeo/harbor/compare/v0.91.0...v0.91.1
[0.91.0]: https://github.com/RDevNeo/harbor/compare/v0.90.0...v0.91.0
[0.90.0]: https://github.com/RDevNeo/harbor/compare/v0.89.0...v0.90.0
[0.89.0]: https://github.com/RDevNeo/harbor/compare/v0.88.0...v0.89.0
[0.88.0]: https://github.com/RDevNeo/harbor/compare/v0.87.0...v0.88.0
[0.87.0]: https://github.com/RDevNeo/harbor/compare/v0.86.0...v0.87.0
[0.86.0]: https://github.com/RDevNeo/harbor/compare/v0.85.1...v0.86.0
[0.85.1]: https://github.com/RDevNeo/harbor/compare/v0.85.0...v0.85.1
[0.85.0]: https://github.com/RDevNeo/harbor/compare/v0.84.1...v0.85.0
[0.84.1]: https://github.com/RDevNeo/harbor/compare/v0.84.0...v0.84.1
[0.84.0]: https://github.com/RDevNeo/harbor/compare/v0.83.0...v0.84.0
[0.83.0]: https://github.com/RDevNeo/harbor/compare/v0.82.0...v0.83.0
[0.82.0]: https://github.com/RDevNeo/harbor/compare/v0.81.0...v0.82.0
[0.81.0]: https://github.com/RDevNeo/harbor/compare/v0.80.0...v0.81.0
[0.80.0]: https://github.com/RDevNeo/harbor/compare/v0.79.0...v0.80.0
[0.79.0]: https://github.com/RDevNeo/harbor/compare/v0.78.0...v0.79.0
[0.78.0]: https://github.com/RDevNeo/harbor/compare/v0.77.0...v0.78.0
[0.77.0]: https://github.com/RDevNeo/harbor/compare/v0.76.0...v0.77.0
[0.76.0]: https://github.com/RDevNeo/harbor/compare/v0.75.0...v0.76.0
[0.75.0]: https://github.com/RDevNeo/harbor/compare/v0.74.2...v0.75.0
[0.74.2]: https://github.com/RDevNeo/harbor/compare/v0.74.1...v0.74.2
[0.74.1]: https://github.com/RDevNeo/harbor/compare/v0.74.0...v0.74.1
[0.74.0]: https://github.com/RDevNeo/harbor/compare/v0.73.0...v0.74.0
[0.73.0]: https://github.com/RDevNeo/harbor/compare/v0.72.3...v0.73.0
[0.72.3]: https://github.com/RDevNeo/harbor/compare/v0.72.2...v0.72.3
[0.72.2]: https://github.com/RDevNeo/harbor/compare/v0.72.1...v0.72.2
[0.72.1]: https://github.com/RDevNeo/harbor/compare/v0.72.0...v0.72.1
[0.72.0]: https://github.com/RDevNeo/harbor/compare/v0.71.0...v0.72.0
[0.71.0]: https://github.com/RDevNeo/harbor/compare/v0.70.0...v0.71.0
[0.70.0]: https://github.com/RDevNeo/harbor/compare/v0.69.0...v0.70.0
[0.69.0]: https://github.com/RDevNeo/harbor/compare/v0.68.0...v0.69.0
[0.68.0]: https://github.com/RDevNeo/harbor/compare/v0.67.2...v0.68.0
[0.67.2]: https://github.com/RDevNeo/harbor/compare/v0.67.1...v0.67.2
[0.67.1]: https://github.com/RDevNeo/harbor/compare/v0.67.0...v0.67.1
[0.67.0]: https://github.com/RDevNeo/harbor/compare/v0.66.0...v0.67.0
[0.66.0]: https://github.com/RDevNeo/harbor/compare/v0.65.1...v0.66.0
[0.65.1]: https://github.com/RDevNeo/harbor/compare/v0.65.0...v0.65.1
[0.65.0]: https://github.com/RDevNeo/harbor/compare/v0.64.1...v0.65.0
[0.64.1]: https://github.com/RDevNeo/harbor/compare/v0.64.0...v0.64.1
[0.64.0]: https://github.com/RDevNeo/harbor/compare/v0.63.1...v0.64.0
[0.63.1]: https://github.com/RDevNeo/harbor/compare/v0.63.0...v0.63.1
[0.63.0]: https://github.com/RDevNeo/harbor/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/RDevNeo/harbor/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/RDevNeo/harbor/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/RDevNeo/harbor/compare/v0.59.2...v0.60.0
[0.59.2]: https://github.com/RDevNeo/harbor/compare/v0.59.1...v0.59.2
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
