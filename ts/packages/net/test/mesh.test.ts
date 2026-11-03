import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Engine } from "@harbor/agents";
import { blankChat, Store, type Item } from "@harbor/store";
import { Api } from "../src/api.ts";
import { http, httpPart, setHello } from "../src/client.ts";
import { err, type Request } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { forHome, ipsAndPort, MEDIA_PART, Mesh, parseMe, readMe, parseWhois, partOf, showCode, startsTurn, statusNode } from "../src/mesh.ts";
import { StoreReplica, type StoreReplicaOptions, sameRemote } from "../src/meshstore.ts";
import { relayServe } from "../src/relay.ts";
import { admit, allowedKey, cleanAddrs, downOf, label, loadAllowed, peerId, type Allowed, type Node } from "../src/shared.ts";
import { generateIdentity, type Identity } from "../src/tls.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-mesh-"));
const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
  rmSync(tmp, { recursive: true, force: true });
});

const req = (headers: [string, string][] = []): Request => ({ method: "GET", path: "/", query: [], headers, len: 0, chunked: false });

function meshOf(hub: Hub, kv = new MemKv()): Mesh {
  return new Mesh({
    hub,
    kv,
    id: () => null,
    app: {
      helloExtra: () => ({ version: "", accounts: [], update: null, owner: "", github: "", owner_suggested: false }),
      chats: () => ({ chats: [], update: null }),
      items: () => null,
      applyChats: () => [],
      applyItems: () => {},
      route: async () => err(404, "unknown mesh call"),
    },
    myAddrs: () => [],
    uploadsDir: tmp,
    upload: async () => err(404, "no"),
  });
}

describe("mesh.rs", () => {
  test("why_a_peer_is_down", () => {
    expect(downOf(["Connection refused (os error 111)"])).toBe("harbor");
    expect(downOf(["connection timed out", "Connection refused (os error 111)"])).toBe("harbor");
    expect(downOf(["connection timed out", "No route to host (os error 113)"])).toBe("pc");
    expect(downOf([])).toBe("pc");
  });

  test("a_fresh_mesh_id_is_the_magicdns_name_else_the_hostname_and_is_kept", () => {
    const tailnet = { Self: { DNSName: "desk.example.ts.net.", ID: "n" } };
    const kv = new MemKv();
    expect(readMe(kv, {}, () => tailnet)).toEqual({ id: "ts:desk", name: "desk" });
    expect(kv.get("mesh_id")).toBe("ts:desk");
    expect(readMe(kv, {}, () => ({}))).toEqual({ id: "ts:desk", name: "desk" });
    const bare = new MemKv();
    expect(readMe(bare, {}, () => ({})).id).toMatch(/^pc:./);
    expect(readMe(new MemKv(), { HARBOR_MESH_ID: "ts:x", HARBOR_MESH_NAME: "Ex" }, () => tailnet)).toEqual({ id: "ts:x", name: "Ex" });
  });

  test("identity_from_tailscale", () => {
    const [me, node] = parseMe({ Self: { DNSName: "desk.example.ts.net.", UserID: 42, ID: "nDESK", Tags: ["tag:home"] } });
    expect(me).toEqual({ id: "ts:desk", name: "desk" });
    expect(node).toEqual({ id: "nDESK", label: "desk", user: 42, tagged: true });
    expect(parseMe({})[0]).toEqual({ id: "", name: "" });
    expect(statusNode({ ID: "nLAP", DNSName: "laptop.example.ts.net.", UserID: 7 })).toEqual({ id: "nLAP", label: "laptop", user: 7, tagged: false });
  });

  test("who_gets_in", () => {
    const whois = (id: string, user: number, tags: unknown) => ({ Node: { StableID: id, Name: `${id}.example.ts.net.`, Tags: tags }, UserProfile: { ID: user } });
    const me: Node = { id: "nME", label: "me", user: 42, tagged: false };
    const same = parseWhois(whois("nA", 42, null)) as Node;
    const other = parseWhois(whois("nB", 7, null)) as Node;
    const tagged = parseWhois(whois("nC", 42, ["tag:home"])) as Node;
    expect([same.label, same.user, same.tagged]).toEqual(["nA", 42, false]);
    expect(admit(me, same, [])).toBe(true);
    expect(admit(me, other, [])).toBe(false);
    expect(admit(me, tagged, [])).toBe(false);
    const allowed: Allowed[] = [
      { node: "nB", name: "b", fp: "", id: "", addrs: [] },
      { node: "nC", name: "c", fp: "", id: "", addrs: [] },
    ];
    expect(admit(me, other, allowed) && admit(me, tagged, allowed)).toBe(true);
    const taggedMe = { ...me, tagged: true };
    expect(admit(taggedMe, same, [])).toBe(false);
    expect(admit(taggedMe, same, [{ node: "nA", name: "", fp: "", id: "", addrs: [] }])).toBe(true);
    expect(admit(null, { id: "", label: "", user: null, tagged: false }, allowed)).toBe(false);
    expect(parseWhois({})).toBeNull();
  });

  test("allowed_list_reads_entries_from_before_keys", () => {
    const old = loadAllowed(new MemKv({ mesh_allowed: '[{"node":"nB","name":"laptop"}]' }));
    expect(old[0]).toEqual({ node: "nB", name: "laptop", fp: "", id: "", addrs: [] });
    expect(allowedKey(old[0] as Allowed)).toBe("nB");
    const a: Allowed = { node: "", name: "", fp: "c".repeat(64), id: "", addrs: [] };
    expect(allowedKey(a)).toBe("c".repeat(64));
    expect(peerId(a)).toBe(`fp:${"c".repeat(16)}`);
    expect(peerId({ ...a, id: "ts:laptop" })).toBe("ts:laptop");
  });

  test("peers_addresses_are_checked", () => {
    const v = ["10.0.0.5:47930", "[fd00::5]:47930", "nonsense", "0.0.0.0:1", "10.0.0.5:47930", "[::ffff:10.0.0.6]:47931", "224.0.0.1:5"];
    expect(cleanAddrs(v)).toEqual(["10.0.0.5:47930", "[fd00::5]:47930", "10.0.0.6:47931"]);
    expect(ipsAndPort(["10.0.0.5:47931", "[fd00::5]:47931", "10.0.0.5:47931", "203.0.113.7:47940"])).toEqual([["10.0.0.5", "fd00::5", "203.0.113.7:47940"], 47931]);
  });

  test("who_by_key", async () => {
    const hub = new Hub([], 0);
    const m = meshOf(hub);
    const fp = "d".repeat(64);
    hub.mesh.allowed = [{ node: "", fp, id: "pc:laptop", name: "laptop", addrs: ["10.0.0.7:47931"] }];
    const at = (via: import("../src/hub.ts").Via) => ({ ip: "10.0.0.8", via });
    expect(m.who(at({ kind: "tls", fp }), req())).toBe("pc:laptop");
    expect(hub.mesh.hints.get(fp)).toEqual(["10.0.0.8:47931"]);
    expect(m.who(at({ kind: "tls", fp: "e".repeat(64) }), req())).toBeNull();
    expect(hub.mesh.seen.has("e".repeat(64))).toBe(true);
    expect(m.who(at({ kind: "tls", fp: null }), req())).toBeNull();
    expect(m.who(at({ kind: "refused" }), req())).toBeNull();
    expect(http({ addr: "10.0.0.9:47930", fp: "" }, "GET", "/mesh/v1/hello", null, 1000)).rejects.toThrow("not sent");
  });

  test("a_range_goes_to_the_other_pc_and_back", async () => {
    let head = "";
    const s = createServer((c) => {
      c.on("data", (d: Buffer) => {
        head += d.toString();
        if (head.includes("\r\n\r\n")) c.end("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 4\r\nContent-Range: bytes 0-3/90000000\r\nConnection: close\r\n\r\nmp4!");
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    stops.push(() => s.close());
    const addr = `127.0.0.1:${(s.address() as AddressInfo).port}`;
    const a = await httpPart({ addr, fp: "" }, "GET", "/mesh/v1/media?path=%2Fa.mp4", null, partOf("bytes=0-"), 5000);
    expect([a.status, a.ctype, a.range, Buffer.from(a.body).toString()]).toEqual([206, "video/mp4", "bytes 0-3/90000000", "mp4!"]);
    expect(head).toContain(`Range: bytes=0-${MEDIA_PART - 1}\r\n`);
  });

  test("a_ranged_mesh_answer_stays_small", () => {
    expect(partOf("bytes=0-")).toBe(`bytes=0-${MEDIA_PART - 1}`);
    expect(partOf("bytes=100-199")).toBe("bytes=100-199");
    expect(partOf(`bytes=5-${200 << 20}`)).toBe(`bytes=5-${5 + MEDIA_PART - 1}`);
    expect(partOf("bytes=-500")).toBe("bytes=-500");
  });

  test("labels", () => {
    expect(label("ts:desk")).toBe("desk");
    expect(label("desk")).toBe("desk");
  });

  test("a_copys_home_answers_writes_and_its_slash_menu", () => {
    for (const [m, p] of [
      ["POST", "v1/chats/7/send"],
      ["PATCH", "v1/chats/7"],
      ["DELETE", "v1/chats/7"],
      ["POST", "v1/chats/7/slash"],
      ["GET", "v1/chats/7/slash"],
      ["GET", "v1/chats/7/commit/35cbb88"],
    ] as const)
      expect(forHome(m, p.split("/"))).toBe(true);
    for (const [m, p] of [
      ["GET", "v1/chats/7/items"],
      ["GET", "v1/chats/7/team"],
      ["GET", "v1/state"],
      ["POST", "v1/chats"],
      ["POST", "v1/upload"],
      ["POST", "v1/chats/7/mention"],
      ["GET", "v1/chats/7/mention"],
      ["POST", "v1/chats/7/snooze"],
      ["DELETE", "v1/chats/7/snooze"],
      ["GET", "v1/snooze"],
      // Move to workspace…: WorkspaceMoves sends a copy's home itself, then keeps it here too.
      ["POST", "v1/chats/7/workspace"],
      ["GET", "v1/chats/7/workspaces"],
      // Share with workspace…: the same.
      ["POST", "v1/chats/7/share"],
      ["GET", "v1/chats/7/shares"],
    ] as const)
      expect(forHome(m, p.split("/"))).toBe(false);
  });

  test("a_copys_queue_calls_go_home", () => {
    for (const [m, p] of [
      ["POST", "v1/chats/7/queue/3/steer"],
      ["POST", "v1/chats/7/queue/3/move"],
      ["PATCH", "v1/chats/7/queue/3"],
      ["DELETE", "v1/chats/7/queue/3"],
      ["POST", "v1/chats/7/resume"],
      ["POST", "v1/chats/7/stop"],
    ] as const)
      expect(forHome(m, p.split("/"))).toBe(true);
    expect(startsTurn("POST", ["queue", "3", "steer"])).toBe(true);
    expect(startsTurn("POST", ["resume"])).toBe(true);
    expect(startsTurn("POST", ["queue", "3", "move"])).toBe(false);
    expect(startsTurn("DELETE", ["queue", "3"])).toBe(false);
  });

  test("remotes match by host and path", () => {
    expect(sameRemote("git@github.com:o/r.git", "https://github.com/O/r")).toBe(true);
    expect(sameRemote("ssh://git@example.org:2222/o/r", "ssh://git@example.org:2222/o/r.git")).toBe(true);
    expect(sameRemote("", "")).toBe(false);
  });

  test("a copy's project with no folder here learns the remote its home sends, one here keeps its own", async () => {
    const store = Store.openAt(join(tmp, "learn.db"));
    const away = store.addRepo("/nowhere/owner/app");
    const here = store.addRepo(tmp);
    store.setRepoRemote(here, "git@example.org:me/mine.git");
    const replica = new StoreReplica({ store, hub: new Hub([], 0), version: "t" });
    const copy = (id: number, path: string, name: string, remote: string) => ({ id, gid: `g${id}`, title: "t", project: { path, name, remote } });
    await replica.applyChats("pc:home", 1, { chats: [copy(1, "/nowhere/owner/app", "app", "git@example.org:o/app.git"), copy(2, "/elsewhere/x", basename(tmp), "git@example.org:o/other.git")] });
    const remotes = new Map(store.repos().map((r) => [r.id, r.remote]));
    expect(remotes.get(away)).toBe("git@example.org:o/app.git");
    expect(remotes.get(here)).toBe("git@example.org:me/mine.git");
    store.close();
  });

  test("move to workspace goes with the chat JSON: the chat's own and its project's, to every copy", async () => {
    const home = Store.openAt(join(tmp, "ws-home.db"));
    const repo = home.addRepo("/nowhere/home/app");
    const lead = home.createChat(blankChat({ repoId: repo, title: "lead", role: "lead" }));
    const other = home.createChat(blankChat({ repoId: repo, title: "other", role: "lead" }));
    home.setChatWorkspace(lead.id, "org_b");
    home.setRepoWorkspace(repo, "org_c");
    const sent = (await new StoreReplica({ store: home, hub: new Hub([], 0), version: "t" }).chats(0, true)).chats as { id: number; workspace: string; project: { workspace: string } }[];
    expect(sent.map((c) => [c.id, c.workspace, c.project.workspace])).toEqual([[lead.id, "org_b", "org_c"], [other.id, "", "org_c"]]);
    const copy = Store.openAt(join(tmp, "ws-copy.db"));
    const mine = copy.addRepo(tmp);
    copy.setRepoWorkspace(mine, "org_mine");
    const replica = new StoreReplica({ store: copy, hub: new Hub([], 0), version: "t" });
    await replica.applyChats("pc:home", 1, { full: true, chats: sent });
    const local = (hid: number) => copy.chats().find((c) => c.homeId === hid)?.id ?? -1;
    let place = copy.placement();
    expect(place.chats.get(local(lead.id))).toBe("org_b");
    expect(place.chats.has(local(other.id))).toBe(false);
    expect(place.carried.get(local(lead.id))).toBe("org_c");
    expect(place.carried.get(local(other.id))).toBe("org_c");
    // The project there (no folder here) takes it too; this PC's own project keeps its own.
    const away = copy.repos().find((r) => r.path === "/nowhere/home/app")?.id ?? -1;
    expect(place.repos.get(away)).toBe("org_c");
    expect(place.repos.get(mine)).toBe("org_mine");
    // Moved back at home: the copies hear it with the next list (an older PC sends no field: none).
    await replica.applyChats("pc:home", 1, { full: true, chats: sent.map((c) => ({ ...c, workspace: "", project: { ...c.project, workspace: "" } })) });
    place = copy.placement();
    expect([place.chats.size, place.carried.size, place.repos.get(away)]).toEqual([0, 0, undefined]);
    home.close();
    copy.close();
  });

  test("share with workspace goes with the chat JSON: the chat's own shares and its project's, to every copy", async () => {
    const home = Store.openAt(join(tmp, "share-home.db"));
    const repo = home.addRepo("/nowhere/home/shared");
    const lead = home.createChat(blankChat({ repoId: repo, title: "lead", role: "lead" }));
    const other = home.createChat(blankChat({ repoId: repo, title: "other", role: "lead" }));
    home.setChatWorkspace(lead.id, "org_a");
    home.setChatShares(lead.id, ["org_b", "org_c"]);
    home.setRepoShares(repo, ["org_d"]);
    const sent = (await new StoreReplica({ store: home, hub: new Hub([], 0), version: "t" }).chats(0, true)).chats as { id: number; shared: string[]; project: { shared: string[] } }[];
    expect(sent.map((c) => [c.id, c.shared, c.project.shared])).toEqual([[lead.id, ["org_b", "org_c"], ["org_d"]], [other.id, [], ["org_d"]]]);
    const copy = Store.openAt(join(tmp, "share-copy.db"));
    const replica = new StoreReplica({ store: copy, hub: new Hub([], 0), version: "t" });
    await replica.applyChats("pc:home", 1, { full: true, chats: sent });
    const local = (hid: number) => copy.chats().find((c) => c.homeId === hid)?.id ?? -1;
    let place = copy.placement();
    // The owner stays what the home PC says; the shares come along beside it.
    expect(place.chats.get(local(lead.id))).toBe("org_a");
    expect(place.shared?.chats.get(local(lead.id))).toEqual(["org_b", "org_c"]);
    expect(place.shared?.chats.has(local(other.id))).toBe(false);
    expect(place.shared?.carried.get(local(other.id))).toEqual(["org_d"]);
    const away = copy.repos().find((r) => r.path === "/nowhere/home/shared")?.id ?? -1;
    expect(place.shared?.repos.get(away)).toEqual(["org_d"]);
    // Unshared at home: the copies hear it with the next list.
    await replica.applyChats("pc:home", 1, { full: true, chats: sent.map((c) => ({ ...c, shared: [], project: { ...c.project, shared: [] } })) });
    place = copy.placement();
    expect([place.shared?.chats.size, place.shared?.carried.size, place.shared?.repos.get(away)]).toEqual([0, 0, undefined]);
    home.close();
    copy.close();
  });

  test("a project made from another PC's chats remembers that PC, even once no copy is left", async () => {
    const store = Store.openAt(join(tmp, "place.db"));
    const replica = new StoreReplica({ store, hub: new Hub([], 0), version: "t" });
    const copy = (id: number, path: string) => ({ id, gid: `p${id}`, title: "t", project: { path, name: "blox", remote: "" } });
    await replica.applyChats("pc:laptop", 1, { chats: [copy(1, "/home/someone/Documents/blox")] });
    const made = store.repos().find((r) => r.path === "/home/someone/Documents/blox");
    if (!made) throw new Error("no project made");
    expect(store.projectPc(made.id)).toBe("pc:laptop");
    // Another PC's copy that only matches by name doesn't take it over; one naming the same folder does.
    await replica.applyChats("pc:desk", 1, { chats: [{ id: 7, gid: "p7", title: "t", project: { path: "/srv/blox", name: "blox", remote: "" } }] });
    expect(store.projectPc(made.id)).toBe("pc:laptop");
    await replica.applyChats("pc:desk", 1, { chats: [copy(8, "/home/someone/Documents/blox")] });
    expect(store.projectPc(made.id)).toBe("pc:desk");
    // Every copy gone: still remembered.
    await replica.applyChats("pc:desk", 2, { full: true, chats: [] });
    await replica.applyChats("pc:laptop", 2, { full: true, chats: [] });
    expect(store.chats().filter((c) => c.repoId === made.id)).toEqual([]);
    expect(store.projectPc(made.id)).toBe("pc:desk");
    store.close();
  });

  test("a chat's published cwd is where its agent works, its worktree before its project", async () => {
    const store = Store.openAt(join(tmp, "cwd.db"));
    const repo = store.addRepo(tmp);
    store.createChat(blankChat({ repoId: repo, title: "in a worktree" }));
    const cwdOf = async (o: { cwd?: () => string | null }) => ((await new StoreReplica({ store, hub: new Hub([], 0), version: "t", ...o }).chats(0, true)).chats as { cwd: string }[])[0]?.cwd;
    expect(await cwdOf({ cwd: () => "/wt/app-fix" })).toBe("/wt/app-fix");
    expect(await cwdOf({ cwd: () => null })).toBe(tmp);
    expect(await cwdOf({})).toBe(tmp);
    store.close();
  });
});

interface Pc {
  id: Identity;
  hub: Hub;
  store: Store;
  mesh: Mesh;
  replica: StoreReplica;
  port: number;
  heard: (number | null)[];
}

async function pc(name: string, live?: StoreReplicaOptions["live"]): Promise<Pc> {
  const id = generateIdentity();
  const store = Store.openAt(join(tmp, `${name}.db`));
  const hub = new Hub([], 0);
  hub.mesh.me = { id: `pc:${name}`, name };
  store.set("mesh_enabled", "1");
  const heard: (number | null)[] = [];
  const replica = new StoreReplica({ store, hub, version: "0.0.0-test", copied: (chat) => void heard.push(chat), ...(live ? { live } : {}) });
  let api: Api | null = null;
  const mesh = new Mesh({
    hub,
    kv: store,
    id: () => id,
    app: replica,
    myAddrs: () => [],
    uploadsDir: join(tmp, name),
    upload: async (r, q) => (api ? api.upload(r, q) : err(503, "")),
  });
  hub.mesh.on = true;
  api = new Api({
    hub,
    id: () => id,
    uploadsDir: join(tmp, name),
    route: async () => err(404, "no such call"),
    account: null,
    appInfo: () => null,
    apk: () => null,
    mesh: (p, q, r) => mesh.serve(p, q, r),
    meshAdmitted: (p, q) => mesh.admitted(p, q),
    relay: (p, q, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: () => false }, p, q, r, w),
    hubs: () => mesh.hubs(),
  });
  await api.listen(["127.0.0.1"]);
  hub.port = api.port();
  const a = api;
  stops.push(() => {
    mesh.stop();
    a.close();
  });
  return { id, hub, store, mesh, replica, port: hub.port, heard };
}

async function until(f: () => boolean, ms = 15_000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (f()) return true;
    await Bun.sleep(50);
  }
  return f();
}

describe("two TypeScript PCs", () => {
  test("pair with a code, then each holds a copy of the other's chat, and edits follow", async () => {
    const a = await pc("alpha");
    const b = await pc("beta");
    const item = (t: string): Item => ({ kind: "text", text: t, at: 1 });
    const own = a.store.createChat(blankChat({ title: "On alpha", role: "lead", name: "lead" }));
    a.store.saveItems(own.id, [item("one")]);
    // Pairing: B shows a code, A types it. Each side ends up allowing the other.
    const code = showCode(b.store);
    setHello("pc:alpha", "alpha", a.id);
    const entry = await a.mesh.pairJoin(`127.0.0.1:${b.port}`, code.code.toLowerCase());
    expect(entry.fp).toBe(b.id.fp);
    expect(loadAllowed(b.store).map((x) => x.fp)).toEqual([a.id.fp]);
    expect(loadAllowed(a.store)[0]?.addrs[0]).toBe(`127.0.0.1:${b.port}`);
    // A used code is gone; a wrong code is refused and counted.
    expect(a.mesh.pairJoin(`127.0.0.1:${b.port}`, code.code)).rejects.toThrow("no pairing code");
    a.replica.reload();
    a.mesh.start();
    b.mesh.start();
    const copied = await until(() => b.store.chats().some((c) => c.home === "pc:alpha" && b.store.items(c.id).length === 1));
    expect(copied).toBe(true);
    const copy = b.store.chats().find((c) => c.home === "pc:alpha");
    expect([copy?.title, copy?.gid, copy?.homeId]).toEqual(["On alpha", own.gid, own.id]);
    expect(b.hub.mesh.peer("pc:alpha")?.online).toBe(true);
    // A new reply on alpha reaches the copy through the long-poll.
    a.store.saveItems(own.id, [item("one"), item("two")]);
    a.replica.touch(own.id);
    const grown = await until(() => {
      const c = b.store.chats().find((x) => x.home === "pc:alpha");
      return c !== undefined && b.store.items(c.id).length === 2;
    });
    expect(grown).toBe(true);
    // The window hears of both: the list of copies and the copy's new items.
    expect(b.heard).toContain(null);
    expect(b.heard).toContain(copy?.id ?? -1);
    // The copy is never served back as its own, and the hubs list knows the peer.
    expect((await b.replica.chats(0, true)).chats).toEqual([]);
    const hubs = b.mesh.hubs() as { hubs: { id: string; online: boolean }[] };
    expect(hubs.hubs.map((h) => [h.id, h.online])).toEqual([
      ["pc:beta", true],
      ["pc:alpha", true],
    ]);
  }, 30_000);

  test("a sub-agent working on its home PC reads as working on the other, and idle once it ends", async () => {
    const turns = new Map<number, number>();
    const a = await pc("gamma", (chat) => {
      const at = turns.get(chat);
      return at === undefined ? null : { running: true, sinceMs: at, queued: 0, status: null };
    });
    const b = await pc("delta");
    const lead = a.store.createChat(blankChat({ title: "Lead", role: "lead", name: "lead" }));
    const sub = a.store.createChat(blankChat({ title: "Usage", role: "sub", name: "usage-ts", parent: lead.id }));
    const code = showCode(b.store);
    setHello("pc:gamma", "gamma", a.id);
    await a.mesh.pairJoin(`127.0.0.1:${b.port}`, code.code.toLowerCase());
    a.replica.reload();
    a.mesh.start();
    b.mesh.start();
    const e = new Engine({ store: b.store, accounts: () => [], changed: () => {}, isForeign: (id) => b.hub.mesh.foreign.has(id), copyTurn: (id) => b.replica.remote.get(id) ?? null });
    const copyOf = (hid: number) => b.store.chats().find((c) => c.home === "pc:gamma" && c.homeId === hid);
    expect(await until(() => copyOf(sub.id) !== undefined && copyOf(lead.id) !== undefined)).toBe(true);
    e.reload();
    const [cl, cs] = [copyOf(lead.id)?.id ?? -1, copyOf(sub.id)?.id ?? -1];
    expect(e.liveSubs(cl)).toEqual([]);
    const at = Date.now() - 180_000;
    turns.set(sub.id, at);
    a.replica.touch(sub.id);
    expect(await until(() => e.liveSince(cs) === at)).toBe(true);
    expect(e.liveSubs(cl).map(([c]) => c.id)).toEqual([cs]);
    expect(e.teamStarted(cl)).toBe(at);
    expect(e.running(cs)).toBe(false);
    turns.delete(sub.id);
    a.replica.touch(sub.id);
    expect(await until(() => !e.live(cs))).toBe(true);
    expect(e.teamStarted(cl)).toBeNull();
  }, 30_000);
});
