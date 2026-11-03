import { readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

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

function portIn(file: string): number | null {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
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
    // The port the bridge wrote last, never another: whoever holds an old one would see the request's token.
    up = await attempt(portIn(file) ?? fallback);
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

/** Listens on a free loopback port and relays to the bridge named in `file` (`fallback` while it can't be read). Null when it can't listen. */
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
