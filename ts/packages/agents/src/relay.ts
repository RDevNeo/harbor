import { readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { alive } from "./procfs.ts";
import { sys } from "@harbor/os";

/**
 * A turn's way to Harbor's MCP bridge that outlives a Harbor restart. The turn's runner listens on a port of its own
 * and passes each connection on to the bridge, whose current port it reads from the file the bridge writes (so a
 * Harbor that came back on another port is found too). While nothing listens there (Harbor is restarting), the
 * connection waits, for up to `relayWait.ms`, instead of failing: nothing of it reached Harbor yet, so the request
 * goes out once, when the new Harbor is up.
 */

/** Set by Harbor in the turn's environment: the bridge's port file; the runner then relays. */
export const RELAY = "HARBOR_BRIDGE_RELAY";
/** The port the agent's MCP URLs name (`${HARBOR_BRIDGE_PORT}`): the bridge's, or the runner's relay once it listens. */
export const BRIDGE_PORT = "HARBOR_BRIDGE_PORT";
/** Codex's bearer token for the bridge (its config is on the command line, so the token stays in its environment). */
export const BRIDGE_TOKEN = "HARBOR_BRIDGE_TOKEN";
/** How URLs on a command line name the port (the runner puts the number in). */
export const PORT_REF = `\${${BRIDGE_PORT}}`;

/** Tests shorten it. */
export const relayWait = { ms: 30_000 };

/** The port file's line (bridge.ts `portLine`): the port, then the pid and /proc start time of the process serving it; an older Harbor wrote the port alone. */
export interface PortOwner {
  port: number;
  pid: number | null;
  start: number | null;
}

export function readPortFile(file: string): PortOwner | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const [p, pid, start] = text.trim().split(/\s+/).map(Number);
  if (p === undefined || !Number.isInteger(p) || p <= 0 || p > 65535) return null;
  return { port: p, pid: pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : null, start: start !== undefined && Number.isInteger(start) && start >= 0 ? start : null };
}

function portIn(file: string): number | null {
  return readPortFile(file)?.port ?? null;
}

/** The file's writer still runs (an unknown one, from an older Harbor, counts as running). */
export function writerAlive(o: PortOwner): boolean {
  if (o.pid === null) return true;
  if (o.start !== null) return alive(o.pid, o.start);
  try {
    process.kill(o.pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** Loopback listeners (the kernel's tcp tables): whether every one on `port` is this user's (null: there are no tables to ask). */
export function listenerIsMine(port: number): boolean | null {
  const uid = process.getuid?.();
  let rows = 0;
  let mine = 0;
  let read = false;
  for (const f of ["tcp", "tcp6"] as const) {
    const text = sys.netTable(f);
    if (text === null) continue;
    read = true;
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      // sl local rem st queues timer retrnsmt uid …; st 0A is LISTEN.
      if (c.length < 8 || c[3] !== "0A" || Number.parseInt(c[1]?.split(":")[1] ?? "", 16) !== port) continue;
      rows++;
      if (Number(c[7]) === uid) mine++;
    }
  }
  if (!read || uid === undefined) return null;
  return rows > 0 && rows === mine;
}

/**
 * The port a connection goes to, or null to wait. The request carries the grant's token, so it may only go where Harbor
 * is: the port the file names while its writer still runs (only this user's processes can write the file), never
 * another. A file that is missing or whose writer is gone vouches for nothing (some other process may hold that port
 * now); then the turn's own port, the bridge's when it started, is tried, but only while the process listening there is
 * this user's (without /proc to tell, as an older Harbor did). The serving bridge writes the file again within seconds.
 */
export function target(file: string, fallback: number): number | null {
  const o = readPortFile(file);
  if (o && writerAlive(o)) return o.port;
  return listenerIsMine(fallback) === false ? null : fallback;
}

function attempt(port: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const up = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const failed = (): void => {
      up.destroy();
      resolve(null);
    };
    up.once("error", failed);
    up.once("connect", () => {
      up.off("error", failed);
      resolve(up);
    });
  });
}

async function pass(c: Socket, file: string, fallback: number): Promise<void> {
  c.pause();
  let gone = false;
  c.once("close", () => (gone = true));
  c.on("error", () => c.destroy());
  const until = Date.now() + relayWait.ms;
  let wait = 100;
  let up: Socket | null = null;
  while (!gone) {
    const to = target(file, fallback);
    up = to === null ? null : await attempt(to);
    if (up || Date.now() + wait > until) break;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 1000);
  }
  if (!up || gone) {
    up?.destroy();
    c.destroy();
    return;
  }
  const u = up;
  u.on("error", () => {
    u.destroy();
    c.destroy();
  });
  c.on("error", () => u.destroy());
  // The bridge's end reaches the agent through the pipe (after what's still on its way); an agent that left takes the bridge's side down with it.
  c.once("close", () => u.destroy());
  c.pipe(u);
  u.pipe(c);
  c.resume();
}

export interface Relay {
  port: number;
  close(): void;
}

/** Listens on a free loopback port and relays to the bridge named in `file` (`fallback` while it names none that runs: `target`). Null when it can't listen. */
export function relay(file: string, fallback: number): Promise<Relay | null> {
  return new Promise((resolve) => {
    const server: Server = createServer({ allowHalfOpen: true }, (c) => void pass(c, file, fallback));
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
    });
  });
}

/** The runner's part: with `RELAY` set, a relay, and the port it listens on (else the bridge's) in `BRIDGE_PORT` and in the arguments that name it. */
export async function setUp(env: Record<string, string | undefined>, argv: string[]): Promise<{ argv: string[]; relay: Relay | null }> {
  const file = env[RELAY];
  delete env[RELAY];
  if (file === undefined) return { argv, relay: null };
  const direct = Number(env[BRIDGE_PORT] ?? "");
  const r = Number.isInteger(direct) && direct > 0 ? await relay(file, direct) : null;
  const port = r ? String(r.port) : (env[BRIDGE_PORT] ?? String(portIn(file) ?? ""));
  env[BRIDGE_PORT] = port;
  return { argv: argv.map((a) => a.replaceAll(PORT_REF, port)), relay: r };
}
