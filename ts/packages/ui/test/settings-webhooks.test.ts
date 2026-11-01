import { expect, test } from "bun:test";
import type { hookcert } from "@harbor/mcp";
import type { Webhook } from "@harbor/store";
import { hookUrl, webhooksAct, webhooksData, type WebhooksHost, type WebhooksInput } from "../src/logic/settings-webhooks.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const NOW = 1_800_000_000;
const status = (over: Partial<hookcert.Status> = {}): hookcert.Status => ({ name: "", base: null, route: "", error: "", expires: 0, busy: false, ...over });
const hook = (id: number, over: Partial<Webhook> = {}): Webhook => ({ id, repoId: 1, name: "deploys", token: "tok", description: "", hits: 0, lastHit: 0, ...over });

function input(over: Partial<WebhooksInput> = {}): WebhooksInput {
  return { kv: new Kv(), status: status(), port: 47920, funnel: null, funnelStale: null, hasTailscale: false, hooks: [], repoName: () => "harbor", now: NOW, ...over };
}

test("webhooks starts private, with this PC's own address", () => {
  const d = webhooksData(input());
  expect([d.public, d.badge, d.badge_tone, d.status_title]).toEqual([false, "Not public", 2, "http://127.0.0.1:47920/hooks (this PC only)"]);
  expect(d.public_desc.endsWith("(port 47911): Harbor asks it to.")).toBe(true);
  expect([d.name, d.name_hint, d.cert, d.funnel_show, d.hooks]).toEqual(["", "203-0-113-7.sslip.io", "", false, []]);
});

test("webhooks shows a public address, or that Harbor is still getting one", () => {
  const kv = new Kv();
  kv.set("hooks_public", "1");
  const up = webhooksData(input({ kv, status: status({ base: "https://hooks.example.test/hooks", name: "hooks.example.test", expires: NOW + 30 * 86400 + 5 }) }));
  expect([up.public, up.badge, up.badge_tone, up.status_title, up.name_hint]).toEqual([true, "Public", 1, "https://hooks.example.test/hooks", "hooks.example.test"]);
  expect(up.cert).toBe("Certificate for hooks.example.test \u{b7} 30 days left \u{b7} renewed by itself");
  const busy = webhooksData(input({ kv, status: status({ busy: true, error: "no route", route: "UPnP" }) }));
  expect([busy.badge, busy.badge_tone, busy.status_title, busy.error, busy.status_desc]).toEqual(["Working", 0, "Opening port 443 and getting a certificate\u{2026}", "no route", "UPnP"]);
});

test("webhooks offers Tailscale Funnel only where Tailscale is, and says when it points elsewhere", () => {
  const on = webhooksData(input({ hasTailscale: true, funnel: "https://box.example.test/hooks" }));
  expect([on.funnel_show, on.funnel_badge, on.funnel_text, on.funnel_mono, on.funnel_action, on.funnel_action_text]).toEqual([true, "Funnel", "https://box.example.test/hooks", true, "funnel-disable", "Disable"]);
  const stale = webhooksData(input({ hasTailscale: true, funnelStale: 9000 }));
  expect([stale.funnel_tone, stale.funnel_text, stale.funnel_action, stale.funnel_action_text]).toEqual([
    2,
    "Funnel sends /hooks to 127.0.0.1:9000, not to Harbor's port 47920: another program there would get your webhooks.",
    "funnel-point",
    "Point Funnel here",
  ]);
  const off = webhooksData(input({ hasTailscale: true }));
  expect([off.funnel_badge, off.funnel_text, off.funnel_action_text]).toEqual(["", "Or with Tailscale Funnel (installed here): https://<machine>.<tailnet>.ts.net/hooks", "Enable Funnel"]);
});

test("webhooks lists each hook with its project, its URL and its calls", () => {
  const d = webhooksData(input({ hooks: [hook(1, { hits: 12, lastHit: NOW - 7200 }), hook(2, { name: "ci", token: "t2" })], repoName: (id) => (id === 1 ? "harbor" : "") }));
  expect(d.hooks).toEqual([
    { id: "1", name: "deploys  \u{b7}  harbor", url: "http://127.0.0.1:47920/hooks/tok", meta: "12 calls \u{b7} last 2h" },
    { id: "2", name: "ci  \u{b7}  harbor", url: "http://127.0.0.1:47920/hooks/t2", meta: "0 calls" },
  ]);
});

test("webhooks gives hooks the public address first, then Funnel's, then this PC's", () => {
  expect(hookUrl("tok", 47920, "https://a.example.test/hooks", "https://b.example.test/hooks")).toBe("https://a.example.test/hooks/tok");
  expect(hookUrl("tok", 47920, null, "https://b.example.test/hooks")).toBe("https://b.example.test/hooks/tok");
  expect(hookUrl("tok", 47920, null, null)).toBe("http://127.0.0.1:47920/hooks/tok");
});

function rig() {
  const calls: string[] = [];
  const host: WebhooksHost = {
    changed: () => calls.push("changed"),
    copy: (t) => calls.push(`copy ${t}`),
    terminal: (title, script) => calls.push(`terminal ${title}: ${script}`),
    deleteWebhook: (id) => calls.push(`delete ${id}`),
    checkFunnel: () => calls.push("checkFunnel"),
    disableFunnel: () => calls.push("disableFunnel"),
    kick: () => calls.push("kick"),
  };
  return { calls, host, kv: new Kv() };
}

test("webhooks writes the public switch and the name where the Rust app keeps them", () => {
  const r = rig();
  webhooksAct(r.kv, r.host, 47920, "public", "1");
  expect(r.kv.get("hooks_public")).toBe("1");
  webhooksAct(r.kv, r.host, 47920, "name", "  hooks.example.test ");
  expect(r.kv.get("hooks_name")).toBe("hooks.example.test");
  webhooksAct(r.kv, r.host, 47920, "public", "0");
  expect(r.kv.get("hooks_public")).toBe("0");
  expect(r.calls).toEqual(["kick", "changed", "kick", "changed"]);
});

test("webhooks runs Tailscale's commands in a terminal and deletes a hook by id", () => {
  const r = rig();
  webhooksAct(r.kv, r.host, 47920, "funnel", "funnel-enable");
  webhooksAct(r.kv, r.host, 47920, "funnel", "funnel-disable");
  webhooksAct(r.kv, r.host, 47920, "delete", "7");
  webhooksAct(r.kv, r.host, 47920, "copy", "http://127.0.0.1:47920/hooks/tok");
  webhooksAct(r.kv, r.host, 47920, "nope", "");
  expect(r.calls).toEqual([
    "terminal Tailscale Funnel: tailscale funnel --bg --set-path /hooks http://127.0.0.1:47920/hooks && echo && echo 'Done. Press Check in Harbor.'",
    "changed",
    "terminal Tailscale Funnel: tailscale funnel --set-path /hooks off",
    "disableFunnel",
    "changed",
    "delete 7",
    "changed",
    "copy http://127.0.0.1:47920/hooks/tok",
  ]);
});
