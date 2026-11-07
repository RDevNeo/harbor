import { mcp } from "@harbor/mcp";
import { appTiles } from "./applogos.ts";
import { type AppsView, integrationsAct, integrationsData, realApi, realView, type Form, type IntData, type IntHost } from "./logic/settings-integrations.ts";
import type { Pixels } from "./logos.ts";

/** The Integrations page over `mcp`: its data and its buttons; `qr` draws the Discord login code. */
export async function integrationsFeed(host: IntHost, qr: (url: string) => Pixels) {
  const tiles = await appTiles();
  const forms = new Map<string, Form>();
  const api = realApi();
  const view = process.env.HARBOR_FAKE_APPS === "signed" ? signedView(realView()) : realView();
  const feed = {
    view: (dark: boolean): IntData => integrationsData({ view, forms, tile: (n) => tiles(n, dark), qr }),
    valid: (client: string, secret: string): boolean => mcp.validGoogleClient(client, secret),
    act: (what: string, id: string, a: string, b: string): void => integrationsAct(api, forms, host, what, id, a, b),
  };
  // A rig has no pointer: HTS_SIGNIN=context7,discord presses those apps' Sign in once the page opens
  // (HARBOR_SHOT_SIGNIN too, which scripts/shot passes on); "what:id" presses another of the card's
  // buttons, e.g. "signin:discord,discord-ok:discord" passes Discord's warning.
  for (const step of (process.env.HTS_SIGNIN ?? process.env.HARBOR_SHOT_SIGNIN ?? "").split(",")) {
    const [what, id] = step.includes(":") ? step.split(":") : ["signin", step];
    if (what && id) integrationsAct(api, forms, { ...host, changed: () => void setTimeout(() => host.changed(), 0) }, what, id, "", "");
  }
  return feed;
}

/** Screenshots with every app signed in, as made-up people (scripts/shot --env HARBOR_FAKE_APPS=signed). */
function signedView(real: AppsView): AppsView {
  const who: Record<string, string> = { github: "sam-rivera-dev", gmail: "sam.rivera@example.com" };
  return {
    ...real,
    pending: () => undefined,
    signedIn: () => true,
    account: (id) => who[id],
    error: () => undefined,
    googleAccounts: (id) => (id === "gmail" ? ["sam.rivera@example.com", "sam.rivera.work@example.org"] : []),
    discordLine: () => ({ text: "Signed in as Sam Rivera", tone: 0 }),
    whatsappLine: () => ({ text: "Signed in as +1 555 123 4567", tone: 0 }),
  };
}
