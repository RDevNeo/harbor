# Persons phone API (Hub's phone API, port 47950, same TLS + auth as every /v1 call)

All JSON. Times are ISO strings. `section` is `stores` | `creators` | `spokpay` | `` (All people).
Pictures are URLs on this same API (`/v1/persons/img/...`), fetched with the same client as JSON.

## GET /v1/persons/state?rev=N
Long-poll: with `rev` equal to the current one, waits up to 25 s for a change, then answers.
```
{ rev: 12, unread: 4,
  connections: [{ id, kind: "discord"|"gmail"|"whatsapp", section, status: "connected"|"connecting"|"signed-out"|"signing-in"|"starting",
                  label: "Discord · igor", error: null, qr: null|"<raw QR payload>", qrRows: null|["0101…", …] }],
  stores: [{ id, name, color: "#3b82f6", image: "/v1/persons/img/store/ID"|null, ownerId|null, count }],
  lists:  [{ id: "creators"|"spokpay", name, accountId }],
  people: [{ id, name, avatar: "/v1/persons/img/person/ID?v=HASH"|null, initials: "AB", color: "#hex",
             storeIds: [], listIds: [], settled: { stores?: true, ... },
             rows: { "": RowInfo, stores?: RowInfo, creators?: RowInfo, spokpay?: RowInfo } }],
  siteRequests: null | { waits: bool, notices: [{ title, text }],
                         rows: [{ ref: "SR-121", subject, store, storeSlug|null, initials, line, waiting, unread, at: <ms>,
                                  side: { text: "Store replied"|"Store waiting", tone: "info"|"warning" }|null,
                                  icon: "/v1/persons/img/url?u=…"|null, url: "https://spokpay.com/admin/requests?thread=SR-121" }] } }
RowInfo = { lastAt|null, unread: 0, presence: "online"|"idle"|"dnd"|"offline"|null,
            status: { text: "Online", tone: "green"|"yellow"|"red"|"muted" }|null,
            channel: "discord"|"gmail"|"whatsapp"|null, typing: "typing"|"recording"|null }
```
Sidebar order: Stores (each store: owner first, then members by last message), then lists in order.
Within a section, people are sorted by `rows[section].lastAt` desc; settled ones go to a "Settled" fold.
`siteRequests` is the SpokPay section's "Site requests" list (Headquarters' Home list), drawn at the top of that section:
SpokPay's active requests read every minute with the saved admin key, newest activity first. `waits`: one waits on
SpokPay (the heading's amber dot). A row opens the request's pane (`site-request/{ref}` below); `url` is its SpokPay
admin page (Copy link).

## POST /v1/persons/site-requests/seen  { ref, at } → `{ ok }`   (a row opened at its `at`: "Store replied" goes, for every device)
## POST /v1/persons/site-requests/reload → `{ ok }`   (read SpokPay's list now)

## GET /v1/persons/folds → `{ closed, stores, settledOpen }` · POST /v1/persons/folds (the same) → `{ ok, … }`
The PC's sidebar folds (folds.ts, `<persons>/folds.json`): sections folded shut (`"sr"` = SpokPay › Site requests),
stores unfolded, sections whose Settled fold is open. The phone keeps its own.

## A site request's pane (SpokPay's admin request page; `srpane.ts`)
- `GET /v1/persons/site-request/{ref}` → `{ ok, pane }`: read from SpokPay now (its newest 100 messages), and what the
  store wrote counts as seen. Offline or while SpokPay fails, the last read of a request opened lately (12 kept) with
  `note` saying so; never opened here: the error.
- `POST /v1/persons/site-request/{ref}/reply { text, images?: [{ name, type, data: base64 }] (≤ 5, ≤ 10 MB), key? }` →
  `{ ok, pane }`: sent to the store as SpokPay (site-requests:write); `key` is the Idempotency-Key of a retry.
- `POST /v1/persons/site-request/{ref}/status { to: working|review|completed|closed }` → `{ ok, pane }`
  (site-requests:status; only the moves in `statuses`; completed and closed are final: ask first, with `confirms`).
- `POST /v1/persons/site-request/{ref}/ai { text, paths?, forward? }` → `{ ok, chat }` (`forward`: a message id, Forward
  to AI: quoted as person chats quote theirs, `text` the question, empty = "What should I reply to this?"): the composer's "To: AI" note to the Person
  AI (as `chat/{id}/ai`), with the request as hidden context (ref, subject, status, store, owner, admin page, brief,
  its newest 40 messages and events): the chat of the person linked to its store (`pane.person`, that section's),
  else the store's own "<Store> · SpokPay". Its reply drafts come as ```reply blocks. Answers `{ ok, chat, ai }` (`ai`
  as below, the note now in it).
- `pane.ai` and `GET /v1/persons/site-request/{ref}/ai` → `{ ok, ai, aiChat }` (no SpokPay read; the pane asks every
  1.5–2 s while the AI works): the request's own turns with the Person AI, as a chat's `ai` (role, text, at, streaming,
  parts, forwarded), `queued: true` on a note still waiting behind a running turn. A note is the request's by its hidden
  context's "Site request: SR-…" line; the chats its notes went to and the notes not yet shown are kept in
  `<persons>/sr-ai.json`, so they show again after a restart (and when the store's person changes). The pane draws
  each where it was sent among the request's lines.
- A refusal: `{ error, code }` with SpokPay's status (403 a permission the key lacks, 404 gone, 429 its rate limit…).
  A permission refused is asked again (the key's probe) before the next call that needs it, at most every 15 s, and
  an open pane asks at most every minute: one added on spokpay.com/admin shows without the key typed again.

`pane`: `{ ref, subject, status, statusLabel, tone: neutral|info|warning|success, store, storeSlug, initials, icon (a
picture route), iconPath (PC), url, brief: { title, sub ("Website · Opened by SpokPay · 19 Nov 2026"), summary,
facts: [{ label, text, full }], files }, factRows (facts paired as the card lays them out), items: [{ kind: "event",
id, text } | { kind: "msg", id, mine (SpokPay's), side, author, head ("Truth · 7 h ago"), text, files, joinsPrev,
joinsNext, at }], statuses: [{ status, label, current }] (the current one first), confirms: { completed, closed }:
{ title, text, ok }, finished, finishedNote, owner, placeholder ("Message <owner> on SpokPay"), person (the linked
person: { id, section, name, initials, color, avatar, avatarPath } | null), aiChat (its Person AI chat | null),
hasMore, writeBlocked, statusBlocked, lastActivityAt, note }`. `files`: `[{ url (SpokPay's), name, image, src (a picture route) }]`. `summary` is "" until
SpokPay's admin API sends it (`siteRequest.summary` of `GET …/admin/site-requests/{ref}/messages`; the admin page
has it, the API's header leaves it out), except for requests Hub opened (the proposal's details).

## GET /v1/persons/chat/{personId}?section=S
```
{ person: { id, name, avatar, presence, status }, account: { id, kind, section, label }|null,
  accounts: [{ id, kind, label }],   // other channels of this person in that section (switch)
  peer: "123…", typing: "typing"|"recording"|null, more: true,
  unreadFrom: "<message id>"|null,
  messages: [{ id, fromMe, text, at, edited, subject|null, status|null, voice,
               reply: { text, fromMe }|null,
               files: [{ name, url: "/v1/persons/file?...", type, size, width, height, image: bool, duration }],
               ai: false }] ,
  ai: [{ id, role: "user"|"assistant", text, at, streaming?,
         parts?, forwarded? }],   // the Person AI chat for this person+section; an answer's `parts` (aiparts.ts):
                       // [{ type: "text", text, blocks }   markdown, `blocks` the phone's block model (android/PROTOCOL.md)
                       //  | { type: "draft", text }]       a message it drafted for the person (```reply)
                       // a note with a forwarded message: `text` is the question, `forwarded: { from, text }` the quote
  aiOn: bool, aiChat: "<hub chat id>"|null,   // the composer's AI switch, "Open in Projects"
  siteRequests: bool,  // the message menu's Open Site Request (SpokPay people / store owners, SpokPay connected)
  proposals: [{ id, at, messageId, store: { slug, name }|null, category, subject, details, brief, why, from, chat,
                images: <picked count>, state: { kind: waiting|opening|opened|failed, ref?, reason? } }],
  proposing: [{ personId, messageId, at, chat, error }] }   // site requests SpokPay's agent is still drafting
```
`?account=ID` picks another of `accounts`. `?before=MSGID` returns an older page (same shape, `messages` only older).

## POST /v1/persons/chat/{personId}/send  { section, account?, text, replyTo?, subject?, files?: [{ name, type, data: base64 }] }
→ `{ ok, message?, error? }`
## POST /v1/persons/chat/{personId}/read  { section, account? }  → `{ ok }`
## POST /v1/persons/chat/{personId}/typing { section, account?, on } → `{ ok }`
## POST /v1/persons/chat/{personId}/ai  { section, account?, text, forward?: <message id>, paths?: [file on this PC] } → `{ ok, chat: <hub chat id> }`
Asks the Person AI; the answer shows in `ai`. `forward` (Forward to AI) quotes that message in the note (its images and
PDFs fetched to this PC for the agent), the question defaulting to "What should I reply to this?".
## POST /v1/persons/chat/{personId}/site-request  { section, account?, messageId } → `{ ok }`
Open Site Request: SpokPay's agent (a chat in the SpokPay project) drafts a proposal from the message and the
conversation (`proposing`, then `proposals`); without a SpokPay project the message itself is the proposal.
## POST /v1/persons/proposal/{id}/open  { fields? } → the proposal (opened, or failed with its reason)
## PATCH /v1/persons/proposal/{id}  { fields?: { category, subject, details, brief }, store?: { slug, name }|null }
## DELETE /v1/persons/proposal/{id}  (discard)
## POST /v1/persons/proposing/{messageId}/local  { personId, section, account? }  (skip the agent: the message itself)
## DELETE /v1/persons/proposing/{messageId}  (dismiss)

## GET /v1/persons/person/{id}
The panel: `{ person: {...all fields of data.json's person}, avatarBig, stores: [{id,name}], lists: [...],
identities: [{ kind, value, section, label }], socials: [{ url, platform, handle, uploads: [{ title, url, thumb, at, views }] }],
spokpay: {...}|null }`
## PATCH /v1/persons/person/{id}  { name?, notes?, settle?: { section, on }, storeIds?, listIds?, email?, whatsapp?, discordId?, socials? } → `{ ok, person }`
## POST /v1/persons/people  { name, discordId?, email?, whatsapp?, storeIds?, listIds? } → `{ ok, person }`
## DELETE /v1/persons/person/{id} → `{ ok }`
## GET /v1/persons/lookup?section=S&kind=K&q=TEXT → `{ matches: [{ id, username, name, avatar }] }`

## Pictures and files (JSON: Hub's routes answer JSON only)
- `GET /v1/persons/img/person/{id}?size=64|256` → `{ type: "image/png", data: "<base64>" }`, 404 when none (draw initials).
- `GET /v1/persons/img/store/{id}` → same shape.
- `GET /v1/persons/file?account=ID&url=ENC&name=ENC` → `{ type, name, size, data: "<base64>" }` (at most 20 MB).
On the PC (in-process) rows also carry `avatarPath` / `imagePath`: a local file for Slint.

## Connections
- `POST /v1/persons/connections { section, kind }` adds one and starts its sign-in.
- `POST /v1/persons/connections/{id}/connect` starts a sign-in (Discord, WhatsApp: a QR code appears in the state's
  `qr` / `qrRows`; Discord's is scanned in the Discord app: You › Scan QR code).
- `POST /v1/persons/connections/{id}/cancel` stops a sign-in under way. `DELETE /v1/persons/connections/{id}` signs out and removes it.

## Linked people (Link with… / Unlink)
A person may hold others linked into them (`links` in data.json: each one kept whole, with what the link added), so one
human on several channels is one person. data.json is copied to `data.before-link.json` before the first link.
- `POST /v1/persons/person/{id}/link { ids: [...] }` → `{ ok, linked, person }`: they leave the list and join `id`.
- `POST /v1/persons/person/{id}/unlink { id }` → `{ ok, person }`: that one is their own person again (same id).
- State: each person has `linked: [{ id, name }]`; the panel (`GET person/{id}`) has `linked: [{ id, name, at, ids, aiChats }]`.
- Chat: `accounts` are the person's chats (a connection and who they are on it): `id` = "<connection>:<identifier>" (what
  `account` takes; a bare connection id still works), `conn`, `kind`, `label`, `to`. `messages` (and `outgoing`) are
  every chat's, by time, each with `channel: { key, kind, label }`. `account` (the composer's) defaults to the chat of
  their latest message. `read` marks every chat of the page; `before` pages through all of them.

## Audio (voice messages and audio files)
An audio attachment in `files` has `kind: "audio"`, `audio` (its key "<connection>:<message id>:<index>"), `bars`
(0..1, the platform's waveform or measured once played), `played`, `transcript` (null until made).
- `POST /v1/persons/audio/play { key, account, url: <files[].raw>, name, at?, speed?, duration? }` plays it on the PC
  (ffmpeg into PipeWire / PulseAudio / ALSA, else mpv / ffplay); one at a time. `pause`, `stop`, `seek { key, pos }`,
  `speed { speed, url? }` (1, 1.5, 2) → the player's state `{ key, playing, pos, speed, duration, at, error }`
  (also `audio` in `GET state`). `GET /v1/persons/audio` → the same.
- `POST /v1/persons/audio/played { key }`: the phone played it itself (MediaPlayer, file through `/v1/persons/file`).
- `POST /v1/persons/audio/transcribe { key, account, url, name }` → `{ ok, text }` (the PC's local speech to text; kept).
