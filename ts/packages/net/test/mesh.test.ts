import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Engine } from "@harbor/agents";
import { blankChat, Store, wssettings, type Item } from "@harbor/store";
import { Api } from "../src/api.ts";
import { http, httpPart, setHello } from "../src/client.ts";
import { err, type Request } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { cleanPcName, forHome, ipsAndPort, loadPeers, MEDIA_PART, Mesh, parseMe, readMe, renamePc, parseWhois, partOf, startsTurn, statusNode } from "../src/mesh.ts";
import { StoreReplica, type StoreReplicaOptions, sameRemote } from "../src/meshstore.ts";
import { takesMainFrom } from "../src/projectfold.ts";
import { relayServe } from "../src/relay.ts";
import { allowedKey, cleanAddrs, downOf, label, newPeer, peerDevices, peerId, type Allowed, type Node, type PeerDevice } from "../src/shared.ts";
import { generateIdentity, type Identity } from "../src/tls.ts";
import type { Json } from "../src/wire.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-mesh-"));
const stops: (() => void)[] = [];
/** The test's folder gone; on Windows a store a test left open holds its file until this process ends (Windows clears its temp folder). */
function rmTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
}

afterAll(() => {
  for (const s of stops) s();
  rmTmp(tmp);
});

// A slow sandbox opens a store in seconds.
const SLOW = 30_000;

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

  test("a renamed pc keeps its id: only the name it shows changes, and an empty name goes back to the default", () => {
    const kv = new MemKv({ mesh_id: "pc:desk-7" });
    expect(renamePc(kv, "  Studio\tPC \n")).toEqual({ id: "pc:desk-7", name: "Studio PC" });
    expect(kv.get("mesh_id")).toBe("pc:desk-7");
    expect(readMe(kv, {}, () => ({}))).toEqual({ id: "pc:desk-7", name: "Studio PC" });
    expect(readMe(kv, { HARBOR_MESH_NAME: "Rig" }, () => ({})).name).toBe("Rig");
    expect(renamePc(kv, "   ")).toEqual({ id: "pc:desk-7", name: "desk-7" });
    expect([...cleanPcName("x".repeat(80))]).toHaveLength(40);
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
    const same = parseWhois(whois("nA", 42, null)) as Node;
    const other = parseWhois(whois("nB", 7, null)) as Node;
    const tagged = parseWhois(whois("nC", 42, ["tag:home"])) as Node;
    expect([same.label, same.user, same.tagged]).toEqual(["nA", 42, false]);
    expect(parseWhois({})).toBeNull();
  });

  test("a_trusted_pc_goes_by_its_id_or_its_key", () => {
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
    hub.mesh.workspacePeers = () => [{ node: "", fp, id: "pc:laptop", name: "laptop", addrs: ["10.0.0.7:47931"] }];
    const at = (via: import("../src/hub.ts").Via) => ({ ip: "10.0.0.8", via });
    expect(m.who(at({ kind: "tls", fp }), req())).toBe("pc:laptop");
    expect(hub.mesh.hints.get(fp)).toEqual(["10.0.0.8:47931"]);
    expect(m.who(at({ kind: "tls", fp: "e".repeat(64) }), req())).toBeNull();
    expect(hub.mesh.seen.has("e".repeat(64))).toBe(true);
    expect(m.who(at({ kind: "tls", fp: null }), req())).toBeNull();
    expect(m.who(at({ kind: "refused" }), req())).toBeNull();
    expect(http({ addr: "10.0.0.9:47930", fp: "" }, "GET", "/mesh/v1/hello", null, 1000)).rejects.toThrow("not sent");
  });

  test("a knock from a key this PC doesn't trust asks for the directory again (it may have just joined)", () => {
    const hub = new Hub([], 0);
    const knocks: string[] = [];
    const m = new Mesh({ ...meshOf(hub).d, stranger: (fp) => void knocks.push(fp) });
    const fp = "d".repeat(64);
    hub.mesh.workspacePeers = () => [{ node: "", fp, id: "pc:laptop", name: "laptop", addrs: [], use: false }];
    const at = (f: string) => ({ ip: "10.0.0.8", via: { kind: "tls" as const, fp: f } });
    // Trusted though not used: it may use this PC.
    expect(m.who(at(fp), req())).toBe("pc:laptop");
    expect(knocks).toEqual([]);
    expect(m.who(at("e".repeat(64)), req())).toBeNull();
    expect(knocks).toEqual(["e".repeat(64)]);
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
  }, SLOW);

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
  }, SLOW);

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
  }, SLOW);

  test("a project shared here opens its owner's main chat: this PC's empty one goes, one with messages stays a chat", async () => {
    const home = Store.openAt(join(tmp, "main-home.db"));
    const repo = home.addRepo("/nowhere/owner/game");
    const main = home.createChat(blankChat({ repoId: repo, title: "Game", role: "lead", started: true }));
    home.createChat(blankChat({ repoId: repo, title: "other", role: "lead" }));
    home.setMainChat(repo, main.id);
    home.setRepoWorkspace(repo, "org_team");
    home.setRepoShares(repo, ["org_owner"]);
    const sent = (await new StoreReplica({ store: home, hub: new Hub([], 0), version: "t" }).chats(0, true)).chats as { project: { main: string } }[];
    // Every chat of the project names its main chat, by gid.
    expect(sent.map((c) => c.project.main)).toEqual([main.gid, main.gid]);
    const run = async (name: string, said: boolean) => {
      // This PC has the project too (a folder of the same name), placed in its workspace by the owner, with a main chat of its own.
      mkdirSync(join(tmp, name, "game"), { recursive: true });
      const copy = Store.openAt(join(tmp, `${name}.db`));
      const mine = copy.addRepo(join(tmp, name, "game"));
      copy.setRepoWorkspace(mine, "org_team");
      copy.setRepoShares(mine, ["org_owner"]);
      const own = copy.createChat(blankChat({ repoId: mine, title: "fresh", role: "lead" }));
      if (said) copy.saveItems(own.id, [{ kind: "user", text: "hello", files: [], at: 1, mentions: [], sender: "", intent: "" }]);
      copy.setMainChat(mine, own.id);
      const mainFrom = (r: number, peer: string) => {
        const place = copy.placement();
        return takesMainFrom({ away: null, peer, mine: "org_team", peerWs: peer === "pc:home" ? "org_owner" : "", moved: place.repos.get(r) ?? "", shares: place.shared?.repos.get(r) ?? [] });
      };
      const replica = new StoreReplica({ store: copy, hub: new Hub([], 0), version: "t", mainFrom });
      await replica.applyChats("pc:home", 1, { full: true, chats: sent as unknown as Json[] });
      const theirs = copy.chats().find((c) => c.gid === main.gid);
      expect(copy.mainChats().get(mine)).toBe(theirs?.id ?? -1);
      // It follows the project into this PC's workspace, though it's someone else's chat.
      expect(copy.placement().mains?.has(theirs?.id ?? -1)).toBe(true);
      const kept = copy.chats().some((c) => c.id === own.id);
      copy.close();
      return kept;
    };
    expect(await run("main-empty", false)).toBe(false);
    expect(await run("main-said", true)).toBe(true);
    // A PC that keeps its own (here: the owner's own folder, never moved here) isn't touched.
    const owner = Store.openAt(join(tmp, "main-owner.db"));
    mkdirSync(join(tmp, "main-owner", "game"), { recursive: true });
    const its = owner.addRepo(join(tmp, "main-owner", "game"));
    const kept = owner.createChat(blankChat({ repoId: its, title: "mine", role: "lead" }));
    owner.setMainChat(its, kept.id);
    await new StoreReplica({ store: owner, hub: new Hub([], 0), version: "t", mainFrom: () => false }).applyChats("pc:home", 1, { full: true, chats: sent as unknown as Json[] });
    expect(owner.mainChats().get(its)).toBe(kept.id);
    owner.close();
    home.close();
  }, SLOW);

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
  }, SLOW);

  test("a chat's published cwd is where its agent works, its worktree before its project", async () => {
    const store = Store.openAt(join(tmp, "cwd.db"));
    const repo = store.addRepo(tmp);
    store.createChat(blankChat({ repoId: repo, title: "in a worktree" }));
    const cwdOf = async (o: { cwd?: () => string | null }) => ((await new StoreReplica({ store, hub: new Hub([], 0), version: "t", ...o }).chats(0, true)).chats as { cwd: string }[])[0]?.cwd;
    expect(await cwdOf({ cwd: () => "/wt/app-fix" })).toBe("/wt/app-fix");
    expect(await cwdOf({ cwd: () => null })).toBe(tmp);
    expect(await cwdOf({})).toBe(tmp);
    store.close();
  }, SLOW);
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

async function pc(name: string, live?: StoreReplicaOptions["live"], ram?: number, memory?: (chat: number | null) => Json, shared = false, devices?: PeerDevice[]): Promise<Pc> {
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
    ...(ram === undefined ? {} : { ram: () => ram }),
    ...(memory ? { memory } : {}),
    ...(devices ? { devices: () => devices } : {}),
    ...(shared ? { shared: { snapshot: () => wssettings.snapshot(store), adopt: (_peer: string, v: unknown) => void wssettings.adopt(store, v) } } : {}),
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

/** Both PCs sign in to one workspace: each finds the other in its directory, the only way PCs trust each other. */
function oneWorkspace(...pcs: { id: Identity; hub: Hub; port: number }[]): void {
  for (const x of pcs) {
    const others = pcs.filter((y) => y !== x).map((y): Allowed => ({ node: "", name: label(y.hub.mesh.me.id), fp: y.id.fp, id: y.hub.mesh.me.id, addrs: [`127.0.0.1:${y.port}`] }));
    x.hub.mesh.workspacePeers = () => others;
  }
}

describe("two TypeScript PCs", () => {
  test("workspace settings: a PC takes a peer's newer value from its hello, and a change here is pushed", async () => {
    const a = await pc("eps", undefined, undefined, undefined, true);
    const b = await pc("zeta", undefined, undefined, undefined, true);
    a.store.set("voice_cleanup", "1");
    b.store.setQuiet("voice_cleanup", "0");
    setHello("pc:eps", "eps", a.id);
    oneWorkspace(a, b);
    a.mesh.start();
    b.mesh.start();
    expect(await until(() => b.store.get("voice_cleanup") === "1")).toBe(true);
    expect(await until(() => a.hub.mesh.peer("pc:zeta")?.online === true && b.hub.mesh.peer("pc:eps")?.online === true)).toBe(true);
    b.store.set("voice_cleanup", "0");
    await b.mesh.pushShared();
    expect(await until(() => a.store.get("voice_cleanup") === "0")).toBe(true);
    expect(wssettings.snapshot(a.store).voice_cleanup).toEqual(wssettings.snapshot(b.store).voice_cleanup ?? ["", -1]);
  }, 30_000);

  test("SSH devices: a PC tells its peers in hello, they keep them, and both list them to phones in /v1/hubs", async () => {
    const mac = { id: "ssh:1", name: "Mac", os: "macOS" };
    const a = await pc("iota", undefined, undefined, undefined, false, [mac]);
    const b = await pc("kappa2");
    setHello("pc:iota", "iota", a.id);
    oneWorkspace(a, b);
    a.mesh.start();
    b.mesh.start();
    expect(await until(() => b.hub.mesh.peer("pc:iota")?.online === true)).toBe(true);
    expect(b.hub.mesh.peer("pc:iota")?.devices).toEqual([mac]);
    // Kept for when it's off.
    expect(loadPeers(b.store).get("pc:iota")?.devices).toEqual([mac]);
    const devs = (h: unknown) => Object.fromEntries((h as { hubs: { id: string; devices: unknown }[] }).hubs.map((x) => [x.id, x.devices]));
    expect(devs(a.mesh.hubs())).toEqual({ "pc:iota": [mac], "pc:kappa2": [] });
    expect(devs(b.mesh.hubs())).toEqual({ "pc:kappa2": [], "pc:iota": [mac] });
  }, 30_000);

  test("peer devices are read leniently: no id or name, duplicates and non-objects go, long names are cut", () => {
    expect(peerDevices(null)).toEqual([]);
    expect(peerDevices([{ id: "ssh:1", name: "Mac" }, { id: "ssh:1", name: "again" }, { id: "", name: "x" }, { id: "ssh:2" }, 7, [1], { id: "ssh:3", name: "n".repeat(90), os: 5 }])).toEqual([
      { id: "ssh:1", name: "Mac", os: "" },
      { id: "ssh:3", name: "n".repeat(60), os: "" },
    ]);
  });

  test("memory: a PC answers with its numbers, one before the route answers nothing", async () => {
    const asked: (number | null)[] = [];
    const a = await pc("gamma", undefined, undefined, (chat) => {
      asked.push(chat);
      return { ram: { total: 16, used: 8, swap_total: 0, swap_used: 0 }, running: 1, top: [], ...(chat === null ? {} : { chat: { parts: [] } }) };
    });
    const b = await pc("delta");
    const own = a.store.createChat(blankChat({ title: "Mine", role: "lead", name: "lead" }));
    setHello("pc:gamma", "gamma", a.id);
    oneWorkspace(a, b);
    a.mesh.start();
    b.mesh.start();
    expect(await until(() => b.hub.mesh.peer("pc:gamma")?.online === true && a.hub.mesh.peer("pc:delta")?.online === true)).toBe(true);
    expect(await b.mesh.memoryOf("pc:gamma", null)).toEqual({ ram: { total: 16, used: 8, swap_total: 0, swap_used: 0 }, running: 1, top: [] });
    expect((await b.mesh.memoryOf("pc:gamma", own.id))?.chat).toEqual({ parts: [] });
    expect(asked).toEqual([null, own.id]);
    expect(await a.mesh.memoryOf("pc:delta", null)).toBeNull();
    expect(await a.mesh.memoryOf("pc:nobody", null)).toBeNull();
  }, 30_000);

  test("PCs of one workspace each hold a copy of the other's chat, and edits follow", async () => {
    const a = await pc("alpha", undefined, 5120);
    const b = await pc("beta");
    const item = (t: string): Item => ({ kind: "text", text: t, at: 1 });
    const own = a.store.createChat(blankChat({ title: "On alpha", role: "lead", name: "lead" }));
    a.store.saveItems(own.id, [item("one")]);
    setHello("pc:alpha", "alpha", a.id);
    oneWorkspace(a, b);
    a.replica.reload();
    a.mesh.start();
    b.mesh.start();
    const copied = await until(() => b.store.chats().some((c) => c.home === "pc:alpha" && b.store.items(c.id).length === 1));
    expect(copied).toBe(true);
    const copy = b.store.chats().find((c) => c.home === "pc:alpha");
    expect([copy?.title, copy?.gid, copy?.homeId]).toEqual(["On alpha", own.gid, own.id]);
    expect(b.hub.mesh.peer("pc:alpha")?.online).toBe(true);
    // Its free memory came with its chats list (the composer's Auto); beta says none.
    expect(b.hub.mesh.peer("pc:alpha")?.ram).toBe(5120);
    expect(await until(() => a.hub.mesh.peer("pc:beta")?.online === true)).toBe(true);
    expect(a.hub.mesh.peer("pc:beta")?.ram).toBeNull();
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
    setHello("pc:gamma", "gamma", a.id);
    oneWorkspace(a, b);
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

  test("one way: a PC whose owner is only in this PC's workspace uses it, and this PC neither follows nor lists it", async () => {
    const a = await pc("kappa");
    const b = await pc("lambda");
    a.store.createChat(blankChat({ title: "On kappa", role: "lead", name: "lead" }));
    b.store.createChat(blankChat({ title: "On lambda", role: "lead", name: "lead" }));
    // kappa's owner invited lambda's into kappa's workspace; lambda's owner never invited kappa's into theirs.
    a.hub.mesh.workspacePeers = () => [{ node: "", name: "lambda", fp: b.id.fp, id: "pc:lambda", addrs: [`127.0.0.1:${b.port}`], use: false }];
    b.hub.mesh.workspacePeers = () => [{ node: "", name: "kappa", fp: a.id.fp, id: "pc:kappa", addrs: [`127.0.0.1:${a.port}`], use: true }];
    a.replica.reload();
    b.replica.reload();
    a.mesh.start();
    b.mesh.start();
    expect(a.mesh.targets()).toEqual([]);
    expect(await until(() => b.store.chats().some((c) => c.home === "pc:kappa" && c.title === "On kappa"))).toBe(true);
    expect(b.hub.mesh.peer("pc:kappa")?.online).toBe(true);
    await Bun.sleep(500);
    expect(a.store.chats().some((c) => c.home === "pc:lambda")).toBe(false);
    expect(a.hub.mesh.peer("pc:lambda")).toBeNull();
    // Phones of kappa's PC aren't offered lambda either.
    expect(((a.mesh.hubs() as { hubs: { id: string }[] }).hubs).map((h) => h.id)).toEqual(["pc:kappa"]);
    // One remembered from before (when trust went both ways) goes from every list.
    a.hub.mesh.peers.set("pc:lambda", newPeer({ id: "pc:lambda", fp: b.id.fp }));
    a.mesh.forgetStrangers();
    expect(a.hub.mesh.peer("pc:lambda")).toBeNull();
  }, 30_000);

  test("a PC outside the workspace gets nothing, and one that leaves it is forgotten", async () => {
    const a = await pc("eps");
    const b = await pc("zeta");
    a.store.createChat(blankChat({ title: "Private", role: "lead", name: "lead" }));
    setHello("pc:eps", "eps", a.id);
    // Only zeta lists eps: eps doesn't list zeta, so it refuses zeta's calls and follows nobody.
    b.hub.mesh.workspacePeers = () => [{ node: "", name: "eps", fp: a.id.fp, id: "pc:eps", addrs: [`127.0.0.1:${a.port}`] }];
    a.replica.reload();
    a.mesh.start();
    b.mesh.start();
    expect(a.mesh.targets()).toEqual([]);
    await Bun.sleep(1500);
    expect(b.store.chats().some((c) => c.home === "pc:eps")).toBe(false);
    expect(b.hub.mesh.peer("pc:eps")?.online ?? false).toBe(false);
    // A peer kept from before (paired by code, say) that isn't in the directory goes from the lists.
    a.hub.mesh.peers.set("pc:old", newPeer({ id: "pc:old", fp: "e".repeat(64) }));
    a.mesh.forgetStrangers();
    expect(a.hub.mesh.peer("pc:old")).toBeNull();
  }, 30_000);
});
