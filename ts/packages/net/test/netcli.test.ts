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
import { loadAllowed } from "../src/shared.ts";
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
  const mesh = new Mesh({ hub, kv, id: () => id, app, myAddrs: () => [], uploadsDir: "", upload: async () => err(404, "") });
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
  test("status, on/off, allow and remove by key or name", async () => {
    const kv = new MemKv({ mesh_id: "pc:desk" });
    const id = generateIdentity();
    const deps = (x: ReturnType<typeof io>) => ({ kv, id, io: x.io, ask: async () => [], addrs: () => ["10.0.0.5"], env: {} });
    let x = io();
    expect(await meshCli(["on"], deps(x))).toBe(0);
    expect(x.o.out).toEqual(["sharing chats with your other PCs: on"]);
    const fp = "ab".repeat(32);
    x = io();
    expect(await meshCli(["allow", fp.toUpperCase()], deps(x))).toBe(0);
    expect(x.o.out).toEqual([`allowed ${short(fp)}`]);
    expect(loadAllowed(kv).map((a) => a.fp)).toEqual([fp]);
    x = io();
    expect(await meshCli(["allow", id.fp], deps(x))).toBe(1);
    expect(x.o.err).toEqual(["harbor: that's this PC's own key"]);
    x = io();
    expect(await meshCli([], deps(x))).toBe(0);
    expect(x.o.out.slice(0, 4)).toEqual(["this PC: desk (pc:desk)", `key:     ${id.fp}`, "sharing: on", "listens: 10.0.0.5:47930"]);
    expect(x.o.out.at(-1)).toBe(`  ${" ".repeat(20)} key ${short(fp)}  `);
    x = io();
    expect(await meshCli(["remove", fp], deps(x))).toBe(0);
    expect(x.o.out).toEqual([`removed ${short(fp)}`]);
    x = io();
    expect(await meshCli(["remove", "nobody"], deps(x))).toBe(1);
    x = io();
    expect(await meshCli(["frobnicate"], deps(x))).toBe(2);
    expect(x.o.err[0]?.startsWith("usage: harbor mesh status")).toBe(true);
  });

  test("pair shows a code and waits; join on the other PC pairs both ways", async () => {
    const hostKv = new MemKv({ mesh_id: "pc:host" });
    const host = generateIdentity();
    const port = await harbor(host, hostKv, "host");
    const p = io();
    const waiting = meshCli(["pair"], { kv: hostKv, id: host, io: p.io, ask: async () => [], addrs: () => ["127.0.0.1"], env: {}, sleep: (ms) => Bun.sleep(ms / 20) });
    await Bun.sleep(30);
    const code = /Pairing code: (\S+)/.exec(p.o.out[0] ?? "")?.[1] ?? "";
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const joinKv = new MemKv({ mesh_id: "pc:joiner" });
    const joiner = generateIdentity();
    const j = io();
    expect(await meshCli(["join", `127.0.0.1:${port}`, code.toLowerCase()], { kv: joinKv, id: joiner, io: j.io, ask: async () => [], addrs: () => [], env: {} })).toBe(0);
    expect(j.o.out).toEqual([`paired with host (key ${short(host.fp)}); sharing is on`]);
    expect(await waiting).toBe(0);
    expect(p.o.out.at(-1)).toBe("paired with joiner");
    expect(loadAllowed(hostKv).map((a) => a.fp)).toEqual([joiner.fp]);
    expect(loadAllowed(joinKv).map((a) => a.fp)).toEqual([host.fp]);
    expect(joinKv.get("mesh_enabled")).toBe("1");
    // A name is looked up on the network first.
    const n = io();
    expect(await meshCli(["join", "elsewhere", code], { kv: joinKv, id: joiner, io: n.io, ask: async () => [], addrs: () => [], env: {} })).toBe(1);
    expect(n.o.err).toEqual(["harbor: no Harbor called elsewhere on this network (give its address)"]);
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

  test("a plain host, and a paired PC through another one that reaches it", async () => {
    const target = await echo();
    const kv = new MemKv();
    const me = generateIdentity();
    expect(await through(["127.0.0.1", String(target)], kv, me)).toEqual([0, "ping"]);
    // The device is a paired PC this one can't reach (port 9), but a relay PC can.
    const relayKv = new MemKv();
    const relay = generateIdentity();
    const far = { node: "", name: "far", fp: "cd".repeat(32), id: "pc:far", addrs: [`127.0.0.1:${target}`] };
    relayKv.set("mesh_allowed", JSON.stringify([{ node: "", name: "me", fp: me.fp, id: "", addrs: [] }, far]));
    const relayPort = await harbor(relay, relayKv, "relay");
    kv.set("mesh_allowed", JSON.stringify([{ ...far, addrs: ["127.0.0.1:9"] }, { node: "", name: "relay", fp: relay.fp, id: "pc:relay", addrs: [`127.0.0.1:${relayPort}`] }]));
    expect(await through(["--device", "pc:far", "far", String(target)], kv, me)).toEqual([0, "ping"]);
    const x = io();
    expect(await ncCli(["only-a-host"], { kv, id: me, io: x.io, stdin: new PassThrough(), stdout: new PassThrough() })).toBe(2);
  });
});
