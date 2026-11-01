import { providers } from "@harbor/agents";
import { control, hookcert } from "@harbor/mcp";
import type { Store } from "@harbor/store";
import { webhooksAct, webhooksData, type WebhooksHost, type WhData } from "./logic/settings-webhooks.ts";

/** The Webhooks page over a store; `funnel` is where Tailscale Funnel points (checked off the page), if it does. */
export function webhooksFeed(store: Store, host: WebhooksHost, funnel: () => { base: string | null; stale: number | null }, hookPort: () => number = () => control.HOOK_PORT) {
  const hasTailscale = providers.which("tailscale") !== null;
  // A rig has no router and no Let's Encrypt: HTS_HOOKSTATUS='{"route":"…","error":"…"}' stands in for what the listener found.
  const rig: unknown = JSON.parse(process.env.HTS_HOOKSTATUS ?? "{}");
  const said = (k: "route" | "error"): string => (typeof rig === "object" && rig !== null && k in rig && typeof Reflect.get(rig, k) === "string" ? String(Reflect.get(rig, k)) : "");
  return {
    view(): WhData {
      const names = new Map(store.repos().map((r) => [r.id, r.name]));
      const f = funnel();
      return webhooksData({ kv: store, status: { ...hookcert.status(), route: said("route") || hookcert.status().route, error: said("error") || hookcert.status().error }, port: hookPort(), funnel: f.base, funnelStale: f.stale, hasTailscale, hooks: store.webhooks(), repoName: (id) => names.get(id) ?? "", now: Math.floor(Date.now() / 1000) });
    },
    act: (what: string, a: string): void => webhooksAct(store, host, hookPort(), what, a),
  };
}
