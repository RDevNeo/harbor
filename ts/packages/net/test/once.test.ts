import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, Store } from "@harbor/store";
import { err, type Reply } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh } from "../src/mesh.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { Once, sendKey } from "../src/once.ts";
import { PhoneRoutes, type PhoneEngine } from "../src/phone.ts";
import { newPeer } from "../src/shared.ts";
import { generateIdentity } from "../src/tls.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-once-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (n: number): Reply => ({ status: 200, body: { n } });

describe("Once: a repeated send runs once", () => {
  test("the same key within the ttl gets the first answer; another key runs", async () => {
    let t = 0;
    const once = new Once<Reply>(1000, 100, () => t);
    let runs = 0;
    const f = async () => ok(++runs);
    expect((await once.run("a", f)).body).toEqual({ n: 1 });
    expect((await once.run("a", f)).body).toEqual({ n: 1 });
    expect((await once.run("b", f)).body).toEqual({ n: 2 });
    t = 999;
    expect((await once.run("a", f)).body).toEqual({ n: 1 });
    t = 1000; // past the ttl: a new send
    expect((await once.run("a", f)).body).toEqual({ n: 3 });
  });

  test("a repeat while the first still runs waits for its answer", async () => {
    const once = new Once<Reply>();
    let runs = 0;
    let finish: (r: Reply) => void = () => {};
    const slow = () => {
      runs++;
      return new Promise<Reply>((res) => (finish = res));
    };
    const first = once.run("k", slow);
    const again = once.run("k", slow);
    expect(runs).toBe(1);
    finish(ok(1));
    expect(await first).toEqual(ok(1));
    expect(await again).toEqual(ok(1));
  });

  test("a send that failed may be tried again; one that threw too", async () => {
    const once = new Once<Reply>();
    let runs = 0;
    expect((await once.run("k", async () => (runs++, err(503, "home is off")))).status).toBe(503);
    expect((await once.run("k", async () => (runs++, ok(runs)))).body).toEqual({ n: 2 });
    expect((await once.run("k", async () => (runs++, ok(runs)))).body).toEqual({ n: 2 });
    await expect(once.run("x", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await once.run("x", async () => ok(7))).body).toEqual({ n: 7 });
  });

  test("it keeps at most max keys, the oldest going first", async () => {
    let t = 0;
    const once = new Once<Reply>(60_000, 3, () => t);
    for (const k of ["a", "b", "c", "d"]) {
      t++;
      await once.run(k, async () => ok(t));
    }
    expect(once.size).toBe(3);
    let ran = false;
    await once.run("a", async () => ((ran = true), ok(0)));
    expect(ran).toBe(true); // "a" was dropped to make room
  });

  test("sendKey: only a well-formed client id, per chat", () => {
    expect(sendKey("g1", { client_id: "0b9f3c1e-7d2a-4f5e-9c3b-1a2b3c4d5e6f" })).toBe("g1\n0b9f3c1e-7d2a-4f5e-9c3b-1a2b3c4d5e6f");
    expect(sendKey("g2", { client_id: "0b9f3c1e-7d2a-4f5e-9c3b-1a2b3c4d5e6f" })).not.toBe(sendKey("g1", { client_id: "0b9f3c1e-7d2a-4f5e-9c3b-1a2b3c4d5e6f" }));
    expect(sendKey("g1", {})).toBeNull();
    expect(sendKey("g1", { client_id: 42 })).toBeNull();
    expect(sendKey("g1", { client_id: "short" })).toBeNull();
    expect(sendKey("g1", { client_id: "has space in it" })).toBeNull();
    expect(sendKey("g1", { client_id: "x".repeat(81) })).toBeNull();
  });
});

function engineFor(store: Store, sent: string[]): PhoneEngine {
  return {
    running: () => false,
    runningSince: () => 0,
    transcript: () => ({ items: [] }),
    send: (_id: number, text: string) => {
      sent.push(text);
    },
    stop: () => {},
    queued: () => [],
    takeQueue: () => [],
    queueJson: () => [],
    steering: () => "now",
    followDefault: () => "queue",
    held: () => false,
    newThread: (repo: number | null) => store.createChat(blankChat({ repoId: repo })),
    reload: () => {},
    queuePromote: () => false,
    queueMove: () => false,
    queueUpdate: () => false,
    queueRemove: () => false,
    queueResume: () => {},
    recap: () => [null, null] as [null, null],
    unread: () => false,
    failed: () => false,
    opened: () => false,
    subsQueued: () => 0,
    queuedCount: () => 0,
    mainChat: () => null,
    forksOf: () => [],
  } satisfies PhoneEngine;
}

describe("phone sends: a retried POST can't send the message twice", () => {
  test("a chat on this PC: the same client id runs once, another runs, none without one", async () => {
    const store = Store.openAt(join(tmp, "local.db"));
    const hub = new Hub([], 0);
    const sent: string[] = [];
    const replica = new StoreReplica({ store, hub, version: "t" });
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: engineFor(store, sent) });
    const c = store.createChat(blankChat({ title: "m" }));
    const send = (body: Record<string, unknown>) => routes.route({ method: "POST", path: ["v1", "chats", String(c.id), "send"], query: [], body, token: "", device: "Pixel", global: false });
    const id = "6f1d2c3b-aaaa-4bbb-8ccc-000000000001";
    const a = await send({ text: "hello", client_id: id });
    const b = await send({ text: "hello", client_id: id });
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(sent).toEqual(["hello"]);
    await send({ text: "hello", client_id: "6f1d2c3b-aaaa-4bbb-8ccc-000000000002" });
    await send({ text: "hello" });
    await send({ text: "hello" });
    expect(sent).toEqual(["hello", "hello", "hello", "hello"]);
    // A send refused (nothing to send) isn't remembered: the same id may come back with text.
    expect((await send({ text: " ", client_id: "6f1d2c3b-aaaa-4bbb-8ccc-000000000003" })).status).toBe(400);
    expect((await send({ text: "now", client_id: "6f1d2c3b-aaaa-4bbb-8ccc-000000000003" })).status).toBe(200);
    expect(sent.at(-1)).toBe("now");
    store.close();
  });

  test("a copy of another PC's chat: forwarded once with the client id, so its home dedups a retry through another PC", async () => {
    const store = Store.openAt(join(tmp, "copy.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.peers.set("pc:home", newPeer({ id: "pc:home", name: "home", online: true, addr: "127.0.0.1:1" }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const copy = store.createChat(blankChat({ title: "theirs", gid: "g-copy", home: "pc:home", homeId: 7 }));
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const forwarded: Record<string, unknown>[] = [];
    let down = true;
    mesh.forward = async (_d, _name, _method, _path, body) => {
      forwarded.push(body);
      return down ? err(503, "home is off or unreachable") : { status: 200, body: { ok: true, queued: false } };
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null });
    const send = () => routes.route({ method: "POST", path: ["v1", "chats", String(copy.id), "send"], query: [], body: { text: "hi", client_id: "c0ffee00-1111-4222-8333-444455556666" }, token: "", device: "Pixel", global: true });
    expect((await send()).status).toBe(503); // home unreachable: not remembered
    down = false;
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(forwarded.length).toBe(2);
    expect(forwarded[1]?.client_id).toBe("c0ffee00-1111-4222-8333-444455556666");

    // At the home PC the forwarded copy (another PC's retry) meets the first: one run.
    const homeStore = Store.openAt(join(tmp, "home.db"));
    const homeHub = new Hub([], 0);
    homeHub.mesh.peers.set("pc-1", newPeer({ id: "pc-1", name: "Desk", online: true }));
    homeHub.mesh.peers.set("pc-2", newPeer({ id: "pc-2", name: "Laptop", online: true }));
    const sent: string[] = [];
    let homeRoutes: PhoneRoutes | null = null;
    const homeReplica = new StoreReplica({ store: homeStore, hub: homeHub, version: "t", route: (call) => (homeRoutes as PhoneRoutes).route(call) });
    homeRoutes = new PhoneRoutes({ store: homeStore, hub: homeHub, replica: homeReplica, mesh: null, version: "t", myFp: () => "", engine: engineFor(homeStore, sent) });
    const own = homeStore.createChat(blankChat({ title: "theirs", gid: "g-copy" }));
    const path = ["v1", "chats", String(own.id), "send"];
    const via = (pc: string) =>
      homeReplica.route({ method: "POST", path: ["mesh", "v1", "call"], query: [], body: { method: "POST", path, body: { text: "hi", client_id: "c0ffee00-1111-4222-8333-444455556666" }, sender: "Pixel", device: "" }, token: "", device: pc, global: false });
    expect((await via("pc-1")).status).toBe(200);
    expect((await via("pc-2")).status).toBe(200);
    expect(sent).toEqual(["hi"]);
    store.close();
    homeStore.close();
  });
});
