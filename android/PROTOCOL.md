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

## Pairing

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
  "version": "0.7.0", "hub_name": "desk", "rev": 1761200000123,
  "projects": [{"id": 1, "name": "harbor", "path": "/home/user/Projects/harbor"}],
  "chats": [{
    "id": 12, "project_id": 1, "title": "Fix the build", "device": "", "account": "claude",
    "model": "claude-opus-5-5", "effort": "high", "access": "full", "fast": false,
    "settled": false, "running": true, "queued": 0, "updated_ms": 1761200000000, "rev": 1761200000100,
    "role": "lead", "parent": null
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
  globe, bot, hammer, gauge. `online` may be null (unknown).
- `can_start`: only Claude accounts can start a new chat (a new chat is a lead; leads run on Claude).
- `queued`: messages waiting for the running turn.

### `GET /v1/chats/{id}/items?since=<rev>`

```json
{"rev": 1761200000200, "count": 31, "running": true, "queued": 1, "items": [ … ]}
```

Items whose revision is greater than `since` (`since=0`: all). `seq` is the item's index
(0-based) and stays stable; an item comes again with a higher `rev` when it changes. If `count`
is smaller than what you hold (a message was taken back), drop items with `seq >= count`.
Every item has `seq`, `rev`, `kind`:

| kind | fields |
|---|---|
| `user` | `text`, `files` (file names), `at` (unix s) |
| `text` | `markdown`, `blocks` (below), `at` |
| `thinking` | `text` |
| `tool` | `name`, `summary`, `input` (string), `result` (string, or null while running), `done`, `is_error` |
| `error` | `text` |
| `notice` | `icon`, `text`, `detail`. A turn's end is `icon:"result"`, `text:"Done · 1m 15s · $0.12"`; agent messages are `icon:"message"`, `text:"lead → worker"`, `detail` the message |

Tool `input`/`result` are clipped to 16 KB. Ignore unknown kinds.

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
queued, updated time; chats added or removed; projects; accounts' usage). Use a read timeout of
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

→ `{"ok": true}`. Stops the running turn (if any).

### `PATCH /v1/chats/{id}`

`{"title"?: "…", "settled"?: true}` → `{"ok": true}`.

### `DELETE /v1/chats/{id}`

Stops a running turn first. → `{"ok": true}`.

### `POST /v1/chats/{id}/fork`

`{"seq": 7}` → `{"id": 14}`. `seq` must be a `text` item that is the last reply of a finished
turn (`409` otherwise).

### `POST /v1/upload?name=<file name>&chat=<id>`

Raw body (the file), `Content-Length` required. `chat` is optional (files go to
`<data>/uploads/<chat>/`, or `uploads/pending/`). → `201 {"id": "12/1761…-photo.jpg", "path": "/…"}`.
Pass `id` in `files` of a send or a new chat. Images reach the agent as images.

### `GET /v1/app`

`{"version_code": 7000, "url": "/app.apk"}`; `version_code` 0: the hub has no app to offer.

### `GET /app.apk`

No token needed. The APK the hub has (`404` when none), `application/vnd.android.package-archive`.

## The APK in releases

The release workflow attaches `harbor-android.apk` and `harbor-android.apk.minisig`
(trusted comment `harbor vX.Y.Z harbor-android.apk`) and lists the APK in the release's
`SHA256SUMS`. Its versionCode is `major*1000000 + minor*1000 + patch` of the Harbor version
(0.7.0 → 7000). Harbor's updater and install.sh fetch it into the install folder
(`~/.local/lib/harbor/harbor-android.apk`, with `harbor-android.version` beside it); builds from
source keep it in `~/.local/share/harbor/` (Settings › Phones › Download).
