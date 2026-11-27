// A person's new messages reach onIncoming (Hub's phone notifications, kind "person"): live ones only, once, with the
// section and chat the phone's Reply sends back through. Stand-in connections: nothing goes to any platform.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnContext, Connection } from "../src/conn/types.ts";
import type { ConnState, Message } from "../src/model/types.ts";
import { PersonsService, type Incoming } from "../src/service.ts";

const T0 = "2026-11-20T10:00:00.000Z";
const ANA = "123456789012345678";
const dirs: string[] = [];
const services: PersonsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 20));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-incoming-"));
  dirs.push(dir);
  writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [{ id: "s1", name: "Loja" }], lists: [], people: [{ id: "ana", name: "Ana Souza", discordId: ANA, storeIds: ["s1"], listIds: [], createdAt: T0, updatedAt: T0 }] }));
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "stores", kind: "discord", section: "stores" }] }));
  let emit: ConnContext["emit"] = () => {};
  const cached: Message = { id: "c1", channelId: "dm", authorId: ANA, fromMe: false, content: "cached", timestamp: new Date(Date.now() - 60_000).toISOString() };
  const fake = (ctx: ConnContext): Connection => {
    emit = ctx.emit;
    const state = (): ConnState => ({ status: "connected", me: null, gateway: "up" });
    return {
      id: ctx.id, kind: ctx.kind, section: ctx.section, state,
      start: async () => ctx.emit({ type: "state", state: state() }),
      connect: async () => state(), disconnect: async () => state(),
      track: async () => ({ [ANA]: { channelId: "dm", messages: [cached] } }),
      lookup: async () => ({ matches: [] }), user: async () => null,
      history: async () => ({ channelId: "dm", messages: [] }),
      send: async () => ({ ok: false, error: "never in tests" }), stop: async () => {},
    };
  };
  const s = new PersonsService({ dir, factories: { discord: fake } });
  services.push(s);
  const got: Incoming[] = [];
  s.onIncoming((m) => got.push(m));
  await s.start();
  await tick();
  return { s, got, emit: (msgs: Message[]) => emit({ type: "messages", peerId: ANA, messages: msgs }), cached };
}

const m = (id: string, o: Partial<Message> = {}): Message => ({ id, channelId: "dm", authorId: ANA, fromMe: false, content: `oi ${id}`, timestamp: new Date().toISOString(), ...o });

describe("incoming messages", () => {
  it("tells a live message from them once, not their history nor the user's own", async () => {
    const { got, emit, cached } = await setup();
    emit([cached]);
    emit([m("me1", { fromMe: true })]);
    emit([m("old", { timestamp: "2026-01-01T00:00:00.000Z" })]);
    expect(got).toEqual([]);
    emit([m("n1")]);
    emit([m("n1", { content: "edited", edited: true })]);
    expect(got.map((x) => [x.person.id, x.section, x.account, x.channel, x.lines.map((l) => l.text)])).toEqual([["ana", "stores", `stores:${ANA}`, "discord", ["oi n1"]]]);
  });
});
