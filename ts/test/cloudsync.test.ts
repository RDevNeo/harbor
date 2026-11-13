// The workspace cloud end to end: the Worker's own handlers (worker/src/cloud.js, on SQLite as D1), two PCs with
// their own harbor.db, the app's wiring (cloudsync.ts) and the mesh's replica making the copies.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_EPOCH, chatCloud, cloudLog } from "../cloudsync.ts";
import { service } from "./cloudrig.ts";
import { type AccountDirectory, type ChatCloud, type CloudContext, chunkTranscript, firstNeeded, Hub, StoreReplica } from "../packages/net/src/index.ts";
import { blankChat, type Item, Store } from "../packages/store/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "hcloud-"));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows: a database file still held open
  }
});

// ---- PCs

let clock = 1_900_000_000_000;
const now = () => clock;

const pcEntry = (fp: string, id: string, name: string) => ({ fp, id, name, addrs: [], owner: "u1", owner_name: "Igor", seen: 0, version: "t" });
const directory: AccountDirectory = {
  at: 1,
  workspaces: [{ id: "W1", name: "Igor's", role: "owner", personal: true, members: [], pcs: [pcEntry("fpA", "ts:a", "Omarchy"), pcEntry("fpB", "pc:b", "Windows"), pcEntry("fpC", "pc:c", "Laptop")], devices: [], invites: [] }],
  peers: [],
};

interface Pc {
  store: Store;
  hub: Hub;
  replica: StoreReplica;
  cloud: ChatCloud;
  online: Set<string>;
}

function pc(name: string, fp: string, id: string, pokeMs?: number): Pc {
  const dir = join(root, name);
  const store = Store.openAt(join(root, `${name}.db`));
  const hub = new Hub([], 0);
  hub.mesh.me = { id, name };
  const online = new Set<string>();
  hub.mesh.online = (x: string) => online.has(x);
  const replica = new StoreReplica({ store, hub, version: "t" });
  const cloud = chatCloud({
    stateDir: dir,
    fp: () => fp,
    store,
    hub,
    replica: () => replica,
    directory: () => directory,
    running: () => false,
    copied: () => {},
    clock: now,
    chunkItems: 3,
    pokeMs,
  });
  return { store, hub, replica, cloud, online };
}

const text = (s: string, at = 1): Item => ({ kind: "text", text: s, at });
const user = (s: string): Item => ({ kind: "user", text: s, files: [], at: 1, mentions: [], sender: "", intent: "" });

/** One round with the account loop's context; the clock moves past the cloud's own pacing. */
async function round(p: Pc, call: CloudContext["call"], ws = "W1"): Promise<void> {
  clock += 60_000;
  await p.cloud.sync({ account: "u1", mine: ws, workspaces: [ws], call });
}

const copyOf = (p: Pc, hid: number) => p.store.chats().find((c) => c.home === "ts:a" && c.homeId === hid);

describe("workspace cloud", () => {
  test("chunks: appending changes the last chunk only; a copy fetches from the first chunk that differs", () => {
    const a = chunkTranscript(["1", "2", "3", "4", "5"], 2);
    const b = chunkTranscript(["1", "2", "3", "4", "5", "6", "7"], 2);
    expect(a.chunks.map((c) => c[0])).toEqual([0, 2, 4]);
    expect(b.chunks.slice(0, 2)).toEqual(a.chunks.slice(0, 2));
    expect(b.chunks[2]?.[1]).not.toBe(a.chunks[2]?.[1]);
    expect(firstNeeded(b.chunks, a.chunks, 5)).toBe(2);
    // The copy is shorter than the chunk that differs: from the chunk that holds its end.
    expect(firstNeeded(b.chunks, a.chunks, 1)).toBe(0);
    expect(firstNeeded(b.chunks, [], 5)).toBe(0);
  });

  test("a PC that is off: its chats, transcripts and projects open on another PC of the account", async () => {
    const svc = service();
    const A = pc("a", "fpA", "ts:a");
    const B = pc("b", "fpB", "pc:b");
    const callA = svc.callAs("u1", "fpA", ["W1"]);
    const callB = svc.callAs("u1", "fpB", ["W1"]);
    const projectDir = mkdtempSync(join(root, "proj-"));
    const repo = A.store.addRepo(projectDir);
    A.store.setRepoRemote(repo, "git@example.org:igor/app.git");
    A.store.addRepo(mkdtempSync(join(root, "lonely-"))); // a project with no chats yet
    const lead = A.store.createChat(blankChat({ repoId: repo, title: "Fix the sidebar", role: "lead", updated: 100 }));
    const loose = A.store.createChat(blankChat({ title: "Loose chat", updated: 90 }));
    const sub = A.store.createChat(blankChat({ repoId: repo, title: "helper", role: "sub", parent: lead.id, name: "helper", updated: 95 }));
    const leadItems = [user("hi"), text("one"), text("two"), text("three"), text("four"), text("five"), text("six")];
    A.store.saveItems(lead.id, leadItems);
    A.store.saveItems(loose.id, [user("loose")]);
    A.store.saveItems(sub.id, [user("sub task"), text("done")]);
    await round(A, callA);
    await round(B, callB);
    const c = copyOf(B, lead.id);
    expect(c?.title).toBe("Fix the sidebar");
    expect(B.store.items(c?.id ?? -1)).toEqual(leadItems);
    expect(B.store.summary(c?.id ?? -1).digest).toBe(A.store.summary(lead.id).digest);
    expect(copyOf(B, loose.id)?.title).toBe("Loose chat");
    // The sub-agent names its parent's copy.
    expect(copyOf(B, sub.id)?.parent).toBe(c?.id ?? -2);
    // Both projects show, the one without chats too, as A's (its folder isn't here: it offers to clone it).
    const repos = B.store.repos();
    const app = repos.find((r) => r.path === projectDir);
    expect(app?.remote).toBe("git@example.org:igor/app.git");
    expect(repos.length).toBe(2);
    expect(B.store.projectPc(app?.id ?? -1)).toBe("ts:a");
    expect(c?.repoId).toBe(app?.id ?? -3);

    // More of the chat: only its last chunk and the new ones go up, and the copy follows.
    const more = [...leadItems, text("seven"), text("eight")];
    A.store.saveItems(lead.id, more);
    A.store.saveChat({ ...lead, title: "Fix the sidebar (2)", updated: lead.updated + 20 });
    const before = svc.requests();
    await round(A, callA);
    const sent = svc.db.query(`SELECT COUNT(*) AS n FROM cloud WHERE id LIKE 'k:%'`).get() as { n: number };
    expect(sent.n).toBe(3 + 1 + 1); // lead 9 items in chunks of 3, loose 1, sub 1
    await round(B, callB);
    expect(svc.requests() - before).toBeLessThan(12);
    const c2 = copyOf(B, lead.id);
    expect(c2?.title).toBe("Fix the sidebar (2)");
    expect(B.store.items(c2?.id ?? -1)).toEqual(more);

    // A chat removed on A goes on B too.
    A.store.deleteChat(loose.id);
    await round(A, callA);
    await round(B, callB);
    expect(copyOf(B, loose.id)).toBeUndefined();

    // While A is on, the mesh brings its chats: the cloud leaves them alone.
    B.online.add("ts:a");
    A.store.saveChat({ ...lead, title: "Renamed while on", updated: lead.updated + 30 });
    await round(A, callA);
    await round(B, callB);
    expect(copyOf(B, lead.id)?.title).toBe("Fix the sidebar (2)");
    B.online.delete("ts:a");
    await round(B, callB);
    expect(copyOf(B, lead.id)?.title).toBe("Renamed while on");

    // A copy newer than the cloud's (the mesh brought it) is never rolled back.
    const mine = copyOf(B, lead.id);
    if (!mine) throw new Error("no copy");
    B.store.saveChat({ ...mine, title: "From the mesh", updated: lead.updated + 999 });
    A.store.saveChat({ ...lead, title: "Older", updated: lead.updated + 40 });
    await round(A, callA);
    await round(B, callB);
    expect(copyOf(B, lead.id)?.title).toBe("From the mesh");
    for (const p of [A, B]) p.store.close();
  }, 30_000);

  test("a copy from the cloud is the mesh's copy: the mesh takes it over when its PC is back", async () => {
    const svc = service();
    const A = pc("a2", "fpA", "ts:a");
    const B = pc("b2", "fpB", "pc:b");
    const chat = A.store.createChat(blankChat({ title: "t", updated: 5 }));
    A.store.saveItems(chat.id, [user("x"), text("y")]);
    await round(A, svc.callAs("u1", "fpA", ["W1"]));
    await round(B, svc.callAs("u1", "fpB", ["W1"]));
    const c = copyOf(B, chat.id);
    expect(c).toBeDefined();
    // The mesh's full list from A, its epoch a real one: same copy, nothing fetched again (same digest).
    const list = (await A.replica.chats(0, true)).chats;
    const wants = await B.replica.applyChats("ts:a", 42, { full: true, chats: list });
    expect(wants).toEqual([]);
    expect(B.store.chats().filter((x) => x.home === "ts:a").map((x) => x.id)).toEqual([c?.id ?? -1]);
    expect(CLOUD_EPOCH).not.toBe(42);
    for (const p of [A, B]) p.store.close();
  }, 30_000);

  test("a chat another PC took over is listed by both: the newest is the copy, and it doesn't flip", async () => {
    const svc = service();
    const A = pc("a4", "fpA", "ts:a");
    const B = pc("b4", "fpB", "pc:b");
    const C = pc("c4", "fpC", "pc:c");
    const old = A.store.createChat(blankChat({ title: "on A", gid: "g-same" }));
    A.store.saveItems(old.id, [user("x")]);
    const took = B.store.createChat(blankChat({ title: "taken over on B", gid: "g-same" }));
    B.store.saveChat({ ...took, updated: old.updated + 50 });
    B.store.saveItems(took.id, [user("x"), text("more on B")]);
    const ca = svc.callAs("u1", "fpA", ["W1"]);
    const cb = svc.callAs("u1", "fpB", ["W1"]);
    const cc = svc.callAs("u1", "fpC", ["W1"]);
    await round(A, ca);
    await round(B, cb);
    for (let i = 0; i < 3; i++) {
      await round(C, cc);
      const copies = C.store.chats().filter((c) => c.gid === "g-same");
      expect(copies.map((c) => [c.home, c.title])).toEqual([["pc:b", "taken over on B"]]);
    }
    for (const p of [A, B, C]) p.store.close();
  }, 30_000);

  test("only the workspace's members, and only the PC that wrote a row rewrites it", async () => {
    const svc = service();
    const outsider = svc.callAs("u9", "fpX", ["W2"]);
    await expect(outsider("GET", "/v1/cloud/key?ws=W1")).rejects.toMatchObject({ code: 403 });
    await expect(outsider("GET", "/v1/cloud?ws=W1&since=0")).rejects.toMatchObject({ code: 403 });
    const a = svc.callAs("u1", "fpA", ["W1"]);
    const b = svc.callAs("u2", "fpB", ["W1"]);
    const id = `m:${"a".repeat(40)}`;
    expect(await a("PUT", "/v1/cloud?ws=W1", { set: [{ id, v: "c1.x" }] })).toMatchObject({ results: [{ id, ok: true }] });
    expect(await b("PUT", "/v1/cloud?ws=W1", { set: [{ id, v: "c1.y" }] })).toMatchObject({ results: [{ id, ok: false, why: "owned" }] });
    expect(await b("PUT", "/v1/cloud?ws=W1", { set: [{ id, v: null }] })).toMatchObject({ results: [{ id, ok: false, why: "owned" }] });
    const rows = (await b("GET", "/v1/cloud?ws=W1&since=0")) as { items: { v: string; by: string }[] };
    expect(rows.items.map((r) => [r.v, r.by])).toEqual([["c1.x", "fpA"]]);
    // Both members get the same key.
    const ka = (await a("GET", "/v1/cloud/key?ws=W1")) as { key: string };
    const kb = (await b("GET", "/v1/cloud/key?ws=W1")) as { key: string };
    expect(ka.key).toBe(kb.key);
  });

  test("an account service without the cloud: the feature is off, nothing breaks", async () => {
    const svc = service({ deployed: false });
    const A = pc("a3", "fpA", "ts:a");
    A.store.createChat(blankChat({ title: "t" }));
    await round(A, svc.callAs("u1", "fpA", ["W1"]));
    expect(A.cloud.status().state).toBe("unsupported");
    expect(A.cloud.status().error).toBe("");
    const n = svc.requests();
    await round(A, svc.callAs("u1", "fpA", ["W1"]));
    // Asked again only after an hour.
    expect(svc.requests()).toBe(n);
    A.store.close();
  });

  test("a chat made here goes up within moments of the change, with no turn of the account loop; the service tells the members' PCs", async () => {
    const svc = service();
    const A = pc("a5", "fpA", "ts:a", 20);
    const B = pc("b5", "fpB", "pc:b");
    const callA = svc.callAs("u1", "fpA", ["W1"]);
    const callB = svc.callAs("u1", "fpB", ["W1"]);
    await round(A, callA);
    const told = svc.told.length;
    // Made, then the window's change (hub.ts pokes on every touch of this PC's own chats); the PC goes off right after.
    const c = A.store.createChat(blankChat({ title: "Made on Windows", updated: 300 }));
    A.store.saveItems(c.id, [user("hello from the other OS")]);
    A.cloud.poke();
    for (let i = 0; i < 100 && svc.told.length === told; i++) await Bun.sleep(10);
    expect(svc.told.slice(told)).toContain("W1");
    await round(B, callB);
    expect(copyOf(B, c.id)?.title).toBe("Made on Windows");
    expect(B.store.items(copyOf(B, c.id)?.id ?? -1)).toEqual([user("hello from the other OS")]);
    // A push brings the next change to B without waiting for its own read: pullSoon reads at once.
    A.store.saveChat({ ...c, title: "Renamed", updated: c.updated + 20 });
    A.cloud.poke();
    for (let i = 0; i < 100 && svc.told.length === told + 1; i++) await Bun.sleep(10);
    clock += 1; // well within B's own read interval
    B.cloud.pullSoon();
    for (let i = 0; i < 100 && copyOf(B, c.id)?.title !== "Renamed"; i++) await Bun.sleep(10);
    expect(copyOf(B, c.id)?.title).toBe("Renamed");
    A.store.close();
    B.store.close();
  });

  test("the service tells members only when a chat or project row changed, not for transcript parts alone", async () => {
    const svc = service();
    const a = svc.callAs("u1", "fpA", ["W1"]);
    await a("PUT", "/v1/cloud?ws=W1", { set: [{ id: `k:${"b".repeat(40)}`, v: "c1.x" }] });
    expect(svc.told).toEqual([]);
    await a("PUT", "/v1/cloud?ws=W1", { set: [{ id: `m:${"b".repeat(40)}`, v: "c1.x" }] });
    expect(svc.told).toEqual(["W1"]);
  });

  test("the cloud's problems reach the journal without HARBOR_ACCOUNT_LOG, each once an hour", () => {
    const out: string[] = [];
    let t = 0;
    const log = cloudLog(false, (l) => out.push(l), () => t);
    log("sent 3 rows");
    log("sync: reading W1: offline");
    log("sync: reading W1: offline");
    t += 3_600_001;
    log("sync: reading W1: offline");
    expect(out).toEqual(["harbor: cloud: sync: reading W1: offline\n", "harbor: cloud: sync: reading W1: offline\n"]);
    const all: string[] = [];
    cloudLog(true, (l) => all.push(l))("sent 3 rows");
    expect(all).toEqual(["harbor: cloud: sent 3 rows\n"]);
  });
});
