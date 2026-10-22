# Harbor

A native, lightweight desktop chat client for coding agents, organised by project.
Rust + egui (glow): no Electron, no webview, no async runtime. Linux only.

- **Providers**: Claude Code (one entry per account: `~/.claude`, `~/.claude2`, …), Codex, Cursor, Grok,
  Gemini, Meta (Muse) and OpenCode. Each is its own CLI, run headless per message; the conversation
  continues through the provider's session id. Nothing stays resident between turns.
- **Composer**: model picker (favourites, provider rail with account badges, search, Ctrl+1–9),
  reasoning effort, access level (full / auto-edit / read only), the device it runs on, attachments
  (button, paste or drag and drop).
- **Remote devices**: a chat can run its Claude Code agent on another PC (Tailscale peers are found by
  themselves, others are added by SSH). See below.
- **Projects → chats** in the sidebar, search, "Settled" section for finished chats.
- **Teams**: a lead agent can spawn sub-agents, run long processes and wake on webhooks.
- **Built-in terminal** (Ctrl+`): PTY + vt100, per-project tabs; sign-in flows and `claude --resume` run there.
- **Side panes**: a browser (optional Servo helper, `browser/`), terminals, and Devices.
- **Pages**: Settings (general, appearance, keybindings, providers/accounts, usage limits,
  integrations, devices, webhooks), Usage (plan limits and Harbor's own token totals), Pull requests (`gh`).
- **Integrations**: GitHub, Vercel, Linear, Sentry, Supabase, Context7, Playwright, Convex presets plus custom
  servers, managed through `claude mcp` so the terminal CLI sees the same config.

## Install

One build for Linux x86_64 (glibc 2.35+: Ubuntu 22.04+, Debian 12+, Fedora 36+, Arch), installed per
user into `~/.local` without sudo:

```sh
curl -fsSL https://github.com/RDevNeo/harbor/releases/latest/download/install.sh | sh
```

- `… | sh -s -- --with-browser` also installs the built-in browser's engine (Servo, about 40 MB, glibc
  2.39+); Harbor can download it later too.
- `… | sh -s -- --uninstall` removes Harbor and keeps your chats (`--uninstall --purge` deletes them).
- Offline: download `harbor-x86_64-linux.tar.gz` (and optionally `harbor-browser-x86_64-linux.tar.gz`
  beside it), extract it and run `./install.sh` in that folder; it installs those files after checking them
  against the signed `SHA256SUMS` inside.
- Files: `~/.local/lib/harbor/` (`harbor`, `harbor-stream`, `harbor-browser`), `~/.local/bin/harbor`, a
  desktop entry and icons. Remote screens use the system's OpenSSL 3, Opus, ALSA and VA-API libraries.

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

Optional helpers, each built separately:

- `browser/`: the browser pane's engine (Servo), `cd browser && cargo build --release`.
- `stream/`: `harbor-stream`, remote screens for the Devices pane (needs FFmpeg, OpenSSL, Opus and ALSA
  development files), `cd stream && cargo build --release`.

**Devices** lists your PCs and phones and opens their screens and files. It needs Remote Devices
(`remote-pcs`, a separate app) installed, found through `$HARBOR_REMOTE_DEVICES`, `remote-pcs` on `PATH`
or `$XDG_DATA_HOME/remote-pcs/remote-pcs.py`. Without it, Devices isn't offered.

### Running agents on another PC

Settings › Devices lists the PCs on your tailnet (`tailscale status --json`) and SSH hosts you add, with
a name, icon, user/key/port, the folder agents start in and a Test button. The composer's device menu
("This PC" by default) pins a new chat to one of them; a started chat stays where its session is.

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
  Linux devices (macOS should work, untested); a turn ends if the connection drops; `start_process` still starts processes
  on this PC; with the device's own files, non-image attachments are paths on this PC; server-initiated MCP streams (sampling,
  notifications) aren't carried; the per-turn token is visible in the device's process list, so treat the
  device's other local users as trusted.

## Use

Data: `~/.local/share/harbor/harbor.db` (SQLite). Override the agent binary with `HARBOR_CLAUDE`.

Keys: Enter send · Shift+Enter newline · Esc stop · Ctrl+N new chat · Ctrl+` terminal · Ctrl+, settings · Ctrl+1–9 model;
rebind them in Settings → Keybindings.

`HARBOR_VIEW=draft|picker|settings|usage|prs|terminal` opens a view at start (for screenshots); a settings
page by name too (`general|appearance|keybindings|providers|limits|integrations|devices|webhooks`);
`device` opens the composer's device menu.

## Licences and credits

- **Harbor** (this repository, apart from what's listed below): MIT, see [LICENSE](LICENSE).
- **Browser helper** (`browser/`): MIT, see [browser/LICENSE](browser/LICENSE). It links
  [Servo](https://servo.org), which is MPL-2.0.
- **harbor-stream** (`stream/`): GPL-3.0-or-later, see [stream/LICENSE](stream/LICENSE), because it links
  [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) (GPL-3.0, vendored in
  `stream/third_party/` with ENet and nanors, both MIT). It's a separate program that Harbor runs as a
  subprocess.
- **Fonts**: [Geist and Geist Mono](https://vercel.com/font) (SIL OFL 1.1, `assets/fonts/OFL.txt`) and a
  subset of [Lucide](https://lucide.dev) icons (ISC, `assets/fonts/LUCIDE-LICENSE.txt`).
- **Logos**: integration marks from [Simple Icons](https://simpleicons.org) (CC0,
  `assets/logos/SIMPLE-ICONS-LICENSE.md`) and provider marks (`assets/logos/p-*`) from
  [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT, © LobeHub, `assets/logos/LOBE-ICONS-LICENSE.txt`).
  Brand logos belong to their owners and are used only to identify the services Harbor works with.
