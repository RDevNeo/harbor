// Syncing chats (packages/net/src/syncing.ts): the state machine on its own (start-up read, holds, newer versions,
// timeouts, a wake), then end to end in one process: two PCs with their own harbor.db, Engine and workspace cloud (the
// Worker's handlers on SQLite). While the chat's carried session is being fetched on the PC that takes it over, a
// send, a rename and a settle are refused (the phone's routes, which other PCs' calls and the window's copies take
// too), an agent's turn waits; once it's in place they go through.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chatCloud } from "../cloudsync.ts";
import { carrySource, ContinueHere } from "../continuehere.ts";
import { Failover } from "../failover.ts";
import { Engine, movechat, type providers } from "../packages/agents/src/index.ts";
import { type AccountDirectory, type ChatCloud, type CloudContext, changesSync, Hub, type Json, PhoneRoutes, StoreReplica, Syncing } from "../packages/net/src/index.ts";
import { blankChat, type Chat, type Item, Store } from "../packages/store/src/index.ts";
import { service } from "./cloudrig.ts";

describe("syncing state", () => {
  const rig = (cloud: Set<number> = new Set([1, 2])) => {
    let t = 1_000_000;
    const late: [number | null, string][] = [];
    const changed: (number | null)[] = [];
    let woke = 0;
    let on = true;
    const s = new Syncing({ manual: true, clock: () => t, inCloud: (id) => cloud.has(id), cloudOn: () => on, changed: (c) => changed.push(c), late: (c, w) => late.push([c, w]), woke: () => woke++ });
    return { s, late, changed, at: (ms: number) => (t += ms), woke: () => woke, off: () => (on = false) };
  };

  test("start-up: the cloud's chats sync until the first read is done; only-local ones never", () => {
    const r = rig();
    r.s.boot();
    expect(r.s.why(1)).toBe("the first sync after start");
    expect(r.s.is(2)).toBe(true);
    expect(r.s.is(3)).toBe(false);
    let ran = 0;
    r.s.after(1, () => ran++);
    expect(ran).toBe(0);
    r.s.pulled();
    expect(r.s.is(1)).toBe(false);
    expect(ran).toBe(1);
    expect(r.late).toEqual([]);
  });

  test("start-up without a reachable cloud ends by its timeout, with a quiet notice", () => {
    const r = rig();
    r.s.boot();
    r.at(29_000);
    r.s.tick();
    expect(r.s.is(1)).toBe(true);
    r.at(2_000);
    r.s.tick();
    expect(r.s.is(1)).toBe(false);
    expect(r.late).toEqual([[null, "the first sync after start"]]);
  });

  test("no account signed in: a start holds nothing", () => {
    const r = rig();
    r.off();
    r.s.boot();
    expect(r.s.is(1)).toBe(false);
  });

  test("a carry in progress holds its chat until released, or until its timeout", () => {
    const r = rig(new Set());
    const release = r.s.hold(5, "bringing its session and work from Desk");
    expect(r.s.why(5)).toBe("bringing its session and work from Desk");
    expect(r.s.held()).toEqual([5]);
    const order: string[] = [];
    r.s.after(5, () => order.push("turn"));
    release();
    expect(r.s.is(5)).toBe(false);
    expect(order).toEqual(["turn"]);
    release();
    // One that hangs: open again after SYNC_MS, said once.
    r.s.hold(6, "handing it to Desk");
    r.at(31_000);
    r.s.tick();
    expect(r.s.is(6)).toBe(false);
    expect(r.late).toEqual([[6, "handing it to Desk"]]);
  });

  test("a newer version in the cloud holds its chat until applied; one that never comes stops holding", () => {
    const r = rig(new Set());
    r.s.behind(new Map([[7, { key: "v1", why: "a newer version is coming from the cloud" }]]));
    expect(r.s.is(7)).toBe(true);
    r.s.behind(new Map());
    expect(r.s.is(7)).toBe(false);
    r.s.behind(new Map([[7, { key: "v2", why: "x" }]]));
    r.at(31_000);
    r.s.tick();
    expect(r.s.is(7)).toBe(false);
    expect(r.late).toEqual([[7, "x"]]);
    // Still listed at that version: it doesn't hold again; a later version does.
    r.s.behind(new Map([[7, { key: "v2", why: "x" }]]));
    expect(r.s.is(7)).toBe(false);
    r.s.behind(new Map([[7, { key: "v3", why: "x" }]]));
    expect(r.s.is(7)).toBe(true);
  });

  test("a wake (the clock jumped past the ticks) holds the cloud's chats for the next read and asks for it", () => {
    const r = rig();
    r.s.tick();
    r.at(5 * 60_000);
    r.s.tick();
    expect(r.woke()).toBe(1);
    expect(r.s.why(1)).toBe("the first sync after waking up");
    r.s.pulled();
    expect(r.s.is(1)).toBe(false);
  });

  test("which calls change what syncs", () => {
    expect(changesSync("POST", ["v1", "chats", "3", "send"])).toBe(true);
    expect(changesSync("PATCH", ["v1", "chats", "3"])).toBe(true);
    expect(changesSync("DELETE", ["v1", "chats", "3"])).toBe(true);
    expect(changesSync("POST", ["v1", "chats", "3", "move_pc"])).toBe(true);
    expect(changesSync("POST", ["v1", "chats", "3", "fork"])).toBe(true);
    expect(changesSync("POST", ["v1", "chats", "3", "stop"])).toBe(false);
    expect(changesSync("POST", ["v1", "chats", "3", "handoff"])).toBe(false);
    expect(changesSync("GET", ["v1", "chats", "3", "items"])).toBe(false);
    expect(changesSync("POST", ["v1", "chats"])).toBe(false);
  });
});

// ---- end to end

const root = mkdtempSync(join(tmpdir(), "hsyncing-"));
const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) {
    e.close();
    await e.idle();
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows: a database file still held open
  }
});

const user = (s: string): Item => ({ kind: "user", text: s, files: [], at: 1, mentions: [], sender: "", intent: "" });
const text = (s: string): Item => ({ kind: "text", text: s, at: 1 });

async function until(what: string, f: () => boolean, ms = 15_000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const pcEntry = (fp: string, id: string, name: string) => ({ fp, id, name, addrs: [], owner: "u1", owner_name: "Sam", seen: 0, version: "t" });
const directory: AccountDirectory = {
  at: 1,
  workspaces: [{ id: "W1", name: "Sam's", role: "owner", personal: true, members: [], pcs: [pcEntry("fpA", "ts:tower", "Tower"), pcEntry("fpB", "pc:desk", "Desk")], devices: [], invites: [] }],
  peers: [],
};

interface Pc {
  name: string;
  store: Store;
  cloud: ChatCloud;
  engine: Engine;
  failover: Failover;
  ch: ContinueHere;
  syncing: Syncing;
  routes: PhoneRoutes;
  account: providers.Account;
  turns: [number, string][];
  call: CloudContext["call"];
  /** While set, the cloud's row fetches (a carried session, a transcript's chunks) wait for it. */
  gate: Promise<void> | null;
}

let skew = 0;

function pc(svc: ReturnType<typeof service>, name: string, fp: string, id: string): Pc {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const store = Store.openAt(join(dir, "harbor.db"));
  const hub = new Hub([], 0);
  hub.mesh.me = { id, name };
  const account: providers.Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C", plan: "", configDir: join(dir, ".claude"), bin: "/nonexistent/claude", loggedIn: true, usage: [] };
  const accounts = () => [account];
  const scratch = join(dir, "scratch");
  // eslint-disable-next-line prefer-const
  let p: Pc;
  const syncing = new Syncing({
    manual: true,
    inCloud: (c) => {
      const x = store.chat(c);
      return x !== undefined && (x.home !== "" || p.cloud.published(c));
    },
    cloudOn: () => true,
    changed: () => {},
  });
  const failover = new Failover({
    store,
    engine: () => p.engine,
    hub,
    mesh: () => null,
    accounts,
    ram: () => 1000,
    forgetCopy: () => {},
    place: () => null,
    touch: () => {},
    carry: { of: (x, h) => p.ch.of(x, h), begin: (c, f, h, off, quiet) => p.ch.begin(c, f, h, off, quiet) },
    mine: () => true,
    syncing,
  });
  const replica = new StoreReplica({ store, hub, version: "t", took: (gid) => failover.took(gid), release: (o, peer, h, n) => failover.release(o, peer, h, n), dropOwn: (o, by, n) => failover.dropOwn(o, by, n) });
  const cloud = chatCloud({
    stateDir: dir,
    fp: () => fp,
    store,
    hub,
    replica: () => replica,
    directory: () => directory,
    running: () => false,
    copied: () => p.engine.reload(),
    carry: carrySource({ store, engine: () => p.engine, accounts, scratch }),
    clock: () => Date.now() + skew,
    syncing,
  });
  const ch = new ContinueHere({ store, engine: () => p.engine, accounts, scratch, cloud: () => cloud, here: () => name, touch: () => {}, hold: (c, why) => syncing.hold(c, why) });
  const engine = new Engine({ store, accounts, changed: () => {}, prepare: (c, prompt, files) => ch.prepare(c, prompt, files), syncing: (c) => syncing.why(c), afterSync: (c, f) => syncing.after(c, f) });
  engines.push(engine);
  const turns: [number, string][] = [];
  // Turns aren't run: a start the engine's hooks hold goes through it (prepare, a sync), the rest are recorded.
  const start = engine.startTurn.bind(engine);
  engine.startTurn = (c: number, prompt: string, files: readonly string[] = []) => {
    if (ch.preparing(c) || ch.waiting(c) || syncing.is(c)) return start(c, prompt, [...files]);
    turns.push([c, prompt]);
  };
  const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => fp, engine: null, syncing: (c) => syncing.why(c) });
  const raw = svc.callAs("u1", fp, ["W1"]);
  const call: CloudContext["call"] = async (method, path, body) => {
    if (path.startsWith("/v1/cloud/rows") && p.gate) await p.gate;
    return raw(method, path, body);
  };
  p = { name, store, cloud, engine, failover, ch, syncing, routes, account, turns, call, gate: null };
  return p;
}

async function round(p: Pc): Promise<void> {
  skew += 60_000;
  await p.cloud.sync({ account: "u1", mine: "W1", workspaces: ["W1"], call: p.call });
  p.engine.reload();
}

/** A call as a phone (or another PC, or the window for a copy) makes it. */
const route = (p: Pc, method: string, path: string, body: Record<string, Json> | null = null) => p.routes.route({ method, path: path.split("/").filter((x) => x !== ""), query: [], body, token: "", device: "", global: false });

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe("syncing end to end", () => {
  test("while a chat's carry is in progress, send, rename and settle are refused; once in place they go through", async () => {
    const svc = service();
    const A = pc(svc, "Tower", "fpA", "ts:tower");
    const B = pc(svc, "Desk", "fpB", "pc:desk");
    // A: a chat that ran, with its Claude session.
    const sid = "11111111-2222-3333-4444-555555555555";
    const chat = A.store.createChat(blankChat({ title: "Fix the parser", account: "claude", started: true, sessionId: sid, updated: Math.floor(Date.now() / 1000) }));
    A.store.saveItems(chat.id, [user("fix the parser"), text("Done")]);
    const cwd = A.engine.chatCwd(chat);
    const sess = join(movechat.sessionDir(A.account.configDir, cwd), `${sid}.jsonl`);
    mkdirSync(dirname(sess), { recursive: true });
    writeFileSync(sess, `${JSON.stringify({ type: "user", cwd, sessionId: sid, message: { content: "fix the parser" } })}\n`);
    A.engine.reload();
    await round(A);

    // B starts: the copy syncs until the first read of the cloud is done.
    B.syncing.boot();
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:tower");
    if (!copy) throw new Error("no copy on B");
    expect(B.syncing.is(copy.id)).toBe(false);
    B.syncing.boot();
    expect(B.syncing.why(copy.id)).toBe("the first sync after start");
    expect((await route(B, "PATCH", `/v1/chats/${copy.id}`, { title: "Renamed early" })).status).toBe(409);
    await round(B);
    expect(B.syncing.is(copy.id)).toBe(false);

    // A is off: a message on B takes the chat over; its session is being fetched (held at the gate).
    const g = gate();
    B.gate = g.wait;
    const r = await B.failover.send(copy, { text: "now the tests", files: [], mentions: [] });
    expect(r.status).toBe(200);
    await until("the carry to start", () => B.ch.preparing(copy.id));
    expect(B.syncing.why(copy.id)).toBe("bringing its session and work from tower");
    // The chat JSON says so (the phone's composer and drawer row show it).
    const json = B.routes.chatJson(B.store.chat(copy.id) as Chat, false) as Record<string, Json>;
    expect(json.syncing).toBe("bringing its session and work from tower");
    const send = await route(B, "POST", `/v1/chats/${copy.id}/send`, { text: "and the docs" });
    expect(send.status).toBe(409);
    expect((send.body as { syncing?: boolean }).syncing).toBe(true);
    expect(String((send.body as { error?: string }).error)).toStartWith("Syncing…");
    expect((await route(B, "PATCH", `/v1/chats/${copy.id}`, { title: "Renamed" })).status).toBe(409);
    expect((await route(B, "PATCH", `/v1/chats/${copy.id}`, { settled: true })).status).toBe(409);
    expect((await route(B, "DELETE", `/v1/chats/${copy.id}`)).status).toBe(409);
    // Reading it and stopping it still work.
    expect((await route(B, "GET", `/v1/chats/${copy.id}/items`)).status).toBe(200);
    expect(B.store.chat(copy.id)?.title).toBe("Fix the parser");
    expect(B.store.chat(copy.id)?.settled).toBe(false);
    expect(B.turns).toEqual([]);

    // The session comes: the turn that brought it starts, the chat opens again.
    g.open();
    B.gate = null;
    await until("B's turn", () => B.turns.length > 0);
    expect(B.syncing.is(copy.id)).toBe(false);
    expect(B.turns[0]?.[1]).toContain("now the tests");
    expect(B.engine.chat(copy.id)?.sessionId).toBe(sid);
    expect((await route(B, "PATCH", `/v1/chats/${copy.id}`, { title: "Renamed" })).status).toBe(200);
    expect((await route(B, "PATCH", `/v1/chats/${copy.id}`, { settled: true })).status).toBe(200);
    expect(B.store.chat(copy.id)?.title).toBe("Renamed");
    expect(B.store.chat(copy.id)?.settled).toBe(true);
    // A send passes the sync check now (this rig's routes have no engine to run it).
    const after = await route(B, "POST", `/v1/chats/${copy.id}/send`, { text: "and the docs" });
    expect((after.body as { syncing?: boolean }).syncing).toBeUndefined();
    for (const p of [A, B]) p.store.close();
  }, 60_000);

  test("a newer version of a copy in the cloud holds it until applied; an agent's turn waits for the sync", async () => {
    const svc = service();
    const A = pc(svc, "Tower", "fpA", "ts:tower");
    const B = pc(svc, "Desk", "fpB", "pc:desk");
    const chat = A.store.createChat(blankChat({ title: "Notes", account: "claude", updated: Math.floor(Date.now() / 1000) }));
    A.store.saveItems(chat.id, [user("one")]);
    A.engine.reload();
    await round(A);
    await round(B);
    const copy = B.store.chats().find((c) => c.home === "ts:tower");
    if (!copy) throw new Error("no copy on B");
    // A goes on (more items, later), then is off; B reads it, the transcript's fetch held at the gate.
    A.store.saveItems(chat.id, [user("one"), text("two"), user("three")]);
    A.store.saveChat({ ...(A.store.chat(chat.id) as Chat), updated: Math.floor(Date.now() / 1000) + 5 });
    A.engine.reload();
    await round(A);
    const g = gate();
    B.gate = g.wait;
    const reading = round(B);
    await until("B to see the newer version", () => B.syncing.is(copy.id));
    expect(B.syncing.why(copy.id)).toBe("a newer version is coming from the cloud");
    expect((await route(B, "POST", `/v1/chats/${copy.id}/fork`, {})).status).toBe(409);
    g.open();
    B.gate = null;
    await reading;
    expect(B.syncing.is(copy.id)).toBe(false);
    expect(B.store.items(copy.id).length).toBe(3);

    // An agent's turn into a chat that syncs starts once the sync is done.
    const own = B.store.createChat(blankChat({ title: "Mine", account: "claude" }));
    B.engine.reload();
    const release = B.syncing.hold(own.id, "handing it to Tower");
    B.engine.startTurn(own.id, "[message from lead] go");
    expect(B.turns).toEqual([]);
    release();
    expect(B.turns).toEqual([[own.id, "[message from lead] go"]]);
    for (const p of [A, B]) p.store.close();
  }, 60_000);
});
