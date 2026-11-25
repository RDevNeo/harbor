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
             rows: { "": RowInfo, stores?: RowInfo, creators?: RowInfo, spokpay?: RowInfo } }] }
RowInfo = { lastAt|null, unread: 0, presence: "online"|"idle"|"dnd"|"offline"|null,
            status: { text: "Online", tone: "green"|"yellow"|"red"|"muted" }|null,
            channel: "discord"|"gmail"|"whatsapp"|null, typing: "typing"|"recording"|null }
```
Sidebar order: Stores (each store: owner first, then members by last message), then lists in order.
Within a section, people are sorted by `rows[section].lastAt` desc; settled ones go to a "Settled" fold.

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
  ai: [{ id, role: "user"|"assistant", text, at }] }   // the Person AI chat for this person+section
```
`?account=ID` picks another of `accounts`. `?before=MSGID` returns an older page (same shape, `messages` only older).

## POST /v1/persons/chat/{personId}/send  { section, account?, text, replyTo?, subject?, files?: [{ name, type, data: base64 }] }
→ `{ ok, message?, error? }`
## POST /v1/persons/chat/{personId}/read  { section, account? }  → `{ ok }`
## POST /v1/persons/chat/{personId}/typing { section, account?, on } → `{ ok }`
## POST /v1/persons/chat/{personId}/ai  { section, text } → `{ ok, chat: <hub chat id> }` (asks the Person AI; the answer shows in `ai`)

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
