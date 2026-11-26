// A chat's past when it opens: read once per run (the open chat reloads on every change, and an empty page used to
// bump `rev` and loop), and WhatsApp's from Hub's own WhatsApp store (the agents' app) when it is the same account, with
// older pages from it too. Stand-ins only: no engine, no network.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnContext, Connection } from "../src/conn/types.ts";
import { createWhatsapp } from "../src/conn/whatsapp.ts";
import type { WaEngine } from "../src/conn/whatsapp-engine.ts";
import type { ConnState, Conversation } from "../src/model/types.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";

const ME = "5511912340000";
const ANA = "5511912345678";
const T0 = "2026-11-20T10:00:00.000Z";
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Hub's data folder with the agents' WhatsApp store: `n` text messages with Ana, one a minute, for account `account`. */
function hubWithStore(n: number, account = ME, phone = ANA): string {
  const hub = mkdtempSync(join(tmpdir(), "hub-history-"));
  dirs.push(hub);
  mkdirSync(join(hub, "persons"));
  const wdir = join(hub, "apps", "whatsapp");
  mkdirSync(wdir, { recursive: true });
  writeFileSync(join(wdir, "linked.json"), JSON.stringify({ jid: `${account}:7@s.whatsapp.net`, name: "Igor", at: 1 }));
  const db = new Database(join(wdir, "wa.db"));
  db.run("CREATE TABLE messages (chat TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', media TEXT, quoted_id TEXT, quoted_text TEXT, deleted INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, reactions TEXT, raw TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat, id))");
  db.run("CREATE TABLE lids (lid TEXT PRIMARY KEY, pn TEXT NOT NULL)");
  db.run("CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0)");
  db.run("INSERT INTO lids VALUES ('999@lid', ?)", [`${phone}@s.whatsapp.net`]);
  const base = Date.parse(T0) / 1000;
  for (let i = 0; i < n; i++) {
    // the oldest few under her lid, as the store may keep them
    const chat = i < 3 ? "999@lid" : `${phone}@s.whatsapp.net`;
    const raw = { key: { remoteJid: chat, remoteJidAlt: `${phone}@s.whatsapp.net`, fromMe: i % 2 === 1, id: `H${i}` }, messageTimestamp: base + i * 60, message: { conversation: `m${i}` } };
    db.run("INSERT INTO messages (chat, id, from_me, sender, ts, kind, text, raw) VALUES (?, ?, ?, ?, ?, 'text', ?, ?)", [chat, `H${i}`, i % 2, chat, base + i * 60, `m${i}`, JSON.stringify(raw)]);
  }
  db.close();
  return hub;
}

class Engine implements WaEngine {
  onEvent: (ev: string, data: unknown) => void = () => {};
  constructor(readonly authDir: string) {}
  async start(onEvent: (ev: string, data: unknown) => void): Promise<void> {
    this.onEvent = onEvent;
  }
  running(): boolean {
    return true;
  }
  async request(): Promise<Record<string, unknown>> {
    return {};
  }
  async stop(): Promise<void> {}
}

async function linked(hub: string): Promise<Connection> {
  const dir = join(hub, "persons");
  mkdirSync(join(dir, "whatsapp-wa1", "auth"), { recursive: true });
  writeFileSync(join(dir, "whatsapp-wa1", "auth", "creds.json"), JSON.stringify({ me: { id: `${ME}:3@s.whatsapp.net` } }));
  let eng: Engine | undefined;
  const c = createWhatsapp({ id: "wa1", kind: "whatsapp", section: "stores", also: ["personal"], dir, emit: () => {}, log: () => {}, openExternal: () => {} } satisfies ConnContext, {
    engine: (o) => (eng = new Engine(o.authDir)),
  });
  closers.push(() => c.stop());
  await c.start();
  for (let i = 0; i < 5 && !eng; i++) await Bun.sleep(1);
  eng?.onEvent("open", { id: `${ME}:3@s.whatsapp.net`, name: "Igor" });
  await c.track([ANA]);
  return c;
}

describe("WhatsApp history from Hub's own WhatsApp store", () => {
  it("the newest 50, then the page before, lid chats included, oldest first", async () => {
    const c = await linked(hubWithStore(60));
    expect(c.state().status).toBe("connected");
    const first = await c.history(ANA);
    expect(first.messages.length).toBe(50);
    expect(first.messages[0]!.content).toBe("m10");
    expect(first.messages.at(-1)).toMatchObject({ id: "H59", content: "m59", fromMe: true });
    const older = await c.history(ANA, "H10");
    expect(older.messages.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
    expect(await c.history(ANA, "H0")).toEqual({ channelId: `${ANA}@s.whatsapp.net`, messages: [] });
  });

  it("a chat the store keeps under the number's other Brazilian form is the same chat; Add contact's check finds it too", async () => {
    // the store has him as WhatsApp answered (no 9th digit: 55 71 9961-6108); Persons asks with the 9-digit mobile
    const c = await linked(hubWithStore(5, ME, "557199616108"));
    expect((await c.history("5571999616108")).messages.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    // WhatsApp's on_whatsapp answered nothing (the stand-in engine): the store's form counts
    expect((await c.lookup("55 (71) 9961-6108")).matches.map((u) => u.id)).toEqual(["557199616108"]);
    expect((await c.lookup("+55 71 98888-7777")).notFound).toBe(true);
  });

  it("another account's store is never read", async () => {
    const c = await linked(hubWithStore(5, "5511900000000"));
    expect((await c.history(ANA)).messages).toEqual([]);
  });
});

describe("a chat's history on open", () => {
  it("is read once per run, and an empty page leaves rev as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-open-"));
    dirs.push(dir);
    writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: [], people: [{ id: "pa", name: "Ana", discordId: "", whatsapp: ANA, storeIds: [], listIds: ["personal"], createdAt: T0, updatedAt: T0 }] }));
    writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "wa1", kind: "whatsapp", section: "stores", also: ["personal"] }] }));
    let asked = 0;
    let page: Conversation = { channelId: null, messages: [] };
    const fake = (ctx: ConnContext): Connection => {
      const state = (): ConnState => ({ status: "connected", me: null, gateway: "up" });
      return { id: ctx.id, kind: ctx.kind, section: ctx.section, state, start: async () => ctx.emit({ type: "state", state: state() }), connect: async () => state(), disconnect: async () => state(), track: async () => ({}), lookup: async () => ({ matches: [] }), user: async () => null, history: async () => (asked++, page), send: async () => ({ ok: false }), stop: async () => {} };
    };
    const s = new PersonsService({ dir, factories: { whatsapp: fake } });
    closers.push(() => s.stop());
    await s.start();
    const r = new PersonsRoutes(s);
    const chat = async () => (await r.route({ method: "GET", path: ["v1", "persons", "chat", "pa"], query: [["section", "personal"]], body: null }))!.body as Record<string, any>;

    await Bun.sleep(50); // the connection's start settles
    const rev = s.rev;
    expect((await chat()).messages).toEqual([]);
    expect(asked).toBe(1);
    expect(s.rev).toBe(rev);
    await chat();
    await chat();
    expect(asked).toBe(1);

    // a page with something new does change it
    page = { channelId: "c", messages: [{ id: "w1", channelId: "c", authorId: ANA, fromMe: false, content: "oi", timestamp: T0 }] };
    expect(await s.loadHistory("wa1", ANA)).toBe(1);
    expect(s.rev).toBeGreaterThan(rev);
    const again = s.rev;
    expect(await s.loadHistory("wa1", ANA)).toBe(1);
    expect(s.rev).toBe(again);
  });
});
