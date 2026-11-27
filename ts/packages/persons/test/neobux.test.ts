// Neobux (the user's own Robux store): a section like Creators, between SpokPay and Personal. It talks through Creators'
// connections until it connects its own; data.json gets the list once. Stand-in connections in a temp dir: nothing is
// sent anywhere and the user's data is never read.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnContext, Connection } from "../src/conn/types.ts";
import { channelsFor, SECTION_LABEL, SECTIONS, serves, type ConnMeta } from "../src/model/accounts.ts";
import { normalizeData } from "../src/model/data.ts";
import { movePerson, parsePlace, placesOf } from "../src/model/move.ts";
import { neobuxShares } from "../src/model/neobux.ts";
import { personalShares } from "../src/model/personal.ts";
import type { ConnState, Person } from "../src/model/types.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";

const T0 = "2026-11-27T10:00:00.000Z";
const person = (x: Partial<Person>): Person => ({ id: "p1", name: "Ana", discordId: "", storeIds: [], listIds: [], createdAt: T0, updatedAt: T0, ...x });

// as on the user's PC: two Creators Gmails, a Creators WhatsApp and Discord, the Stores ones shared with Personal
const CONNS: ConnMeta[] = [
  { id: "stores", kind: "discord", section: "stores", also: ["personal"] },
  { id: "spokpay", kind: "discord", section: "spokpay" },
  { id: "creators-gmail-1", kind: "gmail", section: "creators" },
  { id: "creators-whatsapp-1", kind: "whatsapp", section: "creators" },
  { id: "creators-discord-1", kind: "discord", section: "creators" },
  { id: "stores-whatsapp-1", kind: "whatsapp", section: "stores", also: ["personal"] },
  { id: "personal-instagram-1", kind: "instagram", section: "personal" },
  { id: "creators-gmail-2", kind: "gmail", section: "creators" },
];
const servingNeobux = (l: ConnMeta[]) => l.filter((c) => serves(c, "neobux")).map((c) => c.id);

describe("neobuxShares", () => {
  it("every Creators connection serves Neobux too; nothing else changes", () => {
    const out = neobuxShares(CONNS);
    expect(servingNeobux(out)).toEqual(["creators-gmail-1", "creators-whatsapp-1", "creators-discord-1", "creators-gmail-2"]);
    expect(out.find((c) => c.id === "stores")!.also).toEqual(["personal"]);
    expect(out.find((c) => c.id === "spokpay")!.also).toBeUndefined();
    expect(out.find((c) => c.id === "personal-instagram-1")!.also).toBeUndefined();
    expect(CONNS.find((c) => c.id === "creators-gmail-1")!.also).toBeUndefined(); // the input is left alone
  });

  it("once in place nothing changes (same array), with Personal's shares too", () => {
    const once = neobuxShares(personalShares(CONNS, "ig"));
    expect(neobuxShares(once)).toBe(once);
    expect(neobuxShares(personalShares(once, "ig2"))).toBe(once);
  });

  it("Neobux's own login takes its kind over; removing it gives the kind back to Creators'", () => {
    const shared = neobuxShares(CONNS);
    const own = neobuxShares([...shared, { id: "neobux-gmail-1", kind: "gmail", section: "neobux" }]);
    expect(servingNeobux(own)).toEqual(["creators-whatsapp-1", "creators-discord-1", "neobux-gmail-1"]);
    expect(own.find((c) => c.id === "creators-gmail-1")).toEqual({ id: "creators-gmail-1", kind: "gmail", section: "creators" });
    const back = neobuxShares(own.filter((c) => c.id !== "neobux-gmail-1"));
    expect(servingNeobux(back)).toEqual(servingNeobux(shared));
  });

  it("a share set by hand (another section's login) is kept", () => {
    const hand: ConnMeta[] = [{ id: "spokpay", kind: "discord", section: "spokpay", also: ["neobux"] }, { id: "creators-discord-1", kind: "discord", section: "creators" }];
    expect(neobuxShares(hand)).toBe(hand);
  });

  it("a Neobux chat goes through Creators' Gmail", () => {
    const p = person({ email: "ana@x.com", listIds: ["neobux"] });
    expect(channelsFor(p, neobuxShares(CONNS), "neobux").map((c) => c.id)).toEqual(["creators-gmail-1", "creators-gmail-2"]);
  });
});

describe("the Neobux list", () => {
  it("is a section, labelled Neobux, between SpokPay and Personal", () => {
    expect(SECTIONS).toEqual(["stores", "creators", "spokpay", "neobux", "personal"]);
    expect(SECTION_LABEL.neobux).toBe("Neobux");
  });

  it("is added to data.json once, before Personal, talking through Creators' account", () => {
    const d = normalizeData({ version: 7, lists: [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }, { id: "personal", name: "Personal", accountId: "personal" }], people: [] });
    expect(d.lists).toEqual([
      { id: "creators", name: "Creators", accountId: "gmail" },
      { id: "spokpay", name: "SpokPay", accountId: "spokpay" },
      { id: "neobux", name: "Neobux", accountId: "gmail" },
      { id: "personal", name: "Personal", accountId: "personal" },
    ]);
    expect(normalizeData(d).lists).toEqual(d.lists);
    // a renamed or moved one is kept as the user has it
    const moved = normalizeData({ ...d, lists: [d.lists[2]!, d.lists[0]!, d.lists[1]!, d.lists[3]!].map((l) => (l.id === "neobux" ? { ...l, name: "Neobux Store" } : l)) });
    expect(moved.lists.map((l) => `${l.id}:${l.name}`)).toEqual(["neobux:Neobux Store", "creators:Creators", "spokpay:SpokPay", "personal:Personal"]);
  });

  it("keeps people, Settled and identities in Neobux", () => {
    const d = normalizeData({ version: 7, people: [{ id: "p1", name: "Ana", discordId: "", email: "ana@x.com", listIds: ["neobux"], storeIds: [], settled: { neobux: T0 }, identities: [{ kind: "gmail", value: "ana@neo.com", section: "neobux" }] }] });
    expect(d.people[0]).toMatchObject({ listIds: ["neobux"], settled: { neobux: T0 }, identities: [{ kind: "gmail", value: "ana@neo.com", section: "neobux" }] });
  });

  it("is a place for Move to…", () => {
    expect(parsePlace("neobux")).toEqual({ section: "neobux" });
    expect(placesOf(person({ listIds: ["creators", "neobux"] }), { stores: [] })).toEqual([{ section: "creators" }, { section: "neobux" }]);
    const d = normalizeData({ version: 7, people: [person({ email: "ana@x.com", listIds: ["creators"] })] });
    const r = movePerson(d, "p1", { section: "creators" }, { section: "neobux" }, T0)!;
    expect(r.left).toEqual(["creators"]);
    expect(r.data.people[0]!.listIds).toEqual(["neobux"]);
  });
});

// ---------- over the API, in a temp dir ----------

const dirs: string[] = [];
const services: PersonsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fake(ctx: ConnContext): Connection {
  const state = (): ConnState => ({ status: "signed-out", me: null, gateway: "down", error: null });
  return {
    id: ctx.id,
    kind: ctx.kind,
    section: ctx.section,
    state,
    start: async () => ctx.emit({ type: "state", state: state() }),
    connect: async () => state(),
    disconnect: async () => state(),
    track: async () => ({}),
    lookup: async () => ({ matches: [] }),
    user: async () => null,
    history: async () => ({ channelId: null, messages: [] }),
    send: async () => ({ ok: false, error: "never in tests" }),
    stop: async () => {},
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-neobux-"));
  dirs.push(dir);
  writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }, { id: "personal", name: "Personal", accountId: "personal" }], people: [] }));
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "stores", kind: "discord", section: "stores", also: ["personal"] }, { id: "creators-gmail-1", kind: "gmail", section: "creators" }, { id: "personal-instagram-1", kind: "instagram", section: "personal" }] }));
  const f = (c: ConnContext) => fake(c);
  const s = new PersonsService({ dir, factories: { discord: f, gmail: f, whatsapp: f, instagram: f } });
  services.push(s);
  await s.start();
  const r = new PersonsRoutes(s);
  const call = async (method: string, path: string, body: unknown = null, query: [string, string][] = []) => (await r.route({ method, path: ["v1", "persons", ...path.split("/")], query, body }))!;
  return { dir, s, call };
}

describe("Neobux over the API", () => {
  it("is in the state with the Creators Gmail shared; its own Gmail takes over, and leaving gives it back", async () => {
    const { dir, call } = await setup();
    const st = (await call("GET", "state")).body as Record<string, any>;
    expect(st.lists.map((l: { id: string }) => l.id)).toEqual(["creators", "spokpay", "neobux", "personal"]);
    expect(st.connections.find((c: { id: string }) => c.id === "creators-gmail-1").also).toEqual(["neobux"]);
    const saved = () => JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")).connections as ConnMeta[];
    expect(saved().find((c) => c.id === "creators-gmail-1")).toEqual({ id: "creators-gmail-1", kind: "gmail", section: "creators", also: ["neobux"] });

    const added = (await call("POST", "connections", { section: "neobux", kind: "gmail" })).body as Record<string, any>;
    expect(String(added.id)).toMatch(/^neobux-gmail-/);
    expect(saved().find((c) => c.id === "creators-gmail-1")!.also).toBeUndefined();
    expect(servingNeobux(saved())).toEqual([String(added.id)]);

    await call("DELETE", `connections/${added.id}`);
    expect(servingNeobux(saved())).toEqual(["creators-gmail-1"]);
  });

  it("Add to Neobux by email puts the person in Neobux", async () => {
    const { s, call } = await setup();
    const r = (await call("POST", "contacts", { kind: "gmail", handle: "Ana@X.com", name: "Ana", section: "neobux" })).body as Record<string, any>;
    expect(r.ok).toBe(true);
    expect(s.person(r.person.id)).toMatchObject({ email: "ana@x.com", listIds: ["neobux"] });
  });
});
