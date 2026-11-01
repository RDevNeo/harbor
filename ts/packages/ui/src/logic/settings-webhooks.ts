import { hookcert, control } from "@harbor/mcp";
import type { Webhook } from "@harbor/store";
import { ago } from "./app.ts";
import type { Kv } from "./settings.ts";
import { pick } from "./text.ts";

export type WhTone = 0 | 1 | 2;

export type FunnelAction = "funnel-enable" | "funnel-point" | "funnel-disable" | "";

const ACTS = ["public", "check", "name", "funnel", "funnel-check", "copy", "delete"] as const;

export interface WhHook {
  id: string;
  name: string;
  url: string;
  meta: string;
}

/** One webhook row, as slint/settings-webhooks.slint draws it. */
export interface WhData {
  public: boolean;
  public_desc: string;
  status_title: string;
  status_desc: string;
  badge: string;
  badge_tone: WhTone;
  error: string;
  name: string;
  name_hint: string;
  cert: string;
  funnel_show: boolean;
  funnel_badge: string;
  funnel_tone: WhTone;
  funnel_text: string;
  funnel_mono: boolean;
  funnel_action: FunnelAction;
  funnel_action_text: string;
  hooks: WhHook[];
}

/** What the page reads besides kv. */
export interface WebhooksInput {
  kv: Kv;
  status: hookcert.Status;
  /** The port Harbor's hook server listens on. */
  port: number;
  /** Tailscale Funnel's public base while it points here, and the port it points at when that isn't Harbor's. */
  funnel: string | null;
  funnelStale: number | null;
  hasTailscale: boolean;
  hooks: readonly Webhook[];
  repoName(id: number): string;
  now: number;
}

/** A webhook's URL: Harbor's own public HTTPS first, Tailscale Funnel while it's there, else this PC's (team.rs `hook_url`). */
export function hookUrl(token: string, port: number, base: string | null, funnel: string | null): string {
  const b = base ?? funnel;
  return b === null ? `http://127.0.0.1:${port}/hooks/${token}` : `${b}/${token}`;
}

/** pages.rs `webhooks_tab`. */
export function webhooksData(i: WebhooksInput): WhData {
  const { status: hs, port } = i;
  const pub = i.kv.get("hooks_public") === "1";
  let badge = "Not public";
  let tone: WhTone = 2;
  let title = `http://127.0.0.1:${port}/hooks (this PC only)`;
  if (hs.base !== null) [badge, tone, title] = ["Public", 1, hs.base];
  else if (hs.busy) [badge, tone, title] = ["Working", 0, "Opening port 443 and getting a certificate\u{2026}"];
  const days = Math.trunc((hs.expires - i.now) / 86400);
  const funnelOn = i.funnel !== null;
  let funnelBadge = "";
  let funnelTone: WhTone = 0;
  let funnelText = "Or with Tailscale Funnel (installed here): https://<machine>.<tailnet>.ts.net/hooks";
  if (i.funnel !== null) [funnelBadge, funnelTone, funnelText] = ["Funnel", 1, i.funnel];
  else if (i.funnelStale !== null) [funnelBadge, funnelTone, funnelText] = ["Funnel", 2, `Funnel sends /hooks to 127.0.0.1:${i.funnelStale}, not to Harbor's port ${port}: another program there would get your webhooks.`];
  return {
    public: pub,
    public_desc: `Serves only /hooks/<secret-token> over HTTPS, with a certificate Harbor gets from Let's Encrypt by itself. Your router must send port 443 to this PC (port ${hookcert.PORT}): Harbor asks it to.`,
    status_title: title,
    status_desc: hs.route,
    badge,
    badge_tone: tone,
    error: hs.error,
    name: i.kv.get("hooks_name") ?? "",
    name_hint: hs.name === "" ? "203-0-113-7.sslip.io" : hs.name,
    cert: hs.expires > 0 ? `Certificate for ${hs.name} \u{b7} ${days} days left \u{b7} renewed by itself` : "",
    funnel_show: i.hasTailscale,
    funnel_badge: funnelBadge,
    funnel_tone: funnelTone,
    funnel_text: funnelText,
    funnel_mono: funnelOn,
    funnel_action: funnelOn ? "funnel-disable" : i.funnelStale !== null ? "funnel-point" : "funnel-enable",
    funnel_action_text: funnelOn ? "Disable" : i.funnelStale !== null ? "Point Funnel here" : "Enable Funnel",
    hooks: i.hooks.map((h) => ({
      id: String(h.id),
      name: `${h.name}  \u{b7}  ${i.repoName(h.repoId)}`,
      url: hookUrl(h.token, port, hs.base, i.funnel),
      meta: `${h.hits} calls${h.lastHit > 0 ? ` \u{b7} last ${ago(h.lastHit, i.now)}` : ""}`,
    })),
  };
}

/** What a button of the page does outside it. */
export interface WebhooksHost {
  changed(): void;
  copy(text: string): void;
  /** Runs a shell command in a terminal titled "Tailscale Funnel". */
  terminal(title: string, script: string): void;
  deleteWebhook(id: number): void;
  /** Asks Tailscale again; resolves once the answer is in. */
  checkFunnel(): Promise<void>;
  disableFunnel(): void;
  kick(): void;
}

/** A control of the page, written where the Rust app keeps it. */
export function webhooksAct(kv: Kv, host: WebhooksHost, port: number, what: string, a: string): void {
  switch (pick(what, ACTS)) {
    case "public":
      kv.set("hooks_public", a === "1" ? "1" : "0");
      host.kick();
      break;
    case "check":
      host.kick();
      return;
    case "name":
      kv.set("hooks_name", a.trim());
      return;
    case "funnel":
      if (a === "funnel-disable") {
        host.terminal("Tailscale Funnel", control.funnelDisableCmd());
        host.disableFunnel();
      } else host.terminal("Tailscale Funnel", `${control.funnelEnableCmd(port)} && echo && echo 'Done. Press Check in Harbor.'`);
      break;
    case "funnel-check":
      void host.checkFunnel().then(() => host.changed());
      return;
    case "copy":
      host.copy(a);
      return;
    case "delete":
      host.deleteWebhook(Number(a));
      break;
    default:
      return;
  }
  host.changed();
}
