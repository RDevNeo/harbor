import { createSocket, type Socket } from "node:dgram";
import { canon } from "./ip.ts";
import type { Shared } from "./shared.ts";
import { DISCOVER_PORT, hostPort, lanAddrs, normalizeFp, privateIp, tailnetIp } from "./tls.ts";
import { wire } from "./wire.ts";

export const DISCOVER_GROUP = "239.255.71.30";
const BROADCAST = "255.255.255.255";
/** How often a Harbor says it's here. */
const EVERY_MS = 30_000;
/** An announcement is forgotten after this. */
export const DISCOVER_FRESH_MS = 100_000;
const MAX_SEEN = 64;
const ANSWER_GAP_MS = 500;

/** A Harbor heard on the network. */
export interface LanHarbor {
  fp: string;
  id: string;
  name: string;
  /** Where its API listens ("ip:port"): the datagram's source address and the port it says. */
  addr: string;
  version: string;
  /** When it was heard (ms, on the clock given to the functions that record it). */
  at: number;
}

/** Harbors heard lately, by fingerprint (shared with Settings). */
export const discoverHeard = new Map<string, LanHarbor>();

/** What this Harbor says about itself, read at each announcement. `on`: sharing is on. */
export interface DiscoverMe {
  id: string;
  name: string;
  fp: string;
  port: number;
  version: string;
  on: boolean;
}

/** One place a datagram goes; `from`: the local interface multicast leaves by. */
export interface DiscoverDestination {
  addr: string;
  port: number;
  from?: string;
}

/** Where the socket binds, where datagrams go and whom to read from: all injectable so tests stay on loopback. */
export interface DiscoverNet {
  bindAddr: string;
  bindPort: number;
  /** Interfaces to join the multicast group on, re-read every round. */
  joins(): string[];
  destinations(): DiscoverDestination[];
  /** Whether a datagram from this source address is read at all. */
  accept(ip: string): boolean;
}

/** The IPv4 addresses of this PC's real interfaces (multicast is sent and joined on each). */
function v4Ifaces(): string[] {
  return lanAddrs().filter((a) => !a.includes(":") && !tailnetIp(a));
}

/** The real network: the group on every interface, the broadcast address, port 47930; only private sources. */
export function discoverLanNet(): DiscoverNet {
  return {
    bindAddr: "0.0.0.0",
    bindPort: DISCOVER_PORT,
    joins: v4Ifaces,
    destinations: () => [...v4Ifaces().map((from) => ({ addr: DISCOVER_GROUP, port: DISCOVER_PORT, from })), { addr: BROADCAST, port: DISCOVER_PORT }],
    accept: privateIp,
  };
}

function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
}

/** What a datagram says, when it's a Harbor's: the kind and the Harbor, with `from` (an IP) as its address. */
export function discoverParse(data: Uint8Array, from: string, at: number = Date.now()): { kind: string; lan: LanHarbor } | null {
  if (data.length > 1400) return null;
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return null;
  }
  if (field(v, "harbor") !== 1) return null;
  const rawFp = field(v, "fp");
  const fp = typeof rawFp === "string" ? normalizeFp(rawFp) : null;
  if (fp === null) return null;
  const port = field(v, "port");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const s = (k: string) => {
    const x = field(v, k);
    return typeof x === "string" ? Array.from(x).filter((c) => !/^\p{Cc}$/u.test(c)).slice(0, 60).join("") : "";
  };
  const lan: LanHarbor = { fp, id: s("id"), name: s("name"), addr: hostPort(canon(from), port), version: s("v"), at };
  return { kind: s("t"), lan };
}

/** The datagram this Harbor sends. */
export function discoverMessage(kind: string, id: string, name: string, fp: string, port: number, version: string): Uint8Array {
  return Buffer.from(wire({ harbor: 1, t: kind, id, name, fp, port, v: version }));
}

/** Records a Harbor heard; a paired one's address becomes one more to try. */
export function discoverRecord(shared: Shared, lan: LanHarbor, table: Map<string, LanHarbor> = discoverHeard, now: number = Date.now()): void {
  if (shared.allowedFp(lan.fp) !== null) shared.hint(lan.fp, lan.addr);
  for (const [k, l] of table) if (now - l.at >= DISCOVER_FRESH_MS) table.delete(k);
  if (table.size < MAX_SEEN || table.has(lan.fp)) table.set(lan.fp, lan);
}

const byName = (a: LanHarbor, b: LanHarbor) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Harbors heard lately that aren't paired with this one (for Settings > Devices). */
export function discoverUnpaired(shared: Shared, table: Map<string, LanHarbor> = discoverHeard, now: number = Date.now()): LanHarbor[] {
  return [...table.values()].filter((l) => now - l.at < DISCOVER_FRESH_MS && shared.allowedFp(l.fp) === null).sort(byName);
}

function bindSocket(net: DiscoverNet): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.once("error", reject);
    sock.bind(net.bindPort, net.bindAddr, () => {
      sock.removeListener("error", reject);
      try {
        sock.setBroadcast(true);
      } catch (e) {
        sock.close();
        reject(e);
        return;
      }
      sock.on("error", () => {});
      resolve(sock);
    });
  });
}

function sendOne(sock: Socket, data: Uint8Array, d: DiscoverDestination): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (d.from !== undefined) sock.setMulticastInterface(d.from);
      sock.send(data, d.port, d.addr, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** One after the other: the multicast interface is a setting of the socket, so each send must finish before the next. */
async function sendAll(sock: Socket, data: Uint8Array, dests: DiscoverDestination[]): Promise<void> {
  for (const d of dests) await sendOne(sock, data, d);
}

function join(sock: Socket, joined: Set<string>, ifaces: string[]): void {
  for (const ip of ifaces) {
    if (joined.has(ip)) continue;
    try {
      sock.addMembership(DISCOVER_GROUP, ip);
      joined.add(ip);
    } catch {
      // The interface may have no multicast yet; tried again next round.
    }
  }
}

export interface DiscoverOptions {
  shared: Shared;
  me: () => DiscoverMe;
  net?: DiscoverNet;
  table?: Map<string, LanHarbor>;
  everyMs?: number;
  clock?: () => number;
}

export interface DiscoverHandle {
  /** The port the socket is bound to. */
  port: number;
  /** Says "here" at once (this PC's addresses changed), instead of at the next tick. */
  announceNow(): void;
  stop(): void;
}

const running = new Set<DiscoverHandle>();

/** Says "here" at once on every running discovery. */
export function discoverAnnounceNow(): void {
  for (const h of running) h.announceNow();
}

/** Starts announcing and listening; null when the port can't be bound. The caller starts it once. */
export async function discoverStart(o: DiscoverOptions): Promise<DiscoverHandle | null> {
  const net = o.net ?? discoverLanNet();
  const table = o.table ?? discoverHeard;
  const clock = o.clock ?? Date.now;
  const every = o.everyMs ?? EVERY_MS;
  let sock: Socket;
  try {
    sock = await bindSocket(net);
  } catch (e) {
    console.error(`harbor: no network discovery (UDP ${net.bindPort}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const say = (kind: string): Uint8Array | null => {
    const me = o.me();
    if (me.fp === "" || !me.on) return null;
    return discoverMessage(kind, me.id, me.name, me.fp, me.port, me.version);
  };

  let stopped = false;
  let pending = false;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handle: DiscoverHandle = {
    port: sock.address().port,
    announceNow() {
      pending = true;
      wake?.();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      running.delete(handle);
      if (timer !== null) clearTimeout(timer);
      wake?.();
      sock.close();
    },
  };
  running.add(handle);

  let lastAnswer = Number.NEGATIVE_INFINITY;
  sock.on("message", (data, rinfo) => {
    if (stopped || !net.accept(rinfo.address)) return;
    const t = clock();
    const parsed = discoverParse(data, rinfo.address, t);
    if (parsed === null || parsed.lan.fp === o.me().fp) return;
    discoverRecord(o.shared, parsed.lan, table, t);
    // Someone just started (or a terminal asks): say it's here too, at most twice a second.
    if (parsed.kind === "ask" && t - lastAnswer > ANSWER_GAP_MS) {
      lastAnswer = t;
      const m = say("here");
      if (m !== null) void sendAll(sock, m, net.destinations());
    }
  });

  // Sender: now (asking), then every 30 s; joins the group on interfaces as they come.
  void (async () => {
    const joined = new Set<string>();
    let first = true;
    while (!stopped) {
      join(sock, joined, net.joins());
      const m = say(first ? "ask" : "here");
      if (m !== null) {
        await sendAll(sock, m, net.destinations());
        first = false;
      }
      if (stopped) break;
      if (!pending) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, every);
        });
        wake = null;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      }
      pending = false;
    }
  })();
  return handle;
}

export interface DiscoverAskOptions {
  /** How long to listen. */
  waitMs: number;
  /** This PC's own fingerprint: its own answer is left out. */
  myFp: string;
  net?: DiscoverNet;
}

/** For `harbor mesh` on a terminal: asks the network and listens for `waitMs`. */
export async function discoverAsk(o: DiscoverAskOptions): Promise<LanHarbor[]> {
  const net = o.net ?? discoverLanNet();
  let sock: Socket;
  try {
    sock = await bindSocket(net);
  } catch {
    return [];
  }
  const out = new Map<string, LanHarbor>();
  sock.on("message", (data, rinfo) => {
    const p = discoverParse(data, rinfo.address);
    if (p !== null && p.kind === "here" && p.lan.fp !== o.myFp) out.set(p.lan.fp, p.lan);
  });
  join(sock, new Set(), net.joins());
  const m = Buffer.from(wire({ harbor: 1, t: "ask", fp: "0".repeat(64), port: 1 }));
  await sendAll(sock, m, net.destinations());
  await new Promise((resolve) => setTimeout(resolve, o.waitMs));
  sock.close();
  return [...out.values()].sort(byName);
}
