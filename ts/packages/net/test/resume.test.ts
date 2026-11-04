import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, Store, type Item } from "@harbor/store";
import { err } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh } from "../src/mesh.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { PhoneRoutes, type PhoneEngine } from "../src/phone.ts";
import { RESUME_TEXT, resumeKind, resumeNow } from "../src/resume.ts";
import { newPeer } from "../src/shared.ts";
import { generateIdentity } from "../src/tls.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-resume-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type State = { running: boolean; held: boolean; queued: number; items: number; sent: string[]; resumed: number };

function engineFor(store: Store, s: State): PhoneEngine {
  return {
    running: () => s.running,
    runningSince: () => null,
    transcript: () => ({ items: Array.from({ length: s.items }, () => ({}) as Item) }),
    send: (_id: number, text: string) => {
      s.sent.push(text);
    },
    stop: () => {},
    queued: () => Array.from({ length: s.queued }, () => ({ intent: "", text: "q", files: [] })),
    takeQueue: () => [],
    queueJson: () => [],
    steering: () => "now",
    followDefault: () => "queue",
    held: () => s.held,
    newThread: (repo: number | null) => store.createChat(blankChat({ repoId: repo })),
    reload: () => {},
    queuePromote: () => false,
    queueMove: () => false,
    queueUpdate: () => false,
    queueRemove: () => false,
    queueResume: () => {
      s.held = false;
      s.resumed++;
    },
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

describe("Resume: one rule for the desktop's composer and the phone's", () => {
  test("resumeKind / resumeNow", () => {
    const idle = { empty: true, running: false, editing: false, held: false, transcript: true };
    expect(resumeKind(idle)).toBe("reply");
    expect(resumeKind({ ...idle, held: true })).toBe("queue");
    expect(resumeKind({ ...idle, running: true })).toBeNull();
    const s: State = { running: false, held: true, queued: 0, items: 0, sent: [], resumed: 0 };
    const e = engineFor(Store.openAt(join(tmp, "k.db")), s);
    expect(resumeNow(e, 1)).toBeNull(); // held but nothing queued, no transcript
    s.items = 2;
    expect(resumeNow(e, 1)).toBe("reply");
    s.queued = 1;
    expect(resumeNow(e, 1)).toBe("queue");
  });

  test("the phone's empty send with resume: the reply, the held queue, nothing while running or in an empty chat", async () => {
    const store = Store.openAt(join(tmp, "local.db"));
    const hub = new Hub([], 0);
    const replica = new StoreReplica({ store, hub, version: "t" });
    const s: State = { running: false, held: false, queued: 0, items: 3, sent: [], resumed: 0 };
    const routes = new PhoneRoutes({ store, hub, replica, mesh: null, version: "t", myFp: () => "", engine: engineFor(store, s) });
    const c = store.createChat(blankChat({ title: "m" }));
    const send = (body: Record<string, unknown>) => routes.route({ method: "POST", path: ["v1", "chats", String(c.id), "send"], query: [], body, token: "", device: "Pixel", global: false });

    const r = await send({ text: "  ", resume: true, client_id: "6f1d2c3b-aaaa-4bbb-8ccc-0000000000a1" });
    expect(r.status).toBe(200);
    expect((r.body as { resumed?: string }).resumed).toBe("reply");
    expect(s.sent).toEqual([RESUME_TEXT]);

    // Text typed: an ordinary message, the flag doesn't matter.
    await send({ text: "go on", resume: true });
    expect(s.sent).toEqual([RESUME_TEXT, "go on"]);

    // A Stop held the queue: it starts, no message is sent.
    Object.assign(s, { held: true, queued: 2 });
    const q = await send({ text: "", resume: true });
    expect((q.body as { resumed?: string }).resumed).toBe("queue");
    expect(s.resumed).toBe(1);
    expect(s.sent.length).toBe(2);

    // Running, or no transcript yet: nothing to resume; without the flag an empty send stays refused.
    Object.assign(s, { held: false, queued: 0, running: true });
    expect((await send({ text: "", resume: true })).status).toBe(409);
    Object.assign(s, { running: false, items: 0 });
    expect((await send({ text: "", resume: true })).status).toBe(409);
    expect((await send({ text: "" })).status).toBe(400);
    expect(s.sent.length).toBe(2);
    store.close();
  });

  test("another PC's chat: the flag goes to its home PC, which decides", async () => {
    const store = Store.openAt(join(tmp, "copy.db"));
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.peers.set("pc:home", newPeer({ id: "pc:home", name: "home", online: true, addr: "127.0.0.1:1" }));
    const replica = new StoreReplica({ store, hub, version: "t" });
    const copy = store.createChat(blankChat({ title: "theirs", gid: "g-copy", home: "pc:home", homeId: 7 }));
    const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: tmp, upload: async () => err(404, "") });
    const forwarded: Record<string, unknown>[] = [];
    mesh.forward = async (_d, _name, _method, _path, body) => {
      forwarded.push(body);
      return { status: 200, body: { ok: true, queued: false, resumed: "reply" } };
    };
    const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null });
    const r = await routes.route({ method: "POST", path: ["v1", "chats", String(copy.id), "send"], query: [], body: { text: "", resume: true }, token: "", device: "Pixel", global: true });
    expect(r.status).toBe(200);
    expect(forwarded[0]?.resume).toBe(true);

    // At the home PC, through the mesh call: the resume message.
    const homeStore = Store.openAt(join(tmp, "home.db"));
    const homeHub = new Hub([], 0);
    homeHub.mesh.peers.set("pc-1", newPeer({ id: "pc-1", name: "Desk", online: true }));
    const s: State = { running: false, held: false, queued: 0, items: 1, sent: [], resumed: 0 };
    let homeRoutes: PhoneRoutes | null = null;
    const homeReplica = new StoreReplica({ store: homeStore, hub: homeHub, version: "t", route: (call) => (homeRoutes as PhoneRoutes).route(call) });
    homeRoutes = new PhoneRoutes({ store: homeStore, hub: homeHub, replica: homeReplica, mesh: null, version: "t", myFp: () => "", engine: engineFor(homeStore, s) });
    const own = homeStore.createChat(blankChat({ title: "theirs", gid: "g-copy" }));
    const h = await homeReplica.route({ method: "POST", path: ["mesh", "v1", "call"], query: [], body: { method: "POST", path: ["v1", "chats", String(own.id), "send"], body: { text: "", resume: true }, sender: "Pixel", device: "" }, token: "", device: "pc-1", global: false });
    expect(h.status).toBe(200);
    expect(s.sent).toEqual([RESUME_TEXT]);
    store.close();
    homeStore.close();
  });
});
