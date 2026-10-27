# Harbor phone API (v1)

The contract between Harbor for Android and a desktop Harbor (the "hub"). Implemented in
`src/api.rs`; this file is the reference for both sides.

## Transport

- HTTP/1.1 inside TLS, JSON bodies (UTF-8), `Connection: close` on every response.
- The hub listens on every interface, port **47930** by default (kv `api_port`, applies after a
  restart; `HARBOR_LISTEN=addr,…` picks addresses). Turned on in Settings › Phones.
- **Keys.** The hub and each phone have a long-term key of their own: the hub an ECDSA P-256 key
  and self-signed certificate in `identity.pem` in its state dir (owner-only), the phone an EC
  P-256 key in the Android Keystore (non-exportable) with the certificate the Keystore makes. A
  key's *fingerprint* is the SHA-256 of its certificate's SubjectPublicKeyInfo, 64 lowercase hex
  characters.
- **Mutual TLS, pinned.** TLS 1.3 (the hub also takes 1.2 from phones whose Android has no 1.3).
  The phone checks that the hub's certificate has the fingerprint from the pairing, and nothing
  else (no CA, no names); it shows its own certificate. The handshake signatures are checked
  against that same key. The hub binds a pairing's token to the first phone key it's used with
  (`api_tokens[].fp`); from then on the token is refused with any other key (`401`).
- **Three factors** (from 0.22, [below](#three-factors)): every call carries a session and a MAC
  under the session's current key (`X-Harbor-Session`, `X-Harbor-Auth`); the pairing's token
  alone (`Authorization: Bearer <token>`) only pairs and starts sessions. `GET /app.apk` needs
  neither on the PC's own network. Optional `X-Harbor-Device: <phone name>` (shown next to the token in Settings › Phones) and,
  from app 0.19, `X-Harbor-App: <versionCode>` (Devices and Settings › Phones show the app's
  version and say when it's out of date; the other PCs learn it through `GET /mesh/v1/phones`).
- **Plain HTTP** is answered only from 127.0.0.1 (`adb reverse`, test rigs). Elsewhere it gets
  `426` and nothing else. One exception while users upgrade: a hub that still has Tailscale
  answers plain HTTP on its Tailscale interface, from Tailscale addresses, for tokens no key is
  bound to yet (apps before 0.13; they update themselves from there).
- A TLS client without a known key gets nothing but `GET /app.apk` and PC pairing
  (`POST /mesh/v1/pair`). From outside private networks (a public IPv6, a forwarded port) only a
  key the hub knows gets any answer. Failed authentications are counted per address (IPv6 per
  /64): past 30 a minute, connections are closed without an answer. At most 12 connections per
  address at once.
- Request bodies need `Content-Length` (no chunked encoding). JSON bodies ≤ 2 MB, uploads ≤ 200 MB.
- Errors: a status code and `{"error": "<message for the user>"}`.
  `401` not authorized: one generic answer whatever failed (the reason goes to the hub's log and
  Settings › Phones), with `rekey: true` (start a new session) or `upgrade: true` (a pairing
  from before three factors: run the upgrade), `400` bad input, `404` no such
  chat/route, `409` not possible now (e.g. fork of a running turn), `413` too large,
  `503` Harbor busy/closing.
- When phone access is turned off, connections are closed without an answer.
- The app sends nothing but pinned TLS, except plain HTTP to loopback for a pairing without a
  key, and the one-time upgrade below.

## Pairing

One pairing reaches every PC of the mesh: `GET /v1/hubs` hands the phone a token for each other
PC, with that PC's key and addresses (see [Every PC is a hub](#every-pc-is-a-hub)).

The QR code in Settings › Phones encodes

```
harbor://pair?v=3&host=<address>&port=<port>&token=<token>&name=<hub name>&ip=<address>&fp=<hub fingerprint>&addrs=<address>,<address>,…
```

all values percent-encoded. `addrs` are the hub's addresses (at most 6) in the order to try them:
its network's IPv4, the public address its router maps for it or a port forward set by hand
(`ip:port` when the port differs), a dynamic DNS name for the home (`name:port`), IPv6 (global ones reach it from mobile data where the router lets them in), then
Tailscale's while it's installed. An entry is `ip`, `ip:port` or `[ipv6]:port`;
the app tries the one that answered last, then each of them, then `host` and `ip` (which apps
before 0.13 use: a Tailscale address while the PC has one). Every try is pinned to `fp`; a hub
that answers with another key is never sent the token. The same values are shown as text under
the code. `/v1/state` gives the hub's current `hub_addrs`, so the app's list follows address
changes.

The `token` of a link is a **pairing code**: it works for 10 minutes, once, and for nothing but
the pairing below; the pairing becomes real only when the person at the PC confirms the 6-digit
code both screens show (Settings › Phones › Confirm a phone; the PC also posts a desktop notice).
"Done" or a second phone trying the same code voids it.

**Upgrading a pairing from before 0.13** (no `fp`): the app makes one TLS connection to the
pairing's Tailscale address, only through Tailscale's VPN (as before 0.13, WireGuard vouches for
the hub there), takes the hub's fingerprint from that handshake and pins it from then on; the hub
binds the token to the phone's key on that same call. Without Tailscale such a pairing can't
upgrade: the app asks to pair again.

## Three factors

A phone reaches a hub only with all three, checked when a session starts; then every call needs
the session's current key, which changes every 10 minutes. Code: `src/phoneauth.rs` (hub),
`Sec.java`, `Presence.java`, `Hub.java` (phone).

| factor | what | where it lives | checked |
|---|---|---|---|
| 1. Device key | the phone's TLS key (`harbor-tls`, EC P-256), pinned by fingerprint | Android Keystore, non-exportable | every connection (mutual TLS), and every MAC and transcript names it |
| 2. Pairing secret | 32 bytes from an ECDH agreement at pairing, confirmed by the 6-digit code on the PC | phone: the encrypted pairing list (AES-GCM key in the Keystore); hub: kv `api_tokens[].secret` | HMAC over each session's handshake |
| 3. User presence | a second Keystore key, `harbor-presence` (EC P-256, `setUserAuthenticationRequired`, usable 5 minutes after the fingerprint, face or screen lock) | Android Keystore; the hub pins its public key (`api_tokens[].presence`) | its signature over each session's handshake |

A phone without a screen lock can't make the presence key: from 0.34.1 it pairs with **two
factors** (1 and 2, sessions and rotating keys unchanged), see [Two factors](#two-factors-no-screen-lock).

### Notation

- `th(label, p1, p2, …)` = SHA-256(label ‖ 0x00 ‖ for each part: its length as 4 bytes big-endian ‖ the part).
- `HKDF(salt, ikm, info)` = HKDF-SHA256 (RFC 5869), 32 bytes. `Expand(prk, info)` = HKDF-Expand to 32 bytes.
- `HMAC(k, label, t)` = HMAC-SHA256(k, label ‖ t).
- Fingerprints are the 64-hex strings (their ASCII bytes); ECDH keys and the presence key travel as
  P-256 SubjectPublicKeyInfo DER (91 bytes), hex in JSON; signatures are ECDSA-SHA256, ASN.1 DER.
- `X` = 32 bytes of TLS exporter (RFC 5705 / RFC 8446 §7.5) of the connection the request travels
  on, label `EXPORTER-harbor-v3`, no context. A phone that can export (Android 12+) says
  `binding: true` at pairing; from then on the hub wants `X` in every handshake and MAC of that
  pairing. Without binding, `X` is empty (in transcripts) or `-` (in MACs).

### Pairing (and the upgrade)

`POST /v1/pair/start` with `Authorization: Bearer <pairing code token>` (or a pairing's token
from before three factors: the upgrade, only from the TLS key that token is bound to), over TLS:

```json
{"epk": "<phone ECDH key>", "presence": "<presence public key>", "binding": true,
 "psig": "<presence signature>", "name": "Pixel 8"}
```

- `psig` signs `th("harbor-pair-v3 presence", hubFp, phoneFp, token, epk, presence, "1"|"0", X)`
  (so pairing already wants the unlock).
- Two factors (no screen lock, from 0.34.1): `"nolock": true` instead of `presence` and `psig`
  (sending both is refused); `presence` is then empty in `T`.
- The hub answers `{"epk": "<hub ECDH key>", "wait_ms": 180000}`. Both compute
  `T = th("harbor-pair-v3", hubFp, phoneFp, token, epkPhone, epkHub, presence, "1"|"0", X)`,
  `Z` = the ECDH secret, `S = HKDF(T, Z, "harbor-pair-v3 secret")` and the code:
  `HKDF(T, Z, "harbor-pair-v3 sas")`'s first 4 bytes as a big-endian number, mod 1 000 000, 6 digits.
- The phone shows the code; the PC shows it under "Confirm a phone" with the phone's name and key.
- `POST /v1/pair/finish` `{"proof": HMAC(S, "harbor-pair-v3 phone", T)}` (same token and TLS key)
  waits up to 20 s for the PC's answer: `{"status": "waiting"}` (ask again), `403` refused, or
  `{"status": "paired", "proof": HMAC(S, "harbor-pair-v3 hub", T)}`, which the phone checks. Then
  the token is the pairing's (bound to the phone's TLS key, with `S`, the presence key and
  `binding`); the phone keeps `S` with the pairing. A wrong proof voids the attempt; the PC's
  confirmation waits 3 minutes.

### Sessions

1. `POST /v1/session/hello` (Bearer token of a three-factor pairing, its TLS key)
   `{"epk": "<fresh ECDH key>", "nonce": "<32 bytes>"}` → `{"hid", "epk", "challenge": "<32 bytes>", "factors": 3}`
   (`factors` from 0.34.1: `2` for a pairing confirmed without a screen lock; absent means 3).
2. `POST /v1/session/open` (same) within 60 s: `{"hid", "proof", "sig"}` with
   `T2 = th("harbor-session-v3", hubFp, phoneFp, token, epkPhone, epkHub, nonce, challenge, X)`
   (`X` of this second connection), `proof = HMAC(S, "harbor-session-v3 proof", T2)` (factor 2)
   and `sig` = the presence key's signature over `"harbor-session-v3 presence" ‖ T2` (factor 3).
   For a two-factor pairing `sig` is left out (the hub ignores it).
   → `{"sid", "epoch_ms": 600000, "grace_ms": 30000, "idle_ms", "max_ms", "proof", "factors"}`, where
   `root = HKDF(T2, Z ‖ S, "harbor-session-v3 root")` and `proof = HMAC(root, "harbor-session-v3 hub", T2)`:
   the phone checks it (the hub knows `S` and the fresh `Z`).

The app asks for the unlock before step 1 when the presence key can't sign (5 minutes after
the last unlock), and only while it's in front. Five failed opens within 15 minutes lock the
pairing for 15 minutes (Settings › Phones shows it, with Unlock). A session ends after 30 minutes
without calls, after 12 hours, when the pairing is revoked (here or on another PC), and when the
hub restarts; at most 4 per pairing. Sessions live in memory only.

### Two factors (no screen lock)

From 0.34.1. Android only lets the presence key exist behind a secure screen lock
(`KeyguardManager.isDeviceSecure()`), so a phone without one pairs with factors 1 and 2 only.
Both screens say so: the PC's confirmation card ("wants to pair with two factors"), its
Settings › Phones row (amber "2 factors" badge) and Devices row ("2-factor, no screen lock"), and
the phone's Settings › Sign-in row, each with the hint that a screen lock adds the third.

- Hub: `api_tokens[].nolock = true`, `presence` empty, `keys_at` (unix s of the last change of
  factors). `nolock` is only ever set by a pairing or re-confirmation the person at the PC
  confirmed with the code; a token with a presence key always wants its signature.
- **Adding the third** (a lock set later): the app sees `factors: 2` on a session while the phone
  is secure, makes the presence key and, over that session, sends
  `POST /v1/pair/presence {"presence": "<key>", "psig": "<sig>"}`, `psig` over
  `th("harbor-presence-v3", hubFp, phoneFp, token, sid, presence)` → `{"factors": 3}`. Adding a
  factor needs nothing more. A pairing that has a presence key already gets `409` for another one.
- **Losing the third** (the lock removed, or changed so Android erased the key): the app can't
  sign, and the phone's key and secret alone must not be enough to drop the factor. It offers
  "Use two factors" (no lock) or "Re-confirm" (a new lock, a new key): the pairing ceremony
  again with the pairing's own token (`POST /v1/pair/start` at session level, only from the TLS
  key it is bound to), plus `"rekey": HMAC(S, "harbor-rekey-v3", th("harbor-rekey-v3", hubFp, phoneFp, token, epk, presence, "1"|"0", X))`
  (`presence` empty with `nolock`). A wrong proof counts as a failed session start. The PC
  shows "lost its screen lock: asks to go on with two factors" (or "has a new screen lock") with
  the code; only its Confirm changes anything. `S` stays the same (the mesh's PCs keep theirs).
- **The mesh**: `POST /mesh/v1/mint` also carries `nolock` and `keys_at`; a PC with the same
  secret takes the other factors when `keys_at` is newer (and ends that pairing's sessions).
  A PC that still says `factors: 3` to a two-factor phone is skipped until it has heard.
- Old hubs refuse `nolock` and re-confirmation (`401`): the app says to update Harbor on the PC
  or set a screen lock. Old apps never send them.

### Background pings (online with the app closed)

From 0.37.1 (optional: older hubs answer `401`, older apps never ping). The app schedules an
Android JobScheduler job every 15 minutes with any network (`Alive.java`, persisted across
reboots; Doze and App Standby run it later). It pings one PC, the one calls go to first, then
the others, until one answers:

`POST /v1/alive` with `Authorization: Bearer <token>` over pinned TLS (factor 1), body
`{"ts": <unix ms>, "mac": HMAC-SHA256(K_alive, th("harbor-alive-v1", hubFp, phoneFp, token, ts as decimal text, X))}`,
`K_alive = HKDF("harbor-alive-v1", S_pc, "harbor-alive-v1 key")` (factor 2; the screen lock isn't
needed, nobody is there to unlock). → `{"ok": true, "every_s": 900}`. `ts` must be within
10 minutes of the hub's clock and newer than that pairing's last ping (no replays); `X` as in
sessions when the pairing has binding. Anything wrong is the usual `401`, without counting towards
the pairing's lock-out. Only two- and three-factor pairings can ping.

The hub records the time and nothing else: no session, no call, no `seen` (that stays "the app
is open"). Devices shows a phone **Harbor open** while its app calls (within 75 s), **online**
while its last ping is under 35 minutes old, else offline with "seen X ago" (the newest of
both). The mesh shares pings (`alive` in `GET /mesh/v1/phones`), so a ping to one PC counts
on all.

### Notifications

From 0.40 (optional: older hubs ignore `since` and answer without `notes`). The hub keeps a
short list of notes (a day, 200 at most; `src/notify.rs`) for what matters:

| `kind` | when | key |
|---|---|---|
| `input` | a lead chat's turn ends with a question, or a chat waits for you after a usage limit (`act: "continue"`) | `chat:<gid>` |
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
note. This read needs factors 1 and 2 only (no session, no screen lock): what a lock-screen
notification would show anyway. Acting on a note goes through a normal session.

The app (`Notes.java`, `Alive.java`, `Listen.java`, `NoteAction.java`):
- the 15-minute ping job takes notes; for 8 minutes after the user leaves the app a one-off job
  long-polls (`wait_ms` 60000), when an answer is most likely; **Instant notifications** (off by
  default) runs a minimised foreground service that keeps a 240 s long-poll open (seconds instead
  of minutes, a silent ongoing notification, a little battery);
- shows nothing while Harbor is in front; filters by the phone's own choices (kinds, quiet hours,
  only when away), Android channels per kind;
- actions: tap opens the chat (or the PR's `url`), **Reply** (RemoteInput) sends
  `POST /v1/chats/{gid}/send {"text"}` over a session (three factors: Android unlocks the phone
  first, Android 12+), **Continue** sends `POST /v1/chats/{gid}/continue`. Harbor runs agents
  without permission prompts, so there is no approve/deny.

The desktop shows its own notes with notify-send (click opens the chat) only while Harbor's window
isn't in front, per Settings › Notifications (kinds, "only when I'm away", quiet hours); a key
pops up at most every 30 s, else its notification is replaced quietly.

### Every call

```
X-Harbor-Session: <sid>
X-Harbor-Auth: <epoch>.<counter>.<hex HMAC-SHA256(K_epoch, msg)>
msg = "harbor-req-v3\n<sid>\n<epoch>\n<counter>\n<METHOD>\n<request target as sent>\n<Content-Length or 0>\n<phoneFp>\n<hubFp>\n<hex X, or ->"
```

- **Rotation.** `C_0 = root`, `C_{e+1} = Expand(C_e, "harbor-v3 chain")`,
  `K_e = Expand(C_e, "harbor-v3 mac")`. The epoch is the time since the session opened divided
  by `epoch_ms` (10 minutes), each side on its own monotonic clock. Each step erases the link
  before it (a key taken from memory opens nothing older). The hub takes the previous epoch's key
  for `grace_ms` after a change and the next one for `grace_ms` before it, then the old key is
  gone; anything else is refused with `rekey: true`.
- `counter` starts at 1 and is never used twice in a session (the hub keeps a window of 128, so
  calls may arrive out of order). With binding, `X` ties the MAC to its one TLS connection.
- Ten bad MACs end the session. Every refusal counts towards the per-address limit (30 a minute).
- A call refused for its session wasn't run: the app ends that session, starts a new one and sends
  the call again (writes too). Long-polls and uploads are checked when they start, so a key change
  during one doesn't cut it.

### The other PCs of the mesh

Each PC gets its own secret, so no PC holds another's: `S_pc = HKDF(pcFp, S, "harbor-hub-v3")`.
For a three-factor pairing `GET /v1/hubs` mints nothing: other PCs come with `token: null,
provision: true`. The app then sends `POST /v1/hubs` `{"secrets": {"<pc fp>": "<S_pc hex>"}}` over
its session; the hub passes each to that PC in `POST /mesh/v1/mint` (with the presence key and
`binding`) and answers like the GET, with tokens. The phone starts a session with each PC on its
own (`S_pc`, the same presence key).

### Upgrading older pairings

A pairing made before 0.22 (token bound to the phone's TLS key, no secret) gets only
`GET /v1/app`, `GET /app.apk` and `POST /v1/pair/*`; everything else is `401` with
`upgrade: true`. The app (0.22) then offers "Upgrade the pairing": the same ceremony with the
pairing's own token, confirmed on the PC (marked "asks to upgrade"). There is no way back: a
three-factor pairing never works with the token alone. Apps before 0.22 can still update
themselves (`/v1/app`, `/app.apk`), also from outside the home network, and then upgrade.
Plain HTTP from 127.0.0.1 keeps working with the token alone (test rigs, `adb reverse`): it's
this PC itself.

Test rigs may set `HARBOR_TEST_EPOCH_S` (20 to 3600) on the hub for shorter epochs; the phone
follows `epoch_ms`.

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
  hubs leave it out) is what an empty `effort` means for each kind (the CLI's own default, e.g.
  `high`): show a chat's or the defaults' `""` as that level, and pick it for a new chat.
- `role`: `lead` (a project's thread), `sub` (a subagent of `parent`; usually hidden), `chat`.
- `tree` (optional, older hubs leave it out): where the desktop sidebar places each chat, so the
  list shows the same chats in the same places. `{"projects": [{"id": 1, "snoozed": false,
  "chats": [14, 12]}], "threads": [9], "settled": [3]}`, chat ids in display order. Each project
  lists all its unsettled leads, newest first, as siblings; `threads` are leads with no project
  (or a project the hub doesn't have); `settled` holds every settled lead. Sub-agents and
  snoozed chats are in none of them; a `snoozed` project shows only while searching. Without
  `tree`, group `chats` by `project_id` and `settled` as before.
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
- `hub_fp`, `hub_addrs`, `hub_port`: this hub's key and where it answers (keep the pairing's
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
- `viewing`: the other PCs of the mesh that have the chat open: `[{device, kind, label}]`, `kind`
  `focused` or `away` (their window isn't in front).
- `switchable` / `allowed_accounts`: which run settings `PATCH /v1/chats/{id}` may change now,
  and the accounts it may switch to (see [Run settings](#run-settings)).
- `gid`: the chat's global id, the same on every PC of the mesh (see [Every PC is a hub](#every-pc-is-a-hub)).
  Every `{id}` in a path may be the `gid` instead; keep it to find the chat again on another hub.
- `home` / `home_name`: the PC the chat runs on (its peer id, its name). `writable`: false while
  that PC is off: show the chat read-only with "<home_name> is off" (writes answer `409`).

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

| kind | what the desktop draws | fields |
|---|---|---|
| `hidden` | nothing: remove it if you had it (a lead's coordination; it can become hidden later, when its turn delegates) | only `forks_after` (then draw just the divider) |
| `user` | the right-aligned bubble: mention chips, image strip, text, a 📎 line per other file; "from `sender`" under it when there is one | `text`, `files` (names of non-image files), `images`, `mentions: [{from, text}]`, `at` (unix s), `sender` (where it was written when not on the chat's PC: "Pixel", "desk", "Pixel via desk"; empty otherwise) |
| `text` | the reply (markdown), image strip under it; Fork among its actions when `forkable`; commit pills in its spans (below) | `markdown`, `blocks` (below), `images`, `at`, `forkable`, `commits` (optional, 0.52) |
| `thinking` | a collapsed "Thinking" header; expands to italic text | `text` |
| `tool` | one row: status icon (spinner / ✓ / ✗), `label`, `summary`; tap expands `input` and `result`; image strip under it | `label`, `summary`, `input`, `result` (null while running), `done`, `is_error`, `images` |
| `footer` | the turn's line, monospace and subtle | `text` (e.g. "Claude · AB · Opus 5.5 · 4.3s · 189k in (180k cached) · 304 out · $3.96"), `at` |
| `forked_from` | "Forked from conversation · Open source conversation" divider | `chat`, `seq` (open that chat at that card) |
| `notice` | a centred pill with the icon and `text`; with a `detail` it expands to it (as markdown when `detail_markdown`); with a `url` (a process's address) tapping opens it. Icon `report` (bot glyph) is a lead's one-line entry for a sub-agent's final report ("api finished: Added tests for X"), its `detail` the whole report | `icon`, `text`, `detail`, `detail_markdown`, `url` |
| `message` | the blue card "`from` → `to`" with `text` | `from`, `to`, `text` |
| `error` | the red card, monospace | `text` |
| `media` (0.50) | an image or video an agent showed with its `show_media` tool, drawn like a `text` card's `media` | `media` (one entry; absent when the file can't be shown), `caption`, `pending` (the call hasn't answered yet), `images` |

Optional on `text`, `tool` and `media` cards (0.50): `media: [{name, caption, kind, url, poster?}]`,
the images and videos the card shows large, in order: a reply's markdown images
(`![caption](path or https URL)`), `show_media`, and any video a reply or tool names. `kind` is
`image` (`url` = `/v1/image?…&max=512`; ask a bigger `max` for the inline copy, open the viewer
on tap) or `video` (`url` = `/v1/media?…`, the file itself; `poster` = `/v1/image?…` of the video,
a JPEG of its first frame, `404` when the PC has no ffmpeg). Draw the `images` not in `media` (same
`url`) as the strip; older apps ignore `media` and still get every image in `images`. A video
plays from a local copy (download it with the token, then a player); a media item that can't
load shows a small "can't load" tile that retries on tap. `blocks` leave out the markdown images
that `media` draws.

`images` are `[{name, url}]`; `url` is `/v1/image?path=…&max=512` (below). Tool `input`/`result`,
notice details, messages and errors are clipped to 16 KB. Ignore unknown kinds.

#### Status

`status` is the bars the desktop shows under the transcript; each part is null or empty when
the desktop shows nothing:

- `queue: [{text, files, sending}]`: messages waiting for the running turn, right-aligned
  bubbles labelled "Queued" (or "Sending" once handed to the agent).
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
  `name` in semibold, "  ·  `doing`" ("running tests", "editing src/chat.rs") and the time since
  `since_ms` on the right ("40s", "2m", "1h 5m"), after `usage` and "  ·  " when it isn't empty
  (its tokens and cost so far, "12.4k tok · $0.18"; since 0.39). Tapping a row opens that agent's chat
  (`id`). When `folded` (three or more agents) a header row comes first: the agents' logos
  overlapping, `title` ("3 agents working"), "  ·  " and the names, and a chevron; the rows show
  only once it is tapped open (a per-screen choice). `header` (default `folded`): draw that
  title row even unfolded (no chevron; a tap opens the Agents panel), as `title` then says
  what's queued ("1 agent working  ·  2 queued"). A stop icon sits in the top right corner of
  the box, beside the first row: **Stop all** (`POST /v1/chats/{id}/stop_all`). `doing` is the
  hub's own reading of each agent's latest step; the phone shows it as is.
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

#### Blocks

A list of blocks, each with a `type`:

- `heading` `{level: 1-6, spans}`
- `paragraph` `{spans}`
- `code` `{lang, text}`
- `list` `{ordered, start, items: [[blocks]]}` (each item is a list of blocks)
- `quote` `{blocks}`
- `rule` `{}`
- `table` `{rows: [[spans]]}`: rows of cells, each cell a list of spans; the first row is the header

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
answers `409` with git's reason and creates nothing. Ignored with a `device`.

### `POST /v1/chats/{id}/send`

`{"text": "…", "files": [upload ids]}` → `{"ok": true, "queued": false}`. While a turn runs the
message waits in the queue, as on the desktop (`queued: true`).

### `POST /v1/chats/{id}/stop`

→ `{"ok": true, "returned": [{"text": "…", "files": [upload ids]}]}`. Stops the running turn
(if any). Messages that were queued behind it are taken out of the queue and returned, oldest
first, so the app can put them back in its composer (files that weren't phone uploads are left out).

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
- `device`: `""` (the hub) or an id from `devices`; only before the chat's first turn
  (`switchable.device`); other providers than Claude run on the hub only.
- `fast`: the hub-wide flag; `true` only for providers with a fast mode (claude, codex).

`switch_reason` gives, for each run setting that can't change now, why (e.g. `{"device": "A
started chat stays on the device it started on"}`), for the greyed-out option.
`switchable` tells which of these make sense now: `account` (another allowed account exists),
`model`, `effort` (the provider has efforts), `access` (it has more than one level),
`device` (not started, Claude), `fast` (the provider has a fast mode). Changes apply from the
next turn; a running turn keeps its settings.

### `POST /v1/chats/{id}/typing`

`{"typing"?: true, "kind"?: "phone"}` → `{"ok": true}`.

#### Typing

Send `typing: true` every ~3 s while the composer has fresh input, and `typing: false` when the
message is sent or the composer is cleared. A lease lasts 6 s after the last `true`. `kind` is
`phone` (default) or `pc` (another PC acting as a client). The label shown is the
`X-Harbor-Device` header, else the name saved for the token, else "Phone" / "A PC".

Every chat's `typing` lists `{device, kind, label}`: API clients as `tok:<8 hex>` (stable per
token; compare with `you`), and the hub's own desktop composer as `pc:<hostname>` (kind `pc`,
label the hostname) while someone types there. The desktop shows the others as "✎ Galaxy A13 is
typing…" above its composer and a ✎ on the sidebar row.

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

`git: false` (and nothing else): no chips (no project, not a git repo, another PC's chat, a chat on
another device). `mode` is `worktree` for a chat in its worktree (`name`, `path` its folder) and
for New chat with `worktree=1` (`base`: the branch it would start from). `branch` reads
`detached at <sha>` when detached. `can_move`/`move_why`: whether a chat in the checkout can move to
a new worktree now (not while running, not a sub-agent, …). `branch_lock`: why the branch can't be
switched now (an agent is working there), null when it can. `pending` (0.37.2, optional): what git is
doing there for the PC's own bar ("Creating worktree…"); ask again shortly. Every git call runs off
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

### `POST /v1/chats/{id}/move`

"Move to project…": `{"repo": 6}` (a project id, or its path) or `{"repo": null}` (No project).
Its sub-agents move with it, and its Claude sessions are copied to the new folder's place so the
next turn resumes there. → `{"ok": true, "chat": {...}, "moved": [ids]}`. `409` with the reason
when it can't move now: a sub-agent (move its lead), a lead mid-turn, a chat on a device, another
PC's chat, or a project folder that isn't on this PC.

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
download and gets `409` with the progress ("try again when it's done"). `lang` missing or empty: the PC's own setting. `GET /v1/state`
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

#### `POST /v1/voice/cleanup`

Body `{"text": "…"}` → `{"text": "…"}`. Cleans up dictated text the way the "Clean up dictation"
setting does (filler words and false starts removed, punctuation and capitals fixed, spoken
self-corrections applied, same language, nothing added). On any failure or timeout (~8 s) it
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
to try again.

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
ones) or `#` (the project's GitHub issues and pull requests, the latest 100 of each, from the PC's
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
- A chat without a project has no files, and one whose project has no GitHub remote no issues:
  `items` is empty.
- Send the text as typed: the PC adds a short list of what was tagged after the message for the
  agent (each `@path` that exists in the project with its full path, each `#123` with its kind,
  title, state and URL), for messages from any device, queued ones too.

For a copy of another PC's chat, both calls are answered by its home PC, where its files and
agent are. A PC with a Harbor before 0.23 answers both with `404`: the app then asks the chat's
`home` PC, and the pairing's other PCs, directly (`GET /v1/hubs` tokens), and sends /plan and
/default to the one that answered. When none can, a bare `/` shows why: the home PC's Harbor
needs an update, or the pairing needs its upgrade to three factors.


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
and `share_label`; `levels` lists the choices (`[{id, label, about}]`); `me.share_github` says
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
new item wakes the long-poll. The app also asks every PC of every pairing every 30 s while it's
open.

`GET /v1/inbox` → `{"items": [{"id", "kind", "name", "size", "text"?}]}`, only this pairing's items.
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
didn't go in (refused, or Android asked to confirm: then a notification finishes it) is tried
again by itself only after 6 hours.

### `GET /app.apk` (and `HEAD`)

No token needed on the PC's network; from outside it a session (or a pairing from before three
factors, so old apps can update and then upgrade). The APK the hub has (`404` when none), `application/vnd.android.package-archive`.

## Every PC is a hub

With Settings › Devices › "Share chats with my other PCs" on, each of the user's PCs running
Harbor keeps a full copy of every chat (`src/mesh.rs`), so any of them answers the phone with the
same chats, rendered the same way.

- A chat runs on one PC, its `home`. Another hub holds a copy: reading it is local; a write to it
  (`send`, `stop`, `stop_all`, `continue`, `cancel_limit`, `continue_on`, `fork`, `slash`, `PATCH`, `DELETE`), and
  `GET …/slash`, is forwarded to the home PC and answered from there. The message records where it came from (`sender`).
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
  (`id`, `parent`, `forks_after`, `forked_from.chat`, `status.waiting.agents[].id`, the `id` of a
  new chat or fork, `changed_chats`) and projects by their path (`projects[].id`, `project_id`,
  `defaults.project_id`); `project_id` in `POST /v1/chats` may be a path too.

### `GET /v1/hubs`

```json
{"hubs": [{"id": "ts:desk", "name": "desk", "host": "10.0.0.12", "ip": "10.0.0.12", "port": 47930,
           "fp": "<64 hex>", "addrs": ["10.0.0.12", "fd00::12"],
           "online": true, "token": "<the caller's>", "self": true},
          {"id": "ts:laptop", "name": "laptop", "host": "10.0.0.20", "ip": "10.0.0.20", "port": 47930,
           "fp": "<64 hex>", "addrs": ["10.0.0.20"],
           "online": true, "token": "<a token for this phone on that PC, bound to its key>"}]}
```

`fp` and `addrs` as in the pairing link: each PC is only reached pinned to its own `fp`. A PC
without an `fp` runs Harbor before 0.13 and can't be reached safely: skip it. `host`/`ip` are for
apps before 0.13.

Each other PC that answers mints a token for the caller's pairing (the same one each time), so a
phone paired once can talk to any of them (three-factor pairings: only through
`POST /v1/hubs` with each PC's secret, see [Three factors](#the-other-pcs-of-the-mesh)); `token` is null for a PC that is off (ask again later)
or whose phone access is off (`phones: false`: it would drop the phone; forget it until it's on).
Removing the phone in Settings › Phones on any PC removes its tokens on all of them.

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

The app keeps the hubs' addresses and tokens (encrypted, like the pairing) and sends every call to
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
allowed list (any port of the peer: `harbor nc` uses it for ssh), or a paired phone with a
session (only the peer's Harbor port). Only to a PC on the relay's allowed list, at the addresses
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
  `title`, `project: {name, path}|null`, `account`, `model`, `effort`, `access`, `device`, `settled`,
  `updated`, `role`, `parent` (id there), `name`, `started`, `count`, `digest` (hex FNV of the
  items, only in full lists: a copy whose digest differs fetches its items from 0), `running`,
  `since_ms`, `queued`, `status` (as in items), `forks: [[seq, id]]`.
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
- `POST /mesh/v1/lease` `{chat, view, device, kind, label, on}`: someone types in (`view: false`)
  or has open (`view: true`, `kind` `focused`/`away`) one of this PC's chats on another hub.
  Leases last 6 s (typing) and 15 s (open) unless renewed; the chats list carries them as
  `typing` and `viewing`.
- `POST /mesh/v1/mint` `{group, name, fp}` → `{token}`: this PC's token for a phone paired on
  another PC (`group`: the pairing's id; the same group always gets the same token), bound to the
  phone's key `fp` at once. `410` once removed, `409` when the group's token has another key.
  Three factors: also `secret` (this PC's own, hex), `presence` and `binding`; a token without a
  secret takes them, one with another secret is `409`. From 0.34.1 also `nolock` (two factors,
  `presence` empty) and `keys_at`: the same secret with newer `keys_at` takes the new factors.
- `POST /mesh/v1/revoke` `{groups: […]}`: phones removed on another PC; their tokens here go too.
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
