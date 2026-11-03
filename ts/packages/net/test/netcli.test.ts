import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo, type Server } from "node:net";
import { PassThrough } from "node:stream";
import { Api } from "../src/api.ts";
import { err } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { Mesh, type MeshApp } from "../src/mesh.ts";
import { meshCli, ncCli } from "../src/netcli.ts";
import { relayServe } from "../src/relay.ts";
import { cachedMeshPeers, seedWorkspace as inWorkspace } from "../src/account.ts";
import { generateIdentity, short, type Identity } from "../src/tls.ts";

const closers: (() => void)[] = [];
afterAll(() => {
  for (const c of closers) c();
});

function io() {
  const o = { out: [] as string[], err: [] as string[] };
  return { o, io: { out: (l: string) => o.out.push(l), err: (l: string) => o.err.push(l) } };
}

const app: MeshApp = {
  helloExtra: () => ({ version: "", accounts: [], update: null, owner: "", github: "", owner_suggested: false }),
  chats: () => ({ chats: [], update: null }),
  items: () => null,
  applyChats: () => [],
  applyItems: () => {},
  route: async () => err(404, "unknown mesh call"),
};

/** A running Harbor (listener + mesh) on loopback, with sharing on. */
async function harbor(id: Identity, kv: MemKv, name: string): Promise<number> {
  kv.set("mesh_enabled", "1");
  const hub = new Hub([], 0);
  hub.mesh.me = { id: `pc:${name}`, name };
  const mesh = new Mesh({ hub, kv, id: () => id, app, myAddrs: () => [], uploadsDir: "", upload: async () => err(404, ""), workspacePeers: () => cachedMeshPeers(kv, id.fp) });
  mesh.reread();
  const api = new Api({
    hub,
    id: () => id,
    uploadsDir: "",
    route: async () => err(404, ""),
    account: null,
    appInfo: () => null,
    apk: () => null,
    mesh: (p, q, r) => mesh.serve(p, q, r),
    meshAdmitted: (p, q) => mesh.admitted(p, q),
    relay: (p, q, r, w) => relayServe({ hub, myFp: () => id.fp, isPhone: () => false }, p, q, r, w),
    hubs: () => null,
  });
  await api.listen(["127.0.0.1"]);
  hub.port = api.port();
  const t = setInterval(() => mesh.reread(), 100);
  closers.push(() => {
    clearInterval(t);
    api.close();
  });
  return api.port();
}

async function echo(): Promise<number> {
  const s: Server = createServer((c) => c.pipe(c));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => s.close());
  return (s.address() as AddressInfo).port;
}

describe("harbor mesh (mesh.rs cli)", () => {
  test("status says who this PC is and lists its workspace's PCs; pairing is gone", async () => {
    const kv = new MemKv({ mesh_id: "pc:desk" });
    const id = generateIdentity();
    const deps = (x: ReturnType<typeof io>) => ({ kv, id, io: x.io, ask: async () => [], addrs: () => ["10.0.0.5"], env: {} });
    let x = io();
    expect(await meshCli([], deps(x))).toBe(0);
    expect(x.o.out.filter((l) => !l.startsWith("firewall:"))).toEqual(["this PC: desk (pc:desk)", `key:     ${id.fp}`, "listens: 10.0.0.5:47930", "this workspace's PCs:", "  none (other PCs join this PC's workspace in Settings › Workspace)"]);
    const fp = "ab".repeat(32);
    inWorkspace(kv, [{ name: "laptop", fp, id: "pc:laptop", addrs: ["10.0.0.7:47930"] }, { name: "desk", fp: id.fp, id: "pc:desk", addrs: [] }]);
    x = io();
    expect(await meshCli(["status"], deps(x))).toBe(0);
    expect(x.o.out.filter((l) => !l.startsWith("firewall:")).slice(3)).toEqual(["this workspace's PCs:", `  laptop               key ${short(fp)}  10.0.0.7:47930`]);
    for (const old of [["pair"], ["join", "10.0.0.7", "ABCDE-FGHIJ"], ["allow", fp], ["remove", fp], ["on"]]) {
      x = io();
      expect(await meshCli(old, deps(x))).toBe(2);
      expect(x.o.err[0]?.startsWith("usage: harbor mesh [status]")).toBe(true);
    }
  });
});

describe("harbor nc (relay.rs cli)", () => {
  async function through(args: string[], kv: MemKv, id: Identity): Promise<[number, string]> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let got = "";
    stdout.on("data", (b: Buffer) => {
      got += b.toString();
      if (got.length >= 4) stdin.end();
    });
    const x = io();
    const run = ncCli(args, { kv, id, io: x.io, stdin, stdout, env: {} });
    stdin.write("ping");
    return [await run, got];
  }

  test("a plain host, and a workspace PC through another one that reaches it", async () => {
    const target = await echo();
    const kv = new MemKv();
    const me = generateIdentity();
    expect(await through(["127.0.0.1", String(target)], kv, me)).toEqual([0, "ping"]);
    // The device is a PC of the workspace this one can't reach (port 9), but another of its PCs can.
    const relayKv = new MemKv();
    const relay = generateIdentity();
    const far = { name: "far", fp: "cd".repeat(32), id: "pc:far", addrs: [`127.0.0.1:${target}`] };
    inWorkspace(relayKv, [{ name: "me", fp: me.fp, id: "pc:me", addrs: [] }, far]);
    const relayPort = await harbor(relay, relayKv, "relay");
    inWorkspace(kv, [{ ...far, addrs: ["127.0.0.1:9"] }, { name: "relay", fp: relay.fp, id: "pc:relay", addrs: [`127.0.0.1:${relayPort}`] }]);
    expect(await through(["--device", "pc:far", "far", String(target)], kv, me)).toEqual([0, "ping"]);
    const x = io();
    expect(await ncCli(["only-a-host"], { kv, id: me, io: x.io, stdin: new PassThrough(), stdout: new PassThrough() })).toBe(2);
  });

  test("a_name_nothing_reaches_goes_to_tailscales_nc_when_there_is_one", async () => {
    const kv = new MemKv();
    const me = generateIdentity();
    const asked: [string, number][] = [];
    const x = io();
    const base = { kv, id: me, io: x.io, stdin: new PassThrough(), stdout: new PassThrough(), env: {} };
    expect(await ncCli(["127.0.0.1", "9"], { ...base, tailnetNc: (h, p) => (asked.push([h, p]), Promise.resolve(7)) })).toBe(7);
    expect(asked).toEqual([["127.0.0.1", 9]]);
    expect(x.o.err).toEqual([]);
    expect(await ncCli(["127.0.0.1", "9"], { ...base, tailnetNc: () => null })).toBe(1);
    expect(x.o.err).toEqual(["harbor nc: can't reach 127.0.0.1:9"]);
  });
});
