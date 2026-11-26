# Collector tab (Lead Collector, moved into Hub)

Source: the Tampermonkey userscript `lead-collector.user.js` (github RDevNeo/spok-lead-collector). Target: Hub's
**Collector** tab: Slint on the PC, Java on the phone, one engine for both (`ts/tabs/collector`, routes `v1/collector/…`).
No browser and no WebView: everything runs in the engine against the platforms' own data, one request at a time, gently
(0.25–2.5 s apart; a platform that refuses 5 reads in a row is left alone until later).

## What the user sees

Three views, picked in the sidebar (the phone: chips under the title):

- **Collector**: the form (platform, search term, how many leads, Last upload window, Collect / Stop; Instagram's
  session when Instagram is picked), one line while a run goes ("3 of 20 · Checking @x…", then how it ended), and the
  leads that run found.
- **Available**: every lead not Restricted, newest first, with one filter box (name, handle, email, platform, link).
- **Restricted**: leads the user keeps out of Available. They stay remembered, so no run collects them again.

A lead is one card: picture, name, platform, handle and profile link, the Reach icon when one is set, the email (and
where it was found) or "Add email", the 3 newest videos (thumbnails; a click opens the video), **Restrict / Unrestrict**,
and **Send message**. Copy JSONL (Available's page bar) gives the Available leads for SpokPayCRM → Creators → Import.

A click anywhere else on a card (Collector, Available or Restricted) opens the lead's **detail**, the SpokPay CRM's
creator profile dialog (`src/components/creators/creator-profile-dialog.tsx`, `creator-recent-videos.tsx`,
`creator-reach.tsx`, `lib/social-brands.tsx`) class for class; on the phone the same content as a full-screen sheet:

- Header: the picture (rounded square), the name, PLATFORM @handle, "Has Contact" when there's an email, a WhatsApp or a
  Reach; × closes.
- Stat tiles, only those with data: YouTube Subscribers / Videos / Views, TikTok Followers / Videos / Likes, Instagram
  Followers / Posts (570K, 1K, 69M).
- MOST RECENT: the 3 newest videos as the CRM's podium (#2, #1 wider and raised, #3): thumbnail, two lines of title,
  "yesterday · 22K views"; a click opens the video.
- Bio; How we found them (Search: "term" on Platform); Reach; Social media (each link with its brand mark, title and URL;
  a click opens it).
- **Reach**: one way to contact them (Email, Discord user ID, WhatsApp, Instagram handle; the CRM's checks), Save /
  Clear. Only ever typed: an email or WhatsApp Reach is also the address Send message uses, typed (never replaced by one
  found later). The saved Reach's button: Send email / Send WhatsApp (Send message on that channel), Open in Discord /
  Open Instagram. Its icon shows on the card (a click does the same). Exported as the CRM's `reach_kind` / `reach_value`.
- Footer: Open channel (Open profile), Edit (name, handle, bio, links typed by hand; a later read never replaces them).

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

| Platform | Videos for the term | Then | Needs |
| --- | --- | --- | --- |
| YouTube | `lib/youtube.ts` / `lib/sweep.ts`: the search page exactly as youtube.com/results shows it (no filter: videos and Shorts, YouTube's ranking), paged with innertube continuations; then the Videos filter, this month's videos, the newest videos, while the target isn't met. Channel results are ignored: only videos lead to a creator | The channel's Atom feed (freshness gate and the 3 newest videos), its About data (links, stats) | Nothing |
| TikTok | `lib/tiktok.ts`: the videos under the term's hashtag, what tiktok.com/tag/<tag> shows ("dress to impress" → `#dresstoimpress`): `/api/challenge/detail/` (unsigned) for its id, `/api/challenge/item_list/` 30 a page, signed with **X-Bogus** (the web app's public request checksum, computed here); then the hashtags of the search box's suggestions that contain the term's first word. TikTok's real keyword search (`/api/search/item/full/`, `/general/full/`) answers an empty body unless it also carries **X-Gnarly** (its page code's newer signature): Hub doesn't forge that, so a term with no hashtag finds nothing ("TikTok has no #x") | The profile page (`webapp.user-detail`: bio, bio link, counts), the embed page (3 newest videos). TikTok's "please wait" proof of work is answered | Nothing |
| Instagram | `lib/instagram.ts`, on the app API (`i.instagram.com`, the Android app's UA and app id, the session as an `Authorization: Bearer IGT:2:` token): the search page's `TopSerpQuery` (GraphQL) for the term exactly as typed (a `#tag` only when the user typed `#`), paged by `end_cursor`; the authors of its reels (a page's posts only when it has no reel). Account search is gone. One throttle: ≥2.5 s between any two calls; a 429 waits 60 s once, then the search stops | `users/<name>/usernameinfo` (bio, bio links, public email), `feed/user/<id>` (3 newest reels) | The user's Instagram session: Collector › Instagram › paste `sessionid=…; ds_user_id=…` (and `mid`) from instagram.com's cookies. Kept in `<data>/collector/sessions.json` (0600), never shown or logged |

Example, "dress to impress", Last upload 30 days (Nov 2026): YouTube @callmehhaley, @karenevans_; TikTok @chicobentodti,
@kitrixas2.dti; Instagram @sornbae_dti, @elliadti.

## What every lead gets

- **Never twice**: each lead's keys (`<platform>:<id>`, `<platform>:@handle`, the profiles their links point at on the
  other platforms, their email) go into a ledger (`seen` in state.json) that Restrict and Remove keep. A run skips anyone
  in it, and anyone already in Persons › Creators (their emails and profile links). A creator found on a second
  platform whose links point at one already collected is linked to them instead of kept twice.
- **Links** (`lib/links.ts`, `lib/enrich.ts`): every URL of the bio and the platform's own link list, then every
  link-in-bio page they use (Linktree's JSON; any other page's outbound links). Kept in the record (and the export),
  not shown on the card.
- **Email** with its source: the bio, a link-in-bio page, Instagram's public business email, or their own website. A
  business-looking one wins. Typed by hand ("typed") it is never replaced. YouTube's own business email sits behind a
  sign-in and a captcha: not read.
- **The 3 newest videos**: URL, title, thumbnail; pictures and thumbnails are cached in `avatars/` when the lead is
  kept (TikTok's and Instagram's image links expire).
- **Send message**: a template (the SpokPay CRM's outreach emails, `{name}` / `{handle}` filled), the channel
  (Persons › Creators' Gmail; its WhatsApp when their bio gives a number), To, Subject, the message, then Send… and a
  second "Send now". The lead becomes a person in Persons › Creators and the message is in that chat. The CRM's guards:
  30 new emails a rolling 24 h, no second send to the same person within 2 minutes. `HUB_COLLECTOR_SEND=fake` records
  instead of sending.

**SpokPay CRM import** (`POST v1/collector/import-crm {status?}`, default "Has Contact"; `lib/crm.ts`): the CRM's
creators in that status, read-only through its board's public Convex queries (`creators:listCreatorStatuses`,
`creators:listCreators` on combative-wildcat-45), become Available leads with the detail's fields (bio, counts, links, the
search term, the Reach; an email Reach is their email, kept as typed). Idempotent: a lead already here by its id is only
completed (nothing typed replaced, Restricted stays Restricted); one whose id or handle another lead has is left out.
Every key goes into the never-twice ledger. Their newest videos (the CRM keeps those behind a sign-in) and anything else
missing are then read one lead at a time through the usual fill (1.2 s apart; Instagram 2.5 s).

Records are the userscript's field for field (`lib/types.ts` `CreatorRecord`) plus Hub's own (`email_source`,
`email_manual`, `found_video`, `restricted`, `contacted`, `reach`, `whatsapp_manual`, `edited`, `filled_at`, `imported_from`). Older state.json files load as they are; the old daily
update's state and each record's history are dropped.

Data: `<hub data>/collector/state.json` (settings, leads, the ledger, the last run with its leads' ids, a log),
`templates.json`, `sessions.json`, `avatars/`. A run doesn't survive a restart (it's marked "Interrupted").
`HUB_COLLECTOR_DIR` points at another folder, `HUB_COLLECTOR_OFFLINE=1` fetches nothing (the screenshot rigs;
`ts/rig/collector-fixture.ts` writes made-up data).

Checks: `bun test tabs/collector packages/ui/test/collectorview.test.ts`; `bun ts/rig/collector-fixture.ts <dir>` then
`scripts/shot --empty --view tab:collector --env HUB_COLLECTOR_DIR=<dir> --env HUB_COLLECTOR_OFFLINE=1`
(`HUB_COLLECTOR_SHOT_PAGE=available|restricted` opens that view, `HUB_COLLECTOR_SHOT_SEND=1` the Send dialog,
`HUB_COLLECTOR_SHOT_DETAIL=1` the first lead's detail); `scripts/boat/phoneshot --screen collector` (also
`collector-available`, `collector-restricted`, `collector-send`, `collector-detail`).
