// A Discord chat's Add friend and a DM Discord refuses (50007), against a stand-in Discord (Bun.serve: its HTTP API
// and a gateway WebSocket) through Persons' service and routes. Nothing reaches Discord.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscord } from "../src/conn/discord.ts";
import { relationOf, SEND_ERRORS } from "../src/conn/discord-core.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";
import { friendButton } from "../../ui/src/tabs/persons/view.ts";

const ME = "100000000000000001";
const SPEC = "507955008076251161"; // a stranger: no shared server, not a friend
const BEA = "100000000000000003"; // a friend
const T0 = "2026-11-20T10:00:00.000Z";

type Ws = { send(s: string): void };
let server: ReturnType<typeof Bun.serve>;
const sockets: Ws[] = [];
const asked: { method: string; path: string; body: unknown; context: string | null }[] = [];
let dir = "";
let service: PersonsService;
let routes: PersonsRoutes;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      asked.push({ method: req.method, path: u.pathname, body, context: req.headers.get("x-context-properties") });
      const p = u.pathname.replace(/^\/api\/v9/, "");
      if (p === "/users/@me") return Response.json({ id: ME, username: "me" });
      if (p === "/gateway") return Response.json({ url: `ws://127.0.0.1:${server.port}` });
      if (p === "/users/@me/channels") return Response.json({ id: "200000000000000009", type: 1 });
      if (p === "/channels/200000000000000009/messages" && req.method === "POST") return Response.json({ message: "Cannot send messages to this user", code: 50007 }, { status: 403 });
      if (p === `/users/@me/relationships/${SPEC}` && req.method === "PUT") return new Response(null, { status: 204 });
      return Response.json({ message: "Unknown", code: 0 }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      },
      message(ws, m) {
        const x = JSON.parse(String(m)) as { op: number };
        if (x.op === 2)
          ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s", user: { id: ME, username: "me" }, users: [], guilds: [], private_channels: [], relationships: [{ id: BEA, type: 1, user: { id: BEA, username: "bea" } }], read_state: { entries: [] } } }));
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), "persons-friend-"));
  const person = (x: Record<string, unknown>) => ({ name: "", discordId: "", storeIds: ["s1"], listIds: [], createdAt: T0, updatedAt: T0, ...x });
  writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [{ id: "s1", name: "Loja", ownerId: "ps" }], lists: [], people: [person({ id: "ps", name: "Spectrier", discordId: SPEC }), person({ id: "pb", name: "Bea", discordId: BEA })] }));
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "stores", kind: "discord", section: "stores" }] }));
  service = new PersonsService({
    dir,
    factories: { discord: (ctx) => createDiscord(ctx, { origin: `http://127.0.0.1:${server.port}`, session: async (mode) => (mode === "token" ? { token: "test-token" } : { ok: true }) }) },
  });
  await service.start();
  routes = new PersonsRoutes(service, {});
  for (let i = 0; i < 300 && !(service.view("stores")?.connected && sockets.length > 0 && Object.keys(service.view("stores")?.relations ?? {}).length > 0); i++) await Bun.sleep(10);
});

afterAll(async () => {
  await service?.stop();
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string[], body: unknown = null) =>
  (await routes.route({ method, path: ["v1", "persons", ...path], query: [["section", "stores"]], body }))!.body as Record<string, any>;

it("maps Discord's relationship types, and the header's button from them", () => {
  expect([1, 2, 3, 4, 5, undefined].map(relationOf)).toEqual(["friend", "blocked", "incoming", "sent", null, null]);
  expect(friendButton(null, false)).toBe(""); // Gmail, WhatsApp, signed out
  expect(friendButton("friend", false)).toBe("");
  expect(friendButton("blocked", false)).toBe("");
  expect(friendButton("none", false)).toBe("add");
  expect(friendButton("none", true)).toBe("sending");
  expect(friendButton("incoming", false)).toBe("accept");
  expect(friendButton("sent", true)).toBe("sent");
});

it("a Discord chat says where the account stands with them", async () => {
  expect((await call("GET", ["chat", "pb"])).relation).toBe("friend");
  expect((await call("GET", ["chat", "ps"])).relation).toBe("none");
});

it("a DM Discord refuses (50007) fails with the reason, kept for click to retry", async () => {
  const r = await call("POST", ["chat", "ps", "send"], { section: "stores", text: "oi" });
  expect(r).toMatchObject({ ok: false, error: SEND_ERRORS[50007] });
  expect(SEND_ERRORS[50007]).toContain("Add friend first");
  const chat = await call("GET", ["chat", "ps"]);
  expect(chat.outgoing).toMatchObject([{ status: "failed", error: SEND_ERRORS[50007] }]);
});

it("Add friend sends the client's friend request once; the chat then says Request sent", async () => {
  const r = await call("POST", ["chat", "ps", "friend"], { section: "stores" });
  expect(r).toEqual({ ok: true, relation: "sent" });
  const puts = asked.filter((a) => a.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ path: `/api/v9/users/@me/relationships/${SPEC}`, body: {} });
  expect(JSON.parse(atob(puts[0]!.context ?? ""))).toEqual({ location: "User Profile" });
  expect((await call("GET", ["chat", "ps"])).relation).toBe("sent");
  // a second click asks Discord nothing
  expect(await call("POST", ["chat", "ps", "friend"], { section: "stores" })).toEqual({ ok: true, relation: "sent" });
  expect(asked.filter((a) => a.method === "PUT")).toHaveLength(1);
});

it("the gateway's relationship events move it: accepted = friends, removed = none", async () => {
  for (const s of sockets) s.send(JSON.stringify({ op: 0, s: 2, t: "RELATIONSHIP_UPDATE", d: { id: SPEC, type: 1 } }));
  for (let i = 0; i < 100 && (await call("GET", ["chat", "ps"])).relation !== "friend"; i++) await Bun.sleep(10);
  expect((await call("GET", ["chat", "ps"])).relation).toBe("friend");
  for (const s of sockets) s.send(JSON.stringify({ op: 0, s: 3, t: "RELATIONSHIP_REMOVE", d: { id: SPEC, type: 1 } }));
  for (let i = 0; i < 100 && (await call("GET", ["chat", "ps"])).relation !== "none"; i++) await Bun.sleep(10);
  expect((await call("GET", ["chat", "ps"])).relation).toBe("none");
});
