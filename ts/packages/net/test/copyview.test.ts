import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, type Item, Store } from "@harbor/store";
import { err } from "../src/http.ts";
import { Hub, type SharedDraft } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh, type Sender } from "../src/mesh.ts";
import { StoreReplica } from "../src/meshstore.ts";
import { PhoneRoutes, type PhoneEngine } from "../src/phone.ts";
import { newPeer } from "../src/shared.ts";
import { generateIdentity } from "../src/tls.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-copyview-"));
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
  rmSync(tmp, { recursive: true, force: true });
});

type SendOpts = Parameters<PhoneEngine["send"]>[2];

function engineFor(store: Store, sent: [string, SendOpts][]): PhoneEngine {
  return {
    running: () => false,
    runningSince: () => 0,
    transcript: (id) => ({ items: store.items(id) }),
    send: (_id, text, opts) => {
      sent.push([text, opts]);
    },
    stop: () => {},
    queued: () => [],
    takeQueue: () => [],
    queueJson: () => [],
    steering: () => "now",
    followDefault: () => "queue",
    held: () => false,
    newThread: (repo) => store.createChat(blankChat({ repoId: repo })),
    reload: () => {},
    queuePromote: () => false,
    queueMove: () => false,
    queueUpdate: () => false,
    queueRemove: () => false,
    queueResume: () => {},
    recap: () => [null, null],
    unread: () => false,
    failed: () => false,
    opened: () => false,
    subsQueued: () => 0,
    queuedCount: () => 0,
    mainChat: () => null,
    forksOf: () => [],
  };
}

const PHONE_KEY = "a".repeat(64);

/** The PC a phone talks to, with a copy of a chat homed on "home" (this PC's id 1 for it, 7 there). */
function copyPc(name: string) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const store = Store.openAt(join(dir, "db.sqlite"));
  const hub = new Hub([], 0);
  hub.mesh.on = true;
  hub.mesh.me = { id: "pc:copy", name: "copy-pc" };
  hub.mesh.peers.set("pc:home", newPeer({ id: "pc:home", name: "home-pc", online: true, addr: "127.0.0.1:1" }));
  const home = hub.mesh.peers.get("pc:home");
  if (home) home.owner = "Kim Rig";
  hub.tokens.push({ token: "tok-phone", name: "Pixel 8", created: 0, group: PHONE_KEY, fp: PHONE_KEY, account: "user_1", account_name: "Sam Rig" });
  const replica = new StoreReplica({ store, hub, version: "t" });
  const copy = store.createChat(blankChat({ title: "theirs", gid: "g-copy", home: "pc:home", homeId: 7 }));
  hub.mesh.homes.set(copy.id, ["pc:home", 7]);
  const mesh = new Mesh({ hub, kv: new MemKv(), id: () => generateIdentity(), app: replica, myAddrs: () => [], uploadsDir: join(dir, "uploads"), upload: async () => err(404, "") });
  const routes = new PhoneRoutes({ store, hub, replica, mesh, version: "t", myFp: () => "", engine: null, uploadsDir: join(dir, "uploads") });
  const phone = (method: string, tail: string[], body: unknown = null, query: [string, string][] = []) =>
    routes.route({ method, path: ["v1", "chats", String(copy.id), ...tail], query, body, token: "tok-phone", device: "Pixel 8", global: false });
  return { dir, store, hub, replica, copy, mesh, routes, phone };
}

const homeDraft = (files: SharedDraft["files"]): SharedDraft => ({ text: "look at [Image 1]", files, mentions: [], by: "pc:home-desk", label: "home-pc", rev: 9, quiet: null, held: false });

describe("a phone on a copy of another PC's chat", () => {
  test("its attachment stays in its composer and reaches the home PC's agent", async () => {
    const pc = copyPc("attach");
    // The phone uploaded an image here, for this chat.
    mkdirSync(join(pc.dir, "uploads", String(pc.copy.id)), { recursive: true });
    writeFileSync(join(pc.dir, "uploads", String(pc.copy.id), "1-shot.png"), "png!");
    const id = `${pc.copy.id}/1-shot.png`;
    // The home PC's shared draft has the text but none of this PC's files (the lease forwards none):
    // the copy's draft leaves `files` out, so the phone keeps the image it attached.
    pc.replica.remote.set(pc.copy.id, { running: false, sinceMs: null, queued: 0, status: null, forks: [], typing: [], viewing: [], draft: homeDraft([]), worktree: null, pr: null, cwd: null });
    const items = (await pc.phone("GET", ["items"], null, [["since", "0"]])).body as { draft: Record<string, unknown> };
    expect(items.draft).toMatchObject({ text: "look at [Image 1]", rev: 9 });
    expect("files" in items.draft).toBe(false);

    // The send goes to the home PC with the image's bytes and who wrote it on which phone.
    const forwarded: { files: { name: string; data: Uint8Array }[]; sender: Sender; body: Record<string, unknown> }[] = [];
    pc.mesh.forward = async (_d, _name, _method, _path, body, files, sender) => {
      forwarded.push({ files, sender, body });
      return { status: 200, body: { ok: true, queued: false } };
    };
    expect((await pc.phone("POST", ["send"], { text: "look at [Image 1]", files: [id] })).status).toBe(200);
    expect(forwarded.length).toBe(1);
    expect(forwarded[0]?.files.map((f) => [f.name, Buffer.from(f.data).toString()])).toEqual([["1-shot.png", "png!"]]);
    expect(forwarded[0]?.sender).toEqual(["Pixel 8 (Sam Rig)", "", "Sam Rig", "phone", `phone:${PHONE_KEY}`]);
    expect("files" in (forwarded[0]?.body ?? {})).toBe(false);

    // At the home PC: the call with the upload's id there gives the agent the file and the phone's device id.
    const homeDir = join(tmp, "attach-home");
    mkdirSync(join(homeDir, "uploads", "pending"), { recursive: true });
    writeFileSync(join(homeDir, "uploads", "pending", "2-shot.png"), "png!");
    const homeStore = Store.openAt(join(homeDir, "db.sqlite"));
    const homeHub = new Hub([], 0);
    homeHub.mesh.peers.set("pc:copy", newPeer({ id: "pc:copy", name: "copy-pc", online: true }));
    const sent: [string, SendOpts][] = [];
    let homeRoutes: PhoneRoutes | null = null;
    const homeReplica = new StoreReplica({ store: homeStore, hub: homeHub, version: "t", route: (call) => (homeRoutes as PhoneRoutes).route(call) });
    homeRoutes = new PhoneRoutes({ store: homeStore, hub: homeHub, replica: homeReplica, mesh: null, version: "t", myFp: () => "", engine: engineFor(homeStore, sent), uploadsDir: join(homeDir, "uploads") });
    const own = homeStore.createChat(blankChat({ title: "theirs", gid: "g-copy" }));
    const call = { method: "POST", path: ["v1", "chats", String(own.id), "send"], body: { text: "look at [Image 1]", files: ["pending/2-shot.png"] }, sender: "Pixel 8 (Sam Rig)", device: "", who: "Sam Rig", via: "phone", dev: `phone:${PHONE_KEY}` };
    expect((await homeReplica.route({ method: "POST", path: ["mesh", "v1", "call"], query: [], body: call, token: "", device: "pc:copy", global: false })).status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0]?.[1]).toMatchObject({ files: [join(homeDir, "uploads", "pending", "2-shot.png")], sender: "Pixel 8 (Sam Rig)", who: "Sam Rig", via: "phone", dev: `phone:${PHONE_KEY}` });
    pc.store.close();
    homeStore.close();
  });

  test("this PC's own chats keep the draft's files", async () => {
    const pc = copyPc("own");
    const own = pc.store.createChat(blankChat({ title: "mine" }));
    pc.hub.setDraft(own.id, "tok:1", "Pixel 8", "hi", [{ id: `${own.id}/1-a.png`, name: "1-a.png", path: "/x/1-a.png" }], []);
    const items = (await pc.routes.route({ method: "GET", path: ["v1", "chats", String(own.id), "items"], query: [], body: null, token: "tok-phone", device: "Pixel 8", global: false })).body as { draft: { files: unknown[] } };
    expect(items.draft.files.length).toBe(1);
    pc.store.close();
  });

  test("its sender rows: the home PC's messages show its owner, its own none", async () => {
    const pc = copyPc("rows");
    const items: Item[] = [
      { kind: "user", text: "typed at home", files: [], at: 100, mentions: [], sender: "", intent: "" },
      { kind: "user", text: "from this phone", files: [], at: 200, mentions: [], sender: "Pixel 8 (Sam Rig)", intent: "", who: "Sam Rig", via: "phone", dev: `phone:${PHONE_KEY}` },
      { kind: "user", text: "from this phone, before devices", files: [], at: 210, mentions: [], sender: "Pixel 8 (Sam Rig)", intent: "", who: "Sam Rig", via: "phone" },
      { kind: "user", text: "another phone", files: [], at: 900, mentions: [], sender: "Galaxy (Alex Rig)", intent: "", who: "Alex Rig", via: "phone", dev: "phone:bbbb" },
    ];
    pc.store.saveItems(pc.copy.id, items);
    const got = (await pc.phone("GET", ["items"], null, [["since", "0"]])).body as { items: { text: string; sender: string; who?: string; via?: string; joined?: boolean }[] };
    expect(got.items.map((x) => [x.text, x.sender, x.who ?? "", x.via ?? "", x.joined === true])).toEqual([
      ["typed at home", "home-pc (Kim Rig)", "Kim Rig", "pc", false],
      ["from this phone", "", "", "", false],
      ["from this phone, before devices", "", "", "", true],
      ["another phone", "Galaxy (Alex Rig)", "Alex Rig", "phone", false],
    ]);
    pc.store.close();
  });

  test("an image of an agent's reply comes from the home PC, where the file is", async () => {
    const pc = copyPc("image");
    let asked = "";
    const s = createServer((c) => {
      let head = "";
      c.on("data", (d: Buffer) => {
        head += d.toString();
        if (!head.includes("\r\n\r\n")) return;
        asked = head.split("\r\n")[0] ?? "";
        c.end("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\njpg!");
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    stops.push(() => s.close());
    const home = pc.hub.mesh.peers.get("pc:home");
    if (home) home.addr = `127.0.0.1:${(s.address() as AddressInfo).port}`;
    const a = await pc.mesh.homeImage(pc.copy.id, "/run/user/1000/shot.jpeg", 512);
    expect(asked).toBe("GET /mesh/v1/image?path=%2Frun%2Fuser%2F1000%2Fshot.jpeg&max=512 HTTP/1.1");
    expect([a?.status, a?.ctype, Buffer.from(a?.body ?? []).toString()]).toEqual([200, "image/jpeg", "jpg!"]);
    // This PC's own chats, and a home that is off: answered here.
    const own = pc.store.createChat(blankChat({ title: "mine" }));
    expect(await pc.mesh.homeImage(own.id, "/run/user/1000/shot.jpeg", 512)).toBeNull();
    if (home) home.online = false;
    expect(await pc.mesh.homeImage(pc.copy.id, "/run/user/1000/shot.jpeg", 512)).toBeNull();
    pc.store.close();
  });
});

