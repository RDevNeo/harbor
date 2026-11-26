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
| Updates | Harbor's releases and main | Hub's own branch `hub`: every push is built on the PC and swapped in; phones get new code from the PC (below) |
| Previews from peers | yes | none |

Internal identifiers (`HARBOR_*` variables, `@harbor/*` packages, `X-Harbor-*` headers, `harbor-app.js`) keep their
names: nobody reads them, and renaming them would only make merging Harbor's changes harder.

## Updates (PC and phone, over the air)

**The workflow:** merge into `hub`, `git push origin hub`. Nothing else: every Hub PC picks it up by itself.

- **PC.** The installed Hub follows `hub` of RDevNeo/harbor (`ts/packages/update/src/followmain.ts`, wired in
  `ts/run.ts`; never Harbor's `main` or releases). It watches the checkout it was installed from
  (`~/.local/lib/hub/SOURCE`, written by `hub-install.sh`): a push from this PC is noticed within ~3 s; one from
  elsewhere within a minute (`git ls-remote`). A commit that changes what the app is built from (`ts/`, `assets/`)
  is built in Hub's own clone (`~/.local/share/hub/follow-main/src`: bun install only when the lockfile changed,
  `tsc`, the bundle, `smoke-bundle`), installed beside the running one with the old kept in
  `~/.local/lib/hub/.previous`, VERSION last, and the running Hub restarts into it with the handover (new window
  first, same screen, drafts kept). If `packaging/hub-install.sh` pins another `RUNTIME=`, the whole build
  (`hub-install.sh --stage`) goes in, the runtime binary too. A start that fails, or crashes 3 times within
  minutes, rolls back to `.previous` by itself; a failed build is not retried until `hub` moves.
  `hub follow-main status` says what it's doing (and what phones are served); logs:
  `~/.local/share/hub/follow-main/build.log`. `HUB_FOLLOW_MAIN=0` turns it off for one run;
  `hub follow-main off|on` keeps it off/on. Running `packaging/hub-install.sh` by hand still works.
- **Phone.** Hub for Android is a shell (`android/shell`, version in `android/shell/shell.lock`) that runs downloaded
  app code. When a commit changes the phone's app (`android/` except tests/docs, `assets/fonts|logos`,
  `ts/package.json`), the PC builds it on boat (`scripts/boat/android`, ~3-5 min; `follow-main/phone/build.log`),
  signs the code zip, the APK and the offer, and serves them to its paired phones under `/phone/`
  (`ts/packages/update/src/phoneota.ts`, `~/.local/lib/hub/phone/`). A phone with a Hub screen up holds
  `GET /phone/wait`, so it hears within a second, downloads the code (no install, no Play Protect), and restarts
  in place on the same screen ("Updated to …"); in the background it swaps at the next quiet moment. Version
  numbers are the commit's time in seconds; names are the desktop's (`0.194.0+abc1234`).
  Only a **shell** change (manifest, permissions, `res/`, `android/shell/src`, native libraries: `lock.sh check`
  fails the build until `android/shell/lock.sh bump`) needs a new APK: the PC builds and signs it too, and the
  app downloads it and asks to install it itself (Settings › Update).
- **Keys** (never print or commit them; backups in `~/.local/share/hub/keys/`):
  - `~/.local/share/hub-android/hub-code.key`: Hub's code key (minisign/Ed25519). Its public half is
    `Minisign.HUB_PUBKEY` in the shell; a phone takes nothing it didn't sign. Losing it means a new shell APK.
  - `~/.local/share/hub-android/hub-android.jks` (alias `hub`, password in `hub-android.pass` beside it): the APK
    signing keystore (since shell 6, 2026-11-26). Every APK must be signed with it, or phones must uninstall first.
    Sign by hand: `~/Android/Sdk/build-tools/36.0.0/apksigner sign --ks ~/.local/share/hub-android/hub-android.jks
    --ks-key-alias hub --ks-pass file:$HOME/.local/share/hub-android/hub-android.pass --out OUT.apk IN.apk`.
  No install or cleanup script touches `~/.local/share/hub-android` or `~/.local/share/hub/keys`.

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
