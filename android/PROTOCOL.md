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
- Every request except `GET /app.apk` carries `Authorization: Bearer <token>` as well.
  Optional `X-Harbor-Device: <phone name>` (shown next to the token in Settings › Phones) and,
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
  `401` unknown token or another phone's key (pair again), `400` bad input, `404` no such
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
harbor://pair?host=<address>&port=<port>&token=<token>&name=<hub name>&ip=<address>&fp=<hub fingerprint>&addrs=<address>,<address>,…
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

**Upgrading a pairing from before 0.13** (no `fp`): the app makes one TLS connection to the
pairing's Tailscale address, only through Tailscale's VPN (as before 0.13, WireGuard vouches for
the hub there), takes the hub's fingerprint from that handshake and pins it from then on; the hub
binds the token to the phone's key on that same call. Without Tailscale such a pairing can't
upgrade: the app asks to pair again.

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
  "access":  {"claude": [{"id": "full", "label": "Full access", "desc": "…"}]},
  "devices": [{"id": "", "label": "desk", "icon": "monitor", "online": true},
              {"id": "ts:laptop", "label": "laptop", "icon": "laptop", "online": false}],
  "fast": false,
  "defaults": {"account": "claude", "model": "claude-opus-5-5", "effort": "high", "access": "full",
               "device": "", "project_id": null},
  "app": {"version_code": 7000, "url": "/app.apk"}
}
```

- `models`, `efforts`, `access` are keyed by account `kind` (claude, codex, cursor, grok,
  gemini, meta, opencode). An empty effort list: send `""`.
- `role`: `lead` (a project's thread), `sub` (a subagent of `parent`; usually hidden), `chat`.
- `fast` is hub-wide (not per chat); `chat.fast` mirrors it.
- `devices[0]` is always the hub itself (`id: ""`). Icons: monitor, laptop, terminal, house,
  globe, bot, hammer, gauge. `online` may be null (unknown). `hub: true`: another PC of the mesh
  running Harbor; a new chat with that device starts there, so it can only be picked while `online`.
- `hub_fp`, `hub_addrs`, `hub_port`: this hub's key and where it answers (keep the pairing's
  address list up to date with them).
- `hub_id`: this hub's id in the mesh; `mesh`: chats are shared with the user's other PCs; `hubs`:
  every PC of the mesh (this one first). A hub the phone has no token for yet: ask `GET /v1/hubs`.
- `usage[].percent`: 0–100 with one decimal (100.0 = that window is used up); `label` names the
  window ("5h", "Weekly", …).
- `can_start`: only Claude accounts can start a new chat (a new chat is a lead; leads run on Claude).
- `queued`: messages waiting for the running turn.
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
 "status": { … }, "items": [ … ]}
```

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
| `text` | the reply (markdown), image strip under it; Fork among its actions when `forkable` | `markdown`, `blocks` (below), `images`, `at`, `forkable` |
| `thinking` | a collapsed "Thinking" header; expands to italic text | `text` |
| `tool` | one row: status icon (spinner / ✓ / ✗), `label`, `summary`; tap expands `input` and `result`; image strip under it | `label`, `summary`, `input`, `result` (null while running), `done`, `is_error`, `images` |
| `footer` | the turn's line, monospace and subtle | `text` (e.g. "Claude · AB · Opus 5.5 · 4.3s · 189k in · 304 out · $3.9634"), `at` |
| `forked_from` | "Forked from conversation · Open source conversation" divider | `chat`, `seq` (open that chat at that card) |
| `notice` | a centred pill with the icon and `text`; with a `detail` it expands to it (as markdown when `detail_markdown`); with a `url` (a process's address) tapping opens it | `icon`, `text`, `detail`, `detail_markdown`, `url` |
| `message` | the blue card "`from` → `to`" with `text` | `from`, `to`, `text` |
| `error` | the red card, monospace | `text` |

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
  sub-agents still run: "Waiting for N sub-agents to finish  ·  Q queued" with the agents'
  initials, and **Stop all** (`POST /v1/chats/{id}/stop_all`).
- `limit: {text, can_cancel}`: the usage-limit line (clock icon, `text`), with **Continue now**
  (`POST /v1/chats/{id}/continue`) and, when `can_cancel`, **Cancel** (`POST /v1/chats/{id}/cancel_limit`).

#### Blocks

A list of blocks, each with a `type`:

- `heading` `{level: 1-6, spans}`
- `paragraph` `{spans}`
- `code` `{lang, text}`
- `list` `{ordered, start, items: [[blocks]]}` (each item is a list of blocks)
- `quote` `{blocks}`
- `rule` `{}`
- `table` `{rows: [[spans]]}`: rows of cells, each cell a list of spans; the first row is the header

A span is `{text, bold?, italic?, code?, strike?, link?}`; flags are left out when false and
`link` when there is none. Task list markers arrive as "☑ " / "☐ " text. Raw HTML stays as text.

### `GET /v1/events?since=<rev>`

Long-poll. Answers as soon as anything changed after `since` (after a short 150 ms pause that
gathers a burst of streaming changes), or after 20 s with nothing:

```json
{"rev": 1761200000300, "changed_chats": [12], "state_changed": false}
```

`state_changed` is true when anything in `/v1/state` changed (a chat's title, settled, running,
queued, updated time, run settings, who is typing; chats added or removed; projects; accounts'
usage). A typing lease running out is a change too (its chat is in `changed_chats`). Use a read timeout of
25 s and reconnect on any error.

### `POST /v1/chats`

```json
{"project_id": 1, "device": "", "account": "claude", "model": "claude-opus-5-5",
 "effort": "high", "access": "full", "fast": false, "text": "First message", "files": ["pending/1761…-photo.jpg"]}
```

→ `{"id": 13}`. Fields left out take the hub's defaults (`project_id` missing or null: no
project). With no `text` and no `files` the chat is created idle. `fast` sets the hub-wide flag.

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

Stops a running turn first. → `{"ok": true}`.

### `POST /v1/chats/{id}/fork`

`{"seq": 7}` → `{"id": 14}`. `seq` must be a `text` item that is the last reply of a finished
turn (`409` otherwise).

### `POST /v1/upload?name=<file name>&chat=<id>`

Raw body (the file), `Content-Length` required. `chat` is optional (files go to
`<data>/uploads/<chat>/`, or `uploads/pending/`). → `201 {"id": "12/1761…-photo.jpg", "path": "/…"}`.
Pass `id` in `files` of a send or a new chat. Images reach the agent as images.

### `POST /v1/chats/{id}/stop_all`

The waiting bar's Stop all: stops the lead and its running sub-agents and clears their queues.
→ `{"ok": true, "returned": [...]}` like `stop`.

### `POST /v1/chats/{id}/continue`, `POST /v1/chats/{id}/cancel_limit`

The usage-limit line's Continue now (runs the waiting turn now) and Cancel (drops the planned
continue). → `{"ok": true}`.

### `GET /v1/image?path=<absolute path>&max=<px>`

An image a card shows (its `images[].url`), with the token like every call. With `max`, a JPEG at
most that many pixels on its longer side (16–2048); without, the file as it is. Image files only
(png, jpg, gif, webp, …); `404` otherwise.

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

### `GET /v1/app`

`{"version_code": 7000, "url": "/app.apk"}`; `version_code` 0: the hub has no app to offer.

### `GET /app.apk` (and `HEAD`)

No token needed. The APK the hub has (`404` when none), `application/vnd.android.package-archive`.

## Every PC is a hub

With Settings › Devices › "Share chats with my other PCs" on, each of the user's PCs running
Harbor keeps a full copy of every chat (`src/mesh.rs`), so any of them answers the phone with the
same chats, rendered the same way.

- A chat runs on one PC, its `home`. Another hub holds a copy: reading it is local; a write to it
  (`send`, `stop`, `stop_all`, `continue`, `cancel_limit`, `fork`, `PATCH`, `DELETE`) is forwarded
  to the home PC and answered from there. The message records where it came from (`sender`).
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
phone paired once can talk to any of them; `token` is null for a PC that is off (ask again later)
or whose phone access is off (`phones: false`: it would drop the phone; forget it until it's on).
Removing the phone in Settings › Phones on any PC removes its tokens on all of them.

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
allowed list (any port of the peer: `harbor nc` uses it for ssh), or a paired phone with its
token (only the peer's Harbor port). Only to a PC on the relay's allowed list, at the addresses
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
- `GET /mesh/v1/hello` → `{id, name, version, epoch, accounts: [{id, short, kind}], revoked: [groups], phones, fp, addrs, port}`
  (`phones`: its phone access is on; also in each chats answer; `fp`, `addrs`, `port`: its key
  and addresses).
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
- `POST /mesh/v1/call` `{method, path, body, sender}`: a phone API call (`path` like
  `["v1","chats","12","send"]`, ids of the home PC) run as if made there; `sender` is stored on
  a message it sends. A new chat's answer carries `home` (the PC's id).
- `POST /mesh/v1/upload?name=<file name>` (raw body) → `201 {id, path}`: a file for a forwarded call.
- `POST /mesh/v1/lease` `{chat, view, device, kind, label, on}`: someone types in (`view: false`)
  or has open (`view: true`, `kind` `focused`/`away`) one of this PC's chats on another hub.
  Leases last 6 s (typing) and 15 s (open) unless renewed; the chats list carries them as
  `typing` and `viewing`.
- `POST /mesh/v1/mint` `{group, name, fp}` → `{token}`: this PC's token for a phone paired on
  another PC (`group`: the pairing's id; the same group always gets the same token), bound to the
  phone's key `fp` at once. `410` once removed, `409` when the group's token has another key.
- `POST /mesh/v1/revoke` `{groups: […]}`: phones removed on another PC; their tokens here go too.
- `GET /mesh/v1/phones` → `{phones: [{group, name, seen, app}], apk}`: where this PC saw the
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
