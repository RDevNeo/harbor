import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftFileOf, Hub, type Mesh, type PhoneRoutes, type RemoteState, type Reply, type SharedDraft, type StoreReplica } from "../packages/net/src/index.ts";
import type { Chat } from "../packages/store/src/index.ts";
import { WindowMesh } from "../windowmesh.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-windowmesh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const chat = (id: number, home = ""): Chat => ({ id, home, homeId: home === "" ? 0 : 70 + id, repoId: null }) as unknown as Chat;

/** A window's mesh side over a real hub: chat 1 is this PC's, chat 2 a copy of another PC's. */
function rig(name: string) {
  const dir = join(tmp, name);
  const uploads = join(dir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const hub = new Hub([], 0);
  const remote = new Map<number, RemoteState>();
  const leases: unknown[] = [];
  const mesh = { forwardLease: (...a: unknown[]) => leases.push(a) } as unknown as Mesh;
  const chats = new Map([
    [1, chat(1)],
    [2, chat(2, "pc:home")],
  ]);
  const w = new WindowMesh({
    hub,
    mesh,
    replica: { remote } as unknown as StoreReplica,
    phone: {} as PhoneRoutes,
    chat: (id) => chats.get(id),
    ctx: () => null,
    ownerName: () => null,
    env: { HARBOR_MESH_ID: "desk" },
    uploadsDir: uploads,
  });
  return { dir, uploads, hub, remote, leases, w };
}

describe("the window's shared draft", () => {
  test("a desktop send empties the draft the phone sees (it kept the sent text before)", () => {
    const r = rig("send");
    r.w.lease(1, false, "pc", true, { text: "ship it", mentions: [] });
    expect(r.hub.draft(1)).toMatchObject({ text: "ship it", by: "pc:desk" });
    const typed = (r.hub.draft(1) as SharedDraft).rev;
    r.w.sent(1);
    const d = r.hub.draft(1) as SharedDraft;
    expect([d.text, d.by, d.rev > typed]).toEqual(["", "", true]);
    expect(r.hub.typing(1)).toEqual([]);
    expect(r.w.draft(1)).toEqual({ text: "", files: [], mentions: [], by: "", rev: d.rev });
    // A copy's draft is cleared by its home PC when the message gets there, not here.
    r.w.sent(2);
    expect(r.hub.draft(2)).toBeNull();
  });

  test("files attached in the window reach the phone, and the phone's reach the window", () => {
    const r = rig("files");
    const pic = join(r.dir, "pic.png");
    writeFileSync(pic, "png!");
    r.w.lease(1, false, "pc", true, { text: "see [Image 1]", mentions: [], files: [pic] });
    const d = r.hub.draft(1) as SharedDraft;
    expect(d.files).toHaveLength(1);
    const f = d.files[0]!;
    expect(f.id.startsWith("1/")).toBe(true);
    // Hard-linked into the uploads folder: the phone shows and sends it by its upload id.
    expect(statSync(f.path).ino).toBe(statSync(pic).ino);
    expect(readFileSync(f.path, "utf8")).toBe("png!");
    // The window gets its own path back, not the link's.
    expect(r.w.draft(1)?.files).toEqual([pic]);
    // Reported again: the same link, no second one.
    r.w.lease(1, false, "pc", true, { text: "see [Image 1] now", mentions: [], files: [pic] });
    expect((r.hub.draft(1) as SharedDraft).files.map((x) => x.id)).toEqual([f.id]);

    // The phone attaches an image of its own (an upload on the hub) and writes on.
    mkdirSync(join(r.uploads, "1"), { recursive: true });
    writeFileSync(join(r.uploads, "1", "5-cam.jpg"), "jpg!");
    r.hub.report(1, "tok:1", "phone", "Galaxy", true, { text: "see [Image 1] [Image 2]", files: [f.id, "1/5-cam.jpg"], mentions: [] }, (id) => draftFileOf(r.uploads, id));
    expect(r.w.draft(1)).toMatchObject({ text: "see [Image 1] [Image 2]", files: [pic, join(r.uploads, "1", "5-cam.jpg")], by: "tok:1" });
  });

  test("a copy's draft gives text and mentions; its files only when a message took them", () => {
    const r = rig("copy");
    const base = { running: false, sinceMs: null, queued: 0, status: null, forks: [], typing: [], viewing: [], worktree: null, pr: null, cwd: null } as unknown as RemoteState;
    const home: SharedDraft = { text: "from the phone", files: [{ id: "9/1-a.png", name: "1-a.png", path: "/home-pc/uploads/9/1-a.png" }], mentions: [{ item: 1 }], by: "tok:9", label: "Galaxy", rev: 50, quiet: null, held: false };
    r.remote.set(2, { ...base, draft: home });
    expect(r.w.draft(2)).toEqual({ text: "from the phone", files: null, mentions: [{ item: 1 }], by: "tok:9", rev: 50 });
    r.remote.set(2, { ...base, draft: { ...home, text: "", files: [], mentions: [], by: "", label: "", rev: 51 } });
    expect(r.w.draft(2)).toEqual({ text: "", files: [], mentions: [], by: "", rev: 51 });
    // The window's lease for a copy goes to the home PC (files stay here: they're forwarded with the message).
    r.w.lease(2, false, "pc", true, { text: "hi", mentions: [], files: ["/x.png"] });
    expect(r.leases).toHaveLength(1);
  });

  test("watch calls back with the chats whose draft moved", async () => {
    const r = rig("watch");
    const got: number[][] = [];
    r.w.watch((c) => got.push(c));
    await Bun.sleep(5);
    r.hub.report(1, "tok:1", "phone", "Galaxy", true, { text: "hello", files: [], mentions: [] }, () => null);
    for (let i = 0; i < 50 && got.length === 0; i++) await Bun.sleep(10);
    expect(got.flat()).toContain(1);
  });
});

describe("run anywhere: the window's message for a copy", () => {
  function sendRig(claim: Reply | null, picked: string | null) {
    const hub = new Hub([], 0);
    hub.mesh.me = { id: "pc:desk", name: "Desk" };
    hub.mesh.on = true;
    for (const [id, name] of [["pc:home", "Home"], ["pc:laptop", "Laptop"]] as const) hub.mesh.peers.set(id, { id, name, online: true, addr: "", fp: "", via: undefined } as never);
    const calls: { to: string; path: string; body: Record<string, unknown> }[] = [];
    const mesh = {
      forward: async (d: { addr: string }, name: string, _m: string, path: string[], body: Record<string, unknown>) => {
        calls.push({ to: name, path: path.join("/"), body });
        return { status: 200, body: { ok: true } };
      },
    } as unknown as Mesh;
    const claims: number[] = [];
    const w = new WindowMesh({
      hub,
      mesh,
      replica: { remote: new Map() } as unknown as StoreReplica,
      phone: {} as PhoneRoutes,
      chat: () => undefined,
      ctx: () => null,
      ownerName: () => null,
      env: { HARBOR_MESH_ID: "desk" },
      failover: {
        line: () => null,
        send: async () => ({ status: 200, body: {} }),
        claim: async (c) => {
          claims.push(c.id);
          return claim;
        },
        picked: () => picked,
      },
    });
    const copy = { ...chat(2, "pc:home"), gid: "g-2" } as Chat;
    return { w, calls, claims, copy };
  }

  test("it comes here: the window doesn't send it to the chat's PC", async () => {
    const r = sendRig({ status: 200, body: { ok: true, here: true } }, null);
    const out = await r.w.forward(r.copy, "POST", ["send"], { text: "hi" });
    expect(out.status).toBe(200);
    expect(r.claims).toEqual([2]);
    expect(r.calls).toEqual([]);
  });

  test("it stays (runs there now): the message goes to its PC", async () => {
    const r = sendRig(null, null);
    await r.w.forward(r.copy, "POST", ["send"], { text: "hi" });
    expect(r.calls.map((c) => [c.to, c.path])).toEqual([["Home", "v1/chats/72/send"]]);
  });

  test("picked to run on a third PC: that PC is asked to take it", async () => {
    const r = sendRig(null, "pc:laptop");
    await r.w.forward(r.copy, "POST", ["send"], { text: "hi" });
    expect(r.calls.map((c) => [c.to, c.path, c.body.claim_to])).toEqual([["Laptop", "v1/chats/g-2/send", "pc:laptop"]]);
  });
});

describe("a copy whose PC is off", () => {
  function offRig(adopt: (c: Chat) => Chat | string) {
    const hub = new Hub([], 0);
    hub.mesh.on = true;
    hub.mesh.peers.set("pc:home", { id: "pc:home", name: "Home", online: false, addr: "", fp: "" } as never);
    const forwarded: string[] = [];
    const routed: { method: string; path: string; body: unknown }[] = [];
    const adopted: number[] = [];
    const w = new WindowMesh({
      hub,
      mesh: { forward: async (_d: unknown, _n: string, _m: string, path: string[]) => (forwarded.push(path.join("/")), { status: 200, body: {} }) } as unknown as Mesh,
      replica: { remote: new Map() } as unknown as StoreReplica,
      phone: { route: async (call: { method: string; path: string[]; body: unknown }) => (routed.push({ method: call.method, path: call.path.join("/"), body: call.body }), { status: 200, body: { ok: true } }) } as unknown as PhoneRoutes,
      chat: () => undefined,
      ctx: () => null,
      ownerName: () => null,
      env: { HARBOR_MESH_ID: "desk" },
      failover: {
        line: () => null,
        send: async () => ({ status: 200, body: { ok: true, failover: "Desk" } }),
        adopt: (c) => (adopted.push(c.id), adopt(c)),
      },
    });
    return { w, forwarded, routed, adopted };
  }
  const copy = chat(2, "pc:home");

  test("settle, rename and delete become this PC's and are made here; never the read-only refusal", async () => {
    const r = offRig((c) => ({ ...c, home: "", homeId: 0 }) as Chat);
    for (const [m, body] of [["PATCH", { settled: true }], ["PATCH", { title: "New" }], ["DELETE", {}]] as const) {
      const out = await r.w.forward(copy, m, [], body);
      expect(out.status).toBe(200);
    }
    expect(r.routed.map((x) => [x.method, x.path])).toEqual([
      ["PATCH", "v1/chats/2"],
      ["PATCH", "v1/chats/2"],
      ["DELETE", "v1/chats/2"],
    ]);
    expect(r.forwarded).toEqual([]);
    // A stop has nothing to stop; a message goes through failover.
    expect((await r.w.forward(copy, "POST", ["stop"], { hold: true })).status).toBe(200);
    expect((await r.w.forward(copy, "POST", ["send"], { text: "hi" })).body).toEqual({ ok: true, failover: "Desk" });
    expect(r.adopted).toEqual([2, 2, 2]);
  });

  test("a change this PC can't take says why", async () => {
    const r = offRig(() => "Home is off, and it isn't one of the PCs this account uses");
    const out = await r.w.forward(copy, "PATCH", [], { settled: true });
    expect(out).toEqual({ status: 409, body: { error: "Home is off, and it isn't one of the PCs this account uses" } });
    expect(JSON.stringify(out)).not.toContain("read-only");
  });
});
