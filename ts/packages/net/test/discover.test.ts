import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import {
  DISCOVER_FRESH_MS,
  discoverAnnounceNow,
  discoverAsk,
  discoverMessage,
  discoverParse,
  discoverRecord,
  discoverStart,
  discoverUnpaired,
  type DiscoverHandle,
  type DiscoverMe,
  type DiscoverNet,
  type LanHarbor,
} from "../src/discover.ts";
import { Shared } from "../src/shared.ts";

const LOOP = [127, 0, 0, 1].join(".");
const FIVE = [10, 0, 0, 5].join(".");
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function freePort(): Promise<number> {
  const s = createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, LOOP, r));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(r));
  return p;
}

/** A discovery network that only knows loopback: binds `port`, sends to the given loopback ports. */
function loopNet(port: number, to: number[], accept: (ip: string) => boolean = () => true): DiscoverNet {
  return { bindAddr: LOOP, bindPort: port, joins: () => [], destinations: () => to.map((p) => ({ addr: LOOP, port: p })), accept };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

interface Raw {
  port: number;
  got: { kind: string; data: string }[];
  send(data: Uint8Array | string, to: number): Promise<void>;
  close(): void;
}

async function raw(): Promise<Raw> {
  const s: Socket = createSocket("udp4");
  const got: Raw["got"] = [];
  s.on("message", (m) => {
    const data = m.toString();
    got.push({ kind: (JSON.parse(data) as { t: string }).t, data });
  });
  await new Promise<void>((r) => s.bind(0, LOOP, r));
  return {
    port: s.address().port,
    got,
    send: (data, to) => new Promise<void>((r) => s.send(data, to, LOOP, () => r())),
    close: () => s.close(),
  };
}

const fpA = "a".repeat(64);
const fpB = "b".repeat(64);
const meOf = (fp: string, name: string, port: number, on = true): DiscoverMe => ({ id: `pc:${name}`, name, fp, port, version: "1.2.3", on });

const handles: DiscoverHandle[] = [];
const raws: Raw[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.stop();
  for (const r of raws.splice(0)) r.close();
});

async function started(o: Parameters<typeof discoverStart>[0]): Promise<DiscoverHandle> {
  const h = await discoverStart(o);
  if (!h) throw new Error("discovery did not start");
  handles.push(h);
  return h;
}

describe("discover", () => {
  test("announcements", () => {
    const fp = "a".repeat(64);
    const m = discoverMessage("here", "pc:desk", "desk", fp, 47931, "1.2.3");
    expect(text(m)).toBe(`{"fp":"${fp}","harbor":1,"id":"pc:desk","name":"desk","port":47931,"t":"here","v":"1.2.3"}`);
    const parsed = discoverParse(m, FIVE);
    expect(parsed).not.toBeNull();
    const { kind, lan: l } = parsed!;
    expect([kind, l.fp, l.id, l.name, l.addr]).toEqual(["here", fp, "pc:desk", "desk", `${FIVE}:47931`]);
    expect(l.version).toBe("1.2.3");
    // Not ours, or broken: ignored.
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(discoverParse(enc("hello"), FIVE)).toBeNull();
    expect(discoverParse(enc('{"harbor":1,"fp":"zz","port":1}'), FIVE)).toBeNull();
    expect(discoverParse(enc('{"harbor":2,"fp":"aaaa","port":1}'), FIVE)).toBeNull();
    expect(discoverParse(enc(`{"harbor":1,"fp":"${fp}","port":0}`), FIVE)).toBeNull();
    expect(discoverParse(enc(`{"harbor":1,"fp":"${fp}","port":70000}`), FIVE)).toBeNull();
    expect(discoverParse(new Uint8Array(2000).fill(32), FIVE)).toBeNull();
    const named = `{"harbor":1,"t":"here","fp":"${fp}","port":5,"name":"a\\nb${"x".repeat(100)}"}`;
    expect(discoverParse(enc(named), FIVE)?.lan.name.length).toBe(60);
    expect(discoverParse(enc(named), FIVE)?.lan.name.startsWith("abxx")).toBe(true);
    // An IPv4-mapped source is the IPv4 address; IPv6 gets brackets.
    expect(discoverParse(m, `::ffff:${FIVE}`)?.lan.addr).toBe(`${FIVE}:47931`);
    expect(discoverParse(m, "fd00::7")?.lan.addr).toBe("[fd00::7]:47931");
    // A paired PC's announcement is an address to try; an unpaired one is listed.
    const shared = new Shared();
    shared.workspacePeers = () => [{ node: "", name: "", fp, id: "", addrs: [] }];
    const table = new Map<string, LanHarbor>();
    discoverRecord(shared, l, table);
    expect(shared.hints.get(fp)).toEqual([`${FIVE}:47931`]);
    expect(discoverUnpaired(shared, table).every((x) => x.fp !== fp)).toBe(true);
    const other = { ...l, fp: "b".repeat(64) };
    discoverRecord(shared, other, table);
    expect(discoverUnpaired(shared, table).some((x) => x.fp === other.fp)).toBe(true);
  });

  test("the heard table forgets after 100 s and keeps 64", () => {
    const shared = new Shared();
    const table = new Map<string, LanHarbor>();
    const lan = (n: number, at: number): LanHarbor => ({ fp: n.toString(16).padStart(64, "0"), id: "", name: `n${String(n).padStart(3, "0")}`, addr: `${FIVE}:1`, version: "", at });
    discoverRecord(shared, lan(1, 0), table, 0);
    expect(discoverUnpaired(shared, table, DISCOVER_FRESH_MS - 1)).toHaveLength(1);
    expect(discoverUnpaired(shared, table, DISCOVER_FRESH_MS)).toHaveLength(0);
    discoverRecord(shared, lan(2, DISCOVER_FRESH_MS), table, DISCOVER_FRESH_MS);
    expect([...table.keys()]).toEqual([lan(2, 0).fp]);
    for (let i = 10; i < 200; i++) discoverRecord(shared, lan(i, 500_000), table, 500_000);
    expect(table.size).toBe(64);
    // One already there is still updated when the table is full.
    const known = [...table.values()][0]!;
    discoverRecord(shared, { ...known, name: "renamed" }, table, 500_000);
    expect(table.get(known.fp)?.name).toBe("renamed");
    expect(table.size).toBe(64);
    // Listed by name.
    const small = new Map<string, LanHarbor>();
    for (const n of [3, 1, 2]) discoverRecord(shared, lan(n, 0), small, 0);
    expect(discoverUnpaired(shared, small, 1).map((x) => x.name)).toEqual(["n001", "n002", "n003"]);
  });

  test("two Harbors find each other: ask, then here", async () => {
    const [pa, pb] = [await freePort(), await freePort()];
    const sharedA = new Shared();
    sharedA.workspacePeers = () => [{ node: "", name: "b", fp: fpB, id: "", addrs: [] }];
    const sharedB = new Shared();
    const tableA = new Map<string, LanHarbor>();
    const tableB = new Map<string, LanHarbor>();
    await started({ shared: sharedB, me: () => meOf(fpB, "bee", 41002), net: loopNet(pb, [pa]), table: tableB });
    await started({ shared: sharedA, me: () => meOf(fpA, "ayy", 41001), net: loopNet(pa, [pb]), table: tableA });
    // A asked at start; B heard it and answered "here".
    await until(() => tableB.has(fpA) && tableA.has(fpB));
    expect(tableB.get(fpA)).toMatchObject({ id: "pc:ayy", name: "ayy", addr: `${LOOP}:41001`, version: "1.2.3" });
    expect(tableA.get(fpB)).toMatchObject({ id: "pc:bee", name: "bee", addr: `${LOOP}:41002` });
    // A has B paired: its address is a hint. B has not paired A: it is listed.
    expect(sharedA.hints.get(fpB)).toEqual([`${LOOP}:41002`]);
    expect(discoverUnpaired(sharedA, tableA)).toHaveLength(0);
    expect(discoverUnpaired(sharedB, tableB).map((l) => l.name)).toEqual(["ayy"]);
  });

  test("answers an ask at most twice a second, and says nothing while sharing is off", async () => {
    const listener = await raw();
    raws.push(listener);
    const pb = await freePort();
    const table = new Map<string, LanHarbor>();
    const me = meOf(fpB, "bee", 41002);
    await started({ shared: new Shared(), me: () => me, net: loopNet(pb, [listener.port]), table });
    await until(() => listener.got.some((g) => g.kind === "ask"));
    const ask = JSON.stringify({ harbor: 1, t: "ask", id: "pc:q", name: "q", fp: fpA, port: 41009, v: "1" });
    await listener.send(ask, pb);
    await listener.send(ask, pb);
    await until(() => table.has(fpA));
    await Bun.sleep(250);
    expect(listener.got.filter((g) => g.kind === "here")).toHaveLength(1);
    expect(JSON.parse(listener.got.find((g) => g.kind === "here")!.data)).toMatchObject({ harbor: 1, t: "here", id: "pc:bee", name: "bee", fp: fpB, port: 41002, v: "1.2.3" });

    // Off: still listens (and records), never speaks.
    const quiet = await raw();
    raws.push(quiet);
    const pc = await freePort();
    const tableC = new Map<string, LanHarbor>();
    await started({ shared: new Shared(), me: () => meOf(fpB, "bee", 41002, false), net: loopNet(pc, [quiet.port]), table: tableC });
    await quiet.send(ask, pc);
    await until(() => tableC.has(fpA));
    await Bun.sleep(150);
    expect(quiet.got).toHaveLength(0);
  });

  test("ignores its own datagrams, other sources and anything that is not a Harbor", async () => {
    const p = await freePort();
    const table = new Map<string, LanHarbor>();
    await started({ shared: new Shared(), me: () => meOf(fpB, "bee", 41002, false), net: loopNet(p, []), table });
    const talker = await raw();
    raws.push(talker);
    const hello = (fp: string, t = "here") => JSON.stringify({ harbor: 1, t, id: "x", name: "x", fp, port: 5, v: "1" });
    await talker.send(hello(fpB), p);
    await talker.send("not json", p);
    await talker.send(hello(fpA), p);
    await until(() => table.has(fpA));
    expect([...table.keys()]).toEqual([fpA]);

    const p2 = await freePort();
    const table2 = new Map<string, LanHarbor>();
    await started({ shared: new Shared(), me: () => meOf(fpB, "bee", 41002, false), net: loopNet(p2, [], () => false), table: table2 });
    await talker.send(hello(fpA), p2);
    await Bun.sleep(150);
    expect(table2.size).toBe(0);
  });

  test("announceNow says here before the next tick", async () => {
    const listener = await raw();
    raws.push(listener);
    const p = await freePort();
    await started({ shared: new Shared(), me: () => meOf(fpB, "bee", 41002), net: loopNet(p, [listener.port]), table: new Map(), everyMs: 60_000 });
    await until(() => listener.got.length === 1);
    expect(listener.got[0]?.kind).toBe("ask");
    discoverAnnounceNow();
    await until(() => listener.got.length === 2);
    expect(listener.got[1]?.kind).toBe("here");
  });

  test("a port that can't be bound starts nothing", async () => {
    const holder = createSocket("udp4");
    await new Promise<void>((r) => holder.bind(0, LOOP, r));
    const net = loopNet(holder.address().port, []);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      expect(await discoverStart({ shared: new Shared(), me: () => meOf(fpB, "bee", 1), net })).toBeNull();
    } finally {
      console.error = orig;
      holder.close();
    }
    expect(errors).toHaveLength(1);
  });

  test("ask lists the Harbors that answer here, by name", async () => {
    const responder = createSocket("udp4");
    const seen: string[] = [];
    responder.on("message", (m, r) => {
      seen.push(m.toString());
      const say = (fp: string, name: string, t: string) => discoverMessage(t, `pc:${name}`, name, fp, 41000, "1");
      for (const [fp, name, t] of [[fpB, "zed", "here"], [fpA, "mine", "here"], ["c".repeat(64), "amy", "here"], ["d".repeat(64), "quiet", "ask"]] as const) {
        responder.send(say(fp, name, t), r.port, r.address);
      }
    });
    await new Promise<void>((r) => responder.bind(0, LOOP, r));
    try {
      const p = await freePort();
      const found = await discoverAsk({ waitMs: 300, myFp: fpA, net: loopNet(p, [responder.address().port]) });
      expect(JSON.parse(seen[0]!)).toEqual({ harbor: 1, t: "ask", fp: "0".repeat(64), port: 1 });
      expect(found.map((l) => l.name)).toEqual(["amy", "zed"]);
      expect(found[0]?.addr).toBe(`${LOOP}:41000`);
    } finally {
      responder.close();
    }
  });
});
