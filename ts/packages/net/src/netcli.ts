import type { Duplex } from "node:stream";
import { relayOpen } from "./client.ts";
import { connect as tcpConnect, type Socket } from "node:net";
import { Hub } from "./hub.ts";
import { now, type Kv } from "./kv.ts";
import { loadCode, Mesh, readMe, showCode, type MeshApp } from "./mesh.ts";
import { dial, findPc, relayTargets } from "./relay.ts";
import { allowedJson, label, loadAllowed, type Allowed } from "./shared.ts";
import { DEFAULT_PORT, firewallBlocks, firewallFix, hostPort, lanAddrs, normalizeFp, short, type Identity } from "./tls.ts";
import { err } from "./http.ts";

const CODE_TRIES = 5;

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

const MESH_USAGE = `usage: harbor mesh status | on | off | pair | join <address> <code> | allow <PC>… | remove <PC>…
  pair             show a one-time code; type it on the other PC (Settings › Devices, or harbor mesh join)
  join <PC> <code>  pair with the PC that shows <code>: its name on this network, or its address
  <PC>: the fingerprint of its key (\`harbor mesh status\` on it), its name if it's listed here,
        or its Tailscale name / node ID (PCs from before 0.13)`;

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - Array.from(s).length));

/** `harbor mesh …` (mesh.rs `cli`): sharing on/off, pairing and the allowed PCs. Returns the exit code. */
export async function meshCli(args: string[], d: MeshCliDeps): Promise<number> {
  const { kv, io } = d;
  const me = d.id.fp;
  const who = readMe(kv, d.env ?? process.env);
  const portText = kv.get("api_port") ?? "";
  const port = /^\d+$/.test(portText) && Number(portText) <= 65535 ? Number(portText) : DEFAULT_PORT;
  const addrs = d.addrs ?? (() => lanAddrs(d.env ?? process.env));
  const clock = d.clock ?? now;
  const list = loadAllowed(kv);
  const save = (l: Allowed[]) => kv.set("mesh_allowed", allowedJson(l));
  switch (args[0]) {
    case "on":
    case "off":
      if (args.length !== 1) break;
      kv.set("mesh_enabled", args[0] === "on" ? "1" : "0");
      io.out(`sharing chats with your other PCs: ${args[0]}`);
      return 0;
    case "pair": {
      if (args.length !== 1) break;
      const code = showCode(kv);
      io.out(`Pairing code: ${code.code}   (good for 10 minutes, once)`);
      io.out("On the other PC, in Harbor › Settings › Devices › Pair with a code, or:");
      for (const a of addrs()) io.out(`  harbor mesh join ${hostPort(a, port)} ${code.code}`);
      io.out(`This PC's key: ${short(me)}`);
      io.out("Waiting (Harbor must be running here with sharing on; Ctrl+C to stop waiting)…");
      const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
      while (clock() < code.expires) {
        await sleep(1000);
        const c = loadCode(kv);
        if (c?.code !== code.code) {
          io.err("harbor: another code replaced this one");
          return 1;
        }
        if (c.paired !== "") {
          io.out(`paired with ${c.paired}`);
          return 0;
        }
        if (c.tries >= CODE_TRIES) {
          io.err("harbor: too many wrong tries: the code is void");
          return 1;
        }
      }
      io.err("harbor: the code ran out");
      return 1;
    }
    case "join": {
      if (args.length !== 3) break;
      let target = args[1] ?? "";
      if (!target.includes(".") && !target.includes(":")) {
        const heard = await d.ask();
        const l = heard.find((x) => x.name.toLowerCase() === target.toLowerCase() || label(x.id).toLowerCase() === target.toLowerCase());
        if (!l) {
          io.err(`harbor: no Harbor called ${target} on this network (give its address)`);
          return 1;
        }
        target = l.addr;
      }
      const hub = new Hub([], port);
      hub.mesh.me = who;
      const app: MeshApp = {
        helloExtra: () => ({ version: "", accounts: [], update: null, owner: "", github: "", owner_suggested: false }),
        chats: () => ({ chats: [], update: null }),
        items: () => null,
        applyChats: () => [],
        applyItems: () => {},
        route: async () => err(404, "unknown mesh call"),
      };
      const mesh = new Mesh({ hub, kv, id: () => d.id, app, myAddrs: () => addrs().map((a) => hostPort(a, port)), uploadsDir: "", upload: async () => err(404, "") });
      try {
        const a = await mesh.pairJoin(target, args[2] ?? "");
        kv.set("mesh_enabled", "1");
        io.out(`paired with ${a.name === "" ? (args[1] ?? "") : a.name} (key ${short(a.fp)}); sharing is on`);
        return 0;
      } catch (e) {
        io.err(`harbor: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    case "allow":
    case "remove": {
      if (args.length < 2) break;
      const allow = args[0] === "allow";
      for (const q of args.slice(1)) {
        const fp = normalizeFp(q);
        if (fp !== null) {
          if (fp === me) {
            io.err("harbor: that's this PC's own key");
            return 1;
          }
          const had = list.some((a) => a.fp === fp);
          const keep = list.filter((a) => a.fp !== fp);
          list.length = 0;
          list.push(...keep);
          if (allow) list.push({ node: "", name: "", fp, id: "", addrs: [] });
          io.out(`${allow ? "allowed" : had ? "removed" : "not listed:"} ${short(fp)}`);
          continue;
        }
        const i = list.findIndex((a) => a.name.toLowerCase() === q.toLowerCase() || a.id === q || label(a.id).toLowerCase() === q.toLowerCase() || (a.node !== "" && a.node === q));
        if (i >= 0) {
          if (allow) io.out(`${q} is allowed already`);
          else {
            const [a] = list.splice(i, 1);
            if (a) io.out(`removed ${a.name} ${short(a.fp !== "" ? a.fp : a.node)}`);
          }
          continue;
        }
        io.err(`harbor: no PC ${q}: give the fingerprint of its key (\`harbor mesh status\` on it), or pair with \`harbor mesh pair\``);
        return 1;
      }
      save(list);
      return 0;
    }
    case "status":
    case undefined: {
      if (args.length > 1) break;
      io.out(`this PC: ${who.name} (${who.id})`);
      io.out(`key:     ${me}`);
      io.out(`sharing: ${kv.get("mesh_enabled") === "1" ? "on" : "off"}`);
      const here = addrs().map((a) => hostPort(a, port));
      io.out(`listens: ${here.length === 0 ? "(no network)" : here.join("  ")}`);
      if (firewallBlocks(port)) io.out(`firewall: ufw drops port ${port} from the network; to let your devices in:\n  ${firewallFix(port)}`);
      const heard = await d.ask();
      if (heard.length > 0) {
        io.out("Harbors on this network:");
        for (const l of heard) io.out(`  ${pad(l.name, 20)} ${l.addr}  key ${short(l.fp)}${list.some((a) => a.fp === l.fp) ? "  (paired)" : ""}`);
      }
      io.out("allowed PCs:");
      if (list.length === 0) io.out("  none (pair one: harbor mesh pair)");
      for (const a of list) {
        const name = a.name === "" ? label(a.id) : a.name;
        const how = a.fp === "" ? `Tailscale node ${a.node} (until it upgrades to 0.13)` : `key ${short(a.fp)}`;
        io.out(`  ${pad(name, 20)} ${how}  ${a.addrs.join(" ")}`);
      }
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
  const list = loadAllowed(d.kv);
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
  d.io.err(`harbor nc: can't reach ${host}:${port}`);
  return 1;
}
