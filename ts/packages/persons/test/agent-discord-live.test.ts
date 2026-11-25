// The whole path an agent's Discord tool takes in the hub, against a stand-in Discord (Bun.serve: its HTTP API and a
// gateway WebSocket): Persons' service with a Stores Discord connection (the real client, a login given by a
// stand-in token store), AgentDiscord picking it, and the route `hub app discord` calls. Nothing reaches Discord.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDiscord } from "../src/agent/index.ts";
import { createDiscord } from "../src/conn/discord.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";
import { saveConnections } from "../src/store.ts";

const ME = "100000000000000001";
const ANA = "100000000000000002";
const DM = "200000000000000001";
const G = "300000000000000001";

type Ws = { send(s: string): void };
let server: ReturnType<typeof Bun.serve>;
const sockets: Ws[] = [];
const asked: { method: string; path: string; auth: string | null; body: unknown }[] = [];
let dir = "";
let service: PersonsService;
let routes: PersonsRoutes;
let agent: AgentDiscord;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      asked.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get("authorization"), body });
      const p = u.pathname.replace(/^\/api\/v9/, "");
      if (p === "/users/@me") return Response.json({ id: ME, username: "me" });
      if (p === "/gateway") return Response.json({ url: `ws://127.0.0.1:${server.port}` });
      if (p === `/channels/${DM}/messages` && req.method === "POST") return Response.json({ id: "500000000000000009", channel_id: DM, author: { id: ME, username: "me" }, content: (body as { content: string }).content });
      if (p === `/channels/${DM}/messages`) return Response.json([{ id: "500000000000000005", channel_id: DM, author: { id: ANA, username: "ana" }, content: "oi", timestamp: "2026-01-01T00:00:00.000Z" }]);
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
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "s",
                user: { id: ME, username: "me" },
                users: [{ id: ANA, username: "ana", global_name: "Ana" }],
                guilds: [{ id: G, properties: { name: "Guild" }, channels: [] }],
                private_channels: [{ id: DM, type: 1, recipient_ids: [ANA], last_message_id: "500000000000000005" }],
                relationships: [],
                read_state: { entries: [] },
              },
            }),
          );
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), "agent-live-"));
  saveConnections(dir, [{ id: "stores", kind: "discord", section: "stores" }]);
  service = new PersonsService({
    dir,
    factories: { discord: (ctx) => createDiscord(ctx, { origin: `http://127.0.0.1:${server.port}`, session: async (mode) => (mode === "token" ? { token: "test-token" } : { ok: true }) }) },
  });
  await service.start();
  agent = new AgentDiscord(service);
  routes = new PersonsRoutes(service, { agent });
  for (let i = 0; i < 200 && !(agent.info().status === "connected" && sockets.length > 0); i++) await Bun.sleep(10);
  await Bun.sleep(50);
});

afterAll(async () => {
  await service?.stop();
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const tool = async (name: string, args: unknown = {}) => {
  const r = await routes.route({ method: "POST", path: ["v1", "persons", "agent", "discord"], query: [], body: { tool: name, args, chat: 7 } });
  return r?.body as { json?: Record<string, unknown>; text?: string; error?: string };
};

it("the agents use the Stores connection, signed in through Persons", async () => {
  expect(agent.info()).toMatchObject({ connection: "stores", label: "Stores Discord", status: "connected", account: { id: ME, username: "me" } });
  const r = await routes.route({ method: "GET", path: ["v1", "persons", "agent", "discord"], query: [], body: null });
  expect(r?.body).toMatchObject({ connection: "stores", status: "connected" });
  expect(((await tool("discord_status")).text ?? "")).toContain("Signed in as me");
});

it("tools read the world READY gave and call Discord's API with the connection's login", async () => {
  expect((await tool("discord_dms")).json?.dms).toEqual([{ channelId: DM, kind: "dm", name: "Ana", recipients: [{ id: ANA, username: "ana", name: "Ana", nickname: null, bot: false }] }]);
  const sent = await tool("discord_send", { channelId: DM, content: "hello" });
  expect(sent.json).toMatchObject({ ok: true, messageId: "500000000000000009" });
  const post = asked.find((a) => a.method === "POST" && a.path === `/api/v9/channels/${DM}/messages`);
  expect(post?.auth).toBe("test-token");
  expect(post?.body).toMatchObject({ content: "hello", tts: false });
  expect((await tool("discord_nope")).error).toBe("No such tool: discord_nope");
});

it("waitForMessage hears the gateway's MESSAGE_CREATE", async () => {
  const waiting = tool("discord_waitForMessage", { channelId: DM, timeoutMs: 5000 });
  await Bun.sleep(20);
  for (const s of sockets) s.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "500000000000000010", channel_id: DM, author: { id: ANA, username: "ana", global_name: "Ana" }, content: "tudo bem?" } }));
  const r = await waiting;
  expect(r.json).toMatchObject({ done: true, timedOut: false, matches: [{ id: "500000000000000010", content: "tudo bem?", author: { name: "Ana" } }] });
});

it("a picked connection that's gone falls back to the default; signed out, the tools say how to sign in", async () => {
  expect(() => agent.pick("nope")).toThrow("No Discord connection");
  agent.pick("stores");
  expect(agent.view()?.id).toBe("stores");
  await service.conn("stores")?.disconnect();
  expect((await tool("discord_dms")).error).toContain("Sign in in Hub's Persons tab");
});
