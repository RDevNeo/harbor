import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PORT, listenerIsMine, PORT_REF, RELAY, readPortFile, relayWait, setUp, target, writerAlive } from "../src/relay.ts";

const work = mkdtempSync(join(tmpdir(), "harbor-relay-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = join(work, "bridge-port");

/** A bridge stand-in: answers each connection with what it got, prefixed by its name. */
function upstream(name: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => c.on("data", (d) => c.end(`${name}:${d.toString()}`)));
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}
const portOf = (s: Server): number => (s.address() as { port: number }).port;

async function ask(port: number, text: string): Promise<string> {
  const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data(_s, d) { got += d.toString(); }, close() { done(); }, error() { done(); } } });
  let got = "";
  let done = (): void => {};
  const closed = new Promise<void>((r) => (done = r));
  s.write(text);
  await closed;
  return got;
}

test("the runner relays to the bridge, waits while it is away and follows it to a new port", async () => {
  relayWait.ms = 5000;
  const first = await upstream("first");
  writeFileSync(file, String(portOf(first)));
  const env: Record<string, string | undefined> = { [RELAY]: file, [BRIDGE_PORT]: String(portOf(first)) };
  const { argv, relay } = await setUp(env, ["-c", `url="http://127.0.0.1:${PORT_REF}/x"`, "plain"]);
  expect(relay).not.toBeNull();
  const port = String(relay?.port);
  expect(env[BRIDGE_PORT]).toBe(port);
  expect(env[RELAY]).toBeUndefined();
  expect(argv).toEqual(["-c", `url="http://127.0.0.1:${port}/x"`, "plain"]);
  expect(await ask(Number(port), "hello")).toBe("first:hello");
  // Harbor restarts: nothing listens for a moment, then it comes back on another port.
  const was = portOf(first);
  await new Promise<void>((r) => first.close(() => r()));
  const asked = ask(Number(port), "again");
  await Bun.sleep(400);
  const second = await upstream("second");
  writeFileSync(file, String(portOf(second)));
  expect(await asked).toBe("second:again");
  expect(portOf(second)).not.toBe(was);
  second.close();
  relay?.close();
}, 20_000);

test("a request gives up once the bridge stays away past the wait", async () => {
  relayWait.ms = 300;
  writeFileSync(file, "1");
  const env: Record<string, string | undefined> = { [RELAY]: file, [BRIDGE_PORT]: "1" };
  const { relay } = await setUp(env, []);
  expect(await ask(relay?.port ?? 0, "x")).toBe("");
  relay?.close();
});

test("without the relay asked for, nothing changes", async () => {
  const env: Record<string, string | undefined> = { [BRIDGE_PORT]: "5" };
  const { argv, relay } = await setUp(env, ["a"]);
  expect(relay).toBeNull();
  expect(argv).toEqual(["a"]);
  expect(env[BRIDGE_PORT]).toBe("5");
});

const gonePid = (): number => Bun.spawnSync(["true"]).pid;

test("the port file's writer: a running one is trusted, one that has gone is not", () => {
  writeFileSync(file, `47940 ${process.pid}\n`);
  expect(readPortFile(file)).toEqual({ port: 47940, pid: process.pid, start: null });
  expect(writerAlive({ port: 1, pid: process.pid, start: null })).toBe(true);
  expect(writerAlive({ port: 1, pid: gonePid(), start: null })).toBe(false);
  // The start time tells a reused pid from its first process.
  expect(writerAlive({ port: 1, pid: process.pid, start: 1 })).toBe(false);
  expect(writerAlive({ port: 1, pid: null, start: null })).toBe(true);
  writeFileSync(file, "47940\n");
  expect(readPortFile(file)).toEqual({ port: 47940, pid: null, start: null });
});

test("a listener is this user's only when /proc says so", async () => {
  const s = await upstream("mine");
  expect(listenerIsMine(portOf(s))).toBe(true);
  const free = portOf(s);
  await new Promise<void>((r) => s.close(() => r()));
  expect(listenerIsMine(free)).toBe(false);
});

test("a port file left by a process that has gone strands nothing: the turn's own port is used, never the stale one", async () => {
  relayWait.ms = 3000;
  const live = await upstream("live");
  const stale = await upstream("stale");
  writeFileSync(file, `${portOf(stale)} ${gonePid()}\n`);
  expect(target(file, portOf(live))).toBe(portOf(live));
  const env: Record<string, string | undefined> = { [RELAY]: file, [BRIDGE_PORT]: String(portOf(live)) };
  const { relay } = await setUp(env, []);
  expect(await ask(relay?.port ?? 0, "hi")).toBe("live:hi");
  // While its writer runs, the file's port and no other.
  writeFileSync(file, `${portOf(stale)} ${process.pid}\n`);
  expect(target(file, portOf(live))).toBe(portOf(stale));
  expect(await ask(relay?.port ?? 0, "hi")).toBe("stale:hi");
  // No file and nobody of this user's on the turn's port: it waits for the bridge to write the file.
  rmSync(file);
  const gone = portOf(live);
  await new Promise<void>((r) => live.close(() => r()));
  expect(target(file, gone)).toBeNull();
  stale.close();
  relay?.close();
}, 20_000);
