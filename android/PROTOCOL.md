# Harbor phone API (v1)

The contract between Harbor for Android and a desktop Harbor (the "hub"). Implemented in
`src/api.rs`; this file is the reference for both sides.

## Transport

- HTTP/1.1, JSON bodies (UTF-8), `Connection: close` on every response.
- The hub listens on its Tailscale addresses and 127.0.0.1 only, port **47930** by default
  (kv `api_port`, applies after a restart). Turned on in Settings › Phones.
- Every request except `GET /app.apk` carries `Authorization: Bearer <token>`.
  Optional `X-Harbor-Device: <phone name>` (shown next to the token in Settings › Phones).
- Request bodies need `Content-Length` (no chunked encoding). JSON bodies ≤ 2 MB, uploads ≤ 200 MB.
- Errors: a status code and `{"error": "<message for the user>"}`.
  `401` unknown token (pair again), `400` bad input, `404` no such chat/route,
  `409` not possible now (e.g. fork of a running turn), `413` too large, `503` Harbor busy/closing.
- When phone access is turned off, connections are closed without an answer.
- The app only connects through Tailscale: a socket bound to Tailscale's VPN network, to a tailnet
  address (100.64/10, fd7a:115c:a1e0::/48) or loopback. Otherwise it sends nothing.

## Pairing

One pairing reaches every PC of the mesh: `GET /v1/hubs` hands the phone a token for each other
PC (see [Every PC is a hub](#every-pc-is-a-hub)).

The QR code in Settings › Phones encodes

```
harbor://pair?host=<MagicDNS name>&port=<port>&token=<token>&name=<hub name>&ip=<tailnet IPv4>
```

all values percent-encoded. Use `host`, fall back to `ip` when MagicDNS doesn't resolve.
The same values are shown as text under the code.

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
  "hub_id": "ts:desk", "mesh": true,
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
- `hub_id`: this hub's id in the mesh; `mesh`: chats are shared with the user's other PCs; `hubs`:
  every PC of the mesh (this one first). A hub the phone has no token for yet: ask `GET /v1/hubs`.
- `usage[].percent`: 0–100 with one decimal (100.0 = that window is used up); `label` names the
  window ("5h", "Weekly", …).
- `can_start`: only Claude accounts can start a new chat (a new chat is a lead; leads run on Claude).
- `queued`: messages waiting for the running turn.
- `you`: this client's own device id, as it appears in `typing` (hide yourself with it).
- `typing`: who is writing in the chat now (see [Typing](#typing)).
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
- Ids differ per hub (`id`, `project_id`, `parent`); `gid` and `home` don't. A client that moves
  between hubs sends `X-Harbor-Ids: global` with every call: answers then name chats by `gid`
  (`id`, `parent`, `forks_after`, `forked_from.chat`, `status.waiting.agents[].id`, the `id` of a
  new chat or fork, `changed_chats`) and projects by their path (`projects[].id`, `project_id`,
  `defaults.project_id`); `project_id` in `POST /v1/chats` may be a path too.

### `GET /v1/hubs`

```json
{"hubs": [{"id": "ts:desk", "name": "desk", "host": "desk.example.ts.net", "ip": "<tailnet IPv4>", "port": 47930,
           "online": true, "token": "<the caller's>", "self": true},
          {"id": "ts:laptop", "name": "laptop", "host": "laptop.example.ts.net", "ip": "<tailnet IPv4>", "port": 47930,
           "online": true, "token": "<a token for this phone on that PC>"}]}
```

Each other PC that answers mints a token for the caller's pairing (the same one each time), so a
phone paired once can talk to any of them; `token` is null for a PC that is off (ask again later).
Removing the phone in Settings › Phones on any PC removes its tokens on all of them.

### Failover

The app keeps the hubs' addresses and tokens (encrypted, like the pairing) and sends every call to
the PC used last. When that PC can't be reached, or a call to it fails mid-way, the next one is
tried; the one that answers is used from then on (shown as "via <name>"). Revisions are per hub:
after a switch, start the long-poll over and reload. Only reads are retried at once; a write that
may have reached a PC isn't sent twice.

### Hub to hub (`/mesh/v1/…`)

PCs talk on the same listener (port 47930, Tailscale addresses only). A caller is accepted when
`tailscale whois` puts its address under the same Tailscale user as this PC; no token. Errors as
above (`403`: sharing is off here, or not one of the user's devices).

- `GET /mesh/v1/hello` → `{id, name, version, epoch, accounts: [{id, short, kind}], revoked: [groups]}`.
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
- `POST /mesh/v1/mint` `{group, name}` → `{token}`: this PC's token for a phone paired on another
  PC (`group`: the pairing's id; the same group always gets the same token). `410` once removed.
- `POST /mesh/v1/revoke` `{groups: […]}`: phones removed on another PC; their tokens here go too.

## The APK in releases

The release workflow attaches `harbor-android.apk` and `harbor-android.apk.minisig`
(trusted comment `harbor vX.Y.Z harbor-android.apk`) and lists the APK in the release's
`SHA256SUMS`. Its versionCode is `major*1000000 + minor*1000 + patch` of the Harbor version
(0.7.0 → 7000). Harbor's updater and install.sh fetch it into the install folder
(`~/.local/lib/harbor/harbor-android.apk`, with `harbor-android.version` beside it); builds from
source keep it in `~/.local/share/harbor/` (Settings › Phones › Download).
