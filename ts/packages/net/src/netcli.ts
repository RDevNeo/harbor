import type { Duplex } from "node:stream";
import { relayOpen } from "./client.ts";
import { connect as tcpConnect, type Socket } from "node:net";
import { type Kv } from "./kv.ts";
import { readMe } from "./mesh.ts";
import { dial, findPc, relayTargets } from "./relay.ts";
import { cachedMeshPeers } from "./account.ts";
import { label } from "./shared.ts";
import { DEFAULT_PORT, firewallBlocks, firewallFix, hostPort, lanAddrs, short, type Identity } from "./tls.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface MeshCliDeps {
  kv: Kv;
  id: Identity;
  io: CliIo;
  /** Harbors heard on the network within a moment (discover.ts `discoverAsk`). */
  ask: () => Promise<{ name: string; id: string; addr: string; fp: string }[]>;
  addrs?: () => string[];
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const MESH_USAGE = `usage: harbor mesh [status]
  This PC shares chats with the PCs of its workspace (Settings › Workspace); there is no pairing.`;

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - Array.from(s).length));

/** `harbor mesh [status]`: who this PC is and the workspace's PCs it shares chats with. Returns the exit code. */
export async function meshCli(args: string[], d: MeshCliDeps): Promise<number> {
  const { kv, io } = d;
  const me = d.id.fp;
  const who = readMe(kv, d.env ?? process.env);
  const portText = kv.get("api_port") ?? "";
  const port = /^\d+$/.test(portText) && Number(portText) <= 65535 ? Number(portText) : DEFAULT_PORT;
  const addrs = d.addrs ?? (() => lanAddrs(d.env ?? process.env));
  const list = cachedMeshPeers(kv, me);
  switch (args[0]) {
    case "status":
    case undefined: {
      if (args.length > 1) break;
      io.out(`this PC: ${who.name} (${who.id})`);
      io.out(`key:     ${me}`);
      const here = addrs().map((a) => hostPort(a, port));
      io.out(`listens: ${here.length === 0 ? "(no network)" : here.join("  ")}`);
      if (firewallBlocks(port)) io.out(`firewall: ufw drops port ${port} from the network; to let your devices in:\n  ${firewallFix(port)}`);
      const heard = await d.ask();
      if (heard.length > 0) {
        io.out("Harbors on this network:");
        for (const l of heard) io.out(`  ${pad(l.name, 20)} ${l.addr}  key ${short(l.fp)}${list.some((a) => a.fp === l.fp) ? "  (in this workspace)" : ""}`);
      }
      io.out("this workspace's PCs:");
      if (list.length === 0) io.out("  none (other PCs join this PC's workspace in Settings › Workspace)");
      for (const a of list) io.out(`  ${pad(a.name === "" ? label(a.id) : a.name, 20)} key ${short(a.fp)}  ${a.addrs.join(" ")}`);
      return 0;
    }
  }
  io.err(MESH_USAGE);
  return 2;
}

export interface NcDeps {
  kv: Kv;
  id: Identity;
  io: CliIo;
  stdin: Duplex | NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  /** A name Harbor can't reach is tried through Tailscale's own `nc`, when it is installed: its exit code, or null when there is none to try. */
  tailnetNc?: (host: string, port: number) => Promise<number> | null;
}

function bridge(s: Duplex, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<number> {
  return new Promise((resolve) => {
    stdin.on("data", (b: Buffer) => s.write(b));
    stdin.on("end", () => s.end());
    s.on("data", (b: Buffer) => stdout.write(b));
    s.on("close", () => resolve(0));
    s.on("error", () => resolve(0));
  });
}

/** `harbor nc [--device <id>] <host> <port>` (relay.rs `cli`): ssh's ProxyCommand for remote devices. */
export async function ncCli(args: string[], d: NcDeps): Promise<number> {
  let device = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device") device = args[++i] ?? "";
    else rest.push(args[i] ?? "");
  }
  const host = rest[0];
  const port = rest[1] !== undefined && /^\d+$/.test(rest[1]) && Number(rest[1]) <= 65535 ? Number(rest[1]) : null;
  if (host === undefined || port === null) {
    d.io.err("usage: harbor nc [--device <id>] <host> <port>");
    return 2;
  }
  const env = d.env ?? process.env;
  const list = cachedMeshPeers(d.kv, d.id.fp);
  const pc = findPc(list, device, host);
  if (pc) {
    const s = await dial(relayTargets(pc.addrs, port), env);
    if (s) return bridge(s, d.stdin, d.stdout);
    for (const via of list.filter((a) => a.fp !== "" && a.fp !== pc.fp)) {
      for (const addr of via.addrs) {
        try {
          const s2 = await relayOpen({ addr, fp: via.fp, as: d.id }, pc.fp, port, 30_000);
          return bridge(s2, d.stdin, d.stdout);
        } catch {
          // the next PC, or the next address
        }
      }
    }
    d.io.err(`harbor nc: ${pc.name === "" ? host : pc.name} doesn't answer, directly or through your other PCs`);
    return 1;
  }
  const s = await new Promise<Socket | null>((resolve) => {
    const c = tcpConnect({ host: host.replace(/^\[|\]$/g, ""), port });
    c.once("connect", () => resolve(c));
    c.once("error", () => resolve(null));
  });
  if (s) return bridge(s, d.stdin, d.stdout);
  const through = d.tailnetNc?.(host, port) ?? null;
  if (through !== null) return await through;
  d.io.err(`harbor nc: can't reach ${host}:${port}`);
  return 1;
}
