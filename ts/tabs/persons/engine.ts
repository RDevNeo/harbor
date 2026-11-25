// Persons tab, engine side: @harbor/persons' service and routes (`v1/persons/…`), data in <data dir>/persons/.
// HUB_PERSONS_OFFLINE=1 starts it without connections or background reads (the screenshot rig).
import { desktop } from "../../packages/os/src/index.ts";
import { FACTORIES, PersonAi, PersonsRoutes, PersonsService } from "../../packages/persons/src/index.ts";
import type { Call, Reply } from "../../packages/net/src/index.ts";
import type { TabEngine } from "../api.ts";

let service: PersonsService | null = null;
let routes: PersonsRoutes | null = null;

export const personsEngine: TabEngine = {
  id: "persons",
  async start(ctx) {
    const offline = ctx.env.HUB_PERSONS_OFFLINE === "1";
    service = new PersonsService({
      dir: ctx.env.HUB_PERSONS_DIR || ctx.dir,
      factories: FACTORIES,
      offline,
      openExternal: (url) => desktop.open(url),
    });
    routes = new PersonsRoutes(service, { ai: new PersonAi(service.dir, async (m, p, q, b) => ctx.call(m, p, q, b)) });
    service.onChange(() => ctx.changed());
    await service.start();
  },
  async route(call: Call): Promise<Reply | null> {
    if (call.path[0] !== "v1" || call.path[1] !== "persons") return null;
    if (!routes) return { status: 503, body: { error: "Persons is starting" } };
    return (await routes.route(call)) as Reply | null;
  },
  async stop() {
    await service?.stop();
  },
};
