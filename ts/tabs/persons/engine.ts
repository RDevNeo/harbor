// Persons tab, engine side: @harbor/persons' service and routes (`v1/persons/…`), data in <data dir>/persons/.
// Also Hub's agents' Discord tools (persons/src/agent): they run on a Persons Discord connection.
// HUB_PERSONS_OFFLINE=1 (or Hub's HARBOR_OFFLINE=1) starts it without connections or background reads, conversations from
// the caches on disk (the screenshot rig); HARBOR_PERSONS_DIR points it at another folder (a copy of the data).
import { desktop } from "../../packages/os/src/index.ts";
import { AgentDiscord, AudioService, VoiceQueue, createSocials, createSpokpay, SiteRequests, FACTORIES, formatAge, formatCount, PersonAi, PersonsRoutes, PersonsService, type Socials } from "../../packages/persons/src/index.ts";
import { dictate } from "../../packages/media/src/index.ts";
import { parseSocialUrl, PLATFORM_LABEL, socialHandle } from "../../packages/persons/src/socials.ts";
import type { Call, Reply } from "../../packages/net/src/index.ts";
import type { TabEngine } from "../api.ts";
import { qrRows } from "../../packages/ui/src/qr.ts";
import { discord as agentsDiscord } from "../../packages/mcp/src/index.ts";

let service: PersonsService | null = null;
let socials: Socials | null = null;
let routes: PersonsRoutes | null = null;
let audio: AudioService | null = null;
let voice: VoiceQueue | null = null;

/** Persons' service, in-process, for Collector's Send message (Persons › Creators: find or add the creator, send, see
 * what was sent) and its "already in Persons" check; null while Persons isn't up. */
export function personsService(): PersonsService | null {
  return service;
}

export const personsEngine: TabEngine = {
  id: "persons",
  async start(ctx) {
    const offline = ctx.env.HUB_PERSONS_OFFLINE === "1" || ctx.env.HARBOR_PERSONS_OFFLINE === "1" || ctx.env.HARBOR_OFFLINE === "1";
    const dir = ctx.env.HUB_PERSONS_DIR || ctx.env.HARBOR_PERSONS_DIR || ctx.dir;
    const social = createSocials({ dir, log: (...a) => ctx.log(a.map(String).join(" ")) });
    socials = social;
    service = new PersonsService({
      dir,
      socialPhoto: async (url) => {
        const r = await social.fetchSocial(url);
        return r === null ? null : r.error && !r.photo ? undefined : r.photo;
      },
      factories: FACTORIES,
      offline,
      // the screenshot rig's composer (HUB_PERSONS_SHOT_CONNECTED=1): offline connections drawn as connected
      offlineConnected: offline && ctx.env.HUB_PERSONS_SHOT_CONNECTED === "1",
      openExternal: (url) => desktop.open(url),
    });
    // the panel's Socials: each profile with its latest uploads ("22d ago · 140K views"); offline: what's cached
    const panelSocials = async (urls: string[], fresh: boolean) =>
      Promise.all(urls.map(async (url) => {
        const t = parseSocialUrl(url);
        const r = offline || !fresh ? social.cached(url) : await social.fetchSocial(url).catch(() => social.cached(url));
        if (!r) return { url, platform: t ? PLATFORM_LABEL[t.platform] : "Link", handle: t ? socialHandle(t) : url, note: offline || !fresh ? "" : "Couldn't read the latest uploads", uploads: [] };
        return {
          url: r.url,
          platform: PLATFORM_LABEL[r.platform],
          handle: r.handle,
          note: r.unsupported ? "Uploads can't be read without a login" : r.error && !r.uploads.length ? "Couldn't read the latest uploads" : "",
          uploads: r.uploads.slice(0, 3).map((u) => ({ title: u.title ?? "", url: u.url, thumb: u.thumb ?? null, meta: [formatAge(u.at), u.views != null ? `${formatCount(u.views)} views` : ""].filter(Boolean).join(" · ") })),
        };
      }));
    // Hub's agents' Discord tools run on a Persons Discord connection (the Stores one unless agents.json picks another):
    // `hub app discord` calls them through v1/persons/agent/discord; the Settings card and the phone read it here.
    const agent = new AgentDiscord(service);
    agentsDiscord.provide({ info: () => agent.info(), signIn: () => agent.signIn(), cancel: () => agent.cancel(), signOut: () => agent.signOut() });
    // SpokPay (the admin key in <dir>/spokpay.json): the message menu's Open Site Request and the proposals' cards
    const svc = service;
    const spokpay = createSpokpay({ dir, log: (...a) => ctx.log(a.map(String).join(" ")) });
    if (!offline) spokpay.start();
    const sites = new SiteRequests(spokpay, async (m, p, q, b) => ctx.call(m, p, q, b), () => svc.touch(), (url, name, account) => svc.fetchAttachment(url, name, account));
    // voice messages: played here (ffmpeg into PipeWire…), transcribed with the composer mic's speech to text
    audio = new AudioService({ dir, changed: () => svc.touch(), log: (...a) => ctx.log(a.map(String).join(" ")), transcribe: (samples) => dictate.local(samples, "auto") });
    // their voice messages transcribed in the background (one at a time, low priority), for the AI and the bubbles
    const au = audio;
    voice = offline ? null : new VoiceQueue({
      audio: au,
      chats: () => svc.views().flatMap((v) => Object.values(v.convos).map((c) => ({ connId: v.id, messages: c.messages }))),
      fetch: (url, name, connId) => svc.fetchAttachment(url, name, connId),
      log: (...a) => ctx.log(a.map(String).join(" ")),
    });
    routes = new PersonsRoutes(service, { agent, sites, audio, ...(voice ? { voice } : {}), ai: new PersonAi(service.dir, async (m, p, q, b) => ctx.call(m, p, q, b)), socials: panelSocials as never, qr: async (t) => (await qrRows(t))?.rows ?? null });
    service.onChange(() => {
      ctx.changed();
      voice?.kick();
    });
    await service.start();
  },
  async route(call: Call): Promise<Reply | null> {
    if (call.path[0] !== "v1" || call.path[1] !== "persons") return null;
    if (!routes) return { status: 503, body: { error: "Persons is starting" } };
    return (await routes.route(call)) as Reply | null;
  },
  async stop() {
    agentsDiscord.provide(null);
    voice?.stop();
    audio?.close();
    await service?.stop();
    await socials?.flush().catch(() => {});
  },
};
