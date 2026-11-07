import { mcp } from "@harbor/mcp";
import { appTiles } from "./applogos.ts";
import { integrationsAct, integrationsData, realApi, realView, type Form, type IntData, type IntHost } from "./logic/settings-integrations.ts";
import type { Pixels } from "./logos.ts";

/** The Integrations page over `mcp`: its data and its buttons; `qr` draws the Discord login code. */
export async function integrationsFeed(host: IntHost, qr: (url: string) => Pixels) {
  const tiles = await appTiles();
  const forms = new Map<string, Form>();
  const api = realApi();
  const view = realView();
  const feed = {
    view: (dark: boolean): IntData => integrationsData({ view, forms, tile: (n) => tiles(n, dark), qr }),
    valid: (client: string, secret: string): boolean => mcp.validGoogleClient(client, secret),
    act: (what: string, id: string, a: string, b: string): void => integrationsAct(api, forms, host, what, id, a, b),
  };
  // A rig has no pointer: HTS_SIGNIN=context7,discord presses those apps' Sign in once the page opens
  // (HARBOR_SHOT_SIGNIN too, which scripts/shot passes on); "what:id" presses another of the card's
  // buttons, e.g. "signin:whatsapp,whatsapp-ok:whatsapp" with HARBOR_FAKE_WHATSAPP=qr shows its QR.
  for (const step of (process.env.HTS_SIGNIN ?? process.env.HARBOR_SHOT_SIGNIN ?? "").split(",")) {
    const [what, id] = step.includes(":") ? step.split(":") : ["signin", step];
    if (what && id) integrationsAct(api, forms, { ...host, changed: () => void setTimeout(() => host.changed(), 0) }, what, id, "", "");
  }
  return feed;
}
