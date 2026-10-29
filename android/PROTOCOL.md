# Harbor phone API (v1)

The contract between Harbor for Android and a desktop Harbor (the "hub"). Implemented in
`src/api.rs`; this file is the reference for both sides.

## Transport

- HTTP/1.1 inside TLS, JSON bodies (UTF-8), `Connection: close` on every response.
- The hub listens on every interface, port **47930** by default (kv `api_port`, applies after a
  restart; `HARBOR_LISTEN=addr,…` picks addresses). Turned on in Settings › Phones (and on its
  own when the PC signs in).
- **Keys.** The hub and each phone have a long-term key of their own: the hub an ECDSA P-256 key
  and self-signed certificate in `identity.pem` in its state dir (owner-only), the phone an EC
  P-256 key in the Android Keystore (non-exportable, alias `harbor-tls`) with the certificate the
  Keystore makes. A key's *fingerprint* is the SHA-256 of its certificate's
  SubjectPublicKeyInfo, 64 lowercase hex characters.
- **Mutual TLS, pinned.** TLS 1.3 (the hub also takes 1.2 from phones whose Android has no 1.3).
  The phone checks that the hub's certificate has the fingerprint from its workspace's
  directory ([Accounts](#accounts)), and nothing else (no CA, no names); it shows its own
  certificate. The handshake signatures are checked against that same key.
- **Who calls** (from 0.85): every call but `GET /app.apk` carries
  `Authorization: Bearer <Harbor token>`, the phone's Google sign-in ([Accounts](#accounts)). The
  hub checks it itself, offline, on every call: signed by the account service, not expired,
  `kind: "phone"`, `dev` = the fingerprint of this connection's client key, and the hub's
  workspace in `ws`. Optional `X-Harbor-Device: <phone name>` (Settings › Phones and Devices show
  it) and, from app 0.19, `X-Harbor-App: <versionCode>` (Devices and Settings › Phones show the
  app's version and say when it's out of date; the other PCs learn it through
  `GET /mesh/v1/phones`). The versionCode is the whole app version
  (`major*1000000 + minor*1000 + patch`, the versionName is Cargo.toml's version), so the hub
  derives the versionName from it. From 0.68 the hub keeps each phone's last-seen time and app
  version across restarts (kv `phones_seen`) and agents read them (`GET /v1/versions`, the
  `machines` `list` tool, the who-is-who note).
  From app 0.84, `X-Harbor-Platform: <what the phone is>` (free text, at most 240 characters:
  maker and model, Android version and SDK, ABIs, and whether the built-in browser runs, e.g.
  `Samsung SM-A135M, Android 12 (SDK 31), ABIs armeabi-v7a, armeabi, browser: no (32-bit
  Android)`): kept with the phone like its version, shared with the mesh (`/mesh/v1/phones`
  `platform`) and shown in `GET /v1/versions` (`phones[].platform`, appended to `line`).
- **Plain HTTP** is answered only from 127.0.0.1 (`adb reverse`, test rigs). Elsewhere it gets
  `426` and nothing else. One exception while users upgrade: a hub that still has Tailscale
  answers plain HTTP on its Tailscale interface, from Tailscale addresses (apps before 0.13; they
  can only update themselves there).
- A TLS client without a known key gets nothing but `GET /app.apk` and PC pairing
  (`POST /mesh/v1/pair`). From outside private networks (a public IPv6, a forwarded port) the
  handshake itself needs a key the hub knows: a PC of its workspace or paired by hand, or a
  device of one of the workspace's members (the directory's `devices`). Failed authentications
  are counted per address (IPv6 per /64): past 30 a minute, connections are closed without an
  answer. At most 12 connections per address at once.
- Request bodies need `Content-Length` (no chunked encoding). JSON bodies ≤ 2 MB, uploads ≤ 200 MB.
- Errors: a status code and `{"error": "<message for the user>"}`.
  `401` the sign-in is missing, expired or not this device's, with `signin: true` (the app signs
  in again; a pairing from before accounts also gets `upgrade: true`), `403` signed in but not
  in this PC's workspace (or removed from it), `400` bad input, `404` no such chat/route, `409`
  not possible now (e.g. fork of a running turn), `413` too large, `503` Harbor busy/closing.
- When phone access is turned off, connections are closed without an answer.
- The app sends nothing but pinned TLS to PCs, and HTTPS (the platform's CAs) to Clerk and the
  account service.

## Accounts

From 0.85 every device, each Harbor desktop and each phone, signs in with Google. There's no
pairing: a phone signs in, gets the PCs of its workspaces from the account service, and connects
to them directly (pinned TLS, the fingerprint from the directory). Code: `src/account.rs`,
`src/settingsync.rs`, `src/accountui.rs` (desktop), `Account.java` (phone), `worker/` (the
service).

- **Clerk** is the identity provider: an OAuth 2.0 / OIDC "OAuth application", a *public*
  client with PKCE (S256), Google as its only sign-in method. Endpoints on Clerk's Frontend API
  (`HARBOR_CLERK_URL`, placeholder `https://clerk.harbor.example`):
  - `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=openid profile email offline_access&code_challenge=…&code_challenge_method=S256&state=…&prompt=login`
  - `POST /oauth/token` form: `grant_type=authorization_code&code&redirect_uri&client_id&code_verifier`,
    or `grant_type=refresh_token&refresh_token&client_id` → `{access_token, refresh_token, id_token, expires_in}`.
  - `GET /oauth/userinfo` (`Authorization: Bearer <access token>`) → `{sub, email, name, …}`.
- **Redirects.** Desktop: `http://127.0.0.1:<any port>/callback` (a loopback listener, RFC 8252;
  registered in Clerk as `http://127.0.0.1/callback`). Phone: `<service>/oauth/android`, which
  answers `302` to `harbor://oauth?<the same query>`, so the browser (a Custom Tab where there
  is one) hands the code to the app; the code is useless without the app's PKCE verifier.
- **The account service** (`worker/`, a Cloudflare Worker; `HARBOR_ACCOUNTS_URL`, placeholder
  `https://accounts.harbor.example`) holds Clerk's secret key. Workspaces are Clerk
  organizations: each account gets its own at its first sign-in (`personal`), and owners
  (`org:admin`) invite people by email. The invitation waits in the invited person's Harbor
  (desktop and phone) once they sign in with that address (Google addresses are verified),
  and only their **Accept** joins the workspace (the Worker adds the membership through Clerk's
  Backend API); Decline turns it down. Invitations are the Worker's own (D1, keyed by lowercase
  email), not Clerk's: Clerk only has those on instances that accept email addresses. No email
  is sent. Roles: `owner`
  (invites, removes) and `member`; both control every PC and chat of the workspace.

### Harbor tokens

A JWT `b64url(header).b64url(payload).b64url(signature)`, header
`{"alg":"EdDSA","typ":"JWT","kid":"k1"}`, Ed25519 over the ASCII `header.payload`:

```json
{"iss": "harbor-accounts", "sub": "user_…", "email": "sam@example.com", "name": "Sam Rig",
 "ws": ["org_a", "org_b"], "dev": "<fingerprint of the device's TLS key>", "kind": "phone",
 "iat": 1730000000, "exp": 1730604800}
```

Good for 7 days; devices ask for a new one about daily. PCs verify it with the service's public
keys (shipped in the build, `account::KEYS`; a build without them fetches `GET /v1/keys` over
HTTPS once; tests set `HARBOR_ACCOUNTS_KEYS=kid:base64url,…`). A PC lets a phone in when the
token is valid, its `dev` is this connection's client key, and the PC's own workspace is in `ws`
— **unless** the PC's cached directory of that workspace is newer than the token's `iat` and no
longer lists `sub` among the members (removed) or `dev` among the devices (signed out of that
phone): then `403`/`401`. A PC in no workspace, or in another one, takes nobody (Option A).

### Signing in

1. OAuth with Clerk as above (PKCE). The device keeps Clerk's tokens privately (desktop:
   `<state>/account.json`, 0600; phone: encrypted with a Keystore key), never in the database and
   never synced.
2. `POST <service>/v1/session` with `Authorization: Bearer <Clerk access token>`:
   ```json
   {"device": {"kind": "phone", "name": "Pixel 8", "spki": "<base64 DER SPKI of the TLS key>",
               "ts": 1730000000, "sig": "<base64 ECDSA-P256-SHA256 signature>"}, "app": "0.80.0"}
   ```
   `sig` (DER or raw r‖s) signs `harbor-device-v1\n<ts>\n<sha256 hex of the access token>`, so
   the service knows the device holds its key; `ts` within 10 minutes of the service's clock.
   → `{"account": {"id", "email", "name", "image"}, "workspaces": [{"id", "name", "role", "personal"}],
   "token": "<Harbor token>", "exp", "device": {"fp"}, "invites": [<pending invitation>], "joined": [], "pc"?}`.
   `invites`: invitations waiting for this account (below); nothing joins at sign-in
   (`joined` stays empty, kept for clients of the first version). `pc` (desktops only, when the
   PC is already in a workspace): `{"ws", "ws_name", "owner", "member"}`; with `member: false`
   the desktop drops the sign-in: **someone else's PC stays theirs**.
3. A PC picks its workspace (asked when there are several) and registers:
   `POST /v1/pcs {"ws", "id": "<mesh id>", "name", "addrs": ["host:port", …], "version"}` (every
   5 minutes and when its addresses change). `403` with `ws`/`ws_name`/`owner` when the PC is in a
   workspace the account isn't in.
4. Every 2 minutes: `GET /v1/directory` →
   ```json
   {"at": 1730000000000, "workspaces": [{"id", "name", "role", "personal",
     "members": [{"id", "name", "email", "role"}],
     "pcs": [{"fp", "id", "name", "addrs", "owner", "owner_name", "seen", "version"}],
     "devices": ["<fp>", …], "invites": [{"id", "email", "at"}]}]}
   ```
   (`invites` only for owners). PCs cache it (kv `account_dir`) and link with the workspace's
   other PCs without pairing (mesh.rs); phones turn each workspace into a hub entry whose PCs
   are its endpoints.

Also on the service (all with the Harbor token): `DELETE /v1/pcs/{fp}` (a member takes a PC
out), `DELETE /v1/devices/{fp}` (sign a device out: its own account, or an owner of a workspace
its account is in), `POST /v1/workspaces/{ws}/invites {"email"}`,
`DELETE /v1/workspaces/{ws}/invites/{id}` (owners; cancelling deletes it), `DELETE /v1/workspaces/{ws}/members/{user}`
(owners remove others; anyone leaves a workspace that isn't their own), and settings:
`GET /v1/settings` / `PUT /v1/settings {"set": {"<kv key>": {"v": "<value>", "at": <ms>}}}` →
`{"settings": {…}, "at"}`, newest `at` per key wins (`src/settingsync.rs` lists which keys
follow the account; machine-bound ones never travel). Errors are `{"error"}`; `401` with
`signin: true` means sign in again.

### Phones: Android's own Google account picker (0.86)

With Harbor's Google Cloud **Web client id** set (`HARBOR_GOOGLE_WEB_CLIENT_ID` in
android/build.sh, `GOOGLE_WEB_CLIENT_ID` in the Worker), a phone on Android 14+ signs in without
any website: Sign in shows Android's own "choose an account" sheet (framework
`android.credentials.CredentialManager`, option type
`com.google.android.libraries.identity.googleid.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL` with the Web
client id and a nonce, `GooglePicker.java`), and Google Play services hands the app an ID token
for that Web client. Empty id, older Android, no Google account or no provider: the browser
flow above, in a Custom Tab.

- `POST /v1/session/google` (no bearer) `{"id_token": "<Google ID token>", "nonce": "<the
  request's>", "device": {<device proof over the ID token>}, "app"}` → the `/v1/session` answer
  plus `"refresh": "<64 hex>"`. The Worker checks the token against Google's keys
  (`https://www.googleapis.com/oauth2/v3/certs`, RS256): issuer `accounts.google.com`, `aud` =
  the Web client id, not expired, the nonce, `email_verified`. It then finds the Clerk account
  with that **verified** email: the same account the PCs signed into through Clerk. `409`
  `{"browser": true}`: no Harbor account has that email yet; the phone signs in through Clerk
  in the browser once (a Google-only Clerk instance doesn't let the Worker make accounts).
  `404 {"browser": true}`: not set up on this Worker.
- `POST /v1/session/refresh` (no bearer) `{"refresh": "<the secret>", "device": {<device proof
  over the secret>}}` → a new `/v1/session` answer. The secret works only with the device key it
  was issued to; signing the phone out (`DELETE /v1/devices/{fp}`) ends it (`401 signin`).



- `GET /v1/invites` (Harbor token) → `{"invites": [{"id": "inv_…", "ws": "org_…", "ws_name":
  "Sam's workspace", "inviter_name": "Sam Rig", "email": "pat@example.com", "at": <unix s>}]}`:
  pending invitations to any of the account's verified addresses, oldest first. One the
  account already joined some other way is settled and left out.
- `POST /v1/invites/{id}/accept` → `{"ok": true, "workspaces": [...], "joined": {"id", "name",
  "role", "personal"}}`: joins that workspace as a member. Then ask for a new Harbor token
  (`POST /v1/session`): the old one doesn't name the workspace, so its PCs refuse it until then.
- `POST /v1/invites/{id}/decline` → `{"ok": true, "workspaces": [...], "joined": null}`.
- Accepted, declined or cancelled, the invitation is deleted. Only a **verified** email of the
  signed-in Clerk user matches (`email_addresses[].verification.status == "verified"`).
- `404` the invitation isn't waiting any more, `403` it's for another address.

Desktop: a pop-up (top right, Accept / Decline) and Settings › Account › Invitations; the list
is fetched with the directory (every 2 minutes). Phone: a card per invitation on the start
screen and rows in Settings (tap: Accept / Decline). Accepting changes nothing on the device:
a PC stays in its own workspace (Settings › Account moves it), chats and running turns go on.

### Offline and expired sign-ins

Nothing stops when Clerk or the service can't be reached, or Clerk ends a session (Clerk's free
plan has fixed 7-day sessions and no multi-session, so switching accounts is sign out, sign in):
PCs keep checking phones' tokens with the keys and directory they have, the hub and agents keep
running, and the desktop asks to sign in again in Settings › Account. A phone keeps its Harbor
token until it expires; when it's refused (`401 signin`) the app shows its sign-in screen.
Signing a PC out keeps it in its workspace (its people still reach it); only a member takes it
out (Settings › Account › Take this PC out).

### Phones from before 0.85

Pairing tokens from before accounts (kv `api_tokens` without `account`) still get `GET /v1/app`
and `GET /app.apk` (also from the internet), so the old app updates itself; everything else is
`401` `{"error": "This PC now uses Google accounts: update Harbor on this phone…", "signin": true, "upgrade": true}`.
The 0.85 app forgets its pairings and shows "Sign in with Google". A 0.85 app with a PC that
hasn't updated finds no PCs in its directory and says so.

### Background pings (online with the app closed)

The app schedules an Android JobScheduler job every 15 minutes with any network (`Alive.java`,
persisted across reboots; Doze and App Standby run it later). It pings one PC, the one calls go
to first, then the others, until one answers: `POST /v1/alive` (the Harbor token, as every call)
→ `{"ok": true, "every_s": 900}`. The hub records the time and nothing else: Devices shows a
phone **Harbor open** while its app calls (within 75 s), **online** while its last ping is under
35 minutes old, else offline with "seen X ago" (the newest of both). The mesh shares pings
(`alive` in `GET /mesh/v1/phones`), so a ping to one PC counts on all.

### Notifications

From 0.40 (optional: older hubs ignore `since` and answer without `notes`). The hub keeps a
short list of notes (a day, 200 at most; `src/notify.rs`) for what matters:

| `kind` | when | key |
|---|---|---|
| `input` | a lead chat's turn ends with a question, or a chat waits for you after a usage limit (`act: "continue"`) | `chat:<gid>` |
| `input` | an agent asks for a key, to use one or to write one to a .env file (answered on the PC, never on the phone) | `secret:<gid>:<ask id>` |
| `done` | a lead chat's turn ends (once its sub-agents are done), or stops with an error | `chat:<gid>` |
| `agent` | a sub-agent's turn ends (apps show it only when asked) | `chat:<gid>` |
| `ci` | checks fail on one of the user's open PRs (once per head commit; `url` = the PR) | `ci:<repo>#<n>` |
| `limit` | an account hits its usage limit or cap, or a limit resets and work continues | `limit:<account>` |
| `pc` | another PC of the mesh stops answering, or answers again | `pc:<id>` |
| `test` | Settings › Notifications › Send a test on the PC | `test` |

A note: `{id, at, kind, key, title, body, chat?, url?, act?, count, away, reply, from?}`.
Notes with one `key` within 90 s are one: the newer replaces the older with `count` summed (and
an `input` stays `input`), so the phone keeps **one Android notification per key** and updates
it. `away`: the user wasn't at that PC (its window not in front, or unused for 2 minutes), for
"only when I'm away from the PC". `reply`: the chat takes a reply. `from`: the PC of the mesh it
happened on (each PC fetches the others' own notes, `GET /mesh/v1/notes?since=`, every 15 s, so
asking one PC is enough; `pc` notes stay local).

Phones take them with the background ping (`POST /v1/alive`, [above](#background-pings-online-with-the-app-closed)):
add `"since": <last id taken from that PC>` (0: none yet: the answer has no notes, only `last`, so
nothing old is shown) and optionally `"wait_ms"` (at most 240000: the hub answers as soon as a
note comes). The answer adds `{"notes": [...], "last": <id>}`. Ids grow per PC and start at its
start time in ms, so a restarted hub's ids are higher; a `since` from the future gets every kept
note.

The app (`Notes.java`, `Alive.java`, `Listen.java`, `NoteAction.java`):
- the 15-minute ping job takes notes; for 8 minutes after the user leaves the app a one-off job
  long-polls (`wait_ms` 60000), when an answer is most likely; **Instant notifications** (off by
  default) runs a minimised foreground service that keeps a 240 s long-poll open (seconds instead
  of minutes, a silent ongoing notification, a little battery);
- shows nothing while Harbor is in front; filters by the phone's own choices (kinds, quiet hours,
  only when away), Android channels per kind;
- actions: tap opens the chat (or the PR's `url`), **Reply** (RemoteInput) sends
  `POST /v1/chats/{gid}/send {"text"}` (Android unlocks the phone first, Android 12+), **Continue** sends `POST /v1/chats/{gid}/continue`. Harbor runs agents
  without permission prompts, so there is no approve/deny.

The desktop shows its own notes with notify-send (click opens the chat) only while Harbor's window
isn't in front, per Settings › Notifications (kinds, "only when I'm away", quiet hours); a key
pops up at most every 30 s, else its notification is replaced quietly.

## Revisions

One counter per hub, starting at the hub's start time in ms, so it keeps growing across Harbor
restarts. Each chat has the revision of its last change; each transcript item the revision it
last changed at (a streaming reply is sent again each time it grows). If a client sends a
`since` larger than the current revision, `/v1/events` answers at once with `state_changed:true`:
refetch everything.

## Calls

### `GET /v1/state`

```json
{
  "version": "0.9.0", "hub_name": "desk", "you": "tok:1a2b3c4d", "rev": 1761200000123,
  "hub_id": "ts:desk", "hub_fp": "<64 hex>", "hub_addrs": ["10.0.0.12", "fd00::12"], "hub_port": 47930,
  "mesh": true,
  "hubs": [{"id": "ts:desk", "name": "desk", "online": true}, {"id": "ts:laptop", "name": "laptop", "online": false}],
  "projects": [{"id": 1, "name": "harbor", "path": "/home/user/Projects/harbor"}],
  "chats": [{
    "id": 12, "project_id": 1, "title": "Fix the build", "device": "", "account": "claude",
    "model": "claude-opus-5-5", "effort": "high", "access": "full", "fast": false,
    "settled": false, "running": true, "queued": 0, "updated_ms": 1761200000000, "rev": 1761200000100,
    "role": "lead", "parent": null,
    "typing": [{"device": "pc:desk", "kind": "pc", "label": "desk"}],
    "switchable": {"account": true, "model": true, "effort": true, "access": true, "device": false, "fast": true},
    "allowed_accounts": ["claude", "claude2"],
    "gid": "5f0c…-uuid", "home": "ts:desk", "home_name": "desk", "writable": true
  }],
  "accounts": [{"id": "claude", "label": "Claude · AB", "name": "…", "kind": "claude",
                "signed_in": true, "can_start": true, "usage": [{"label": "5h", "percent": 42.0}]}],
  "models":  {"claude": [{"id": "claude-opus-5-5", "label": "Opus 5.5", "more": false}], "codex": […]},
  "efforts": {"claude": [{"id": "high", "label": "High", "desc": ""}], "cursor": []},
  "default_efforts": {"claude": "high", "cursor": ""},
  "access":  {"claude": [{"id": "full", "label": "Full access", "desc": "…"}]},
  "devices": [{"id": "", "label": "desk", "icon": "monitor", "online": true},
              {"id": "ts:laptop", "label": "laptop", "icon": "laptop", "online": false}],
  "fast": false,
  "defaults": {"account": "claude", "model": "claude-opus-5-5", "effort": "high", "access": "full",
               "device": "", "project_id": null},
  "app": {"version_code": 7000, "url": "/app.apk"},
  "hub_update": {"version": "0.29.0", "current": "0.28.0", "installing": false,
                 "notes_url": "https://github.com/RDevNeo/harbor/releases/tag/v0.29.0"},
  "provider_updates": {"items": [{"kind": "codex", "label": "Codex", "logo": "p-openai.a8", "current": "0.46.0", "latest": "0.47.0"},
                                 {"kind": "claude", "label": "Claude", "logo": "p-claude-color.rgba", "current": "2.0.14", "latest": "2.0.15"}],
                       "names": "Codex and Claude", "key": "codex=0.47.0,claude=2.0.15",
                       "updating": false, "error": null}
}
```

- Chats also have `unread` and `failed` (optional, 0.42): the last turn ended while nobody had the
  chat open and nobody opened it since (the desktop sidebar's blue dot), and whether that turn
  failed. Fetching the chat's items (`GET /v1/chats/{id}/items`) marks it read, as opening it on the
  desktop does. Older hubs leave them out: no dot.
- `projects` come in the desktop sidebar's order (by hand, or by last activity when it's set so).
  Projects never settle, only chats do. Older hubs sent a project `settled`; clients ignore it,
  and current hubs no longer send it.
- `models`, `efforts`, `access` are keyed by account `kind` (claude, codex, cursor, grok,
  gemini, meta, opencode). An empty effort list: send `""`. `default_efforts` (optional, older
  hubs leave it out) is what an empty `effort` means for each kind (Harbor's `medium` for
  Claude since 0.84, the CLI's own default for the others): show a chat's or the defaults' `""`
  as that level, and pick it for a new chat.
- `role`: `lead` (a project's thread), `sub` (a subagent of `parent`; usually hidden), `chat`.
- `tree` (optional, older hubs leave it out): where the desktop sidebar places each chat, so the
  list shows the same chats in the same places. `{"projects": [{"id": 1, "snoozed": false,
  "chats": [14, 12]}], "threads": [9], "settled": [3]}`, chat ids in display order. Each project
  lists all its unsettled leads, newest first, as siblings; `threads` are leads with no project
  (or a project the hub doesn't have); `settled` holds every settled lead. Sub-agents and
  snoozed chats are in none of them; a `snoozed` project shows only while searching. From 0.78
  `snoozed` (optional) lists the snoozed unsettled leads: a search shows the matching ones back
  in their project (or Threads, when the project isn't in `projects`), as the desktop does. Without
  `tree`, group `chats` by `project_id` and `settled` as before. With `X-Harbor-Ids: global`
  its chats are gids and its projects paths from 0.64.1; hubs 0.55.2 to 0.64.0 left this hub's
  ids there, so when `tree` places none of the chats, ignore it and group as without it.
- `fast` is hub-wide (not per chat); `chat.fast` mirrors it.
- `devices[0]` is always the hub itself (`id: ""`). Icons: monitor, laptop, terminal, house,
  globe, bot, hammer, gauge. `online` may be null (unknown). `hub: true`: another PC of the mesh
  running Harbor; a new chat with that device starts there, so it can only be picked while `online`.
- `hub_update` (optional, null or missing: nothing to offer): a Harbor release this hub can
  install; show it as the "Harbor X.Y.Z is available" banner with Update
  (`POST /v1/hub/update`) and What's new (`notes_url`). `installing`: it's on its way. Once the
  hub runs it, its `app.version_code` offers the matching APK. `ready` (optional, from 0.47.1;
  missing: false): the version is already installed on the hub's disk and Update only restarts
  the hub into it (a client may say "installed, restart to switch"); the call is the same.
  `checking` (optional, from 0.51; missing: false): an Update was asked before the hub knew of
  any release, so it is checking first; `version` is `""` then (older apps hide the banner on
  an empty version). The banner says "Looking for the newest Harbor…" with Update disabled.
  From 0.53 a hub that updates automatically (`GET /v1/app` `hub.auto`) leaves it null while it
  installs and while the new version waits on its disk to swap in, as its desktop shows no toast.
- `profile_check` (optional, from 0.47; null or missing: nothing to ask): `{key, title, body}`,
  "Is this you?" while this PC's owner is a detection nobody confirmed (the desktop's pop-up).
  Confirm sends `PATCH /v1/people {"op": "confirm"}`; closing remembers `key` on the phone.
- `provider_updates` (optional, null or missing: none): the hub's provider CLIs that are behind,
  as the separate "Updates available: N providers" banner ("<names> can be updated"), with
  Update (`POST /v1/providers/update`). `updating`: the hub is running the updaters; `error`:
  the last update failed (text). Dismissing either banner remembers its version (`version`, or
  `key` for providers), so it shows again for the next one. Older hubs send neither field.
- `hub_fp`, `hub_addrs`, `hub_port`: this hub's key and where it answers (keep the entry's
  address list up to date with them).
- `hub_id`: this hub's id in the mesh; `mesh`: chats are shared with the user's other PCs; `hubs`:
  every PC of the mesh (this one first). A hub the phone has no token for yet: ask `GET /v1/hubs`.
- `usage[].percent`: 0–100 with one decimal (100.0 = that window is used up); `label` names the
  window ("5h", "Weekly", …).
- `can_start`: only Claude accounts can start a new chat (a new chat is a lead; leads run on Claude).
- `queued`: messages waiting for the running turn.
- `working` (optional, older hubs leave it out: use `running`): the chat is busy as the desktop
  sidebar shows it, its own turn or, for a lead, any of its sub-agents' turns or work queued for
  them. Draw the list's spinner from it; `running` stays the chat's own turn (the composer's Stop).
- `you`: this client's own device id, as it appears in `typing` (hide yourself with it).
- `typing`: who is writing in the chat now (see [Typing](#typing)); for another PC's chat, as
  that PC keeps it (typing in a copy is passed on to its PC).
- `draft`: the chat's shared composer draft (0.64, see [Shared draft](#shared-draft-064)), or `null`.
- `viewing`: the other PCs of the mesh that have the chat open: `[{device, kind, label}]`, `kind`
  `focused` or `away` (their window isn't in front).
- `switchable` / `allowed_accounts`: which run settings `PATCH /v1/chats/{id}` may change now,
  and the accounts it may switch to (see [Run settings](#run-settings)).
- `gid`: the chat's global id, the same on every PC of the mesh (see [Every PC is a hub](#every-pc-is-a-hub)).
  Every `{id}` in a path may be the `gid` instead; keep it to find the chat again on another hub.
- `home` / `home_name`: the PC the chat runs on (its peer id, its name). `writable`: false while
  that PC is off: show the chat read-only with "<home_name> is off" (writes answer `409`).
- `worktree` (optional, 0.66; null or missing: it runs in the project's checkout, or an older
  hub): the chat runs in a git worktree of its own (sub-agents: their lead's), `{"name":
  "app-a1b2c3", "path": "/home/sam/.local/share/harbor/worktrees/app-a1b2c3" | null, "gone":
  false}`. `path` is null for another PC's chat (its home PC only says the name); `gone`: the
  folder was removed outside Harbor (its turns refuse to start). The desktop marks such a chat's
  sidebar row with the folder-git glyph (`U+E40A`, red when gone) and shows a chip next to the
  chat's title, "Worktree · <branch>" (the branch from `GET /v1/workspace`, else the name;
  "Worktree gone"; a new chat headed for one: "New worktree · from <base>"); the phone does the
  same in its list and under its title. Tapping the chip opens the workspace sheet.
- `pr` (optional, 0.83; null or missing: none, or an older hub): the pull request of the branch
  the chat works on (sub-agents: their lead's), `{"number": 123, "state": "open" | "draft" |
  "merged" | "closed", "label": "PR #123 · Open", "title": "Fix the login", "url":
  "https://github.com/o/r/pull/123"}`. The hub looks it up with the GitHub CLI off its UI thread
  (src/chatpr.rs): while the chat is shown on the desktop or a phone asks
  `GET /v1/workspace?chat=` (at most once a minute), after each of its turns, and every few minutes
  for open ones; another PC's chat has it as its home PC says. None for the default branch, a
  branch never pushed, a project without a GitHub remote, or without `gh`. The desktop shows
  `label` in the footer under the composer, left of the branch, its icon in the state's colour
  (git-pull-request `U+E555` green, pr-draft `U+E35B` grey, git-merge `U+E0E4` purple, pr-closed
  `U+E35A` red; a click opens `url`), and, for a chat with a `worktree` (a checkout's branch is
  every chat's there), the same icon after the title on its sidebar row; the phone does the same
  in its footer chips (tap: open `url`, long-press: the title) and list.
- `snoozed_until_ms` / `snoozed_label` (optional, 0.78; missing: an older hub, so offer no
  Snooze): the chat is snoozed out of this hub's sidebar until then, and that time as the
  desktop's row says it ("Tomorrow, 9:00", "Thu, 14:00"); both null when it isn't. Such a chat is
  in `tree.snoozed`, shown only while searching, its row marked with the clock glyph and the label
  (see [Snooze](#snooze-078)).

### `GET /v1/chats/{id}/items?since=<rev>`

```json
{"rev": 1761200000200, "count": 31, "running": true, "queued": 1, "typing": [ … ],
 "status": { … }, "usage": { … }, "items": [ … ]}
```

`usage` (optional, since 0.39; null before the chat's first turn ends): its tokens and cost so far,
as the desktop's header shows them dim after the chat's settings: `label` ("12.4k tok · $0.18"; a
lead's counts its agents' turns too), `detail` (the header's hover: "12k in (8k cached) · 500 out ·
$0.18 · 2 turns", and for a lead "With its agents: …" and "This chat alone: …" on two lines),
`chat` and `team` (null for other chats) with the numbers: `{turns, input, output, cached, cost,
label, detail}`. `input` counts the cached tokens too; `cost` is the provider's own estimate in
USD (Claude Code's is the API-equivalent price, also for subscription accounts), 0 when it reports
none (Codex, Gemini: show tokens only).

The chat **exactly as the desktop draws it**: `items` are the desktop's own cards (one
projection, `src/view.rs`, that `chat.rs` draws and this call sends), so a phone renders them
1:1 and filters nothing itself. Cards whose revision is greater than `since` (`since=0`: all).
There is one card per transcript item: `seq` is the item's index (0-based, stable; `fork` uses it)
and a card comes again with a higher `rev` when it, or how it shows, changes. If `count` is
smaller than what you hold (a message was taken back), drop cards with `seq >= count`.

Every card has `seq`, `rev`, `kind`, and may have `forks_after: [chat ids]`: the desktop's
"Conversation fork · Open fork" divider(s), drawn right after the card (tap: open that chat).

Optional `group` (0.58): the card is part of a run of tool calls (consecutive `tool` and
`thinking` cards, `hidden` ones in between don't break it, with at least one `tool`), and
`group` is the `seq` of the run's first card. It is stable while the run grows, so key the
open/closed state on it. The desktop folds each run into one small, muted row before its first
card: a chevron (Lucide `chevron-right` closed, `chevron-down` open), "N tool calls" (N = the
run's `tool` cards; "1 tool call") and, while the chat is `running` and one of them isn't
`done`, a small spinner. Runs start closed and only open on a tap (never by themselves); open,
the cards draw as below. Cards without `group` (an older hub) draw as before.

| kind | what the desktop draws | fields |
|---|---|---|
| `hidden` | nothing: remove it if you had it (a lead's coordination; it can become hidden later, when its turn delegates) | only `forks_after` (then draw just the divider) |
| `user` | the right-aligned bubble: mention chips, image strip, text, a 📎 line per other file; "from `sender`" small in its bottom-right corner, inside the bubble, when there is one | `text`, `files` (names of non-image files), `images`, `mentions: [{from, text, excerpt, note, kind?, chat?, title?}]` (`kind` "chat" from 0.72: a mentioned chat, `chat` its global id, `title` its title; the chip shows it and a tap opens that chat; `excerpt` true when only a selected part of the message was mentioned: the chip shows `text` in quotes; `note` what the user wrote about that mention, shown under its chip, empty when none; both absent on older hubs), `at` (unix s), `sender` (where it was written when not on the chat's PC: "Pixel", "desk", "Pixel via desk"; empty otherwise), `intent` (0.71, absent otherwise: `steer` when it steered a running turn, `promoted` when it was queued first; draw a small "↻ Steer" caption over the bubble and put "Steered the active turn" / "Originally queued, then promoted to steer the active turn" in its long-press menu) |
| `text` | the reply (markdown), image strip under it; Fork among its actions when `forkable`; commit pills in its spans (below) | `markdown`, `blocks` (below), `images`, `at`, `forkable`, `commits` (optional, 0.52) |
| `thinking` | a collapsed "Thinking" header; expands to italic text | `text` |
| `tool` | one row: status icon (spinner / ✓ / ✗), `label`, `summary`; tap expands `input` and `result`; image strip under it | `label`, `summary`, `input`, `result` (null while running), `done`, `is_error`, `images` |
| `footer` | nothing since 0.59.2: the end of a turn comes as `hidden` (its usage stays in Usage). Older hubs send its line here; draw nothing | `text` (e.g. "Claude · AB · Opus 5.5 · 4.3s · 189k in (180k cached) · 304 out · $3.96"), `at` |
| `forked_from` | "Forked from conversation · Open source conversation" divider | `chat`, `seq` (open that chat at that card) |
| `chat_link` (0.57) | a divider "`text` · Open chat" linking to another chat: at the top of a chat an agent opened with its `open_chat` tool ("Opened by the agent of “Fix login”"), and in the chat that opened it ("Opened “Docs pass”"). Tap: open `chat`; while `chat` is null (that chat hasn't reached this hub yet) draw just the text | `text`, `chat` (this hub's id, or the gid with `X-Harbor-Ids: global`; null when it isn't here), `gid` |
| `notice` | a centred pill with the icon and `text`; with a `detail` it expands to it (as markdown when `detail_markdown`); with a `url` (a process's address) tapping opens it. Icon `report` (bot glyph) is a lead's one-line entry for a sub-agent's final report ("api finished: Added tests for X"), its `detail` the whole report. Icon `worktree` (0.66, folder-git glyph; older apps: any fallback) says the chat works in a new worktree from then on ("Working in a new worktree · app-a1b2c3 on branch harbor/a1b2c3 (from main)", or "Moved to a new worktree · …"), its `detail` the folder and branch. Icons `started` and `sent` (0.84, play and send glyphs; older apps: any fallback) are a lead handing work off, which shows nothing else: `started` for each sub-agent it starts ("api started: PR status in the footer"), `sent` for a message it passes to one while answering the user ("Sent to api: Also make it blue"), their `detail` the whole task or message (markdown) | `icon`, `text`, `detail`, `detail_markdown`, `url` |
| `message` | the blue card "`from` → `to`" with `text` | `from`, `to`, `text` |
| `error` | the red card, monospace | `text` |
| `media` (0.50–0.83) | an image or video an agent showed with its `show_media` tool. Hubs from 0.84 don't send it (agents put `![caption](path)` in their reply instead; an old transcript's call comes as a `tool` card with its file in `images`); from older hubs draw it like a `text` card's `media`, or skip it | `media` (one entry), `caption`, `pending`, `images` |

Optional on `text` and `tool` cards (0.50): `media: [{name, caption, kind, url, poster?}]`,
the images and videos the card shows large, in order: a reply's markdown images
(`![caption](path or https URL)`: an absolute path, a path relative to the chat's folder, or an
https URL, resolved by the chat's own PC even when another PC answers), and any video a reply or
tool names. `caption` is the image's alt text: draw it small under the image or video (empty: no
caption). `after` (0.84, `text` cards): an image on its own line in the reply goes right after
that many of the card's `blocks` (0: before the first), next to the text it illustrates; draw
media without `after` after the text. `kind` is
`image` (`url` = `/v1/image?…&max=512`; ask a bigger `max` for the inline copy, open the viewer
on tap) or `video` (`url` = `/v1/media?…`, the file itself; `poster` = `/v1/image?…` of the video,
a JPEG of its first frame, `404` when the PC has no ffmpeg). Draw the `images` not in `media` (same
`url`) as the strip; older apps ignore `media` and still get every image in `images`. A video
plays from a local copy (download it with the token, then a player); a media item that can't
load shows a small "can't load" tile that retries on tap. `blocks` leave out the markdown images
that `media` draws. A reply's local files are kept by its PC when the reply ends (0.84), so
their `url`s keep working after the agent deletes them (a screenshot in /tmp).

Optional on `text` cards (0.70): `chat_links: {"<link as written>": {title, chat, missing}}`, the
chat links the reply names (`harbor://chat/<gid>`, optionally `?pc=<PC name>`; agents write them
to point at a chat, sub-agent chats included). The hub resolves them: `title` is the chat's title
(a sub-agent's "Lead title › name"), `chat` the chat to open (this hub's id, or the gid with
`X-Harbor-Ids: global`), null when it isn't here, with `missing` saying why ("Chat not found",
"laptop is offline"). In `blocks` a bare link already reads as `title` (a span whose `link` is the
link as written). Make a span tappable only when its `link` starts with `harbor://chat/` and is a
key of `chat_links`: a tap opens `chat` in the app, or shows `missing` as a short notice when
`chat` is null. Never hand any other non-web link (`harbor://pair`, `intent:`…) to the system.
Older hubs send no `chat_links`: the link stays plain text.

Optional on every card the desktop gives a hover bar or an "@" button (0.69): `actions`, what
that bar offers, in its order, and `time` ("11:40 AM", the hub's clock, on cards with an `at`).
A long-press opens them in a bottom sheet with `time` on top: `user` sends `["copy", "quote",
"mention"]`, `text` `["copy", "mention"]` (`["copy", "fork", "mention"]` when `forkable`), `tool`,
`notice` and `message` `["mention"]`. `copy` copies the text, `quote` puts the message as `> `
lines on top of the composer's draft (then a blank line, then what was there), `fork` is
`POST …/fork` with the card's `seq`, `mention` adds `GET /v1/chats/{id}/mention?seq=N`'s
`mention` to the draft's `mentions` (once per message) and sends the draft. Leave out actions
you don't know; without `actions` (an older hub) offer Copy, and Fork when `forkable`.

Message text is selectable (0.74), as on the desktop: a long-press on the text selects, and the
selection's menu adds Mention (when `actions` has `mention`: `POST /v1/chats/{id}/mention`
`{seq, text}` with the selected text, below) and More… (the long-press sheet). A long-press
beside the text (a bubble's edge, a tool row, a notice) opens the sheet as before.

`images` are `[{name, url}]`; `url` is `/v1/image?path=…&max=512` (below). Tool `input`/`result`,
notice details, messages and errors are clipped to 16 KB. Ignore unknown kinds.

The image viewer browses the whole chat (0.82), as the desktop's does (view.rs `gallery`): a
tap on any image opens it on that image, and previous/next go through every image of the
chat's cards in `seq` order, skipping `hidden` ones; within a card its `media` of kind `image`
come first, then its other `images`; an image (same `url`) already listed earlier is left out.
Nothing new on the wire: the list comes from the cards the app already has.

#### Status

`status` is the bars the desktop shows under the transcript; each part is null or empty when
the desktop shows nothing:

- `queue: [{id, text, files, sending, intent, held, note, editing}]`: messages sent while the
  turn runs (see "Steer and the queue" below). Items with an `intent` (`steer`, `promoted`) are
  steers on their way in: the user's own bubble captioned "Steering…" until the agent takes it
  in (then it's a transcript `user` item). The others are "Up next": dashed right-aligned
  bubbles under the turn, in order, "Sending" once handed to the agent (no controls then).
  `held`: a Stop holds it; `note`: why it's there when it wasn't queued as such ("Steer didn't
  land: queued", in red); `editing`: some device is editing it. Hubs before 0.71 send only
  `text`, `files`, `sending` (no ids: read-only bubbles labelled "Queued").
- `can_steer` (0.71): whether a message sent now can steer the running turn (Claude, Codex);
  false or absent: the send button queues. `held` (0.71): a Stop holds the queue; the empty
  composer's button is ▶ Resume queue. `follow_up`: the PC's own Enter setting (`steer` |
  `queue`); the phone keeps its own (Settings › While the agent is running, default Steer).
- `working: {since_ms, subagents, text}`: the spinner line while the chat's own turn runs;
  show the time since `since_ms` after `text` ("Working…  ·  1 sub-agent running").
- `waiting: {agents: [{id, name, title, since_ms}], queued}`: a lead whose own turn is done while
  sub-agents still run. Only for apps without the agent strip below (hubs before 0.29 send no
  `agents`): "Waiting for N sub-agents to finish  ·  Q queued" with the agents' initials, and
  **Stop all** (`POST /v1/chats/{id}/stop_all`). When `agents` is there, don't draw it: the
  strip shows the agents and holds Stop all.
- `limit: {text, can_cancel}`: the usage-limit line (clock icon, `text`), with **Continue now**
  (`POST /v1/chats/{id}/continue`) and, when `can_cancel`, **Cancel** (`POST /v1/chats/{id}/cancel_limit`).
  `targets: [{id, name}]` (optional, hubs before 0.48 send none): other signed-in accounts of the
  same provider that aren't blocked; when not empty, a **Continue on…** chip opens a picker of
  their `name`s and sends the choice to `POST /v1/chats/{id}/continue_on`.
- `agents: {title, folded, header, rows: [{id, name, doing, task, model, logo, badge, since_ms, usage}]}` (optional,
  null or missing without running sub-agents; older hubs never send it): the live strip over a
  lead chat's composer, drawn after the typing line. A rounded box with one row per running
  sub-agent: its account mark (the provider logo `logo`, a file in the APK's `assets/logos/`,
  48×48 RGBA when 9216 bytes, else an alpha mask in the text colour; `badge` in its corner),
  `name` in semibold and a green working dot right after it, with a ring that swells and fades
  every 1.6 s (rows out of step); then a stop icon. The stop icon turns the row into "Stop
  `name`?" with **Cancel** and a red **Stop** (`POST /v1/chats/{id}/stop` of that agent), one row
  at a time; it cancels itself after 5 s or when another row is touched. Tapping a row opens that
  agent's chat (`id`); a long press shows `model`, `task` and "Working for 2m" (since `since_ms`).
  `doing` ("running tests") and `usage` ("12.4k tok · $0.18", since 0.39) are still sent for
  older apps, which show them in the row with the elapsed time; this app doesn't. When `folded`
  (three or more agents) a header row comes first: the agents' logos
  overlapping, `title` ("3 agents working"), "  ·  " and the names, and a chevron; the rows show
  only once it is tapped open (a per-screen choice). `header` (default `folded`): draw that
  title row even unfolded (no chevron; a tap opens the Agents panel), as `title` then says
  what's queued ("1 agent working  ·  2 queued"). A stop icon sits in the top right corner of
  the box, beside the first row: **Stop all**, which asks first ("Stop 3 running sub-agents?",
  "Stop the main agent and …" while the lead's own turn runs) and then sends
  `POST /v1/chats/{id}/stop_all` with `{"hold": true}`.
- `recap: "…"` (optional string, missing when there is none; older hubs never send it): the
  session recap (Claude Code's "away summary"), drawn after the agent strip, right over the
  composer: "recap: " in semibold then the text in italics, both gray-900, wrapping. The hub
  writes it once the user has been away for 3 minutes after a turn, and drops it when the next
  turn starts.
- `suggestion: "…"` (optional string, missing when there is none): the message the user would
  likely send next. While the composer is empty it is the composer's placeholder, in gray-700
  instead of the usual placeholder colour, with a small "⇥ Use" chip in the composer's row (the
  desktop's Tab / →): tapping it puts the text into the composer (it doesn't send). Typing
  anything hides both. Gone once the next turn starts.
- `folder: {text, cloning, owner: {id, name}|null, suggested, action, action_note}` (optional, from 0.62; null or
  missing otherwise, older hubs never send it): the chat's project isn't on its PC (a project
  another PC of the mesh shares). The desktop draws a line under the transcript: a folder icon
  (a spinner while `cloning`) and `text`, then, unless `cloning`, **Clone here** and, with an
  `owner`, **Run on `owner.name`**. A turn that starts without the folder clones the project
  first by itself (the line says "Cloning…", the queued message runs once it's there); these
  are for when that can't be done (no access, no remote known). On the phone, the chips go under
  the line like the limit line's:
  - **Clone here**: a dialog with a path field filled with `suggested` (the owner's folder,
    relative to this PC's home) → `POST /v1/chats/{id}/clone` `{"path": "<absolute, or ~/…>"}`
    → `{"ok": true}`; `409` with the reason (already there, already cloning, not a full path).
    A folder that already holds a clone of the project is used as it is; an empty or new one
    gets the clone; one with other files gets it in a subfolder named after the project. The
    message that was waiting runs once it's there. `action` (optional, from 0.65; default "Clone
    here") names the chip and the dialog, `action_note` the dialog's text: a project without a git
    remote (made without Git) reads **Use a folder here**, and the path must be a folder that
    already holds its files (nothing can be cloned).
  - **Run on …** → `POST /v1/chats/{id}/run_on` → `{"id": <new chat>}`: the chat's waiting (else
    last) message starts a chat in the project on the owner PC, with the same run settings;
    open that chat (`id` null: not copied yet, find it in the next state by its gid). This chat
    is deleted if it never ran. `409` when the owner is off or there's nothing to send.
  Hubs before 0.62 answer both with `404 unknown action`: keep the old behaviour (the error card
  only).

#### Blocks

A list of blocks, each with a `type`:

- `heading` `{level: 1-6, spans}`
- `paragraph` `{spans}`
- `code` `{lang, text}`
- `list` `{ordered, start, items: [[blocks]]}` (each item is a list of blocks)
- `quote` `{blocks}`
- `rule` `{}`
- `table` `{rows: [[spans]]}`: rows of cells, each cell a list of spans; the first row is the header

Bare http/https URLs in prose receive `link` just like explicit Markdown links, using the
same preprocessing as the desktop. Inline code and code blocks stay literal.

A span is `{text, bold?, italic?, code?, strike?, link?, commit?}`; flags are left out when false and
`link` / `commit` when there is none. Task list markers arrive as "☑ " / "☐ " text. Raw HTML stays as text.

#### Commit pills (0.52)

A commit hash in a reply (7–40 lowercase hex digits with at least one digit and one letter,
standing alone in the text or alone in inline code) that the hub verified as a commit of the
chat's project comes as a span of its own with `commit`: the full sha. Fenced and indented code
blocks, link texts and URLs are left alone; lookalikes (colours, UUID parts, fingerprints, paths)
are never pills, since only `git cat-file` decides. The card then has `commits`:
`{"<full sha>": {sha, short, subject, author, at}}` (`at`: author date, unix s).

Draw the span as the desktop's pill: a small rounded chip with the Lucide git-commit glyph
(U+E0E3) and the short id (`short`, at least 7 characters, monospace) instead of `text`. Tapping it
opens the commit card (below). The span's `text` is still the token as written, so an app that
ignores `commit` shows what it always did. The hub looks commits up off the UI thread: a reply
may come first without them and again with a higher `rev` once git has answered. A copy of
another PC's chat only gets pills where this PC has a clone of its project.

### `GET /v1/chats/{id}/commit/{sha}[?diff=1]` (0.52)

A commit pill's card, read from git on the chat's PC (forwarded there for a copy):

```json
{"sha": "35cbb88a…", "short": "35cbb88", "subject": "0.47.1", "author": "A. Person", "at": 1761460000,
 "email": "a@example.com", "body": "…", "url": "https://github.com/o/r/commit/35cbb88a…",
 "files": [{"path": "src/x.rs", "adds": 2, "dels": 1}, {"path": "logo.png", "adds": null, "dels": null}],
 "more_files": 0}
```

`url` is null unless the project has a GitHub remote (built from origin, else another remote; no
credentials). `adds`/`dels` are null for a binary file; at most 300 files are listed, `more_files`
counts the rest. A merge lists what it brought in (first parent). With `diff=1` the answer also
has `lines` and `clipped`, as `GET /v1/prs/diff`. `404` with `error` for an unknown commit or a
chat without a project on that PC.

The phone draws it as a bottom sheet: the subject as the title, the glyph, short id, author and
age, the message, "N files changed +A −D" over the file list, then **Open on GitHub** (when
`url`), **Copy SHA** and **Show diff** (the `diff=1` lines, drawn like a PR's Code tab).

### `GET /v1/events?since=<rev>`

Long-poll. Answers as soon as anything changed after `since` (after a short 150 ms pause that
gathers a burst of streaming changes), or after 20 s with nothing:

```json
{"rev": 1761200000300, "changed_chats": [12], "state_changed": false}
```

`state_changed` is true when anything in `/v1/state` changed (a chat's title, settled, running,
queued, updated time, run settings, who is typing; chats added or removed; projects; accounts'
usage; the update banners). A typing lease running out is a change too (its chat is in `changed_chats`). Use a read timeout of
25 s and reconnect on any error.

### `POST /v1/chats`

```json
{"project_id": 1, "device": "", "account": "claude", "model": "claude-opus-5-5",
 "effort": "high", "access": "full", "fast": false, "text": "First message", "files": ["pending/1761…-photo.jpg"]}
```

→ `{"id": 13}`. Fields left out take the hub's defaults (`project_id` missing or null: no
project). With no `text` and no `files` the chat is created idle. `fast` sets the hub-wide flag.
Since 0.37 (optional): `"worktree": true, "base": "<branch>"` starts it in a new git worktree of
the project made from `base` ("" or missing: the checkout's branch); a hub that can't make it
answers `409` with git's reason and creates nothing. Ignored with a `device`, and since 0.65 in a
project without Git (`GET /v1/workspace` says `git: false`: a plain folder): the chat starts in
the folder (older hubs answer `409`).
Since 0.57 (optional): `"title": "…"` names it in the sidebar (default: the text's first line), and
`"opened_from": {"gid", "title"}` (sent by a hub whose agent opened the chat on this PC with
`open_chat`) puts a `chat_link` card back to that chat at its top. Phones don't need either.

### `POST /v1/chats/{id}/send`

`{"text": "…", "files": [upload ids], "mode"?: "steer" | "queue"}` → `{"ok": true, "queued":
false, "steering": false}`. While a turn runs, `mode` says what the message does (0.71; absent:
queue, as older apps expect): `steer` reaches the running turn now (`steering: true`) when it can
(`can_steer`), else it queues; `queue` waits for the turn to end (`queued: true`). A message to an
idle chat starts a turn, and resumes a queue a Stop held (it runs after this one).

Optional `mentions` (the draft's, as the shared draft holds them). A mentioned chat (from 0.72,
`$` in the composer) is `{"kind": "chat", "chat": "<global id>", "title": "…", "from": "<its
row's line>", "note"?: "…"}`: the hub fills in its context when the message goes out (title,
project, PC, status, recap, its last 6 turns' prompts and final answers, at most about 8 KB, read
from that PC's copy of the chat: the mesh keeps one of every chat) and the agent gets it quoted
with the chat's id and link. Old hubs read it as an empty message mention.

### `POST /v1/chats/{id}/stop`

`{"hold": true}` (0.71) → `{"ok": true, "returned": [], "held": true}`: stops the running turn
(if any); the queue stays, in order, held until `POST …/resume` or the next message sent. Without
`hold` (older apps) → `{"ok": true, "returned": [{"text": "…", "files": [upload ids]}]}`: messages
queued behind it are taken out of the queue and returned, oldest first, so the app can put them
back in its composer (files that weren't phone uploads are left out).

### Steer and the queue (0.71)

While the agent works, a message either **steers** it (reaches the running turn now: Claude takes
it with `priority: "now"`, ending what it was doing; Codex is stopped and its session resumed
with it) or is **queued** (waits for the turn to end, then runs as the next turn, one message per
turn, in order). The phone's send button shows which (`list-plus` Queue, `corner-up-right`
Steer) and long-press offers the other ("Choose how to send this message": Steer now / Queue).
Agents that can't be steered (`can_steer` false) always queue. A steer never gets lost: if the
turn just ended it runs as the next turn; if it can't be written it goes back to the top of the
queue with a `note`. Ids are the status' `queue[].id` (the home PC's for a chat on another PC;
calls about a copy are forwarded there like other writes). Each answers `{"ok": true}`, or 404
when the message is gone (it started or was removed):

- `POST /v1/chats/{id}/queue/{qid}/steer`: steer with it now (`intent: promoted`); when no turn
  runs it's "Send now" and starts one.
- `PATCH /v1/chats/{id}/queue/{qid}` `{"text"?, "mentions"?, "editing"?: bool}`: edit it in place
  (it keeps its place); `editing` marks that a device has it in its composer.
- `POST /v1/chats/{id}/queue/{qid}/move` `{"to": n}`: move it to position n (0 = next).
- `DELETE /v1/chats/{id}/queue/{qid}`: remove it.
- `POST /v1/chats/{id}/resume`: after a Stop, the next queued message starts.

### `PATCH /v1/chats/{id}`

`{"title"?: "…", "settled"?: true, "account"?, "model"?, "effort"?, "access"?, "device"?, "fast"?}`
→ `{"ok": true, "chat": {…the chat as in /v1/state…}}`.

#### Run settings

The same changes the desktop composer allows, with its rules. The whole request is checked
first; if any field fails nothing changes (`400` an unknown value, `409` not switchable now).

- `account`: one of the chat's `allowed_accounts`. A lead runs on Claude; a chat that has
  started keeps its provider (Claude accounts share sessions, so it may move between them).
  When the provider changes and no `model` is given, the model becomes that provider's first one.
- `model`: one of `models[kind]` of the (new) account's kind.
- `effort`: one of `efforts[kind]`, or `""`. Left out and no longer valid for the provider: its default.
- `access`: one of `access[kind]`. Left out and no longer valid: the provider's first level.
- `device`: `""` (the hub) or an id from `devices`; other providers than Claude run on the hub
  only. Before the chat's first turn it is just set. Since 0.63 a started Claude chat **moves**
  there (with its sub-agents): the hub carries each Claude session (`<sid>.jsonl` and its
  sidecar folder) from where it is to where the next turn will look (an SSH device's newest
  copy over ssh, into this hub's account folder for the project, or onto the device in the
  profile and folder its turns use), then the chat runs there; a `hub` device (another PC of
  the mesh) gets the chat through "Move to PC…" (below). The answer comes at once with
  `chat.moving_to` set; the outcome is a notice in the chat ("Moved from X to Y", icon
  `monitor`, or "Couldn't move to Y: why", icon `alert`). `409` with why when it can't go there
  now; when the agent's files change place (this PC's files and a device that works on its
  own), uncommitted changes in the folder it leaves refuse the move in that notice ("… commit
  or stash them first"). Hubs before 0.63 answer `409` for any device change of a started chat.
- `fast`: the hub-wide flag; `true` only for providers with a fast mode (claude, codex).

`switch_reason` gives, for each run setting that can't change now, why (e.g. `{"device": "it
is running: move it once its turn ends"}`), for the greyed-out option.
`switchable` tells which of these make sense now: `account` (another allowed account exists),
`model`, `effort` (the provider has efforts), `access` (it has more than one level),
`device` (Claude; a started chat only when it can move now: idle, a lead, not another PC's),
`fast` (the provider has a fast mode). Changes apply from the next turn; a running turn keeps
its settings.

Optional since 0.63, for a started chat: `device_why` `{"<device id>": "why"}` names the
places of `devices` (`""` this hub) it can't move to now, each with why (offline, an older
Harbor, no Claude account, a Windows device…): grey those rows out with it; the rest can be
picked. `moving_to`: the place's name while a move runs (`null` otherwise); messages sent
meanwhile follow the chat.

### `POST /v1/chats/{id}/typing`

`{"typing"?: true, "kind"?: "phone", "draft"?: {"text", "files", "mentions"}, "text"?: "…"}` →
`{"ok": true}`.

#### Typing

Send `typing: true` every ~3 s while the composer has fresh input, and `typing: false` when the
message is sent or the composer is cleared. A lease lasts 6 s after the last `true`. `kind` is
`phone` (default) or `pc` (another PC acting as a client). The label shown is the
`X-Harbor-Device` header, else the name saved for the token, else "Phone" / "A PC".

Every chat's `typing` lists `{device, kind, label, text?}`: API clients as `tok:<8 hex>`
(stable per token; compare with `you`), and the hub's own desktop composer as `pc:<hostname>`
(kind `pc`, label the hostname) while someone types there. `text` is the end of their draft (last
500 characters), for 0.56–0.63 clients. Clients show who else types as a small "✎ Galaxy A13" in
the composer's corner (never yourself), and a ✎ on the sidebar row.

#### Shared draft (0.64)

A chat has one composer draft, the same on every device: what anyone types (text, attached
files, mentioned messages) shows up in everyone's composer as if they had typed it.

- Send it as `draft` `{text, files, mentions}` with each typing report: `text` the composer's
  whole text (untrimmed; the hub keeps the last 32 000 characters), `files` upload ids
  (`POST /v1/upload`, at most 20), `mentions` the mentioned messages as `send` takes them (at
  most 20). Report when it changes, at most every ~400 ms (the last change always goes), plus
  the 3 s heartbeat. Also send `text` (its last 500 characters) for hubs before 0.64.
- An emptied composer (no text, files or mentions) sends `typing: false` with the empty
  `draft`: the draft empties everywhere. `typing: false` without `draft` (leaving the chat) only
  ends the lease; the draft stays.
- A message sent in the chat (from any device, or the desktop) empties the draft everywhere
  and ends every typing lease in it (the message doesn't wait for "one sender at a time" then).
- A report with only `text` (0.56–0.63 clients) changes the draft's text and keeps its files
  and mentions; `typing: false` from such a client leaves the draft alone. Clients before 0.56
  don't touch it.
- Every chat (the chats list and items replies) carries `draft`: `{text, files: [{id, name,
  path}], mentions, by, label, rev}`, or `null` when nobody wrote one since the hub started. `by`
  is the device that wrote it (`""` after a send), `rev` grows with every change. `path` is the
  file on the hub, for `/v1/image?path=…&chat=…`. Another PC's chat leaves `files` out (they're
  that PC's uploads): keep your own files there.
- Applying it: take a draft whose `rev` is newer than the last one you saw, unless `by` is you
  (`you`), and unless your composer was edited in the last second (try again after that second;
  the newer report wins at the hub: last writer wins). Keep the cursor where it was (at the end
  if it was there). The draft stays after its writer's lease runs out (it's just a draft then;
  the hub keeps drafts in memory until it restarts).
- A new draft wakes the long-polls (the chat is in `changed_chats`) at most every 400 ms per
  chat; heartbeats with the same draft don't.

Other PCs: any client with a paired token can report typing with `kind: "pc"`; another PC's
Harbor doesn't act as a client of a hub yet (chats aren't shared between PCs' Harbors).

### `DELETE /v1/chats/{id}`

Stops a running turn first. → `{"ok": true}`. Its worktree is removed with it (0.37), unless it has
uncommitted changes: then it's kept, and the PC says so (a toast and a desktop notification).
(0.37.0 answered `"kept_worktree"`; since 0.37.2 removal runs after the answer, and it's gone.)

### Workspace and branch (0.37)

The desktop's bar under the composer (src/worktree.rs), as two chips under the phone's composer
and New chat screen. Where the agent works: the project's own checkout, or a git worktree of its
own (`<Harbor data>/worktrees/<project>-<6 hex>`, branch `harbor/<6 hex>`) so parallel agents don't
collide. Hubs before 0.37 answer `404`: show no chips.

`GET /v1/workspace?chat=<id>` (a chat) or `?project=<id>&worktree=0|1&base=<branch>` (New chat,
with its picks) →

```json
{"git": true, "mode": "checkout", "name": null, "path": "/home/sam/Projects/app",
 "branch": "main", "dirty": 2, "base": "", "can_move": true, "move_why": null, "branch_lock": null}
```

`git: false` (and nothing else): no chips (no project, not a git repo such as a project made
"without Git" on the desktop, another PC's chat, a chat on another device). Chats in a project
without Git work like any other; only the workspace/branch chips, commit pills and `#` issue tags
have nothing to show there (`@` lists the folder's files from disk since 0.65). `mode` is `worktree` for a chat in its worktree (`name`, `path` its folder; the
chip reads "Worktree · <name>" since 0.66) and for New chat with `worktree=1` (`base`: the branch it would start from). `branch` reads
`detached at <sha>` when detached. `can_move`/`move_why`: whether a chat in the checkout can move to
a new worktree now (not while running, not a sub-agent, …). `branch_lock`: why the branch can't be
switched now (an agent is working there), null when it can. `pending` (0.37.2, optional): what git is
doing there for the PC's own bar ("Creating worktree…"); ask again shortly. Since 0.83 asking for
a chat also has the hub look up its branch's pull request when it's over a minute old; it comes in
the chat's JSON `pr` (a state change), not in this answer. Every git call runs off
the hub's UI thread, so a big repository answers late but never freezes it: give these calls the
long timeout, and show a pending chip meanwhile.

`GET /v1/branches?chat=|project=&q=<filter>` → `{"current": "main", "dirty": 2, "warning": "2
uncommitted changes here: …" | null, "checkout_note": "Switches the project's checkout …" | null,
"branches": [{"name": "feature/x", "remote": false, "current": false}, …], "can_create": true,
"branch_lock": null}`. Ranked on the hub (recent first when `q` is empty; remote branches only when
no local one has their name). Show `warning` before switching.

`POST /v1/branches` `{"chat": id | "project": id, "switch": "<name>", "remote": false}` or
`{…, "create": "<name>"}` → `{"ok": true, "branch": "<now>"}`; `409` with git's reason (it refuses
to overwrite uncommitted changes, a bad name, `branch_lock`). For New chat with a new worktree
the pick is only the `base` of `POST /v1/chats`: nothing is sent.

`POST /v1/chats/{id}/worktree` → `{"ok": true, "name", "path"}`: the chat (and its sub-agents) moves
to a new worktree from the checkout's branch; `409` with why not (`move_why`). A chat in a
worktree stays there.

### `POST /v1/chats/{id}/fork`

`{"seq": 7}` → `{"id": 14}`. `seq` must be a `text` item that is the last reply of a finished
turn (`409` otherwise).

### `GET /v1/chats/{id}/mention?seq=N` (0.69)

The mention the desktop's composer gets for card `seq` (its "@" or Mention in your next
message): `{"mention": {item, from, at, text, len}}`, ready to append to the shared draft's
`mentions` as is. `404` when that card can't be mentioned (no `mention` among its `actions`).
Answered by the PC asked, also for another PC's chat (it holds a copy of the transcript).

`POST /v1/chats/{id}/mention` `{"seq": N, "text": "…"}` (0.74) answers the same for a part of the
message the user selected: an excerpt mention (`excerpt: true`, `text` the selection), the
desktop's "Mention selection"; a selection of the whole message is the message's mention. Without
`text`, the whole message. Never forwarded to the chat's home PC (the copy here answers it).

### `POST /v1/chats/{id}/move`

"Move to project…": `{"repo": 6}` (a project id, or its path) or `{"repo": null}` (No project).
Its sub-agents move with it, and its Claude sessions are copied to the new folder's place so the
next turn resumes there. → `{"ok": true, "chat": {...}, "moved": [ids]}`. `409` with the reason
when it can't move now: a sub-agent (move its lead), a lead mid-turn, a chat on a device, another
PC's chat, or a project folder that isn't on this PC.

### `GET /v1/chats/{id}/move_targets`, `POST /v1/chats/{id}/move_pc`

"Move to PC…" (optional; hubs without it answer `404`, and the app says so; for a copy whose
home PC is older, the hub answers `409` with that reason itself). A finished chat (and
its sub-agents) moves to another PC of the mesh and goes on there: its home changes, its `gid`
stays. Both calls about a copy are forwarded to its home PC, which decides.

`GET …/move_targets` → `{"why": "…"|null, "targets": [{"id", "name", "why": "…"|null}]}`: the
other PCs of the mesh, each with why the chat can't go there now (`null`: it can). The top `why`
says why it can't move at all (then every target carries it): another PC's chat that its home
can't reach, a sub-agent (its lead moves it), a turn running, a provider other than Claude, a
chat on an SSH device, sharing off, a move already under way, or uncommitted changes where it
works ("… commit or stash them first"). Per PC: off or out of reach, an older Harbor, no Claude
account.

`POST …/move_pc` `{"pc": "<target id>"}` → `202 {"ok": true, "moving": true, "to": "<name>"}`:
the handoff runs on the hub; `409 {"error"}` when it can't start (the reasons above). Its outcome
shows in the chat: on success the chat turns into a copy of the target's (its `home`/`home_name`
change in the next state) with a `notice` (`icon: "monitor"`, "Moved here from …"); otherwise a
notice (`icon: "alert"`, "Couldn't move to …: why"). The target refuses when it has no project
for the chat's repository (matched by git remote, then folder or project name) or no Claude
account that can take it. Messages sent while it moves follow it.

### Snooze (0.78)

The desktop sidebar's clock menu ("Snooze until"): a snoozed chat leaves the list until its time
comes, then comes back unread (`unread: true`). A snooze belongs to the hub's sidebar, which is
the phone's list: the phone and that PC's desktop hide the same chats, and a snooze from either
shows on both. It's never forwarded to a copy's home PC (another PC's list, maybe another
person's, keeps the chat). Offer it on unsettled leads when the chat has `snoozed_until_ms`
(older hubs: no Snooze).

`GET /v1/snooze?text=<typed>&off=<seconds east of UTC>&chat=<id>` → `{"presets": [{"label":
"1 hour", "until_ms"}, {"label": "3 hours"}, {"label": "Tomorrow, 9:00"}, {"label": "Next
week"}], "text": "5h", "until_ms": 1793…|null, "preview": "until Today, 23:40", "snoozed":
"until Thu, 14:00"|null}`. All parts are optional. `off` is the phone's zone, so clock times and
labels follow it; without it the hub uses its own. `text` (echoed back, to drop stale answers)
is the custom field: a duration ("5h", "90m", "1h30m", "1h30", "1.5h", "2d", "1w"; units m, h,
d, w; a bare number is hours) or a clock time ("18:00", "6pm", "at 9": the next one, today or
tomorrow). Under a minute or over a year is no time. `preview` is the line under the field:
"until …" when it reads as a time (`until_ms` set), "Try 5h, 1h30m, 2d or 18:00" when it doesn't,
"" when empty. `snoozed`: until when `chat` is snoozed now, null when it isn't.

`POST /v1/chats/{id}/snooze` `{"until_ms": N}` (a preset's) or `{"text": "5h", "off": N}` (the
field's) → `{"ok": true, "snoozed_until_ms", "snoozed_label"}`; `400 {"error"}` for text that
isn't a time ("Try 5h, 1h30m, 2d or 18:00") or a time not within the next year.
`DELETE /v1/chats/{id}/snooze` wakes it now → `{"ok": true, "snoozed_until_ms": null, …}`.

### `POST /v1/transcribe?lang=<auto|en|pt>` (0.38)

Dictation from the app's mic. Since 0.55 the phone records itself (no Android `SpeechRecognizer`),
cuts the recording into phrases with Silero VAD (sherpa-onnx) and sends each phrase here as it
ends, with `cleanup=0` (below); when the hub doesn't answer within ~6 s, fails (other than `409`)
or is unreachable, its own offline sherpa-onnx model transcribes the phrase. A hub that answers
`404` to `GET /v1/voice` (before 0.55) gets the whole dictation here once, at the end, without
`cleanup`. Phones before 0.55
used `SpeechRecognizer` and sent whole recordings here only without one. The body
is the recording as a WAV file (16-bit PCM, mono, 16 kHz; at most 10 minutes), `Content-Type:
audio/wav`. The PC transcribes it with its speech model from Settings › Voice (see below) → `{"text":
"…"}` (it may be empty: nothing was said). `409 {"error": "…"}` says why it can't, to show as is:
since 0.53 whisper.cpp is built into the hub, and with no model yet the first recording starts its
download and gets `409` with the progress ("try again when it's done"). `lang` missing or empty: the PC's own setting.
`auto` (the default on both sides) detects the language per phrase, so a speaker can switch
languages; a fixed `lang` makes Whisper write everything in that language (translating the rest),
so phones send it only when the user picked one (since 0.74.2 the setting starts again from Detect). `GET /v1/state`
says beforehand (optional, 0.38): `"voice": {"transcribe": true|false, "why": "…"|null, "lang":
"auto"}`. Hubs before 0.38 answer `404`.

### Voice on the hub: Parakeet, mesh routing, cleanup (0.55)

Since 0.55 the hub's main speech engine is NVIDIA Parakeet TDT 0.6B v3 (int8, via sherpa-onnx,
built in; 25 European languages, detects the language itself). Its model (~670 MB) downloads on
first use; a built-in Whisper stays as the fallback (a language Parakeet lacks, or Parakeet
failing). The model is loaded only while in use and freed after an idle period. All fields below
are optional additions: old phones ignore them, and phones must treat a `404` from an older hub as
"not supported" (fall back to plain `POST /v1/transcribe`).

**Mesh routing.** A transcription runs on the mesh PC with the most free RAM at that moment
(`MemAvailable`; a PC that already has the model loaded counts its free RAM plus the model's size).
Near ties (within ~10%) prefer the PC that got the request. Unreachable or failing PCs are
skipped; the receiving PC is the last resort. The phone just calls its own hub: the hub routes.

#### `GET /v1/voice`

→ `{"engine": "parakeet"|"whisper", "model_state": "none"|"downloading"|"ready"|"loaded",
"progress": 0-100, "model_mb": 670, "mem_available_mb": 5120, "cleanup": true,
"keep_loaded_min": 5, "host": "<pc name>"}`. `engine`: what this hub transcribes with by default.
`model_state`: `none` (not downloaded), `downloading` (`progress` is present only then), `ready`
(on disk, not in memory), `loaded` (in memory). Used by mesh routing and the phone's Settings.

#### `POST /v1/transcribe` additions

Body and format unchanged (WAV, 16-bit PCM). New optional query parameters: `cleanup=0|1`
(default: the hub's "Clean up dictation" setting) and `local=1` (transcribe here, don't forward
to another PC; hubs set it when they forward, so requests never loop). The response keeps `text`
and may add `raw` (the transcript before cleanup; present when cleanup ran) and `host` (the PC
that transcribed). The `409` with the model download's progress stays.

#### Dictionary and spoken commands (0.76)

`GET /v1/voice` adds `"commands": true|false` and `"dictionary": [{"term": "SpokPay", "sounds":
["spoke pay"]}]` (the hub's personal dictionary: exact spellings, optional sound-alikes). `PUT
/v1/voice/settings` takes either (`dictionary` replaces the whole list; blank and duplicate terms
are dropped, at most 500 of 60 characters) and answers the new status. Phones keep the last
dictionary for phrases their offline model transcribes. The hub spells the dictionary's words in
everything it transcribes (a close spelling counts only for terms of 6+ letters said in two or
more words, or of 7+ letters) and gives them to the cleanup.

`POST /v1/transcribe?commands=1` (phones that know the reply): when the hub's commands are on, a
transcript that ends with "press enter" / "hit enter" / "aperta enter" (…), or whose last sentence
is only "send" / "enter" / "enviar" / "manda" (…), comes back without it and with `"send": true`
(the text may then be empty); a sentence that is only "new line" / "nova linha" becomes `"\n"`,
"new paragraph" / "novo parágrafo" `"\n\n"`. The phone then ends the dictation and sends the
message once the words are in (after the cleanup). The rules are `src/dictwords.rs`; the phone's
offline copy (`Words.java`) checks the same `android/test/dictation-cases.txt`.

#### `POST /v1/voice/cleanup`

Body `{"text": "…"}` → `{"text": "…"}`. Cleans up dictated text the way the "Clean up dictation"
setting does (filler words and false starts removed, punctuation and capitals fixed, spoken
self-corrections applied, every word kept in the language it was spoken, nothing added or
translated; an answer with many words the transcript doesn't have is dropped for the input). On any failure or timeout (~8 s) it
returns the input unchanged, still `200`. The phone sends each VAD phrase to `/v1/transcribe`
with `cleanup=0` for live text, then the whole text here when dictation stops.

#### `PUT /v1/voice/settings`

Body `{"cleanup": true|false, "keep_loaded_min": N}`, each optional → the same object as
`GET /v1/voice`. `keep_loaded_min`: minutes the model stays in memory after the last use
(Settings › Voice › "Keep speech model loaded"); `0` frees it right after each use. The desktop's
Settings › Voice shows the same two settings.

### `POST /v1/upload?name=<file name>&chat=<id>`

Raw body (the file), `Content-Length` required. `chat` is optional, an id or a gid (files go to
`<data>/uploads/<chat>/`, or `uploads/pending/`). → `201 {"id": "12/1761…-photo.jpg", "path": "/…"}`.
Pass `id` in `files` of a send or a new chat. Images reach the agent as images.

### `POST /v1/chats/{id}/stop_all`

The waiting bar's Stop all: stops the lead and its running sub-agents and clears their queues.
→ `{"ok": true, "returned": [...]}` like `stop`.

### `POST /v1/chats/{id}/continue`, `POST /v1/chats/{id}/cancel_limit`

The usage-limit line's Continue now (runs the waiting turn now) and Cancel (drops the planned
continue). → `{"ok": true}`.

### `POST /v1/chats/{id}/continue_on`

`{"account": "<id>"}`, one of the limit line's `targets`: the chat moves to that account and
continues there now (like the desktop's Continue on…). → `{"ok": true}`; `409` when that account
can't take it now (blocked, signed out, gone) or the chat couldn't move. Hubs before 0.48 answer
`404 unknown action`.

### `GET /v1/image?path=<absolute path>&max=<px>`

An image a card shows (its `images[].url`), with the token like every call. With `max`, a JPEG at
most that many pixels on its longer side (16–2048); without, the file as it is. Image files only
(png, jpg, gif, webp, …); `404` otherwise. An upload's `path` works too. Card URLs carry
`&chat=<gid>`: when the chat runs on another PC of the mesh, the PC answering fetches the image
from there (its paths are that PC's files). When an image can't be had, show its tile with a way
to try again. From 0.84 a chat of another PC asks that PC first, even when a file of the same path
is here, and a file a reply showed that's since deleted comes from the copy its PC kept.

### `GET /v1/media?path=<absolute path>` (0.50)

A video (or an image's original) a card's `media` shows, the file as it is with its
`Content-Type` (`video/mp4`, `video/webm`, `video/quicktime`, `image/…`) and `Content-Length`.
Only files that are really images or videos by their first bytes, at most 200 MB, never in key
folders (`.ssh`, `.gnupg`, …); `404` otherwise. `/v1/image` follows the same rules (and draws
SVGs as PNG). Card URLs carry `&chat=<gid>` like images; through another PC of the mesh a video
comes from the chat's own PC, up to 64 MB.

### `GET /v1/chats/{id}/team`

What the desktop's team panel shows beside a lead: its sub-agents, processes, wake-ups and its
project's webhooks. For a sub-agent, its lead's team. Read-only.

```json
{"lead": 12, "project_id": 1, "home": "",
 "agents": [{"id": 15, "name": "worker", "title": "Fix the parser", "account": "Claude · AB",
             "model": "Opus 5.5", "running": true, "started_ms": 1761200000000, "queued": 0,
             "paused": null, "settled": false, "updated_ms": 1761200000000, "usage": "12.4k tok · $0.18"}],
 "processes": [{"id": 3, "name": "dev", "cmd": "npm run dev", "url": "http://localhost:5173",
                "started_ms": 1761200000000}],
 "wakeups": [{"id": 4, "at_ms": 1761203600000, "reason": "Check the deploy"}],
 "webhooks": [{"id": 2, "name": "github", "description": "", "hits": 3, "last_ms": 1761200000000,
               "public": true, "url": "https://…/hooks/…"}]}
```

- `agents[].usage` (since 0.39; null before its first turn ends): its tokens and cost so far, shown
  after the model like the desktop's agent card.
- `agents`: working ones first, then the most recently active. `started_ms` is null unless
  `running`; `paused` names when a usage limit lets it go on ("14:00", "usage limit") or is null;
  `settled` agents are the desktop's folded "Settled" group.
- `processes` are the running ones; `url` is the first local URL it printed, or null.
- `wakeups[].at_ms`: when the lead is woken; `webhooks[].last_ms`: 0 when never called, `url`
  the public URL when there is one, else this PC's local one.
- `home`: the PC a copy of another PC's chat runs on ("" for this PC's own). Its processes,
  wake-ups and webhooks are there, so they're empty here.
- A change in a team (an agent starts, stops or queues, a process or a wake-up comes or goes, a
  webhook is called) is a change of its lead: the lead's id comes in `changed_chats`.

### `GET /v1/chats/{id}/slash`

The desktop composer's slash menu for this chat (`src/slash.rs`): what typing `/` at the start
of a word offers, with the same list, sources, descriptions and hints.

```json
{"pending": false,
 "entries": [{"name": "model", "aliases": [], "description": "Switch the model for this chat", "hint": "",
              "source": "harbor", "badge": "Harbor", "skill": false, "command": "model"},
             {"name": "compact", "aliases": [], "description": "Free up context", "hint": "<instructions>",
              "source": "builtin", "badge": "Built-in", "skill": false, "command": null},
             {"name": "review", "aliases": [], "description": "Review the diff", "hint": "",
              "source": "personal", "badge": "Personal skill", "skill": true, "command": null}]}
```

- `source`: `harbor` (Harbor's own), `project` / `personal` (the project's and the user's
  `.claude/commands` and `.claude/skills`), `builtin` / `plugin` (Claude Code's own list).
  `badge` is the label to show ("Harbor", "Built-in", "Plugin", "Project command", "Project
  skill", "Personal command", "Personal skill").
- The list follows the chat's agent: for a Claude chat on this PC it is Claude Code's own list
  (asked once per account and project, cached; commands that do nothing in Harbor are left out)
  plus the user's files; for other agents, and Claude on another device, Harbor's and the files.
  `/plan` shows only for providers with a read-only mode and becomes `/default` while the chat
  is read only. Since 0.31 Harbor also lists `/effort` (providers with effort levels), `/new`,
  `/fork` (when the chat has a finished reply to fork after), `/settle` (unless it is settled)
  and `/clear-queue` (while messages wait for the running turn); older PCs don't.
- `pending`: Claude Code hasn't answered yet; ask again in a second or two for its commands.
- Matching is the client's, as the desktop does it: case-insensitive on `name`, then `aliases`
  (one step lower), then `description`; exact, prefix, after `-` `_` `:` `/`, anywhere, the
  letters in order. Equal matches in `source` order harbor, project, personal, builtin, plugin,
  then by name. After other words only entries with `skill`, and `harbor` and `plugin` ones.
- Accepting an entry writes `/name ` in place of the word. Send it as typed: the PC expands it
  for agents that don't (the command's text, or the skill's instructions before the message),
  for messages from any device, queued ones too. Entries with a `command` act instead of being
  written: `model` and `effort` open the app's model and effort pickers, `new` the new-chat
  screen in the chat's project; `plan`, `default`, `fork`, `settle` and `clear-queue` are the
  call below. An app that doesn't know a `command` sends it to the call below, which answers
  `400` with a message to show for `model`, `effort` and `new`.

### `POST /v1/chats/{id}/slash`

`{"command": "plan"}` or `{"command": "default"}` → `{"ok": true, "chat": {…as in /v1/state…}}`.
The menu's /plan (the chat becomes read only, `access: "plan"`) and /default (back to the access it
had before /plan on any device, else the provider's first level), with the rules of `PATCH`.

Since 0.31 also: `{"command": "fork"}` forks the chat after its last finished reply, as
`POST …/fork` does, → `{"ok": true, "id": 12, "gid": "…"}` (`409` without such a reply);
`{"command": "settle"}` marks it settled → `{"ok": true, "chat": {…}}`; `{"command":
"clear-queue"}` drops the messages waiting for its running turn → `{"ok": true, "dropped": 2}`.

### `GET /v1/chats/{id}/tags?trigger=@&q=`

The desktop composer's `@` and `#` menu for this chat (`src/tags.rs`, since 0.31; older PCs answer
`404`: show no menu). `trigger` is `@` (the project's files: git's tracked and untracked-not-ignored
ones; in a project without Git, since 0.65, the folder's files on disk without hidden ones,
`node_modules`, `target` and other build folders) or `#` (the project's GitHub issues and pull requests, the latest 100 of each, from the PC's
`gh`); `q` is what follows the trigger up to the cursor. The PC ranks them as the desktop does
(file name exactly, prefix, at a word boundary, anywhere, a folder, the path, the letters in
order; issues by number, then title, open before closed) and sends at most 50, best first.

```json
{"pending": false,
 "items": [{"kind": "file", "insert": "@src/components/creators/creator-profile-dialog.tsx",
            "path": "src/components/creators/creator-profile-dialog.tsx",
            "name": "creator-profile-dialog.tsx", "dir": "src/components/creators", "icon": "tsx"},
           {"kind": "issue", "insert": "#12", "number": 12, "title": "Composer tagging",
            "state": "open", "url": "https://github.com/o/r/issues/12"},
           {"kind": "pr", "insert": "#15", "number": 15, "title": "Tag files", "state": "draft",
            "url": "https://github.com/o/r/pull/15"}]}
```

- The tag is the word at the cursor that starts with `@` or `#` (at the start, after a space or an
  opening bracket or quote; not `##` or `@@`). Accepting a row writes its `insert` and a space in
  place of the word. Ask again as the query changes; don't rank on the phone.
- `icon` (files): `ts`, `tsx`, `js`, `rs`, `json`, `md`, `image`, `shell`, `code` or `file`, drawn
  with the desktop's Lucide glyph and colour. `state` (issues): `open` / `closed`; (PRs): `open`,
  `draft`, `closed`, `merged`.
- `pending`: the PC is still listing the files or asking GitHub; ask again in a second.
- `trigger=$` (from 0.72; older hubs answer their file list or nothing: keep only `kind` "chat"
  rows): chats to mention, `{"kind": "chat", "insert": "", "chat": "<global id>",
  "title", "project", "pc", "status": "working" | "idle" | "settled", "updated", "line":
  "harbor · desk · idle"}`. Every chat the PC has (other PCs' too), never the chat itself nor
  sub-agents; ranked by title, then project, PC and status, this project's chats first and
  settled ones below active ones. `$` starts the word as `@` does (not `$$`, not `$5`). Picking a
  row takes the `$word` out (its `insert` is empty) and adds the chat to the draft's `mentions`
  (above). The phone draws the composer's chip as "💬 title · line": a tap opens the chat, a
  long-press drops it. `GET /v1/tags?trigger=$&project=…` lists the same for a new chat.
- A chat without a project has no files, and one whose project has no GitHub remote no issues:
  `items` is empty.
- Send the text as typed: the PC adds a short list of what was tagged after the message for the
  agent (each `@path` that exists in the project with its full path, each `#123` with its kind,
  title, state and URL), for messages from any device, queued ones too.

For a copy of another PC's chat, both calls are answered by its home PC, where its files and
agent are. A PC with a Harbor before 0.23 answers both with `404`: the app then asks the chat's
`home` PC, and the workspace's other PCs, directly, and sends /plan and /default to the one that
answered. When none can, a bare `/` shows why: the home PC's Harbor needs an update.


### `GET /v1/slash?project=&account=&device=&access=` and `GET /v1/tags?project=&trigger=@&q=`

The same two menus for the new-chat screen, which has no chat yet (since 0.33.1; older PCs answer
`404`: show no menu). `project` is a project's `id` (or its `path`, as in `POST /v1/chats`), empty
for none; `account`, `device` and `access` are the screen's picks (an unknown account: the
desktop's current one). The answers are those of the chat calls. Only Harbor's `model`, `effort`,
`plan` and `default` commands are listed (no chat to fork, settle or clear), and all four are the
screen's own pickers: `plan` sets the Permission pick to `plan`, `default` back to what it was.
Ask the PC the screen talks to; another PC's projects aren't its own.
### `GET /v1/usage`

Settings › Usage's breakdown (since 0.39; older PCs answer `404`): `{"projects": [row], "days":
[row], "accounts": [row]}`, each `row` `{"name", "label", "detail", "usage": {turns, input, output,
cached, cost, label, detail}}` (as in `usage` of the items call). `projects` costliest first ("No
project" for chats without one); `days` the last 14 that had turns, newest first ("Today",
"Yesterday", "Mon 24 Oct"); `accounts` by account name. All from every chat's turn results.

### `GET /v1/palette?q=&chat=`

The desktop's command palette (Ctrl+K, `src/palette.rs`, since 0.35; older PCs answer `404`: say
the PC needs an update). `q` is what's typed; `chat` the chat the phone has open, for its actions.
The PC ranks (every word in the title, the detail or hidden keywords, the title first; projects,
chats, agents, pages and actions in sections, the sections by their best row) and sends only what
the phone can open or do. With an empty `q`, the recent picks (from any device) come first, in a
`recent` section, then each section's first rows (chats by their last activity).

```json
{"sections": [
  {"key": "recent", "title": "Recent", "items": [
    {"id": "chat:12", "kind": "chat", "chat": 12, "title": "Fix the composer", "detail": "harbor", "icon": "message"}]},
  {"key": "actions", "title": "Actions", "items": [
    {"id": "act:settle:12", "kind": "action", "title": "Settle this chat", "detail": "Fix the composer", "icon": "archive"},
    {"id": "new:3", "kind": "new_chat", "project": 3, "title": "New chat in harbor", "detail": "~/Projects/harbor", "icon": "compose"}]},
  {"key": "pages", "title": "Pages", "items": [
    {"id": "page:prs", "kind": "page", "page": "prs", "title": "Pull requests", "detail": "GitHub", "icon": "pr"}]}]}
```

- `kind`: `chat` (open `chat`), `new_chat` (the new-chat screen in `project`, null for none),
  `page` (`prs` or `issues`), `action` (the call below does it: settle or unsettle the open chat,
  fork it after its last reply, fast mode on or off).
- `icon`: `message`, `bot`, `folder`, `compose`, `archive`, `unarchive`, `fork`, `gauge`, `pr`,
  `issue` (others: a generic one), the desktop's Lucide glyphs.
- Sections: `recent`, `actions`, `projects`, `chats` (settled ones too), `agents` (sub-agents),
  `pages`. The desktop also lists devices, Settings sections and window actions; the phone doesn't
  get those.

### `POST /v1/palette/run`

`{"id": "act:fork:12", "chat": 12}` → `{"ok": true, "open": 31, "gid": "…", "toast": ""}`. Remembers
the pick for the recent list, and does it when it's an `action`; `open` is a chat to show (a fork),
`toast` what to say. Send it for every pick (the screens open on the phone): other kinds only count
as recent. An item that isn't there any more answers `404`; /fork without a finished reply `409`.

### Pull requests and issues

The desktop's Pull requests and Issues pages, from this PC's GitHub CLI (`gh`, signed in on the
PC): what you wrote, were asked to review or are assigned, plus everything in the projects' GitHub
repos. `gh` takes seconds, so allow a 40 s read timeout; a list is served again for a minute
(`refresh=1` asks GitHub anew). Nothing here comes through `/v1/events`: the desktop also only
fetches when the page opens or on Refresh. `gh` failing (not installed, not signed in) answers
`502` with its message.

#### `GET /v1/prs?state=&involvement=&project=&author=&label=&draft=&review=&checks=&sort=&q=`

Every parameter is optional; the PC filters, sorts and groups as the desktop does:
`state` open (default) / closed / merged / all; `involvement` reviewing / authored; `project` a
repo (`owner/name`, from `projects`); `author` a login; `label` (repeat it: each must be on the
PR); `draft` only / hide; `review` approved / changes / required / none; `checks` passing /
failing / pending; `sort` one of `sorts[].id` (default `ready`); `q` the search box, with the
desktop's syntax (`label:a,b`, `-label:x`, `author:`, `draft:true`, `review:`, `checks:`, `#12`).

```json
{"viewer": "octocat", "total": 40,
 "groups": [{"key": "authored", "label": "Authored", "items": [
   {"number": 42, "title": "Compact drawer", "url": "https://github.com/o/r/pull/42", "repo": "o/r",
    "state": "open", "draft": false, "adds": 120, "dels": 40, "created_ms": 1761000000000,
    "updated_ms": 1761200000000, "branch": "feat/drawer", "review": "approved", "checks": "passing",
    "conflicting": false, "author": "octocat", "labels": [{"name": "ui", "color": "a2eeef"}],
    "review_requested": false}]}],
 "authors": [{"login": "octocat", "n": 12}], "labels": [{"name": "ui", "color": "a2eeef", "n": 3}],
 "sorts": [{"id": "ready", "label": "Merge readiness"}],
 "projects": [{"id": 1, "name": "harbor", "repo": "o/r"}]}
```

`groups` are Authored / Review requested / Others (one group without a label when `involvement`
is set); empty ones are left out. `state` open / closed / merged; `review` approved / changes /
required / none; `checks` passing / failing / pending / none. `projects` are this PC's projects
with a GitHub repo (ids as in `/v1/state`).

#### `GET /v1/issues?state=&account=&involvement=&project=&author=&assignee=&label=&milestone=&sort=&q=`

The same for issues: `state` open (default) / closed / all; `involvement` assigned / authored /
mentioned; `assignee` a login or `none`; `milestone` a title or `none`; `sort` one of
`sorts[].id` (default `updated`); `q` adds `assignee:`, `no:assignee`, `milestone:`,
`no:milestone`. Groups: Assigned / Authored / Mentioned / Others. Items:

```json
{"number": 50, "title": "…", "url": "https://github.com/o/r/issues/50", "repo": "o/r",
 "state": "open", "created_ms": …, "updated_ms": …, "comments": 3, "author": "octocat",
 "labels": [{"name": "bug", "color": "d73a4a"}], "assignees": ["octocat"], "milestone": "v1",
 "mentioned": false, "linked_pr": true, "accounts": ["octocat"]}
```

`state` open / done (closed as completed) / not_planned; `linked_pr`: an open PR says it fixes it.
Also `assignees` and `milestones` (`[{"name", "n"}]`) for the pickers.

**Every PC's account (from 0.45).** The hub merges the Issues of every PC of the mesh, each
fetched with that PC's own `gh` login and projects (`GET /mesh/v1/issues`), one item per URL.
Optional fields, which older hubs leave out:

- `accounts: [{"login": "octocat", "pc": "desk", "n": 12}]`: the logins in the list, the PCs
  signed in with each (`, `-joined) and how many items each sees: the Account filter's choices.
  The app shows the Account chip once there are two or more.
- `account=<login>` narrows the list to that account's items and makes Involvement (and the
  Assigned / Authored / Mentioned sections, and `mentioned`) about that login; without it, about
  every account's. `viewer` is then that login.
- `projects` (from 0.46.3) lists every PC's projects: this PC's (with `id`), then the other PCs'
  (one per repo, no `id`), then other repos of the list (no `id`, no `pc`); `pc` names the PCs
  that have it as a project (`, `-joined). `project=<repo>` filters by any of them. An entry
  without `id` is no project here: Fix with… then goes by the item's `fix_on`.
- Per item `accounts`: the logins that see it; `fix_on` (a PC's name) when the repo isn't a project
  on this PC but is on that one, where `POST /v1/issues/fix` runs the agent.
- `notes: ["laptop: unreachable", "desk: GitHub not connected"]`: PCs whose part is missing
  (off, not signed in, an older Harbor). The rest still shows; only when no PC has a list does
  the call fail (`502`, this PC's `gh` error).

`/v1/issues/view`, `close`, `reopen` and `fix` go to a PC whose account sees the issue (this PC
first), and `fix` to one that has the repo as a project; the hub forwards them over the mesh.
They take an optional `account` (query or body) to prefer that login's PC. A chat that `fix`
starts on another PC answers with this hub's id for its copy, as `POST /v1/chats` does.

#### `GET /v1/prs/view?url=<PR url>`, `GET /v1/issues/view?url=<issue url>`

One item as the desktop's side panel shows it. `url` must be `https://github.com/<owner>/<repo>/
pull/<n>` (or `/issues/<n>`); `400` otherwise. A PR:

```json
{"number": 42, "title": "…", "url": "…", "repo": "o/r", "state": "open", "draft": false,
 "author": "octocat", "created_ms": …, "updated_ms": …, "base": "main", "head": "feat/drawer",
 "adds": 120, "dels": 40, "files": 3, "labels": […], "conflicting": false,
 "reviewers": [{"login": "hubot", "state": "APPROVED"}], "body": "markdown", "blocks": […],
 "checks": [{"name": "build", "state": "pass", "url": "https://…"}],
 "comments": [{"author": "hubot", "at_ms": …, "body": "markdown", "blocks": […]}],
 "timeline": [{"at_ms": …, "who": "octocat", "kind": "opened"},
              {"kind": "commit", "sha": "1a2b3c4", "headline": "…"},
              {"kind": "review", "state": "APPROVED", "body": "…", "blocks": […]},
              {"kind": "comment", "body": "…", "blocks": […]}],
 "agent": "Claude"}
```

`state` open / closed / merged; reviewer `state` APPROVED / CHANGES_REQUESTED / COMMENTED /
DISMISSED, or PENDING for a requested review; check `state` pass / fail / pending / skipped.
`blocks` are the markdown as [Blocks](#blocks). `agent` names who Merge with… / Fix with… runs
(as the desktop's button says it). An issue has `state` (as in the list), `assignees`,
`milestone`, `labels`, `body`, `blocks` and `comments`.

#### `GET /v1/prs/diff?url=<PR url>`

`{"lines": [{"t": "file", "text": "src/x.rs", "adds": 2, "dels": 1}, {"t": "hunk", "text": "@@ …"},
{"t": "add" | "del" | "ctx", "text": "…"}], "clipped": false}`: at most 5000 lines.

#### Actions

`{"url": "…"}` bodies; `400` for a URL that isn't one of GitHub's.

- `POST /v1/prs/ready`: a draft, ready for review (`gh pr ready`). → `{"ok": true}`
- `POST /v1/issues/close`, `POST /v1/issues/reopen` (`gh issue close` / `reopen`). → `{"ok": true}`
- `POST /v1/prs/merge`, `POST /v1/issues/fix`, with `"extra": "instructions"` (optional): the
  desktop's Merge with… and Fix with…, a new chat in the repo's project where the agent does it.
  → `{"id": <chat>}`. `409` when the repo isn't a project, or the item isn't in a list this PC
  fetched for phones (fetch the list first).

### `GET /v1/people`, `PATCH /v1/people` (0.44)

Settings › People and memory, as the desktop's Settings › Devices shows it (`src/meshctx.rs`):

```json
{"pcs": [{"id": "pc:desk", "name": "desk", "self": true, "online": true, "owner": "Sam",
          "github": "sam-gh", "phones": ["Pixel"], "accounts": ["Claude · SG"],
          "line": "Sam · GitHub sam-gh · phones: Pixel · Claude · SG"}],
 "me": {"owner": "", "owner_hint": "Sam Doe", "github": "", "github_hint": "sam-gh",
        "send_context": true}}
```

`pcs`: this PC first, then the mesh's other PCs; `line` is the row's subtitle, made on the hub.
`me`: what this PC says about its owner (`owner`/`github` empty: the hints are used, the PC
account's full name and Harbor's GitHub sign-in) and whether a chat driven from this PC that runs
on another PC takes this PC's instructions and memory (`send_context`). `PATCH` takes any of
`owner`, `github`, `send_context` and answers like `GET`. Older hubs answer `404`: hide the row.

From 0.45 (shared files, `src/machines.rs`): each other PC in `pcs` has `share` (`off`, `read`,
`edit` or `full`: what chats running on that PC may do with this PC's files, shell and GitHub)
and `share_label` (since 0.55.3 a PC nobody chose a level for is `full`; before, `read`; an
explicit choice is stored and kept); `levels` lists the choices (`[{id, label, about}]`); `me.share_github` says
whether chats this PC drives on other PCs may run `gh` here with its GitHub sign-in. `PATCH` also
takes `share_github` and `share: {pc, level}`.

From 0.47 (detected profiles, `src/profile.rs`): each PC detects its owner's name and GitHub login
(git, gh, agent accounts, phones, SSH hosts and key comments, CLAUDE.md, the mesh's reports; one
Haiku question through the PC's own Claude account, else rules). Until the user confirms, that
detection fills in wherever nothing was typed. `me.owner_hint`/`github_hint` are what shows now
(typed, else detected, else the old fallbacks); `me` also has `suggested` (null before the first
run: `{owner, github, confidence: "high"|"medium"|"low"|"", why, by, at}`), `confirmed` (the user
typed a name or confirmed one), `detecting` (a run is going) and `check` (as `profile_check` in
`/v1/state`). Each entry of `pcs` has `suggested` (a detection nobody confirmed), `guessed` (this
PC's guess about a peer that says nothing itself) and `why` (the evidence, when this PC has it).
`PATCH` also takes `{"op": "confirm"}` (what shows becomes the user's own, in the fields still
empty; typed values stay) and `{"op": "detect"}` (run again; poll `GET` for `detecting`). Older
hubs ignore `op` and send none of these fields.

### `GET /v1/inbox`, `GET /v1/inbox/{id}`, `POST /v1/inbox/{id}/done`

What the hub's user sent this phone from Devices › Send. Each item waits on the PC that sent it
for up to a day, until the app takes it. `GET /v1/events` says how many wait (`"inbox": 2`), and a
new item wakes the long-poll. The app also asks every PC of its workspaces every 30 s while it's
open.

`GET /v1/inbox` → `{"items": [{"id", "kind", "name", "size", "text"?}]}`, only this phone's items.
`kind` is `text` (put `text` on the clipboard), `clip-image` (an image for the clipboard), `image`
(saved to Pictures/Harbor and opened) or `file` (saved to Download/Harbor). `GET /v1/inbox/{id}`
gives an item's bytes (`application/octet-stream`, `404` when it's gone). `POST /v1/inbox/{id}/done`
with `{}`, or `{"error": "<why>"}` when the phone couldn't take it, removes the item, and the PC
shows the item as delivered or failed.

### `POST /v1/providers/update`, `POST /v1/hub/update`

`{}`. The two update banners' buttons: update the hub's provider CLIs (each with its own updater:
`claude update`, `opencode upgrade`, `npm i -g …@latest`), or install the Harbor release on offer
and reload into it (running agents keep going). `{"ok": true}` when started; `409` when there's
nothing to update. A hub with a newer version already on disk answers `{"ok": true}` and
restarts into it about a second later (the reply goes out first). Progress shows in `/v1/state` (`provider_updates.updating`,
`hub_update.installing`; `state_changed` fires).

From 0.51 `POST /v1/hub/update` works without an offer too: a hub only learns of a release from
its own check (20 s after it starts, then every 4 h), so with none known it checks now and
installs what it finds: `202 {"ok": true, "checking": true}`; `hub_update.checking`, then
`installing`, then the reload. Nothing newer after all: it stays (`hub.status` "up to date" in
`GET /v1/app`). `409` only for a hub built from source (it doesn't update itself) or one busy
with another download. Hubs before 0.51 answer `409 "Harbor is up to date"` without an offer.

### `POST /v1/hub/check` (from 0.51)

`{}`. "Check for updates": the hub's scheduled release check, now (with Settings › Updates ›
Automatically on it also installs). `202 {"ok": true, "checking": true}`; the result shows in
`GET /v1/app` `hub` and in `hub_update`. `409` for a hub built from source; `404` before 0.51.

### `POST /v1/hub/auto` (from 0.53)

`{"on": true}` or `{"on": false}`: the hub's Settings › Updates, "Automatically" or "Ask me".
Turned on, a hub that updates itself also looks for a release at once (and installs it, then
swaps in while nobody uses it). `{"ok": true, "auto": true}`; `400` without `on`; `404` before
0.53 (offer it only for PCs whose `GET /v1/app` `hub` has `auto`). The phone's PCs sheet: a tap
on a PC picks Automatically / Ask me, and "Auto-update all" turns it on for every PC that asks;
the desktop's Settings › Devices has Auto-update per PC and "Auto-update all PCs" (through
`/mesh/v1/call`).

### `GET /v1/app`

`{"version_code": 7000, "url": "/app.apk", "hub": {…}}`; `version_code` 0: the hub has no app
to offer. Cheap (no UI thread), so the phone asks every PC of every pairing with it.

`hub` (optional, from 0.51; missing: an older Harbor, show no Update for it): the PC's own Harbor,
`{"version": "0.51.0", "managed": true, "latest": "0.51.1" | null, "ready": false,
"installing": false, "checking": false, "error": null, "status": "0.51.1 available"}`.
`managed`: an installed copy that updates itself (false: built from source, no Update).
`latest`: a newer release it knows of (null: none, or it hasn't checked yet; it checks on Update).
`ready`: `latest` is already on its disk. `status`: the line to show after its version ("up to
date", "checking for updates…", "updating to X…", "update failed: …", or `""` before its first
check). The phone's PCs page (sidebar › PCs) lists every PC with `Harbor <version> · <status>`
and an Update (`POST /v1/hub/update` to that PC, `callOn`) when it's `managed` and older than the
newest `version` or `latest` any PC says, plus "Update all" with two or more behind and "Check
for updates" (`POST /v1/hub/check` to each).

### `GET /v1/versions`

From 0.68 (`404` before: show nothing extra). Every PC's Harbor and every paired phone's app, as
the hub knows them, with the line to show built on the hub (the same text agents read):
`{"newest": "0.68.0", "pcs": [{"name": "desk", "self": true, "online": true, "seen": 1761600000,
"version": "0.68.0", "line": "0.68.0 (latest, updates automatically)"}, …], "phones": [{"name":
"Pixel", "app": 68000, "app_version": "0.68.0", "seen": 1761600000, "via": "laptop", "line":
"app 0.68.0 (68000), seen 5m ago at laptop"}]}`. `pcs`: this PC first, then the mesh's PCs; an
offline one keeps the version it last ran (`line` "0.66.0, offline (last seen 2d ago)"; `version`
"" when unknown). `phones`: paired here or on another PC of the mesh, most recently seen first;
`app` 0 = unknown (an app before 0.19), `via` "" = seen at this PC. The phone's PCs sheet shows
`phones` as "Harbor on your phones" and, for a PC that doesn't answer, "not answering · Harbor
<line>" from `pcs`.

`hub.auto` (optional, from 0.53; missing: false): the PC's Settings › Updates is
"Automatically". Such a PC installs releases in the background and swaps them in while nobody
looks at it (window closed, or focused and left alone for a few minutes with nothing typed), so
it shows no update toast meanwhile and its `/v1/state` `hub_update` stays null while it installs
or waits to swap in (an Update asked from the phone still shows as before).

The phone's own Settings › Update automatically follows `auto` until it's chosen on the phone
(on when any PC that answered says true). On, the background jobs (Alive, Listen) look for a
newer app (this call, at most every 10 minutes) and install it only while none of Harbor's
screens is in front and the screen is off or locked: Android always ends an app's process when
it replaces it. The next start opens the chat the user had (drafts are kept). A version that
didn't go in by itself is never tried again in the background: one notification per version
offers it ("Harbor X is ready: tap to install", which installs it in front, from the PC that
offered it), and Settings shows Android's whole reason (`INSTALL_FAILED_…`, with the status).
When the phone's verifier refused it (Google Play Protect wants to ask "Scan app?" for a build
it hasn't seen, which it can't with nobody there: `INSTALL_FAILED_VERIFICATION_FAILURE`), later
versions skip the background and go straight to the notification, until the user asks to try the
background again in Settings (after turning on Play Protect's "Improve harmful app detection").
Nothing on the wire changed for this (0.55.1).

### `GET /app.apk` (and `HEAD`)

No token needed on the PC's network; from outside it a signed-in phone (or a pairing from before
accounts, so old apps can update and then sign in). The APK the hub has (`404` when none), `application/vnd.android.package-archive`.

## Every PC is a hub

With Settings › Devices › "Share chats with my other PCs" on, each of the user's PCs running
Harbor keeps a full copy of every chat (`src/mesh.rs`), so any of them answers the phone with the
same chats, rendered the same way.

- A chat runs on one PC, its `home`. Another hub holds a copy: reading it is local; a write to it
  (`send`, `stop`, `stop_all`, `continue`, `cancel_limit`, `continue_on`, `fork`, `slash`, `move_pc`, `PATCH`, `DELETE`), and
  `GET …/slash` and `GET …/move_targets`, is forwarded to the home PC and answered from there. The message records where it came from (`sender`).
  While the home PC is off the copy is read-only (`writable: false`, writes `409`) and catches up
  when it's back.
- `POST /v1/chats` with a `device` that is another hub's id starts the chat on that PC (`409` when
  it's off); the answer's `id` is the copy's id on this hub (null if it hasn't arrived yet: find
  it by `gid` in the next state).
- One sender at a time: a message sent while another device is typing in the chat waits in the
  chat's queue (`send` answers `queued: true`) and goes out when they stop typing or send; the
  queue is the chat PC's and shows in `status.queue` on every hub.
- Ids differ per hub (`id`, `project_id`, `parent`); `gid` and `home` don't. A client that moves
  between hubs sends `X-Harbor-Ids: global` with every call: answers then name chats by `gid`
  (`id`, `parent`, `tree`'s chats, `forks_after`, `forked_from.chat`, `chat_link.chat`, `status.waiting.agents[].id`, the `id` of a
  new chat or fork, `changed_chats`) and projects by their path (`projects[].id`, `project_id`, `tree.projects[].id`,
  `defaults.project_id`); `project_id` in `POST /v1/chats` may be a path too.

### `GET /v1/hubs`

```json
{"hubs": [{"id": "ts:desk", "name": "desk", "host": "10.0.0.12", "ip": "10.0.0.12", "port": 47930,
           "fp": "<64 hex>", "addrs": ["10.0.0.12", "fd00::12"], "online": true, "self": true},
          {"id": "fp:0123abcd", "name": "laptop", "host": "10.0.0.20", "ip": "10.0.0.20", "port": 47930,
           "fp": "<64 hex>", "addrs": ["10.0.0.20"], "online": true}]}
```

The PCs this hub shares chats with: its workspace's (also ones it hasn't reached yet, from the
directory) and any paired by hand. Each is only reached pinned to its own `fp`; entries are `ip`,
`ip:port` or `[ipv6]:port` (the port of the first, or its own). A PC without an `fp` runs Harbor
before 0.13: skip it. `host`/`ip` are for apps before 0.13. The phone's Harbor token works on
every PC of its workspace, so there are no tokens here (before 0.85 each entry had one, minted
for the phone's pairing); the app adds these addresses to what the directory says (they're
fresher on the local network). `phones: false`: that PC's phone access is off (it would drop the
phone): skip it.

Since 0.34 (optional, older hubs leave them out) each other PC also has `seen` (unix seconds of
its last answer to this PC, 0: never) and, while `online` is false, `down`: `"harbor"` when its PC
refused the connection (the PC is up, Harbor isn't running there) or `"pc"` when nothing answered
(off, asleep, out of reach).

### When a PC doesn't answer

Harbor keeps running in the background when its window is closed (0.34, on by default), so a PC
normally answers while it's on. When it doesn't, the app tells apart what it can from its own
connection attempt: refused (`ECONNREFUSED`) = "Harbor isn't running on <PC>", a connect timeout
or no route = "<PC> is offline", each with when that PC last answered this phone (kept by the
app). The home screen shows it as a card with Try again over the last list the PC sent; the
long-poll keeps retrying (1–10 s apart) and the card goes when the PC answers. Connects time out
after 3 s (8 s with a single address), so nothing waits longer than a long-poll (25 s).

### Failover

The app keeps the PCs' addresses (encrypted, with the account) and sends every call to
the PC used last. When that PC can't be reached, or a call to it fails mid-way, the next one is
tried; the one that answers is used from then on (shown as "via <name>"). Revisions are per hub:
after a switch, start the long-poll over and reload. Only reads are retried at once; a write that
may have reached a PC isn't sent twice.

### Relay (`/relay/v1/…`)

A PC (or phone) that can't reach a peer directly can go through another PC of the mesh that
can: `POST /relay/v1/<peer fingerprint>/<port>` with an empty body, over that PC's pinned TLS.
The answer is `HTTP/1.1 200 Connection established` and an empty line, and from then on the
connection carries a raw byte stream to the peer; the caller runs a second TLS session inside
it, pinned to the peer's key (the relay only sees ciphertext). Allowed: a PC on the relay's
allowed list (any port of the peer: `harbor nc` uses it for ssh), or a signed-in phone of the
workspace (only the peer's Harbor port). Only to a PC on the relay's allowed list, at the addresses
the relay knows for it, never through a second relay. `403` not allowed, `404` not a paired PC,
`502` the relay can't reach it either. Idle streams close after 15 minutes.

The phone doesn't need it: every hub serves every chat (writes go to the chat's PC over the
mesh), so moving to any hub that answers is enough.

### Finding PCs on the network

While sharing is on, each Harbor sends a UDP datagram every 30 s (and at once when asked) to
`239.255.71.30:47930` and the broadcast address, port 47930:
`{"harbor": 1, "t": "here"|"ask", "id", "name", "fp", "port", "v"}`. Nothing in it is trusted:
for a paired PC it's one more address to try (pinned to its key), an unpaired one is listed in
Settings › Devices to pair with a code, and `harbor mesh join <name> <code>` looks names up this way.

### Hub to hub (`/mesh/v1/…`)

PCs talk on the same listener (port 47930) over the same mutual TLS, each showing its own key.
A caller is accepted when its key's fingerprint is on this PC's allowed list (kv `mesh_allowed`
= `[{fp, name, id, addrs, node}]`: Settings › Devices, `harbor mesh allow <fingerprint>`, or
pairing below). No token. A PC only follows peers it allows, so two PCs share once each allows
the other. A caller that isn't allowed gets `403 {"error", "harbor": true, "name"}`. Sharing is
kv `mesh_enabled` = `1` (`harbor mesh on`); both are re-read every 10 s. Requests say who sends
them in `X-Harbor-Id` and `X-Harbor-Name` (for the other side's Settings, never for access).

A peer is found by its key, not its address: its `hello` lists its addresses (`addrs`,
"host:port"), a PC that calls in leaves its address, and while Tailscale is installed its peer
list adds the tailnet addresses. Each is tried, pinned to the peer's key, until one answers.

- `POST /mesh/v1/pair` `{proof, id, name, addrs, port}` (any TLS client with a key): the caller
  typed the one-time code this PC shows (kv `mesh_pair` = `{code, expires, tries, paired}`;
  Settings › Devices › Show a code, or `harbor mesh pair`). `K = PBKDF2-HMAC-SHA256(code
  without dashes, uppercase, O→0 I/L→1; salt "harbor-pair-v1"; 100 000 rounds)`; the caller
  sends `proof = HMAC-SHA256(K, "harbor-pair-v1\njoin\n<host fp>\n<caller fp>")` with the
  fingerprints it saw in this very TLS connection, and checks the answer's
  `proof = HMAC-SHA256(K, "harbor-pair-v1\nhost\n<host fp>\n<caller fp>")`. A man in the middle
  shows another key, so neither proof fits. On success both add each other to `mesh_allowed`;
  the answer is `{proof, fp, id, name, addrs, port}`. The code is good for 10 minutes, once;
  `403` wrong code (5 of those void it), `404` no code shown, `429` more than 10 tries a minute
  from one address.
- `POST /mesh/v1/enroll` `{fp, id, name, addrs, port}` → `{fp, id, name, addrs, port}`: only in
  plain HTTP over Tailscale, from a PC allowed by Tailscale node before 0.13 (`tailscale whois`
  names it): the two swap keys, which go into their allowed entries. From then on that PC gets
  only `hello` and `enroll` in plain HTTP; everything else needs TLS with its key. `409` when
  another key is already on file for it (pair again).
- `GET /mesh/v1/hello` → `{id, name, version, epoch, accounts: [{id, short, kind}], revoked: [groups], phones, fp, addrs, port, owner, github, owner_suggested}`
  (`phones`: its phone access is on; also in each chats answer; `fp`, `addrs`, `port`: its key
  and addresses; from 0.44 `owner` and `github`: who owns the PC, for the who is who; from 0.47
  `owner_suggested`: they are that PC's own detection, not confirmed there yet; from 0.51
  `update`: its Harbor's updates, as `GET /v1/app` `hub`, also in each chats answer, for
  Settings › Devices' per-PC version and Update, which sends `POST /mesh/v1/call`
  `{method: "POST", path: ["v1", "hub", "update"], body: {}}` to that PC).
  `epoch` is the hub's start revision: revisions compare only within one epoch.
- `GET /mesh/v1/events?since=<rev>&epoch=<epoch>` → `{epoch, rev}` as soon as one of this PC's
  own chats changed after `since` (or one was deleted), or after 20 s. Another `epoch`: start over.
- `GET /mesh/v1/chats?since=<rev>&epoch=<epoch>` → `{epoch, rev, full, chats: [chat], gone: [id]}`:
  this PC's own chats changed after `since`, all of them (`full: true`) when `since` is 0 or the
  epoch is another; `gone` are own chats deleted since. A chat: `id` (on its home PC), `gid`,
  `title`, `project: {name, path, remote?}|null`, `account`, `model`, `effort`, `access`, `device`, `settled`,
  `updated`, `role`, `parent` (id there), `name`, `started`, `count`, `digest` (hex FNV of the
  items, only in full lists: a copy whose digest differs fetches its items from 0), `running`,
  `since_ms`, `queued`, `status` (as in items), `forks: [[seq, id]]`.
  `project.remote` (optional, from 0.62; older PCs send none and ignore it): the project's git
  origin URL. A shared project is the same one on every PC by its remote (normalized: host and
  path, lowercase, no `.git`), whatever folder each keeps it in; `path` stays the owner's and is
  still how the project is named in calls. A PC that lists the project without its folder clones
  the remote when one of its own chats first needs it (see `status.folder`). The `project` of a
  new chat forwarded with `POST /mesh/v1/call` (`POST /v1/chats`) carries `remote` too: a PC
  without the project then lists it and clones it for the chat's first turn, instead of `409`.
- `GET /mesh/v1/chats/{id}/items?since=<rev>&epoch=<epoch>` → `{epoch, rev, count, items: [{seq, item}]}`:
  raw transcript items (the database's JSON) changed after `since`; cut the copy to `count`.
- `POST /mesh/v1/call` `{method, path, body, sender, ctx?}`: a phone API call (`path` like
  `["v1","chats","12","send"]`, ids of the home PC) run as if made there; `sender` is stored on
  a message it sends. A new chat's answer carries `home` (the PC's id).
  From 0.44 a call that may start a turn (`POST /v1/chats`, `…/send`, `…/continue`, `…/slash`)
  carries `ctx`, the calling PC's person's context: `{v: 1, instructions, memory: {name: text},
  memory_id, settings, owner, github}` (their global CLAUDE.md, the auto-memory of the chat's
  project on that PC, and only `language`, `outputStyle`, `alwaysThinkingEnabled`,
  `includeCoAuthoredBy`, `attribution`, `autoMemoryEnabled` of their settings), or
  `{v: 1, off: true, owner, github}` when they don't send it. The chat's turns then run with
  that context in an overlay profile instead of the home PC owner's (also when `ctx` is
  missing: an older caller, nothing loads), until someone at the home PC or its phones writes in
  it. The home PC's GitHub and app sign-ins are off for it unless both say the same `github`.
- `GET /mesh/v1/share` (0.45) → `{level, github, projects: [{name, path}], home}`: what this PC
  lets the caller's chats do here (`level` as in `/v1/people`; `projects` empty when `off`; `home`
  only with `full`; `github`: chats it commands may use this PC's GitHub sign-in).
- `POST /mesh/v1/tool` `{tool, args, project, chat, memory_id}` (0.45) → `{ok, content}`: one call
  of the `machines` tools for an agent on the caller (`tool`: `bash`, `read`, `write`, `edit`,
  `glob`, `grep` with workspace.rs's arguments, or `github` `{args: [gh's arguments], cwd?}`;
  `content` is MCP tool content). Checked against what this PC shares with the caller: `read`
  allows read/glob/grep and `edit` also write/edit, both only inside this PC's Harbor projects
  (symlinks resolved); `full` allows everything as this PC's user. `github` needs `full`, or the
  share-GitHub setting on and a `memory_id` this PC sent in a `ctx` (a chat it commands).
  Relative paths and the shell start in the project named `project` here, else home (`full`) or
  the first project. A refusal is `{ok: false}` with the reason as text.
- `POST /mesh/v1/memory` `{id, files: {name: text | null}}` (0.44): memory an agent saved (null:
  removed) in a chat this PC commanded, sent back by the PC it ran on. Written only into the
  memory folder `id` was handed out for (in a `ctx`, valid 30 days), flat `*.md` names only;
  `404` for an unknown id.
- `GET /mesh/v1/issues?state=open|closed|all[&refresh=1]` → `{login, projects: ["owner/name"], items: [item]}`
  (0.45): this PC's own Issues, with its `gh` login and its projects' repos, for another PC's
  merged page. Items are `/v1/issues` items plus `avatar` and `trusted` (author is owner, member
  or collaborator). `gh` failing answers `200 {login: "", projects, error}`. Served again for a
  minute unless `refresh=1`. Older PCs answer `404`.
- `GET /mesh/v1/issues/view?url=<issue url>` → the raw `gh issue view --json` object, and
  `POST /mesh/v1/issues/close|reopen?url=<issue url>` → `{ok: true}`: with this PC's account,
  for a PC whose own can't see the issue.
- `POST /mesh/v1/upload?name=<file name>` (raw body) → `201 {id, path}`: a file for a forwarded call.
- "Move to PC…" (`src/movepc.rs`; peers say they take moved chats with `moves: 1` in `hello`):
  `POST /mesh/v1/adopt/check` `{gid, kind: "claude", email, project: {name, folder, remote}|null,
  from, code: {branch, sha}, worktree: {branch, remote}|null}` → `{ok, owns, busy?, ids?, why?,
  project?, account?}`: whether this PC already owns the chat (`owns`, with `ids` {gid: id}),
  is taking it now (`busy`), or could take it (`ok`, else `why`). With only `{gid}` it answers
  just `owns`/`busy`. Then the chat's home uploads `move.json` (`{chats: [{gid, title,
  session_id, started, model, effort, access, settled, role, parent (gid), name, items}]}`, lead
  first) and each session file (`<sid>.jsonl` and its sidecar folder `<sid>/…`) with
  `/mesh/v1/upload`, and sends `POST /mesh/v1/adopt` (the check's body plus `payload`: upload id,
  `sessions: [{sid, files: [{rel, upload}]}]`) → `{ok, ids}` once this PC owns the chats: it
  fetched the pushed worktree branch (if any) into a worktree of its own, wrote the sessions
  under its account's folder for its own path of the project, and made the copies its chats.
  This PC takes it only within 150 s of receiving the call (its listener waits 180 s), so the
  home PC, which gives up ownership only after this answer, never ends up with two owners; with
  no answer it asks `adopt/check` again, and the target's chat list (the chat listed as its own,
  or a full list without it) settles a move whose answer was lost.
- `POST /mesh/v1/lease` `{chat, view, device, kind, label, on, text?, draft?}`: someone types in (`view: false`; `draft` the shared draft without `files` (0.64), `text` its text for older PCs)
  or has open (`view: true`, `kind` `focused`/`away`) one of this PC's chats on another hub.
  Leases last 6 s (typing) and 15 s (open) unless renewed; the chats list carries them as
  `typing` and `viewing`.
- `POST /mesh/v1/mint` (before 0.85): minted phone tokens for pairings; gone, a 0.85 PC answers `404`.
- `POST /mesh/v1/revoke` `{groups: […]}`: pairings (from before 0.85) removed on another PC; their tokens here go too.
- `GET /mesh/v1/phones` → `{phones: [{group, name, seen, app, alive}], apk, owner, github, owner_suggested}` (`alive`: unix s of its last background ping, from 0.37.1; `owner`, `github` from 0.44, `owner_suggested` from 0.47, as in `hello`): where this PC saw the
  phones (unix `seen`, `app` its versionCode, 0 unknown) and the versionCode of the phone app it
  serves. Each PC asks the others every 15 s: a phone that talks to another PC shows online
  there, "via" that PC. A PC whose peer serves a newer app takes it.
- `GET /mesh/v1/app.apk`: the phone app this PC serves, for a paired PC (`403` otherwise). A
  phone app that only asks the PC it talks to thus finds the newest one there too; the app
  from 0.19 also asks every PC it knows (`GET /v1/app` on each) and downloads from the newest.
- `POST /mesh/v1/phones` `{}`: turn this PC's phone access on (Settings › Devices' "Enable phone
  access" on another PC).

## The APK in releases

The release workflow attaches `harbor-android.apk` and `harbor-android.apk.minisig`
(trusted comment `harbor vX.Y.Z harbor-android.apk`) and lists the APK in the release's
`SHA256SUMS`. Its versionCode is `major*1000000 + minor*1000 + patch` of the Harbor version
(0.7.0 → 7000). Harbor's updater and install.sh fetch it into the install folder
(`~/.local/lib/harbor/harbor-android.apk`, with `harbor-android.version` beside it); builds from
source keep it in `~/.local/share/harbor/` (Settings › Phones › Download).
