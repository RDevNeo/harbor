# Harbor

A native, lightweight desktop chat client for coding agents, organised by project.
Rust + egui (glow): no Electron, no webview, no async runtime. Linux only.

- **Providers**: Claude Code (one entry per account: `~/.claude`, `~/.claude2`, …), Codex, Cursor, Grok,
  Gemini, Meta (Muse) and OpenCode. Each is its own CLI, run headless per message; the conversation
  continues through the provider's session id. Nothing stays resident between turns.
- **Composer**: model picker (favourites, provider rail with account badges, search, Ctrl+1–9),
  reasoning effort, access level (full / auto-edit / read only), attachments (button, paste or drag and drop).
- **Projects → chats** in the sidebar, search, "Settled" section for finished chats.
- **Teams**: a lead agent can spawn sub-agents, run long processes and wake on webhooks.
- **Built-in terminal** (Ctrl+`): PTY + vt100, per-project tabs; sign-in flows and `claude --resume` run there.
- **Side panes**: a browser (optional Servo helper, `browser/`), terminals, and Devices.
- **Pages**: Settings (general, appearance, keybindings, providers/accounts, usage limits,
  integrations, webhooks), Usage (plan limits and Harbor's own token totals), Pull requests (`gh`).
- **Integrations**: GitHub, Vercel, Linear, Sentry, Supabase, Context7, Playwright, Convex presets plus custom
  servers, managed through `claude mcp` so the terminal CLI sees the same config.

## Install

An installer and packages are coming. Until then, build from source (Rust stable):

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

## Use

Data: `~/.local/share/harbor/harbor.db` (SQLite). Override the agent binary with `HARBOR_CLAUDE`.

Keys: Enter send · Shift+Enter newline · Esc stop · Ctrl+N new chat · Ctrl+` terminal · Ctrl+, settings · Ctrl+1–9 model;
rebind them in Settings → Keybindings.

`HARBOR_VIEW=draft|picker|settings|usage|prs|terminal` opens a view at start (for screenshots); a settings
page by name too (`general|appearance|keybindings|providers|limits|integrations|webhooks`).

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
