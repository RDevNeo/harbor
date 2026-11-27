// Discord's captcha solved in Hub: a stand-in Discord (Bun.serve) answers a friend request and a DM with an hCaptcha
// challenge, then takes only the very same request again with the client's headers (X-Captcha-Key, X-Captcha-Rqtoken,
// X-Captcha-Session-Id). Through Persons' service and routes, as the desktop and the phone call them. Nothing reaches
// Discord; the "token" is a test string (Hub never solves a captcha itself).
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscord } from "../src/conn/discord.ts";
import { captchaHeaders, captchaOf } from "../src/conn/discord-core.ts";
import { CAPTCHA_PAGE_URL, captchaPage } from "../src/captchapage.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";

const ME = "100000000000000001";
const ANA = "100000000000000002"; // Add friend: captcha, a wrong answer, then the right one
const CAI = "100000000000000004"; // Add friend: captcha, given up
const DUDA = "100000000000000005"; // a DM: captcha on the message
const DM = "200000000000000005";
const SITEKEY = "a9b5fb07-92ff-493f-86fe-352a2803b3df";
const T0 = "2026-11-20T10:00:00.000Z";

type Hit = { method: string; path: string; body: unknown; h: Record<string, string | null> };
let server: ReturnType<typeof Bun.serve>;
const asked: Hit[] = [];
let rq = 0;
let dir = "";
let service: PersonsService;
let routes: PersonsRoutes;

/** Discord's captcha answer: a new rqtoken each time, one session id. */
const challenge = () => Response.json({ captcha_key: ["captcha-required"], captcha_sitekey: SITEKEY, captcha_service: "hcaptcha", captcha_rqdata: "RQDATA</script>", captcha_rqtoken: `rq${++rq}`, captcha_session_id: "sess-1" }, { status: 400 });
/** Taken only with the token "good" and the newest rqtoken and the session id. */
const solved = (req: Request) => req.headers.get("x-captcha-key") === "good" && req.headers.get("x-captcha-rqtoken") === `rq${rq}` && req.headers.get("x-captcha-session-id") === "sess-1";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      const h = Object.fromEntries(["x-captcha-key", "x-captcha-rqtoken", "x-captcha-session-id", "x-context-properties"].map((k) => [k, req.headers.get(k)]));
      asked.push({ method: req.method, path: u.pathname.replace(/^\/api\/v9/, ""), body, h });
      const p = u.pathname.replace(/^\/api\/v9/, "");
      if (p === "/users/@me") return Response.json({ id: ME, username: "me" });
      if (p === "/gateway") return Response.json({ url: `ws://127.0.0.1:${server.port}` });
      if (p === "/users/@me/channels") return Response.json({ id: DM, type: 1 });
      if (p === `/channels/${DM}/messages` && req.method === "POST") {
        if (!solved(req)) return challenge();
        const b = body as { content: string; nonce: string };
        return Response.json({ id: "300000000000000001", channel_id: DM, content: b.content, nonce: b.nonce, author: { id: ME, username: "me" }, timestamp: new Date().toISOString(), attachments: [], embeds: [], type: 0 });
      }
      if (p.startsWith("/users/@me/relationships/") && req.method === "PUT") return solved(req) ? new Response(null, { status: 204 }) : challenge();
      return Response.json({ message: "Unknown", code: 0 }, { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      },
      message(ws, m) {
        const x = JSON.parse(String(m)) as { op: number };
        if (x.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s", user: { id: ME, username: "me" }, users: [], guilds: [], private_channels: [], relationships: [], read_state: { entries: [] } } }));
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), "persons-captcha-"));
  const person = (x: Record<string, unknown>) => ({ name: "", discordId: "", storeIds: ["s1"], listIds: [], createdAt: T0, updatedAt: T0, ...x });
  writeFileSync(
    join(dir, "data.json"),
    JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [{ id: "s1", name: "Loja", ownerId: "pa" }], lists: [], people: [person({ id: "pa", name: "Ana", discordId: ANA }), person({ id: "pc", name: "Cai", discordId: CAI }), person({ id: "pd", name: "Duda", discordId: DUDA })] }),
  );
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "stores", kind: "discord", section: "stores" }] }));
  service = new PersonsService({
    dir,
    factories: { discord: (ctx) => createDiscord(ctx, { origin: `http://127.0.0.1:${server.port}`, session: async (mode) => (mode === "token" ? { token: "test-token" } : { ok: true }) }) },
  });
  await service.start();
  routes = new PersonsRoutes(service, {});
  for (let i = 0; i < 300 && !service.view("stores")?.connected; i++) await Bun.sleep(10);
});

afterAll(async () => {
  await service?.stop();
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string[], body: unknown = null) =>
  (await routes.route({ method, path: ["v1", "persons", ...path], query: [["section", "stores"]], body }))!.body as Record<string, any>;
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await f()); i++) await Bun.sleep(20);
};

it("reads Discord's captcha answer and the headers its client retries with", () => {
  expect(captchaOf({ captcha_key: ["captcha-required"], captcha_sitekey: "k", captcha_service: "hcaptcha", captcha_rqdata: "d", captcha_rqtoken: "t", captcha_session_id: "s" })).toEqual({ sitekey: "k", service: "hcaptcha", rqdata: "d", rqtoken: "t", sessionId: "s" });
  expect(captchaOf({ captcha_key: ["x"], captcha_sitekey: "k" })).toMatchObject({ service: "hcaptcha", rqdata: null, rqtoken: null, sessionId: null });
  expect(captchaOf({ captcha_key: ["x"] })).toBeNull(); // no sitekey: nothing to show
  expect(captchaOf({ captcha_key: ["x"], captcha_sitekey: "k", captcha_service: "recaptcha" })).toBeNull();
  expect(captchaOf({ message: "nope", code: 50007 })).toBeNull();
  expect(captchaHeaders({ sitekey: "k", service: "hcaptcha", rqdata: null, rqtoken: "t", sessionId: "s" }, "tok")).toEqual({ "X-Captcha-Key": "tok", "X-Captcha-Rqtoken": "t", "X-Captcha-Session-Id": "s" });
  expect(captchaHeaders({ sitekey: "k", service: "hcaptcha", rqdata: null, rqtoken: null, sessionId: null }, "tok")).toEqual({ "X-Captcha-Key": "tok" });
});

it("the page draws hCaptcha with Discord's sitekey and rqdata, nothing able to close its script", () => {
  const html = captchaPage({ sitekey: SITEKEY, rqdata: "a</script><b>" });
  expect(html).toContain(SITEKEY);
  expect(html).toContain("js.hcaptcha.com/1/api.js");
  expect(html).toContain("setData");
  expect(html).not.toContain("a</script>");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(CAPTCHA_PAGE_URL.startsWith("https://discord.com/")).toBe(true);
});

it("Add friend: the captcha comes back at once; a wrong answer asks again; the right one sends the same request with the client's headers", async () => {
  const r = await call("POST", ["chat", "pa", "friend"], { section: "stores" });
  expect(r).toMatchObject({ ok: false, captcha: { what: "friend", sitekey: SITEKEY, rqdata: "RQDATA</script>", url: CAPTCHA_PAGE_URL, account: `stores:${ANA}` } });
  expect(r.captcha.html).toContain(SITEKEY);
  // the chat shows it too (the phone and the desktop find it there)
  expect((await call("GET", ["chat", "pa"])).captcha).toMatchObject({ id: r.captcha.id, what: "friend" });
  const puts = () => asked.filter((a) => a.method === "PUT" && a.path.endsWith(ANA));
  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.h["x-captcha-key"]).toBeNull();

  const wrong = await call("POST", ["chat", "pa", "captcha"], { section: "stores", account: r.captcha.account, id: r.captcha.id, key: "bad" });
  expect(wrong).toMatchObject({ ok: false, captcha: { what: "friend", sitekey: SITEKEY } });
  expect(wrong.captcha.id).not.toBe(r.captcha.id);
  expect(puts()).toHaveLength(2);

  const right = await call("POST", ["chat", "pa", "captcha"], { section: "stores", account: wrong.captcha.account, id: wrong.captcha.id, key: "good" });
  expect(right).toEqual({ ok: true });
  expect(puts()).toHaveLength(3);
  const last = puts()[2]!;
  expect(last.h).toMatchObject({ "x-captcha-key": "good", "x-captcha-rqtoken": "rq2", "x-captcha-session-id": "sess-1" });
  // the same request otherwise: body and the profile's context
  expect(last.body).toEqual(puts()[0]!.body);
  expect(last.h["x-context-properties"]).toBe(puts()[0]!.h["x-context-properties"]);
  const chat = await call("GET", ["chat", "pa"]);
  expect(chat.captcha).toBeNull();
  expect(chat.relation).toBe("sent");
  // an answer to a captcha that waits no more
  expect(await call("POST", ["chat", "pa", "captcha"], { section: "stores", id: wrong.captcha.id, key: "good" })).toMatchObject({ ok: false });
}, 30_000);

it("Add friend given up: the captcha goes, nothing more is sent", async () => {
  const r = await call("POST", ["chat", "pc", "friend"], { section: "stores" });
  expect(r.captcha?.what).toBe("friend");
  expect(await call("POST", ["chat", "pc", "captcha"], { section: "stores", id: r.captcha.id, cancel: true })).toEqual({ ok: true });
  await until(async () => (await call("GET", ["chat", "pc"])).captcha === null);
  expect((await call("GET", ["chat", "pc"])).captcha).toBeNull();
  expect((await call("GET", ["chat", "pc"])).relation).toBe("none");
  expect(asked.filter((a) => a.method === "PUT" && a.path.endsWith(CAI))).toHaveLength(1);
  // no answer, no key: refused
  expect((await routes.route({ method: "POST", path: ["v1", "persons", "chat", "pc", "captcha"], query: [], body: { section: "stores", id: "x" } }))!.status).toBe(400);
}, 30_000);

it("a DM Discord gates behind a captcha waits as sending, then goes with the same nonce once solved", async () => {
  const r = await call("POST", ["chat", "pd", "send"], { section: "stores", text: "oi" });
  expect(r).toMatchObject({ ok: false, captcha: { what: "message", sitekey: SITEKEY } });
  const chat = await call("GET", ["chat", "pd"]);
  expect(chat.outgoing).toMatchObject([{ status: "sending", text: "oi" }]);
  expect(chat.captcha?.id).toBe(r.captcha.id);
  expect(await call("POST", ["chat", "pd", "captcha"], { section: "stores", id: r.captcha.id, key: "good" })).toEqual({ ok: true });
  const posts = asked.filter((a) => a.method === "POST" && a.path === `/channels/${DM}/messages`);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
  expect(posts[1]!.h).toMatchObject({ "x-captcha-key": "good", "x-captcha-session-id": "sess-1" });
  await until(async () => ((await call("GET", ["chat", "pd"])).outgoing ?? []).length === 0);
  const after = await call("GET", ["chat", "pd"]);
  expect(after.outgoing).toEqual([]);
  expect(after.captcha).toBeNull();
  expect(after.messages.map((m: { text?: string }) => m.text)).toContain("oi");
}, 30_000);
