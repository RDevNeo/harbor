// Personal › Add contact over the API (POST v1/persons/contacts): resolved on the platform through the connection that
// serves Personal (here the Stores Discord, shared), then saved in Personal and its chat shown; a handle that can't be
// resolved answers its reason and saves nothing. Stand-in connections: nothing goes to any platform.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnContext, Connection } from "../src/conn/types.ts";
import type { ChannelUser, ConnState } from "../src/model/types.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";

const T0 = "2026-11-20T10:00:00.000Z";
const ANA = "123456789012345678";
const dirs: string[] = [];
const services: PersonsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fake(ctx: ConnContext, users: ChannelUser[], connected: boolean): Connection {
  const state = (): ConnState => ({ status: connected ? "connected" : "signed-out", me: null, gateway: connected ? "up" : "down", error: connected ? null : "Paste your Instagram session to connect" });
  return {
    id: ctx.id,
    kind: ctx.kind,
    section: ctx.section,
    state,
    start: async () => ctx.emit({ type: "state", state: state() }),
    connect: async () => state(),
    disconnect: async () => state(),
    track: async () => ({}),
    lookup: async (q) => ({ matches: users.filter((u) => u.username === q.toLowerCase() || u.id === q) }),
    user: async () => null,
    history: async (peer) => ({ channelId: "dm", messages: [{ id: "m1", channelId: "dm", authorId: peer, fromMe: false, content: "oi", timestamp: "2026-11-25T09:00:00.000Z" }] }),
    send: async () => ({ ok: false, error: "never in tests" }),
    stop: async () => {},
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-personal-"));
  dirs.push(dir);
  writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }], people: [{ id: "px", name: "Xan", discordId: "999999999999999999", storeIds: [], listIds: ["spokpay"], createdAt: T0, updatedAt: T0 }] }));
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "stores", kind: "discord", section: "stores" }, { id: "spokpay", kind: "discord", section: "spokpay" }] }));
  const users = [{ id: ANA, username: "ana_s", globalName: "Ana S", avatar: null, avatarUrl: "" }, { id: "999999999999999999", username: "xan", globalName: null, avatar: null, avatarUrl: "" }];
  const s = new PersonsService({ dir, factories: { discord: (c) => fake(c, users, true), instagram: (c) => fake(c, [], false) } });
  services.push(s);
  await s.start();
  const r = new PersonsRoutes(s);
  const call = async (method: string, path: string, body: unknown = null, query: [string, string][] = []) => (await r.route({ method, path: ["v1", "persons", ...path.split("/")], query, body }))!;
  return { dir, s, call };
}

describe("Personal over the API", () => {
  it("is a section with the shared Stores Discord and its own Instagram (connections.json keeps both)", async () => {
    const { dir, call } = await setup();
    const st = (await call("GET", "state")).body as Record<string, any>;
    expect(st.lists.map((l: { id: string }) => l.id)).toEqual(["creators", "spokpay", "personal"]);
    const conns = st.connections.map((c: Record<string, unknown>) => [c.id, c.section, c.also]);
    expect(conns[0]).toEqual(["stores", "stores", ["personal"]]);
    expect(conns[1]).toEqual(["spokpay", "spokpay", []]);
    expect(conns[2][1]).toBe("personal");
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")).connections;
    expect(saved[0]).toEqual({ id: "stores", kind: "discord", section: "stores", also: ["personal"] });
    expect(saved[2].kind).toBe("instagram");
  });

  it("adds a Discord contact by username and shows their conversation in Personal", async () => {
    const { s, call } = await setup();
    const r = (await call("POST", "contacts", { kind: "discord", handle: "@Ana_S", name: "" })).body as Record<string, any>;
    expect(r.ok).toBe(true);
    expect(r.existed).toBe(false);
    const p = s.person(r.person.id)!;
    expect(p).toMatchObject({ discordId: ANA, discordUsername: "ana_s", displayName: "Ana S", listIds: ["personal"] });
    const chat = (await call("GET", `chat/${p.id}`, null, [["section", "personal"]])).body as Record<string, any>;
    expect(chat.account).toMatchObject({ conn: "stores", kind: "discord" });
    expect(chat.messages.map((m: { text: string }) => m.text)).toEqual(["oi"]);
    const st = (await call("GET", "state")).body as Record<string, any>;
    expect(st.people.find((x: { id: string }) => x.id === p.id).rows.personal).toBeTruthy();
  });

  it("someone already in Persons joins Personal instead of being added twice", async () => {
    const { s, call } = await setup();
    const r = (await call("POST", "contacts", { kind: "discord", handle: "xan" })).body as Record<string, any>;
    expect(r).toMatchObject({ ok: true, existed: true, joined: true, renamed: false, message: "Already in Persons as Xan: added to Personal" });
    expect(s.person("px")!.listIds).toEqual(["spokpay", "personal"]);
    expect(s.data!.people.length).toBe(1);
  });

  it("the same WhatsApp number in its other Brazilian form: found, renamed to the name typed, said so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-personal-wa-"));
    dirs.push(dir);
    // they're kept as WhatsApp answers (8 digits after the area code); the form gets the 9-digit mobile
    writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: [], people: [{ id: "pf", name: "Fagner", discordId: "", whatsapp: "557199616108", storeIds: [], listIds: ["personal"], createdAt: T0, updatedAt: T0 }] }));
    writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "wa1", kind: "whatsapp", section: "stores" }] }));
    const asked: string[] = [];
    const wa = (c: ConnContext): Connection => ({ ...fake(c, [], true), lookup: async (q: string) => (asked.push(q), { matches: [{ id: "557199616108", username: "+557199616108", globalName: "Fagner", avatar: null, avatarUrl: "" }] }) });
    const s = new PersonsService({ dir, factories: { whatsapp: wa, instagram: (c) => fake(c, [], false) } });
    services.push(s);
    await s.start();
    const r = new PersonsRoutes(s);
    const res = (await r.route({ method: "POST", path: ["v1", "persons", "contacts"], query: [], body: { kind: "whatsapp", handle: "55 (71) 9961-6108", name: "Filipe" } }))!.body as Record<string, any>;
    expect(asked).toEqual(["5571999616108"]);
    expect(res).toMatchObject({ ok: true, existed: true, joined: false, renamed: true, message: "Already in Personal as Fagner, now named Filipe" });
    expect(s.data!.people.map((p) => [p.id, p.name, p.listIds])).toEqual([["pf", "Filipe", ["personal"]]]);
  });

  it("can't resolve it: the reason, and nothing is saved", async () => {
    const { s, call } = await setup();
    const before = JSON.stringify(s.data!.people);
    const r1 = (await call("POST", "contacts", { kind: "discord", handle: "nobody_here" })).body as Record<string, any>;
    expect(r1).toEqual({ ok: false, error: "No Discord user @nobody_here found. Discord only finds people you share a server or a DM with." });
    const r2 = (await call("POST", "contacts", { kind: "instagram", handle: "ana.s" })).body as Record<string, any>;
    expect(r2).toEqual({ ok: false, error: "Instagram isn't connected: Paste your Instagram session to connect" });
    const r3 = (await call("POST", "contacts", { kind: "whatsapp", handle: "+55 11 91234-5678" })).body as Record<string, any>;
    expect(r3).toEqual({ ok: false, error: "No WhatsApp connection in Personal" });
    expect((await call("POST", "contacts", { kind: "gmail", handle: "a@b.c" })).status).toBe(400);
    expect(JSON.stringify(s.data!.people)).toBe(before);
  });
});
