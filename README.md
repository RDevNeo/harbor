# Harbor

A native, lightweight desktop chat client for coding agents, organised by project.
Rust + egui (glow): no Electron, no webview, no async runtime. Linux only.

- **Providers**: Claude Code (one entry per account: `~/.claude`, `~/.claude2`, …), Codex, Cursor, Grok,
  Gemini, Meta (Muse) and OpenCode. Each is its own CLI, run headless per message; the conversation
  continues through the provider's session id. Nothing stays resident between turns.
- **Composer**: model picker (favourites, provider rail with account badges, search, Ctrl+1–9),
  reasoning effort, access level (full / auto-edit / read only), the device it runs on, attachments
  (button, paste or drag and drop).
- **Remote devices**: a chat can run its Claude Code agent on another PC (your paired PCs show up by
  themselves, others are added by SSH). See below.
- **Your phone and other PCs**: Harbor for Android (`android/`) and Harbor on your other PCs share
  chats over your own network, every connection mutual TLS pinned to each device's own key; pair a
  phone with a QR code and a PC with a one-time code (`harbor mesh pair`). PCs find each other on
  the network, ask the router to open Harbor's port (UPnP, NAT-PMP, PCP; or use a port forward you
  set: `harbor net forward <port>`, `harbor net name <ddns name>`; `harbor net` shows the result), use IPv6 directly and go through another PC when they can't reach each other. No VPN
  or other software.
- **Projects → chats** in the sidebar, search, "Settled" section for finished chats.
- **Teams**: a lead agent can spawn sub-agents, run long processes and wake on webhooks (public over
  HTTPS with a Let's Encrypt certificate Harbor gets itself, `/hooks/<token>` only).
- **Secrets**: API keys agents use by name without seeing them (Settings › Secrets, or an agent
  asks with `request_secret`, saying where to get one). Each use needs your approval for a time
  you pick; `run_with_secrets` runs a command with them set and hides their values in its output.
  They stay on this PC (`secrets.json`, 0600), never in chats or the mesh. On request Harbor also
  writes one to the project's `.env` file, which is plain text the agent's own tools can read.
- **Built-in terminal** (Ctrl+`): PTY + vt100, per-project tabs; sign-in flows and `claude --resume` run there.
- **Side panes**: a browser (Servo, in its own `harbor-browser` process from `browser/`; no Chromium, Electron or system WebView), terminals, and Devices (your paired
  PCs and phones: send them text, images and files).
- **Pages**: Settings (general, appearance, keybindings, providers/accounts, usage limits,
  integrations, secrets, devices, webhooks), Usage (plan limits and Harbor's own token totals), Pull requests (`gh`).
- **Integrations**: GitHub, Vercel, Linear, Sentry, Supabase, Context7, Playwright, Convex, Gmail presets plus custom
  servers, managed through `claude mcp` so the terminal CLI sees the same config.

## Install

Builds for Linux x86_64 and aarch64 (glibc 2.35+: Ubuntu 22.04+, Debian 12+, Fedora 36+, Arch),
installed per user into `~/.local` without sudo:

```sh
curl -fsSL https://github.com/RDevNeo/harbor/releases/latest/download/install.sh | sh
```

- The built-in browser's engine (Servo, about 45 MB) comes with it on x86_64 and aarch64 with glibc
  2.39+ (Ubuntu 24.04+, Debian 13+, Fedora 40+, Arch); on older systems Harbor installs without it.
  `… | sh -s -- --no-browser` leaves it out (`--with-browser` adds it back). Copies installed
  before it came by default fetch it by themselves.
- `… | sh -s -- --uninstall` removes Harbor and keeps your chats (`--uninstall --purge` deletes them).
- Offline: download `harbor-x86_64-linux.tar.gz` or `harbor-aarch64-linux.tar.gz` (and
  `harbor-browser-<arch>-linux.tar.gz` beside it for the browser engine, else it's downloaded), extract it and run `./install.sh` in that folder; it installs those files after checking them
  against the signed `SHA256SUMS` inside.
- install.sh checks every download against the release's minisign signature, fetching a pinned static
  minisign when none is installed; `HARBOR_INSECURE=1` installs without that check.
- Files: `~/.local/lib/harbor/` (`harbor`, `harbor-browser`), `~/.local/bin/harbor`, a desktop entry
  and icons.

### What a fresh PC needs

Required:

| | |
|---|---|
| A Wayland or X11 session with OpenGL/EGL | loaded at runtime (Mesa is enough) |
| `curl`, `tar`, `sha256sum` | the installer and the self-updater |
| An agent CLI, signed in | Claude Code, Codex, Cursor, Grok, Gemini, OpenCode… Codex, Grok and Gemini install with npm, so they need [Node.js](https://nodejs.org) |

Optional (only that feature is off without it):

| Program | For |
|---|---|
| `zenity` (or `kdialog`) | file pickers: Attach, project and device icons, Devices uploads (drag and drop and paste work without it) |
| `wl-clipboard` | reliable clipboard on Wayland (arboard is the fallback) |
| `git`, `gh` | projects, diffs, cloning, the Pull requests and Issues pages |
| `notify-send`, `xdg-open` | notifications, opening links and files |
| `ssh` | terminals, files and agents on your other PCs |
| `rg` | the grep tool for agents on other PCs working on this PC's files |
| `fontconfig` (glibc 2.39+) | the built-in browser's engine (every desktop has it) |
| `rsvg-convert` or `magick` | SVG project favicons |
| `npx` | Convex login |
| Hyprland or Sway | raising the open window when you launch Harbor again |

install.sh notes the missing optional ones at the end.

Harbor updates itself: it checks GitHub Releases, verifies the download's
[minisign](https://jedisct1.github.io/minisign/) signature (key
`RWSaeVHfD2GBvTEgaNXQQs8eQR5rCD50vuckgoo79X6wqhOKXIpUVHNh`), swaps the new version in and reloads
without stopping running agents. Settings › General › Updates turns automatic installs off, checks now,
or restores the previous version. Releases also carry `SHA256SUMS` and GitHub build attestations
(`gh attestation verify <file> --repo RDevNeo/harbor`). Changes: [CHANGELOG.md](CHANGELOG.md).

### From source

Rust stable:

```sh
cargo build --release   # target/release/harbor
```

The browser pane's engine (Servo, `browser/`) is a separate program, built separately:
`cd browser && cargo build --release` (or the pane's "Build engine"). Releases ship it prebuilt.

**Devices** (a side pane) lists what is paired with this Harbor: your other PCs (Settings › Devices)
and phones running Harbor for Android (Settings › Phones), online or not. Send puts text or an image
on a device's clipboard, or sends it images (they open there) and files (its Downloads). A phone
picks them up while the app is open; they wait on this PC for up to a day. PCs also get a terminal
and a file browser over ssh (through `harbor nc`, with Settings › Devices' login).

### Running agents on another PC

Any PC with an SSH server and Claude Code can be a device: Linux, macOS or Windows, with or without
Harbor, no Tailscale needed. Settings › Devices lists the SSH hosts you add (by name, IP or
`~/.ssh/config` alias; your `~/.ssh/config` hosts and the PCs announcing ssh on your network over mDNS,
via `avahi-browse` when it's installed, are offered as one-click adds), the PCs paired with this one
and, while Tailscale is installed, its other PCs, with a name, icon, user/key/port, the folder agents
start in and a Test button. The composer's device menu ("This PC" by default) pins a new chat to one of
them; a started chat stays where its session is.

- Harbor finds each device's OS on its first connection (the Test button, or the first time it's
  shown) and keeps it: Linux, macOS and BSD get a POSIX `sh` script; Windows (OpenSSH Server, with cmd
  or PowerShell as its shell) gets a fixed `powershell -EncodedCommand` line that reads its script from
  stdin, so no prompt length hits cmd's 8191-character limit. Claude Code is found on the login shell's
  PATH or where its installers put it (`~/.local/bin`, Homebrew, npm, bun, mise, volta; on Windows
  `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm`, scoop, winget).
- On a new device: macOS, System Settings › General › Sharing › Remote Login; Windows, Settings ›
  System › Optional features › OpenSSH Server, then `Start-Service sshd` (and
  `Set-Service sshd -StartupType Automatic`); put this PC's public key in `~/.ssh/authorized_keys`
  (Windows admins: `C:\ProgramData\ssh\administrators_authorized_keys`), install Claude Code there.
- Devices added as Tailscale peers before (not paired PCs) move onto an `~/.ssh/config` alias of the
  same machine when there is one (its `HostName` or name is the peer's machine name), chats and all.

- ssh reaches a paired PC through `harbor nc` (its ProxyCommand): the PC's address on your network,
  or a stream through another paired PC that reaches it.
- The turn runs `ssh <device> claude -p …` under Harbor's detached runner, so it streams, takes messages
  mid-turn and survives a Harbor reload like a local turn. On the device it runs in a login shell, in the
  device's folder (the project's path mirrored under its home, or the device's folder + project name),
  under the device's own Claude login (`~/.claudeN` too, when the device has it). Only key-based ssh and
  Claude Code are needed there.
- **The bridge** (`src/bridge.rs`) gives the remote agent this PC's MCP servers: Harbor serves them on
  `127.0.0.1` as streamable-HTTP MCP and `ssh -R` forwards that port to the device's `127.0.0.1`; the
  remote `--mcp-config` points there, with a random per-turn token in each URL. Stdio servers (Omarchy,
  Blender, Playwright, Harbor's own team tools…) run here; HTTP apps (GitHub, Vercel…) are proxied with
  their tokens added here, so no credential is copied to the device. The bridge's own `origin` server
  offers your `~/.claude/commands` and `~/.claude/skills` as prompts and, if the device is allowed it,
  `run_command` on this PC.
- **Work on this PC's files** (per device, on by default): the remote Claude runs without its own Bash,
  Read, Write, Edit, Glob, Grep (and LSP, Monitor, worktrees) and starts in its home, so the project
  needn't exist there; `origin` offers `bash`, `read`, `write`, `edit`, `glob` and `grep` instead
  (`src/workspace.rs`), running here in the chat's project, so edits, builds and git commits happen in
  one place. They follow Claude Code's tools (bash keeps its folder per chat, has timeouts and a
  background option; edit is exact-string replace; grep is ripgrep), the project's `CLAUDE.md` files
  go into the system prompt, and the chat's access applies: read only gets read/glob/grep, auto-edit adds
  write/edit, full adds bash. Off: everything runs on the device, in its mirrored copy of the project.
- Limits: Claude Code only (other CLIs stay local; their subagents of a remote lead run here); tested with
  Linux and macOS devices, Windows only with PowerShell 7 running the generated scripts (not yet on a real
  Windows PC); a turn ends if the connection drops; `start_process` still starts processes
  on this PC; with the device's own files, non-image attachments are paths on this PC; server-initiated MCP streams (sampling,
  notifications) aren't carried; the per-turn token is visible in the device's process list, so treat the
  device's other local users as trusted.

## Use

Data: `~/.local/share/harbor/harbor.db` (SQLite). Override the agent binary with `HARBOR_CLAUDE`.

Keys: Enter send · Shift+Enter newline · Esc stop · Ctrl+N new chat · Ctrl+` terminal · Ctrl+, settings · Ctrl+1–9 model;
rebind them in Settings → Keybindings.

`HARBOR_VIEW=draft|picker|settings|usage|prs|terminal` opens a view at start (for screenshots); a settings
page by name too (`general|appearance|keybindings|providers|limits|integrations|secrets|devices|webhooks`);
`device` opens the composer's device menu.

## Licences and credits

- **Harbor** (this repository, apart from what's listed below): MIT, see [LICENSE](LICENSE).
- **Browser helper** (`browser/`): MIT, see [browser/LICENSE](browser/LICENSE). It links
  [Servo](https://servo.org), which is MPL-2.0.
- **Fonts**: [Geist and Geist Mono](https://vercel.com/font) (SIL OFL 1.1, `assets/fonts/OFL.txt`) and a
  subset of [Lucide](https://lucide.dev) icons (ISC, `assets/fonts/LUCIDE-LICENSE.txt`).
- **Logos**: integration marks from [Simple Icons](https://simpleicons.org) (CC0,
  `assets/logos/SIMPLE-ICONS-LICENSE.md`) and provider marks (`assets/logos/p-*`) from
  [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT, © LobeHub, `assets/logos/LOBE-ICONS-LICENSE.txt`).
  Brand logos belong to their owners and are used only to identify the services Harbor works with.
