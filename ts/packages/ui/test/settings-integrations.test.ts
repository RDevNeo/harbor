import { discord } from "@harbor/mcp";
import { expect, test } from "bun:test";
import type { Tile } from "../src/applogos.ts";
import { type AppsApi, type AppsView, type Form, integrationsAct, integrationsData, type IntApp, type IntHost } from "../src/logic/settings-integrations.ts";

const pixel = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
const tile = (name: string): Tile => ({ kind: "initial", logo: pixel, glyph: "", glyph_color: "#000000", initial: name.slice(0, 1).toUpperCase() });

function view(over: Partial<AppsView> = {}): AppsView {
  return {
    pending: () => undefined,
    signedIn: () => false,
    account: () => undefined,
    error: () => undefined,
    googleBuiltin: () => false,
    googleClient: () => ({ id: "", secret: "" }),
    googleAccounts: () => [],
    discordLine: (about: string) => ({ text: about, tone: 0 }),
    whatsappLine: (about: string) => ({ text: about, tone: 0 }),
    locals: () => [
      { id: "discord", label: "Discord", found: false },
      { id: "playwright", label: "Playwright", found: true },
    ],
    isOff: (id) => id === "playwright",
    ...over,
  };
}

const find = (d: ReturnType<typeof integrationsData>, id: string): IntApp | undefined => d.rows.flatMap((r) => (r.has_right ? [r.left, r.right] : [r.left])).find((a) => a.id === id);
const data = (v: AppsView, forms: Map<string, Form> = new Map()) => integrationsData({ view: v, forms, tile, qr: () => pixel });

test("integrations lists every app two to a row, the last alone", () => {
  const d = data(view());
  expect(d.rows.map((r) => [r.left.id, r.has_right ? r.right.id : null])).toEqual([
    ["github", "vercel"],
    ["linear", "sentry"],
    ["supabase", "context7"],
    ["convex", "gmail"],
    ["discord", "whatsapp"],
  ]);
  expect(find(d, "github")).toMatchObject({ sub: "Repos, issues, PRs; gh and git push", action: "signin", action_text: "Sign in", action_primary: true, form: "" });
});

test("integrations shows a signed-in app with who it is and a Sign out button", () => {
  const d = data(view({ signedIn: (id) => id === "github", account: () => "someone" }));
  expect(find(d, "github")).toMatchObject({ sub: "Signed in as someone", action: "signout", action_primary: false });
  const named = data(view({ signedIn: (id) => id === "github" }));
  expect(find(named, "github")?.sub).toBe("Repos, issues, PRs; gh and git push");
});

test("integrations tells a sign-in going on from its code and its URL", () => {
  const noted = find(data(view({ pending: (id) => (id === "linear" ? { note: "Waiting for Linear" } : undefined) })), "linear");
  expect([noted?.sub, noted?.sub_tone, noted?.busy, noted?.action]).toEqual(["Waiting for Linear", 1, true, "cancel"]);
  const coded = find(data(view({ pending: (id) => (id === "github" ? { code: "ABCD-1234", url: "https://example.test/device" } : undefined) })), "github");
  expect(coded).toMatchObject({ sub: "Enter the code below in your browser", form: "pending", code: "ABCD-1234", has_url: true });
  const plain = find(data(view({ pending: (id) => (id === "vercel" ? {} : undefined) })), "vercel");
  expect([plain?.sub, plain?.form]).toEqual(["Finish in your browser\u{2026}", ""]);
});

test("integrations signs Google apps in with one click when Harbor has a client, and keeps a gear for your own", () => {
  const builtin = find(data(view({ googleBuiltin: () => true })), "gmail");
  expect(builtin).toMatchObject({ action: "google", action_text: "Sign in with Google", gear: true, builtin: true });
  const own = find(data(view({ googleBuiltin: () => true, googleClient: () => ({ id: "mine", secret: "s" }) })), "gmail");
  expect(own).toMatchObject({ action: "signin", gear: false });
  expect(find(data(view()), "gmail")).toMatchObject({ action: "signin", gear: false, builtin: false });
});

test("integrations lists a Google app's accounts, the first as the default when there are several", () => {
  const one = find(data(view({ signedIn: () => true, googleAccounts: () => ["a@example.test"] })), "gmail");
  expect([one?.action, one?.form, one?.accounts]).toEqual(["add", "accounts", [{ email: "a@example.test", default: true, label: "" }]]);
  const two = find(data(view({ signedIn: () => true, googleAccounts: () => ["a@example.test", "b@example.test"] })), "gmail");
  expect([two?.sub, two?.accounts.map((a) => a.label)]).toEqual(["2 accounts", ["Default", ""]]);
});

test("integrations opens the form each kind of sign-in needs", () => {
  const forms = new Map<string, Form>([
    ["context7", { kind: "key" }],
    ["discord", { kind: "discord" }],
    ["gmail", { kind: "google", clientId: "id", secret: "sec" }],
  ]);
  const d = data(view(), forms);
  expect([find(d, "context7")?.sub, find(d, "context7")?.form, find(d, "context7")?.action]).toEqual(["Paste an API key below", "key", "cancel-form"]);
  expect([find(d, "discord")?.sub, find(d, "discord")?.form]).toEqual(["Read this first", "discord"]);
  expect(find(d, "gmail")).toMatchObject({ sub: "Add your Google OAuth client below", form: "google", client_id: "id", client_secret: "sec" });
});

test("integrations shows Discord's login code, and its window button until the window is open", () => {
  const qr = (window: boolean) => find(data(view({ pending: (id) => (id === "discord" ? { qr: "https://example.test/login", window } : undefined) })), "discord");
  expect(qr(false)).toMatchObject({ form: "discord-qr", has_qr: true, window_btn: true });
  expect(qr(true)).toMatchObject({ window_btn: false });
});

test("integrations shows Discord's trouble in amber", () => {
  const d = find(data(view({ discordLine: () => ({ text: "Repairing the tools for a new Discord\u{2026}", tone: 2 }) })), "discord");
  expect([d?.sub, d?.sub_tone]).toEqual(["Repairing the tools for a new Discord\u{2026}", 2]);
});

test("the Discord card's line, which the phone shows too", () => {
  const about = "About";
  const base = { phase: "frozen", account: { id: "1", username: "ana", name: "Ana" }, attention: "", failing: [], repairing: false, signin: { active: false }, captcha: null };
  expect(discord.cardLine(base, about)).toEqual({ text: "Signed in as Ana", tone: 0 });
  expect(discord.cardLine({ ...base, phase: "ready" }, about).text).toBe("Signed in as Ana");
  expect(discord.cardLine({ ...base, account: null }, about)).toEqual({ text: "About", tone: 0 });
  expect(discord.cardLine({ ...base, failing: ["ReactionActions"] }, about)).toEqual({ text: "Signed in as Ana · Discord changed: some tools can't work", tone: 2 });
  expect(discord.cardLine({ ...base, attention: "Discord tools need attention" }, about)).toEqual({ text: "Discord tools need attention", tone: 2 });
  expect(discord.cardLine({ ...base, captcha: { guild: "G" } }, about)).toEqual({ text: "Signed in as Ana · A captcha waits for you", tone: 1 });
  expect(discord.cardLine({ ...base, signin: { active: true, note: "Scan with the Discord app" } }, about)).toEqual({ text: "Scan with the Discord app", tone: 1 });
});

test("integrations lists errors and the local servers with what a click does", () => {
  const d = data(view({ error: (id) => (id === "vercel" ? "the browser closed" : undefined) }));
  expect(d.errors).toEqual([{ id: "vercel", text: "Vercel: the browser closed" }]);
  expect(d.chips.map((c) => [c.id, c.found, c.off, c.tip])).toEqual([
    ["discord", false, false, "Not set up on this machine"],
    ["playwright", true, true, "Off for agents \u{b7} click to turn on"],
  ]);
});

function rig() {
  const calls: string[] = [];
  const api: AppsApi = {
    signIn: (id) => calls.push(`signIn ${id}`),
    signOut: (id) => calls.push(`signOut ${id}`),
    cancel: (id) => calls.push(`cancel ${id}`),
    dismiss: (id) => calls.push(`dismiss ${id}`),
    saveKey: (id, k) => calls.push(`saveKey ${id} ${k}`),
    saveGoogleClient: (id, c, s) => calls.push(`saveGoogleClient ${id} ${c} ${s}`),
    forgetGoogleClient: (id) => calls.push(`forget ${id}`),
    googleClient: () => ({ id: "saved", secret: "pw" }),
    googleDesktopClient: () => undefined,
    setGoogleDefault: (id, e) => calls.push(`default ${id} ${e}`),
    signOutAccount: (id, e) => calls.push(`signOutAccount ${id} ${e}`),
    toggleOff: (id) => calls.push(`toggleOff ${id}`),
    pendingUrl: () => "https://example.test/page",
  };
  const host: IntHost = { changed: () => calls.push("changed"), openUrl: (u) => calls.push(`open ${u}`), copy: (t) => calls.push(`copy ${t}`), discordWindow: () => calls.push("discordWindow") };
  const forms = new Map<string, Form>();
  return { calls, api, host, forms, act: (what: string, id: string, a = "", b = "") => integrationsAct(api, forms, host, what, id, a, b) };
}

test("integrations' Sign in opens a key form, Discord's warning or Google's client form, and signs the rest in at once", () => {
  const r = rig();
  r.act("signin", "context7");
  r.act("signin", "discord");
  r.act("signin", "gmail");
  r.act("signin", "github");
  expect(r.forms.get("context7")).toEqual({ kind: "key" });
  expect(r.forms.get("discord")).toEqual({ kind: "discord" });
  expect(r.forms.get("gmail")).toEqual({ kind: "google", clientId: "saved", secret: "pw" });
  expect(r.forms.has("github")).toBe(false);
  expect(r.calls.filter((c) => c.startsWith("signIn"))).toEqual(["signIn github"]);
});

test("integrations saves a key or a Google client, signs in, and closes the form", () => {
  const r = rig();
  r.forms.set("context7", { kind: "key" });
  r.act("save-key", "context7", "   ");
  expect(r.forms.has("context7")).toBe(true);
  r.act("save-key", "context7", "abc");
  expect(r.forms.has("context7")).toBe(false);
  r.forms.set("gmail", { kind: "google", clientId: "", secret: "" });
  r.act("save-google", "gmail", "cid", "sec");
  expect(r.calls).toContain("saveKey context7 abc");
  expect(r.calls.slice(-3)).toEqual(["saveGoogleClient gmail cid sec", "signIn gmail", "changed"]);
  expect(r.forms.has("gmail")).toBe(false);
});

test("integrations' Add account asks for a client only when there is none to sign in with", () => {
  const r = rig();
  r.act("add", "gmail");
  expect(r.forms.get("gmail")).toEqual({ kind: "google", clientId: "", secret: "" });
  expect(r.calls).not.toContain("signIn gmail");
  r.api.googleDesktopClient = () => ({ id: "c", secret: "s" });
  r.forms.clear();
  r.act("add", "gmail");
  expect(r.calls).toContain("signIn gmail");
});

test("integrations' remaining buttons reach mcp and the host", () => {
  const r = rig();
  r.act("discord-ok", "discord");
  r.act("make-default", "gmail", "b@example.test");
  r.act("signout-account", "gmail", "b@example.test");
  r.act("get-key", "context7");
  r.act("google-help", "gmail");
  r.act("open-page", "github");
  r.act("copy", "github", "ABCD");
  r.act("dismiss", "vercel");
  r.act("harbors", "gmail");
  r.act("nope", "gmail");
  expect(r.calls.filter((c) => c !== "changed")).toEqual([
    "signIn discord",
    "default gmail b@example.test",
    "signOutAccount gmail b@example.test",
    "open https://context7.com/dashboard",
    "open https://console.cloud.google.com/apis/credentials",
    "open https://example.test/page",
    "copy ABCD",
    "dismiss vercel",
    "forget gmail",
  ]);
});

test("WhatsApp's card is a sign-in row: Sign in goes straight to its QR; signed in, the number and Sign out", () => {
  const r = rig();
  expect(find(data(view()), "whatsapp")).toMatchObject({ action: "signin", action_text: "Sign in", action_primary: true, sub: "Read and send as you" });
  r.act("signin", "whatsapp");
  expect(r.calls).toContain("signIn whatsapp");
  expect(r.forms.has("whatsapp")).toBe(false);
  // Codes by number are gone: the card has no such button.
  r.calls.length = 0;
  r.act("whatsapp-code", "whatsapp", "+1 555 123 4567");
  expect(r.calls).toEqual([]);
  const ready = find(data(view({ pending: (id) => (id === "whatsapp" ? {} : undefined) })), "whatsapp");
  expect(ready).toMatchObject({ form: "", busy: true, sub: "Getting WhatsApp ready\u{2026}", action: "cancel" });
  const qr = find(data(view({ pending: (id) => (id === "whatsapp" ? { qr: "2@x", note: "Scan with WhatsApp" } : undefined) })), "whatsapp");
  expect(qr).toMatchObject({ form: "whatsapp-qr", has_qr: true, busy: false, sub: "Scan with WhatsApp", sub_tone: 1, window_btn: false, action: "cancel", action_text: "Cancel" });
  const linked = find(data(view({ signedIn: (id) => id === "whatsapp", whatsappLine: () => ({ text: "Signed in as +1 555 123 4567", tone: 0 }) })), "whatsapp");
  expect(linked).toMatchObject({ action: "signout", action_text: "Sign out", action_primary: false, sub: "Signed in as +1 555 123 4567", sub_tone: 0 });
  const offline = find(data(view({ signedIn: (id) => id === "whatsapp", whatsappLine: () => ({ text: "Offline, retrying · +1 555 123 4567", tone: 2 }) })), "whatsapp");
  expect(offline).toMatchObject({ action: "signout", sub_tone: 2 });
});
