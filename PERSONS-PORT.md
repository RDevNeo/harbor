# Persons → Hub (native) port plan

Source: Person Hub (`creators-hub`, Electron + React, `src/` + `shell/*.cjs`).
Target: Hub's **Persons** tab — Slint on the PC, Java on the phone, one TS engine for both.
Owner of this port: agent `persons` (branch `hub-persons`). Tab bar / `app.slint` wiring: agent `fork`.

## Shape

```
ts/packages/persons/            @harbor/persons (new workspace package; engine side, no UI)
  src/model/*.ts                pure logic ported from creators-hub/src/lib (data, accounts, readState,
                                conversation, presence, socials, calm, format, personAi context) + tests
  src/store.ts                  data.json / connections.json in <hub data>/persons (atomic writes,
                                normalizeData on load, external-edit watch)
  src/conn/types.ts             the Connection interface (= Person Hub's DiscordBridge, one per account)
  src/conn/discord*.ts          port of shell/discord.cjs + discord-core.cjs (REST + gateway in Bun);
  src/conn/remoteauth.ts        new Discord sign-ins: Discord's QR remote-auth (scanned in the Discord app),
                                no browser engine anywhere; the QR is drawn by Slint and by the Android tab
  src/tokens.ts                 Discord logins in the desktop keyring (Secret Service), else an AES-GCM sealed file
  src/import/leveldb.ts         read-only LevelDB + snappy reader: the import reads Person Hub's saved Discord
                                logins from its session storage once, without running Chromium
  src/conn/gmail*.ts            port of shell/gmail.cjs + gmail-core.cjs (OAuth PKCE loopback, REST, history poll)
  src/conn/whatsapp*.ts         port of shell/whatsapp.cjs on Hub's own Baileys engine (whatsapp/engine.mjs,
                                plus Person Hub's extra ops: presence, profile_picture, add_contact)
  src/spokpay.ts                port of shell/spokpay*.cjs (admin key in <data>/persons/spokpay.json 0600)
  src/socials.ts                YouTube / TikTok latest uploads + profile photo (fetched from the PC directly)
  src/avatars.ts                disk cache of Discord / Google / WhatsApp / social pictures → file paths
                                (Slint Image needs a file; the phone gets them through /v1/persons/avatar)
  src/service.ts                PersonsService: data + connections + conversations + presence + typing +
                                read state + outgoing queue; emits "changed" (debounced) — the single
                                source of truth for the Slint tab and the phone
  src/ai.ts                     Person AI chats: one Hub chat per person+section in the project whose folder
                                ends in creators-hub/tabs/Persons, hidden <person-hub-context>, replies as AI bubbles
  src/routes.ts                 phone API: GET/POST /v1/persons/... (state, chat, send, read, people CRUD, avatar)
  scripts/migrate.ts            ~/.local/share/creators-hub → ~/.local/share/hub/persons (copy, never deletes)

ts/packages/ui/slint/persons/   Slint: PersonsTab (sidebar | list or chat | person panel), dialogs
ts/packages/ui/src/persons/     binding: models from PersonsService → Slint structs; callbacks → service

android/src/dev/harbor/app/Persons*.java   the phone's Persons tab (same screens, one at a time), on /v1/persons
```

## Screens (same as Person Hub)

1. **Sidebar** (240 px): sections Stores (each store folds open to its owner + members), Creators,
   SpokPay; each section header has its connections (Discord / Gmail / WhatsApp chips with state,
   connect / sign-in QR, remove) and a Settled fold; rows = PersonRow (avatar + presence dot, name +
   channel icon, crown for owners, status line "Online" / "last seen 14:32", time ago, unread pill,
   typing dots). Right-click: rename, settle, remove from store, delete. "All people" on top.
2. **List** ("All people" / a list): search, filter, sort (last message / name), Add person, Add members.
3. **Chat** (middle, when a person is open): header (avatar, name, presence, channel chip, details
   toggle), messages grouped by day (bubbles, replies, attachments: images inline, voice notes,
   files; email subject dividers; WhatsApp ticks; edited; unread divider), typing line, AI bubbles
   from the Person AI chat, composer (text, attach files, reply-to, Gmail subject, send / Ask AI).
4. **Person panel** (right, ≥1500 px or toggled): big avatar, names, identities per section,
   stores / lists, notes (editable), socials (profiles + 3 latest uploads each), prev / next, edit,
   delete; SpokPay store link.
5. **Dialogs**: person form (name, Discord id/username lookup, email, WhatsApp, identities, stores,
   lists, socials), store form (name, color, picture, owner), add members (search + lookup), message
   a store (bulk, paced).
6. **Phone**: home = sidebar; list; chat full screen; panel as a sheet; Android back closes the top one.

## Backends: reuse vs port

| Person Hub | Hub | Plan |
| --- | --- | --- |
| Discord (`discord.cjs`: hidden Electron window per account for the token; REST + gateway in Node) | Hub's discord host (Vencord page tools, ONE account, Igor's) | Port Person Hub's REST + gateway client to TS (3 accounts: stores #1, spokpay #2 Fagner's, creators). **No Electron or Chromium**: the import reads each saved login once from Person Hub's session storage (LevelDB, read-only) into the keyring, so nobody signs in again; new sign-ins by Discord's QR remote-auth. |
| Gmail (`gmail.cjs`) | `mcp/src/gmail.ts` (agents' Gmail) | Port Person Hub's (PKCE, contacts photos, history poll); reuse Hub's Google desktop client if the copied `google-client.json` is missing. Refresh token copied (Person Hub's file keeps it plain, 0600); Google's sign-in page opens in the user's own browser. |
| WhatsApp (`whatsapp.cjs` + `whatsapp-engine.mjs`, a copy of Harbor's) | `whatsapp/engine.mjs` + `mcp/src/whatsapphost.ts` | Same Baileys engine; Person Hub's extra ops added to Hub's engine.mjs; auth folder copied (same linked device: Person Hub must be stopped at cutover, the lead does it). |
| SpokPay admin API | — | Port as is. |
| Phone server (`remote*.cjs`, :47960 + tunnel) | Hub phone API (:47950, pinned TLS, pairing) | Routes under `/v1/persons/*` on Hub's API; Hub's Android app gets the tab. |
| Person AI (Harbor API from the page) | Hub's own engine/store | Direct: create/find the chat in the Persons project, send with context, read items. "Open in Projects" switches tabs. |
| data.json, read state, settled | — | Same JSON schema (v7), moved to `~/.local/share/hub/persons/`. |

## Data migration (`bun ts/packages/persons/scripts/migrate.ts [--dry-run]`)

Copies, never moves or deletes: `data.json`, `connections.json`, `images/`, `avatars/`,
`discord-cache*.json`, `gmail-account-*.json`, `gmail-cache-*.json`, `google-client.json`,
`spokpay.json`, `spokpay-links.json`, `whatsapp-*/` → `~/.local/share/hub/persons/`; Discord logins read from
Person Hub's session storage (read-only) into the keyring; its client headers → `persons/discord/<conn id>/`. Refuses to overwrite a newer target unless `--force`.
Prints file names and sizes only, never contents. The lead runs it at cutover.

## Order

1. Engine package: model (+ tests), store, service, connection interface, routes. 2. Slint tab on
fake data, then live. 3. Backends (Discord, Gmail, WhatsApp, SpokPay, socials) in parallel.
4. Android tab. 5. Migration script, staged build, screenshots.

## Status (2026-11-25, branch hub-persons)

Done: engine (`@harbor/persons`: service, routes `v1/persons/*`, Person AI, avatars), Discord / Gmail / WhatsApp
connections, SpokPay and socials backends, Slint tab (`persons.slint` + `src/tabs/persons/`), Android tab
(`Persons*.java`, `PersonsTab implements HubTab`), import script. Checks: `tsc` clean, `bun test packages/persons`
(125) and `packages/ui/test/personsview.test.ts` (7) pass, boundary test passes, `scripts/shot --view tab:persons`
on a copy of the data, one staged build (`packaging/hub-install.sh --stage`).

Not yet: SpokPay site-request panes and the SpokPay key dialog in the UI (backend `createSpokpay` is ported, not
routed), "Message a store" (bulk), Add members with lookup, store pictures upload, voice recording / in-app audio,
"Open in Projects" from a Person AI bubble, the QR drawn on the phone. Nothing ran against real accounts yet
(Discord's QR sign-in ran against a fake remote-auth gateway; the 3 imported logins answered Discord's /users/@me).

## Cutover (the lead runs it; Person Hub keeps its own data untouched)

1. Before: `bun ts/packages/persons/scripts/migrate.ts --dry-run`, then without `--dry-run`: copies data, caches,
   pictures, Gmail sign-in and SpokPay key into `~/.local/share/hub/persons`, and the Discord logins into the keyring.
   Repeatable; prints counts of both sides and exits 1 if any differ. Hub's Persons can run beside Person Hub then
   (Discord and Gmail allow several clients), WhatsApp stays signed out in Hub.
2. Switch: stop Person Hub, run `migrate.ts --sessions` (adds WhatsApp's linked-device keys and anything that changed),
   start Hub. Never run both on the WhatsApp keys at once.
3. Rollback: stop Hub's use of it; Person Hub's folders were only read.
