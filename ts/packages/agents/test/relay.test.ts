import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PORT, PORT_REF, RELAY, relayWait, setUp } from "../src/relay.ts";

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
