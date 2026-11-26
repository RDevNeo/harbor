# Collector tab (Lead Collector, moved into Hub)

Source: the Tampermonkey userscript `lead-collector.user.js` (github RDevNeo/spok-lead-collector). Target: Hub's
**Collector** tab: Slint on the PC, Java on the phone, one engine for both (`ts/tabs/collector`, routes `v1/collector/…`).
No browser and no WebView: everything runs in the engine against the platforms' own data, one request at a time, gently
(0.25–2.5 s apart; a platform that refuses 5 reads in a row is left alone until later).

Creators only (the Servers tab is gone).

## Platforms

| Platform | How Hub collects | Needs |
| --- | --- | --- |
| YouTube | The userscript's search passes (`lib/youtube.ts`, `lib/sweep.ts`): channels and uploaders for the term, the Atom feed as the freshness gate, the About page for stats and links | Nothing |
| TikTok | `lib/tiktok.ts`: accounts from TikTok's search suggestions for the term (`/api/search/general/preview/`, the term and its suggested phrases), then each profile page (`webapp.user-detail`: exact followers, likes, videos, bio, bio link) and its embed page (newest videos, dates from the video ids). TikTok's own "please wait" check is a small proof of work Hub answers | Nothing. TikTok's full search (`/api/search/user|general/full`) answers only requests signed by its page code (X-Bogus/X-Gnarly), with or without a login, so a run finds fewer accounts per term than the userscript did |
| Instagram | `lib/instagram.ts`: hashtag posts (`tags/web_info`, then the recent section, paged) and account search (`topsearch`) on the user's session, then each profile (`web_profile_info`: exact counts, bio, bio links, business email when public, newest posts) | The user's Instagram session: Collector › Instagram › paste `sessionid=…; csrftoken=…` from instagram.com's cookies (DevTools › Application › Cookies). Kept in `<data>/collector/sessions.json` (0600), never shown or logged; checked once when saved. Without it, every Instagram search answers 404, and profiles (for the daily update) come from the public link preview: rounded counts, no posts |

## What every creator gets

- **Never twice**: each creator's keys (`<platform>:<id>`, `<platform>:@handle`, the profiles their links point at on
  the other platforms, their email) go into a ledger (`seen` in state.json) that Clear and Remove keep. A run skips
  anyone in it, and anyone already in Persons › Creators (their emails and profile links). A creator found on a second
  platform whose links point at one already collected is linked to them (the new profile is added to their links)
  instead of kept twice.
- **Links** (`lib/links.ts`, `lib/enrich.ts`): every URL of the bio and the platform's own link list (bare
  `instagram.com/x` too, redirect wrappers unwrapped, tracking params dropped), then every link-in-bio page they use
  (Linktree's JSON; any other page's outbound links). Beacons and lnk.bio sit behind Cloudflare's browser check and
  give nothing.
- **Email** with its source: the bio ("YouTube About", "TikTok bio"; disguised ones like `nome [arroba] gmail [ponto]
  com` too), a link-in-bio page, Instagram's public business email, or, when none yet, their own website (home page,
  then a contact page). A business-looking one (`contato@`, `parcerias@`…) wins. The email can be typed or corrected by
  hand ("typed": the daily update never replaces it). YouTube's own business email sits behind a sign-in and a
  captcha: not read.
- **Daily update** (`lib/refresh.ts`): once a day (on by default; a switch on the Daily update card), every creator is
  read again, oldest first, one every 2.5 s, waiting while a run goes: stats, last upload, bio, links, email. What
  changed is written in their history (10 kept) and shown on the row ("↻ Subscribers 176K → 182K") for a day and a
  half. Update all now / Update now (one creator) do the same on demand.
- **Send message**: the creator's page › Send message: a template (Person Hub's Email dialog templates, which are the
  SpokPay CRM's outreach emails, `{name}` / `{handle}` filled), the channel (Persons › Creators' Gmail; its WhatsApp
  when their bio gives a number), To, Subject, the message (all editable; Save as template keeps it), then Send… and
  a second "Send now". It goes through Persons: the creator becomes a person in Persons › Creators (name, picture,
  profiles, the other links and where they came from in the notes, email or number) and the message is in that chat;
  if the send fails, the new person is removed again. The CRM's guards: 30 new emails a rolling 24 h, no second send
  to the same person within 2 minutes, "You emailed them on …". `HUB_COLLECTOR_SEND=fake` records instead of sending
  (rigs, previews).

Records are the userscript's field for field (`lib/types.ts` `CreatorRecord`) plus Hub's own fields; Copy JSONL gives
the CRM's fields and the email, one creator per line, for SpokPayCRM → Creators → Import (influencers' `leadImport.ts`).

Data: `<hub data>/collector/state.json` (settings, creators, the ledger, the last run, the daily update, the log's last
400 lines), `templates.json` (edited templates), `sessions.json`, `avatars/`. A run doesn't survive a restart (it's
marked "Interrupted"). `HUB_COLLECTOR_DIR` points at another folder, `HUB_COLLECTOR_OFFLINE=1` fetches nothing (the
screenshot rigs; `ts/rig/collector-fixture.ts` writes made-up data).

Checks: `bun test tabs/collector packages/ui/test/collectorview.test.ts`; `bun ts/rig/collector-fixture.ts <dir>` then
`scripts/shot --empty --view tab:collector --env HUB_COLLECTOR_DIR=<dir> --env HUB_COLLECTOR_OFFLINE=1`
(`HUB_COLLECTOR_SHOT_CREATOR=<id>`, `HUB_COLLECTOR_SHOT_SEND=1` open a creator and the Send dialog);
`scripts/boat/phoneshot --screen collector`.
