# Collector tab (Lead Collector, moved into Hub)

Source: the Tampermonkey userscript `lead-collector.user.js` (github RDevNeo/spok-lead-collector). Target: Hub's
**Collector** tab: Slint on the PC, Java on the phone, one engine for both (`ts/tabs/collector`, routes `v1/collector/…`).
No browser: the sweeps run in the engine against the platforms' own data, at the userscript's gentle pace (one request
at a time, 150–1500 ms apart).

| Userscript | Hub | State |
| --- | --- | --- |
| Creators › YouTube (search passes, freshness gate on the Atom feed, About data, JSONL) | `lib/youtube.ts` (parsing ported as is), `lib/sweep.ts` (passes, appetite, harvest); innertube key / version read from the first search page instead of `window.ytcfg` | Works, no login |
| Creators › TikTok | — | Not available yet: search needs TikTok's request signatures (X-Bogus/msToken) computed by its page code |
| Creators › Instagram | — | Not available yet: needs a signed-in Instagram session; profiles only render in a browser |
| Servers › Discover (clicks through Discover, copies the "Invite to Server" dialog) | `lib/discord.ts`: `GET /discoverable-guilds/search` on Persons' Stores Discord login, then each server's public widget (`/guilds/<id>/widget.json`) | Works, read-only. Only servers with their widget on give an invite (~1 in 8 in tests); the rest are logged as SKIP. Nothing is joined and no invite is created |
| Servers › Reader (scrolls a channel) | `GET /channels/<id>/messages` (100 a page, up to 3000), invites looked up with `/invites/<code>` | Works, read-only; the account must be able to read the channel |
| Servers › Sidebar (opens every member's profile) | — | Not available yet: profile-by-profile reads are what gets an account flagged |

Records are the userscript's field for field (`lib/types.ts` `CreatorRecord`); Copy gives JSONL, one record per line,
for SpokPayCRM → Creators → Import (influencers' `leadImport.ts`), or the invite URLs one per line. Dedupe: creators by
`platform:platform_id`, invites by code and server. Targets are per tab; drops never count toward them.

Data: `<hub data>/collector/state.json` (settings, records, the last run, the log's last 400 lines) and `avatars/`.
A run doesn't survive a restart (it's marked "Interrupted"). `HUB_COLLECTOR_DIR` points at another folder,
`HUB_COLLECTOR_OFFLINE=1` fetches nothing (the screenshot rigs).

Checks: `bun test tabs/collector packages/ui/test/collectorview.test.ts`; `scripts/shot --view tab:collector --env
HUB_COLLECTOR_DIR=… --env HUB_COLLECTOR_OFFLINE=1`; `scripts/boat/phoneshot --screen collector`.
