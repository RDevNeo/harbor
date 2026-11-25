// Persons tab, engine side: @harbor/persons' service and routes (`v1/persons/…`), data in <data dir>/persons/.
// Also Hub's agents' Discord tools (persons/src/agent): they run on a Persons Discord connection.
// HUB_PERSONS_OFFLINE=1 (or Hub's HARBOR_OFFLINE=1) starts it without connections or background reads, conversations from
// the caches on disk (the screenshot rig); HARBOR_PERSONS_DIR points it at another folder (a copy of the data).
import { desktop } from "../../packages/os/src/index.ts";
import { AgentDiscord, createSocials, FACTORIES, formatAge, formatCount, PersonAi, PersonsRoutes, PersonsService, type Socials } from "../../packages/persons/src/index.ts";
import type { Call, Reply } from "../../packages/net/src/index.ts";
import type { TabEngine } from "../api.ts";
import { qrRows } from "../../packages/ui/src/qr.ts";
import { discord as agentsDiscord } from "../../packages/mcp/src/index.ts";

let service: PersonsService | null = null;
let socials: Socials | null = null;
let routes: PersonsRoutes | null = null;

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
      openExternal: (url) => desktop.open(url),
    });
    // the panel's Socials: each profile with its latest uploads ("22d ago · 140K views"); offline: what's cached
    const panelSocials = async (urls: string[]) =>
      Promise.all(urls.map(async (url) => {
        const r = offline ? social.cached(url) : await social.fetchSocial(url).catch(() => social.cached(url));
        if (!r) return { url, platform: null, handle: url, note: "", uploads: [] };
        return {
          url: r.url,
          platform: r.platform,
          handle: r.handle,
          note: r.unsupported ? "Uploads can't be read without a login" : r.error && !r.uploads.length ? "Couldn't read the latest uploads" : "",
          uploads: r.uploads.slice(0, 3).map((u) => ({ title: u.title ?? "", url: u.url, thumb: u.thumb ?? null, meta: [formatAge(u.at), u.views != null ? `${formatCount(u.views)} views` : ""].filter(Boolean).join(" · ") })),
        };
      }));
    // Hub's agents' Discord tools run on a Persons Discord connection (the Stores one unless agents.json picks another):
    // `hub app discord` calls them through v1/persons/agent/discord; the Settings card and the phone read it here.
    const agent = new AgentDiscord(service);
    agentsDiscord.provide({ info: () => agent.info(), signIn: () => agent.signIn(), cancel: () => agent.cancel(), signOut: () => agent.signOut() });
    routes = new PersonsRoutes(service, { agent, ai: new PersonAi(service.dir, async (m, p, q, b) => ctx.call(m, p, q, b)), socials: panelSocials as never, qr: async (t) => (await qrRows(t))?.rows ?? null });
    service.onChange(() => ctx.changed());
    await service.start();
  },
  async route(call: Call): Promise<Reply | null> {
    if (call.path[0] !== "v1" || call.path[1] !== "persons") return null;
    if (!routes) return { status: 503, body: { error: "Persons is starting" } };
    return (await routes.route(call)) as Reply | null;
  },
  async stop() {
    agentsDiscord.provide(null);
    await service?.stop();
    await socials?.flush().catch(() => {});
  },
};
