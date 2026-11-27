# Collector tab (Lead Collector, moved into Hub)

Source: the Tampermonkey userscript `lead-collector.user.js` (github RDevNeo/spok-lead-collector). Target: Hub's
**Collector** tab: Slint on the PC, Java on the phone, one engine for both (`ts/tabs/collector`, routes `v1/collector/…`).
No browser and no WebView: everything runs in the engine against the platforms' own data, one request at a time, gently
(0.25–2.5 s apart; a platform that refuses 5 reads in a row is left alone until later).

## What the user sees

Six views, picked in the sidebar (the phone: the drawer's rows):

- **Collector**: the form (platform, search term, how many leads, Last upload window, Collect / Stop; Instagram's
  session when Instagram is picked), one line while a run goes ("3 of 20 · Checking @x…", then how it ended), and the
  leads that run found.
- **Available**: every lead not Approved, Sent or Restricted, newest first, with one filter box (name, handle, email,
  platform, link).
- **Approved**: leads approved in the review bar (below), the same filter box and its own Copy JSONL. Their detail
  has no review bar (they're reviewed).
- **Sent**: leads a message actually went out to, by email, WhatsApp, Discord or Instagram: from Collector's Send
  message, or typed in Persons to the person a lead is (matched by the address it went to, else their profiles;
  Persons tells Collector only of sends that went, `PersonsService.onSent`, so a failed send moves nobody). Newest sent
  first (Sort doesn't apply there), each card with the channel and the day ("Email · 27 Nov 2026"; the phone: "Sent ·
  Email · …"). A sent lead leaves Available and Approved (Restricted stays Restricted), has no review bar, and like
  every lead is never collected again; the people in Persons places Collector sent to are skipped by runs too.
  `listOf` in `lib/types.ts`: Restricted, else Sent (`contacted`), else Approved, else Available.
- **Restricted**: leads the user keeps out of Available (Reject in the review bar). They stay remembered, so no run
  collects them again. In their detail the review bar's Reject is **Move to Available**.
- **History**: every search run, newest first, grouped by day ("Today", "Yesterday", "Wed, Nov 25", the PC's time
  zone), drawn as Headquarters' Timeline (`app/src/spaces/blox-survivors/TimelineView.tsx`): the start time (13px
  mono, right-aligned in a 52px column; a run going shows how long, "5m", in blue), a dot on the day's vertical line
  (blue going, green done, amber stopped or interrupted, red an error, a smaller grey one when nobody new, that row
  at 60%), then the term with the platform's mark, "YouTube · 20 new leads · 7 already collected", and only when it
  ended early why ("Stopped before the target (20).", "Stopped on an error: …", "Interrupted: Hub restarted."). A
  click (a tap) shows that run: ‹ History, the term, "YouTube · Today 08:26 · 20 new leads", and the leads it found
  in the order found, whichever list they're in now, as the usual cards; a card opens the usual detail, whose review
  bar goes through that run's leads. Back (the phone's) returns to the timeline. No filters, no deleting.

Each view keeps its scroll while Hub runs (the detail, a review, a refresh or another tab doesn't move it); a new
filter, sort or platform choice starts the list at the top.

The three lists share one bar over them (it stays put while they scroll): the filter box, then **Sort** and **Show
only — platforms**, the SpokPay CRM's creator column menus (`creator-status-column.tsx`, `sortCreatorsForStatus`).
Sort: Followers (high → low), the default, or Followers (low → high) (YouTube subscribers count as followers);
unknown counts go last either way, the newest collected first among equals. Platforms: All platforms, or any of YouTube / TikTok / Instagram (brand mark in its colour, the
list's count on the right; several at once, the menu stays open). Both are remembered (`settings.sort`,
`settings.platforms`, the phone's too) and give the review bar's next-lead order. Phone: two compact buttons beside
the filter, each a simple menu.

A lead is one card: picture, name, platform, handle and profile link, the email or "Add email", and its followers on
the right ("9.2M followers"; YouTube subscribers count as followers; none when unknown). Review, Send message and the
videos are in its detail. Copy JSONL (Available's and Approved's page bar) gives that view's leads for SpokPayCRM → Creators → Import.

A click anywhere else on a card (Collector, Available or Restricted) opens the lead's **detail**, the SpokPay CRM's
creator profile dialog (`src/components/creators/creator-profile-dialog.tsx`, `creator-recent-videos.tsx`,
`creator-reach.tsx`), trimmed to one screen that never scrolls (the podium gets smaller in a short window); on the phone
the same content as a full-screen sheet:

- Header: the picture (rounded square), the name, PLATFORM @handle, "Has Contact" when there's an email, a WhatsApp or a
  Reach; on the right Open channel (Open profile), Edit (name, handle, bio, links typed by hand; a later read never
  replaces them), "3 of 12" and × (the phone: Open channel, Edit and "3 of 12" under its bar).
- Stat tiles, only those with data: YouTube Subscribers / Videos / Views, TikTok Followers / Videos / Likes, Instagram
  Followers / Posts (570K, 1K, 69M).
- MOST RECENT: the 3 newest videos as the CRM's podium (#2, #1 wider and raised, #3): thumbnail, two lines of title,
  "yesterday · 22K views"; a click opens the video.
- Bio (three lines at most, clipped, its line breaks folded into " · " so a bio that's a list can't grow; a cut one
  ends in "… more", and a click shows it all, as written, in a popover over the dialog; the phone four lines, a tap
  shows it all); Reach. The search term and the links stay in the record
  (and the export), not on screen.
- **Reach**: one way to contact them (Email, Discord user ID, WhatsApp, Instagram handle; the CRM's checks), Save /
  Clear. Only ever typed: an email or WhatsApp Reach is also the address Send message uses, typed (never replaced by one
  found later). No help line under it: a value that doesn't fit says why (red) only once typed. Under it one **Send
  message** button, the same whichever icon is picked: it opens the composer with that icon's channel picked in To and
  To filled with the field's value (when it's valid). No per-channel "Send email" / "Open in Discord" buttons and no
  "Approved on" line. Exported as the CRM's `reach_kind` / `reach_value`.
- The **review bar** at the bottom, only for leads still under review (a run's, Available's, Restricted's: not an
  Approved lead's, wherever it's opened, nor one opened from Approved or Sent; `underReview` in the PC's ui.ts), always under the content (the podium gives way in a short window; nothing reaches
  the bar) (a review queue's: three equal cells, the keys' caps after each label):
  **Reject** (R or ←) moves the lead to Restricted; **Skip** (S or ↓) leaves it as it is; **Approve** (A or →) marks
  it approved (out of Available, into Approved). Each then shows the next lead
  of the list the detail was opened from (its filter and order at that moment; a lead that left that list meanwhile
  is passed over); after the last one the detail closes (no toast after Reject, Skip, Approve, Restrict or Unapprove: the move is the feedback; a failed one still toasts why). The keys act only while no text field
  has the focus. Approved and rejected leads stay in the ledger: never collected again. Phone: the same bar at the
  bottom of the sheet (no caps), hidden for an Approved lead.

On the phone the detail is the PC dialog's structure in one scrolling column: the picture, name, platform · handle and
tags, Open channel and Edit, the stat tiles, Most recent, Bio and Reach (with its Send message). No Copy link,
Unapprove, Approve to Persons / Restrict chips, contact email row, Links or Note (Reach is where contact goes; the
review bar approves and rejects).

Older leads fill in what they miss (bio, counts, links, the newest videos' views and dates) when their detail opens: one
read of the profile, at most once a day per lead, never during a run on that platform (Instagram only with its session).
There is still no update loop.

When a run ends (done, stopped, an error, or no new leads) Hub notifies, as for its other events: "Collector: done — 7
new leads for “dress to impress”" (this PC's popup while the window isn't in front, and the phones; Settings ›
Notifications › "Collector: a run finished" turns it off). The Collector tab's button then carries a count, as Persons'
carries its unread messages (the window's tab row: TabsBus.collector-unread; the phone's tab bar: Ds.pill), until the
tab is opened on the PC or the phone (`GET v1/collector/unread`, `POST v1/collector/seen`).

## How each platform searches

Every run searches the term for **videos**, as the platform's own search shows them, then goes from each video to its
creator (in the platform's order), keeps the active ones (a post inside Last upload) and reads their profile.

Searches run as **Brazil, in Brazilian Portuguese (pt-BR)** on all three platforms: steering only on YouTube and
Instagram (no creator is dropped for their country). TikTok's hashtag feed is nearly the same list from anywhere, so
TikTok runs also **keep only Brazilian creators** (below). YouTube: the search page and its continuations with `gl=BR&hl=pt` (`Accept-Language: pt-BR`); a
channel's About page stays `hl=en` (with `gl=BR`) so its country reads "Brazil" as before. TikTok: the web params
`region=BR`, `language`/`app_language`/`browser_language`/`webcast_language` `pt-BR` (inside the X-Bogus-signed query),
`Accept-Language: pt-BR`. Instagram: the app's `X-IG-App-Locale` / `X-IG-Device-Locale` / `X-IG-Mapped-Locale` `pt_BR`,
`pt_BR` in the app UA, `Accept-Language: pt-BR,pt;q=0.9`. Parsing reads JSON, ids and timestamps, not UI words, so it
doesn't depend on the language.

| Platform | Videos for the term | Then | Needs |
| --- | --- | --- | --- |
| YouTube | `lib/youtube.ts` / `lib/sweep.ts`: the search page exactly as youtube.com/results shows it (no filter: videos and Shorts, YouTube's ranking), paged with innertube continuations; then the Videos filter, this month's videos, the newest videos, while the target isn't met. Channel results are ignored: only videos lead to a creator | The channel's Atom feed (freshness gate and the 3 newest videos), its About data (links, stats) | Nothing |
| TikTok | `lib/tiktok.ts`: the videos under the term's hashtag, what tiktok.com/tag/<tag> shows ("dress to impress" → `#dresstoimpress`): `/api/challenge/detail/` (unsigned) for its id, `/api/challenge/item_list/` 30 a page, signed with **X-Bogus** (the web app's public request checksum, computed here); then the hashtags of the search box's suggestions that contain the term's first word. A term with no hashtag finds nothing ("TikTok has no #x"). TikTok's real keyword search (`/api/search/item/full/`) isn't used: signed out it answers every request with a captcha (`bdturing-verify`, empty body), whatever the signatures (X-Gnarly included), and runs don't use the user's TikTok login. **Brazil filter**: a video is Portuguese when TikTok tags its caption `pt` (`textLanguage`) or its speech (`video.claInfo.originalLanguageInfo`, the original-audio caption, the ASR subtitles) ("clear"), or when its caption's own words read Portuguese (`ptCaption`: ã/õ, "kkk", você/não/gente…; TikTok often tags a short Portuguese caption "en" or "un"); a creator's most Portuguese video on the page leads to them. Nothing Portuguese: skipped unread (counted as dropped, one log line a page). The rest: their video's page (`webapp.video-detail` → `locationCreated`, where it was made) must say `BR` (the lead's country then reads "Brazil"); a video that doesn't say passes only on a clear tag. A Portuguese video from Portugal is dropped | The profile page (`webapp.user-detail`: bio, bio link, counts), the embed page (3 newest videos). TikTok's "please wait" proof of work is answered. TikTok sometimes sends the profile page without `webapp.user-detail` for a while after many reads (a missing account still gets one, statusCode 10221): the profile is then read from the embed page (bio, rounded counts, newest videos; no bio link or video count) | Nothing |
| Instagram | `lib/instagram.ts`, on the app API (`i.instagram.com`, the Android app's UA and app id, the session as an `Authorization: Bearer IGT:2:` token): the search page's `TopSerpQuery` (GraphQL) for the term exactly as typed (a `#tag` only when the user typed `#`), paged by `end_cursor`; the authors of its reels (a page's posts only when it has no reel). Account search is gone. One throttle: ≥2.5 s between any two calls; a 429 waits 60 s once, then the search stops | `users/<name>/usernameinfo` (bio, bio links, public email), `feed/user/<id>` (3 newest reels) | The user's Instagram session: Collector › Instagram › paste `sessionid=…; ds_user_id=…` (and `mid`) from instagram.com's cookies. Kept in `<data>/collector/sessions.json` (0600), never shown or logged |

Example, "dress to impress", Last upload 30 days (Nov 2026): YouTube @callmehhaley, @karenevans_; TikTok @chicobentodti,
@diasprodti; Instagram @sornbae_dti, @elliadti.

## What every lead gets

- **Never twice** (also: everyone in Persons › Creators and in every other Persons place Collector has sent a lead to,
  `contacted.place`): each lead's keys (`<platform>:<id>`, `<platform>:@handle`, the profiles their links point at on the
  other platforms, their email) go into a ledger (`seen` in state.json) that Restrict and Remove keep. A run skips anyone
  in it, and anyone already in Persons › Creators or in a place Collector sent to (their emails and profile links). A creator found on a second
  platform whose links point at one already collected is linked to them instead of kept twice.
- **Links** (`lib/links.ts`, `lib/enrich.ts`): every URL of the bio and the platform's own link list, then every
  link-in-bio page they use (Linktree's JSON; any other page's outbound links). Kept in the record (and the export),
  not shown on the card.
- **Email** with its source: the bio, a link-in-bio page, Instagram's public business email, or their own website. A
  business-looking one wins. Typed by hand ("typed") it is never replaced. YouTube's own business email sits behind a
  sign-in and a captcha: not read.
- **The 3 newest videos**: URL, title, thumbnail; pictures and thumbnails are cached in `avatars/` when the lead is
  kept (TikTok's and Instagram's image links expire), one at a time behind the others (a CRM import queues hundreds).
  An opening detail's picture and thumbnails go first: `POST fill` fetches the missing ones itself (8 s at most)
  before it answers, and the PC's open detail is read again when more pictures come in.
- **Send message** (the detail's Reach, the card's Reach icon): Persons' composer as a dialog (the phone: a screen).
  The templates on the left (the SpokPay CRM's outreach emails, `{name}` / `{handle}` filled); on the right a composer
  card: **To** on top, a destination picker (a menu: every Persons › Creators connection, Email (Gmail), WhatsApp,
  Discord, Instagram, each with who they are there — their email, number, the Reach's Discord ID or Instagram handle —
  and the account it goes from, or why it can't: not signed in, or "Persons › Creators has no Discord: add one there")
  and the address beside it (editable), then the Subject (email only), the message, and "From igor@… · Creators Gmail"
  with Send… at the bottom; under the card **Add to Persons ›** and a menu of Persons' places, read from Persons' data
  as its sidebar has them (each store, e.g. Robux Paradise, then Creators, SpokPay, Personal; the phone: chips under
  the message). The place decides the To channels: Persons ties connections to sections (Stores Gmail, Creators
  Gmail…; Personal also talks through the Stores Discord and WhatsApp), so To lists that place's section's connections
  and "From …" names it ("From lojas@… · Stores Gmail"); another place keeps the kind of channel, To and the text. A
  second step asks "Send it?" (Back / Send now). Another destination keeps what was
  written; another template fills it again. It **remembers** the template and the channel (the connection, so its
  account too) picked last, in state.json's settings (`lastTemplate`, `lastChannel`: the PC and the phone share them;
  `compose?…&remember=1` when the user picked, and every send): it opens on that template (while it exists) and that
  channel when the lead has a valid address there (another place's connection: the same kind there), and the Persons
  place picked last (`lastPlace`; Creators when it's gone or never picked). A Reach icon clicked in the detail (or the card's Reach icon) wins:
  its channel, To filled with its value. Otherwise the saved Reach's channel, else the first that can send to someone. Sends go through Persons (`persons-bridge.ts`): the lead becomes
  (or joins) a person in the place picked (a store's people, or the Creators / SpokPay / Personal list, made when
  missing) with that identifier (email, WhatsApp number, Discord ID, Instagram id: an
  Instagram lead's own id, else the handle looked up through Persons' Instagram) and the message is in that chat; a
  Discord ID or Instagram handle sent to becomes their Reach when they have none. The CRM's guards: 30 new emails a
  rolling 24 h (shown only once reached), no second send to the same person within 2 minutes.
  `HUB_COLLECTOR_SEND=fake` records instead of sending (its fake Persons has Gmail, WhatsApp, Discord and a signed-out
  Instagram).

**SpokPay CRM import** (`POST v1/collector/import-crm {status?}`, default "Has Contact"; `lib/crm.ts`): the CRM's
creators in that status, read-only through its board's public Convex queries (`creators:listCreatorStatuses`,
`creators:listCreators` on combative-wildcat-45), become Available leads with the detail's fields (bio, counts, links, the
search term, the Reach; an email Reach is their email, kept as typed). Idempotent: a lead already here by its id is only
completed (nothing typed replaced, Restricted stays Restricted); one whose id or handle another lead has is left out.
Every key goes into the never-twice ledger. Their newest videos (the CRM keeps those behind a sign-in) and anything else
missing are then read one lead at a time through the usual fill (1.2 s apart; Instagram 2.5 s).

Records are the userscript's field for field (`lib/types.ts` `CreatorRecord`) plus Hub's own (`email_source`,
`email_manual`, `found_video`, `restricted`, `approved` {at, to, person}, `note`, `contacted`, `reach`,
`whatsapp_manual`, `edited`, `filled_at`, `imported_from`); `settings.approveTo` and `note` are kept from the
removed Approve to and Quick note (harmless; the routes still take them). Older state.json files load as they are; the old daily
update's state and each record's history are dropped.

**Runs** (`lib/history.ts`): each run is recorded in state.json's `runs` (oldest first, the newest 1000) when it ends:
`{id: "run-<startedAt>", platform, query, gapDays, target, startedAt, endedAt, found, known, ids, outcome, error?}`,
outcome one of done (the target in), exhausted (no more for the term), none (nobody new), stopped, failed (with the
error), interrupted (cut by Hub closing or a restart; recorded at the next start). The view (`GET v1/collector`)
carries `history`: days `{key, label, runs: [{id, time, query, platform, platformKey, line, note, tone, running, ids,
found}]}`, the run going now on top. A state.json from before History gets its runs rebuilt once (when it has no
`runs`): the saved last run as it was, and every other lead a run found (not one imported from the CRM) grouped by
platform and search term (`discovered_via`), a new run wherever two were captured more than an hour apart
(`backfilled: true`: no settings, counts of passed-over creators or stop reason).

Data: `<hub data>/collector/state.json` (settings, leads, the ledger, the last run with its leads' ids, every run
(History), a log),
`templates.json`, `sessions.json`, `avatars/`. A run doesn't survive a restart (it's marked "Interrupted").
`HUB_COLLECTOR_DIR` points at another folder, `HUB_COLLECTOR_OFFLINE=1` fetches nothing (the screenshot rigs;
`ts/rig/collector-fixture.ts` writes made-up data).

Checks: `bun test tabs/collector packages/ui/test/collectorview.test.ts`; `bun ts/rig/collector-fixture.ts <dir>` then
`scripts/shot --empty --view tab:collector --env HUB_COLLECTOR_DIR=<dir> --env HUB_COLLECTOR_OFFLINE=1`
(`HUB_COLLECTOR_SHOT_PAGE=available|restricted|history` opens that view, `HUB_COLLECTOR_SHOT_RUN=1` History's newest
run that found someone, `HUB_COLLECTOR_SHOT_SEND=1` the Send dialog,
`HUB_COLLECTOR_SHOT_DETAIL=1` the first lead's detail); `scripts/boat/phoneshot --screen collector` (also
`collector-available`, `collector-restricted`, `collector-history`, `collector-history-run`, `collector-send`, `collector-detail`).
