# Hub

This branch (`hub`) is Harbor's app forked as **Hub**: the same native app (Slint window, engine, agents, phone API,
Hub for Android in `android/`), in a world of its own. Harbor apps (desktop or phone) never see Hub's chats, and Hub
never talks to Harbor's PCs, phones, account service or releases.

## What differs from Harbor

| | Harbor | Hub |
| --- | --- | --- |
| Name everywhere a user or an agent reads it | Harbor | Hub |
| Install | `~/.local/lib/harbor` | `~/.local/lib/hub` (`packaging/hub-install.sh`), `~/.local/bin/hub`, `hub.desktop`, autostart |
| Data / state / socket | `~/.local/share/harbor`, `~/.local/state/harbor`, `$XDG_RUNTIME_DIR/harbor.sock` | `…/hub`, `…/hub`, `hub.sock` (the database file keeps its name `harbor.db`) |
| Phone API port | 47930 (kv `api_port`) | **47950** (kv `hub_api_port`). 47940 stays the MCP bridge's, 47920/47911 the webhooks' |
| Window app id / WM class, tray id | `harbor` | `hub` |
| Agents' MCP server | `harbor` (`mcp__harbor__*`) | `hub` (`mcp__hub__*`) |
| Other PCs for agents | the mesh's `machines` | `machines` = hub-machines (stdio, SSH on Tailscale), shipped in `~/.local/lib/hub/hub-machines/` |
| Chat links | `harbor://chat/…` | `hub://chat/…` (old links still open) |
| Worktree branches | `harbor/<name>` | `hub/<name>` (old ones still known) |
| Patches | `.harbor/patches` | `.hub/patches` (`.harbor/patches` still read) |
| Phones | Google sign-in, Harbor's directory | Google sign-in with Hub's service, or pairing: `hub pair` (QR / `hub://pair?…`), android/PROTOCOL.md "Hub pairing" |
| Account service, workspace cloud, settings sync | Harbor's (`harbor-accounts`) | Hub's own: `hub-accounts.rdevneo.workers.dev` (`worker/`, own D1, signing key `k1:HDOd…`, vault secret; Harbor's Clerk). Harbor's is never called |
| Mesh, relay, network discovery | with Harbor PCs of the workspace | with Hub PCs of the workspace only (Hub's directory; discovery on UDP 47950) |
| Phones away from home | UPnP/NAT-PMP/PCP port mapping, a port forward set by hand | a port forward set by hand (kv `net_forward`, `hub net forward PORT`): its public address goes to phones (directory, pairing links) and Hub also listens on that port when it isn't 47950 (a router that forwarded Harbor's 47930 keeps working); router mapping only with `HUB_PORTMAP=1`. ufw must let 47950/tcp (and a forward's port) in: `hub net` says what's missing |
| Updates, follow-main, previews from peers | Harbor's releases and main | none: running `packaging/hub-install.sh` again is the update (a running Hub restarts into it) |

Internal identifiers (`HARBOR_*` variables, `@harbor/*` packages, `X-Harbor-*` headers, `harbor-app.js`) keep their
names: nobody reads them, and renaming them would only make merging Harbor's changes harder.

## Workspaces

Hub's account service is a separate deploy of `worker/` ("hub-accounts": its own D1, Durable Objects, signing key and
vault secret, `APP_REDIRECT=hub://oauth`) on Harbor's Clerk instance and OAuth client: the same Google sign-ins and
the same workspaces (Clerk organizations, members, invitations), with a device directory, tokens, cloud and vault of
its own. Each Hub (desktop and phone) signs in once (Settings › Account). `HUB_ACCOUNTS_URL` in the environment
overrides `account.ts`; pairing keeps working beside it.

## Commands

- `bash packaging/hub-install.sh [--machines DIR]` builds and installs; `--stage DIR` builds only.
- `hub pair` (a phone), `hub pair list`, `hub pair remove FP`; `hub quit`; `hub api METHOD PATH [JSON]`.
- From Person Hub (creators-hub): `scripts/hub-cutover.sh` moves this PC from Harbor's engine to Hub (and `--rollback`).
