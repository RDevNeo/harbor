import { createSocket, type Socket } from "node:dgram";
import { request as httpRequest } from "node:http";
import { isIPv4 } from "node:net";
import { canonical, ipString, isUnspecified, parseIp } from "./ip.ts";
import type { Kv } from "./kv.ts";
import { now as nowSecs } from "./kv.ts";
import { socketAddr } from "./shared.ts";
import { DEFAULT_PORT, firewallBlocksInternet, firewallFixInternet, hostPort, lanAddrs, privateIp } from "./tls.ts";
import { sys } from "@harbor/os";

const LIFETIME = 3600;
const EVERY_MS = 20 * 60 * 1000;
const FORWARD_EVERY_MS = 300_000;
const MAX_HTTP_BODY = 256 << 10;

export interface PortmapSock {
  ip: string;
  port: number;
}

export function portmapSockText(s: PortmapSock): string {
  return hostPort(s.ip, s.port);
}

/** What this PC knows about being reachable from outside. */
export interface PortmapState {
  /** The mapping that works: how, and the public address and port. */
  mapped: [string, PortmapSock] | null;
  /** The router's public IPv4 address, when it said. */
  publicV4: string | null;
  /** IPv6 pinholes opened (PCP). */
  pinholes: string[];
  /** What each method answered, for Settings ("PCP: no answer", ...). */
  tried: [string, string][];
  /** When it last looked (ms; null: not yet). */
  checked: number | null;
  /** The last time a known key reached this PC from a public address: unix time and its address. */
  outside: [number, string] | null;
  /** A port forward set by hand on the router (kv `net_forward`), at the current public address. */
  forwarded: PortmapSock | null;
}

function emptyState(): PortmapState {
  return { mapped: null, publicV4: null, pinholes: [], tried: [], checked: null, outside: null, forwarded: null };
}

/** Every address and timing the port mapping uses. `lanPortmapNet()` is the real network. */
export interface PortmapNet {
  /** The default IPv4 gateway. */
  gatewayV4(): string | null;
  /** The default IPv6 gateway (link-local) and its interface name ("" for none). */
  gatewayV6(): { ip: string; dev: string } | null;
  /** The address this PC uses towards `to`. */
  localTo(to: string): Promise<string | null>;
  lanAddrs(): string[];
  /** The gateway's UDP port for PCP and NAT-PMP. */
  natPort: number;
  /** Where the SSDP M-SEARCH goes. */
  ssdp: { addr: string; port: number };
  /** How long one UDP try waits. */
  waitMs: number;
  ssdpWaitMs: number;
  /** One request to the router's own pages. */
  httpMs: number;
  /** Address-echo services over HTTPS. */
  publicUrls: string[];
  publicMs: number;
  /** Checks of the mapping, and of the port forward's public address. */
  everyMs: number;
  forwardEveryMs: number;
}

/** The real network: the router from the kernel's route tables, PCP/NAT-PMP on 5351, SSDP on 239.255.255.250:1900. */
export function lanPortmapNet(): PortmapNet {
  return {
    gatewayV4: () => gatewayV4(sys.netTable("route") ?? ""),
    gatewayV6: () => gatewayV6(sys.netTable("ipv6_route") ?? ""),
    localTo: localToDefault,
    lanAddrs: () => lanAddrs(),
    natPort: 5351,
    ssdp: { addr: "239.255.255.250", port: 1900 },
    waitMs: 1500,
    ssdpWaitMs: 2000,
    httpMs: 5500,
    publicUrls: ["https://api.ipify.org", "https://ipv4.icanhazip.com"],
    publicMs: 10_000,
    everyMs: EVERY_MS,
    forwardEveryMs: FORWARD_EVERY_MS,
  };
}

async function localToDefault(to: string): Promise<string | null> {
  const s = createSocket(to.includes(":") ? "udp6" : "udp4");
  s.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.connect(9, to, resolve);
    });
    return s.address().address;
  } catch {
    return null;
  } finally {
    s.close();
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A DNS name as typed: letters, digits, dashes and dots, with a dot, not too long. */
export function portmapValidName(n: string): boolean {
  return n.length <= 253 && n.includes(".") && !n.startsWith(".") && !n.endsWith(".") && /^[A-Za-z0-9.-]*$/.test(n);
}

/** Not private, not shared (CGNAT), not loopback: reachable from the internet if mapped. */
export function portmapIsPublic(s: string): boolean {
  const ip = parseIp(s);
  if (!ip) return false;
  const c = canonical(ip);
  const multicast = c.v === 4 ? ((c.b[0] ?? 0) & 0xf0) === 0xe0 : c.b[0] === 0xff;
  const shared = c.v === 4 && c.b[0] === 100 && ((c.b[1] ?? 0) & 0xc0) === 64;
  return !privateIp(s) && !isUnspecified(c) && !multicast && !shared;
}

/** A port as typed: 0 to 65535. */
function parsePort(s: string | null | undefined): number | null {
  if (s === null || s === undefined || !/^\+?\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= 65535 ? n : null;
}

/** The default IPv4 gateway, from /proc/net/route. */
export function gatewayV4(route: string): string | null {
  for (const l of route.split("\n").slice(1)) {
    const f = l.split(/\s+/).filter((x) => x !== "");
    const g = f[2];
    if (f.length > 2 && f[1] === "00000000" && g !== "00000000" && g !== undefined && /^[0-9a-fA-F]{1,8}$/.test(g)) {
      const n = parseInt(g, 16);
      return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
    }
  }
  return null;
}

/** The default IPv6 gateway (a link-local address) and its interface, from /proc/net/ipv6_route. */
export function gatewayV6(route: string): { ip: string; dev: string } | null {
  const zero = "0".repeat(32);
  for (const l of route.split("\n")) {
    const f = l.split(/\s+/).filter((x) => x !== "");
    const hex = f[4];
    const dev = f[9];
    if (f.length < 10 || f[0] !== zero || f[1] !== "00" || hex === undefined || hex === zero || dev === undefined || dev === "lo") continue;
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) continue;
    const b = Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
    return { ip: ipString({ v: 6, b }), dev };
  }
  return null;
}

export function pmpPublicParse(r: Uint8Array): string {
  if (r.length < 12 || r[0] !== 0 || r[1] !== 128) throw new Error("not a NAT-PMP answer");
  const code = ((r[2] ?? 0) << 8) | (r[3] ?? 0);
  if (code !== 0) throw new Error(`refused (code ${code})`);
  return [r[8], r[9], r[10], r[11]].join(".");
}

export function pmpRequest(port: number, lifetime: number): Uint8Array {
  return pmpRequestTo(port, port, lifetime);
}

const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A NAT-PMP TCP mapping of `internal`, asking for `external` outside. */
export function pmpRequestTo(internal: number, external: number, lifetime: number): Uint8Array {
  return Uint8Array.from([0, 2, 0, 0, ...be16(internal), ...be16(external), ...be32(lifetime)]);
}

/** The external port of a NAT-PMP TCP mapping answer. */
export function pmpMapParse(r: Uint8Array): number {
  if (r.length < 16 || r[0] !== 0 || r[1] !== 130) throw new Error("not a NAT-PMP answer");
  const code = ((r[2] ?? 0) << 8) | (r[3] ?? 0);
  if (code !== 0) throw new Error(`refused (code ${code})`);
  return ((r[10] ?? 0) << 8) | (r[11] ?? 0);
}

function v6Of(s: string): number[] {
  const ip = parseIp(s);
  if (!ip) return new Array<number>(16).fill(0);
  return ip.v === 4 ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...ip.b] : [...ip.b];
}

/** A PCP MAP request for TCP `port` from `client` (its IPv4 or IPv6 address), with `nonce`. */
export function pcpRequest(client: string, port: number, lifetime: number, nonce: Uint8Array): Uint8Array {
  return pcpRequestTo(client, port, port, lifetime, nonce);
}

/** A PCP MAP request of TCP `internal`, suggesting `external` outside. */
export function pcpRequestTo(client: string, internal: number, external: number, lifetime: number, nonce: Uint8Array): Uint8Array {
  const v4 = parseIp(client)?.v === 4;
  return Uint8Array.from([
    2, 1, 0, 0,
    ...be32(lifetime),
    ...v6Of(client),
    ...nonce,
    6, 0, 0, 0,
    ...be16(internal),
    ...be16(external),
    // Suggested external address: any, of the client's family.
    ...(v4 ? v6Of("0.0.0.0") : new Array<number>(16).fill(0)),
  ]);
}

/** A PCP MAP answer: the external address and port. */
export function pcpParse(r: Uint8Array, nonce: Uint8Array): PortmapSock {
  if (r.length < 60 || r[0] !== 2 || r[1] !== 0x81) throw new Error("not a PCP answer");
  if (r[3] !== 0) throw new Error(`refused (code ${r[3]})`);
  if (!nonce.every((x, i) => r[24 + i] === x)) throw new Error("answer to another request");
  const port = ((r[42] ?? 0) << 8) | (r[43] ?? 0);
  return { ip: ipString(canonical({ v: 6, b: Uint8Array.from(r.subarray(44, 60)) })), port };
}

function nonce12(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

const sameHost = (a: string, b: string) => canon0(a) === canon0(b);
const canon0 = (s: string) => {
  const ip = parseIp(s);
  return ip ? ipString(canonical(ip)) : s;
};

/** One UDP question, waiting up to `waitMs` for the answer (two tries); only the gateway's answer counts. */
async function udpAsk(waitMs: number, to: string, port: number, msg: Uint8Array, max: number): Promise<Uint8Array> {
  const sock: Socket = createSocket(to.includes(":") ? "udp6" : "udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, () => {
        sock.removeListener("error", reject);
        resolve();
      });
    });
  } catch (e) {
    sock.close();
    throw new Error(message(e));
  }
  sock.on("error", () => {});
  let waiter: ((b: Uint8Array) => void) | null = null;
  sock.on("message", (m, r) => {
    if (r.port === port && sameHost(r.address, to)) waiter?.(Uint8Array.from(m.subarray(0, Math.max(max, 64))));
  });
  try {
    for (let i = 0; i < 2; i++) {
      sock.send(msg, port, to, () => {});
      const got = await new Promise<Uint8Array | null>((resolve) => {
        const t = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, waitMs);
        waiter = (b) => {
          clearTimeout(t);
          waiter = null;
          resolve(b);
        };
      });
      if (got !== null) return got;
    }
  } finally {
    sock.close();
  }
  throw new Error("no answer");
}

/** The control URL of a gateway's WAN connection service: service type and URL. */
export function igdService(desc: string, base: string): { st: string; url: string } | null {
  for (const st of ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"]) {
    const at = desc.indexOf(`<serviceType>${st}</serviceType>`);
    if (at < 0) continue;
    const rest = desc.slice(at);
    const end = rest.indexOf("</service>");
    const block = end < 0 ? rest : rest.slice(0, end);
    const url = block.split("<controlURL>")[1]?.split("</controlURL>")[0]?.trim();
    if (url === undefined) return null;
    const full = url.startsWith("http") ? url : `${base.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
    return { st, url: full };
  }
  return null;
}

/** "http://host:port" of a URL. */
export function portmapBaseOf(url: string): string | null {
  if (!url.startsWith("http://")) return null;
  const host = url.slice(7).split("/")[0] ?? "";
  return `http://${host}`;
}

/** The text between `<name>` and `</name>`. */
export function portmapTag(xml: string, name: string): string | null {
  return xml.split(`<${name}>`)[1]?.split(`</${name}>`)[0] ?? null;
}

/** A tiny HTTP client for the router's own pages (plain HTTP on the LAN, as UPnP is). It goes direct: a proxy in the environment is no use for a router. */
function http(ms: number, url: string, soap?: { action: string; body: string }): Promise<string> {
  if (!url.startsWith("http://")) return Promise.reject(new Error("not http"));
  const rest = url.slice(7);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "/" : rest.slice(slash);
  const addr = socketAddr(host.includes(":") ? host : `${host}:80`);
  if (addr === null) return Promise.reject(new Error("bad host"));
  // Only the gateway's own LAN address: nothing a router's answer names elsewhere is fetched.
  if (!privateIp(addr.ip)) return Promise.reject(new Error("not on this network"));
  return new Promise((resolve, reject) => {
    let done = false;
    const end = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const headers: Record<string, string> = soap
      ? { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${soap.action}"`, "Content-Length": String(Buffer.byteLength(soap.body)), Connection: "close" }
      : { Connection: "close" };
    const req = httpRequest({ host: addr.ip, port: addr.port, path, method: soap ? "POST" : "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      const finish = () =>
        end(() => {
          const status = res.statusCode ?? 0;
          if (status !== 200) reject(new Error(`answered ${status}`));
          else resolve(Buffer.concat(chunks).subarray(0, MAX_HTTP_BODY).toString("utf8"));
        });
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        n += c.length;
        if (n >= MAX_HTTP_BODY) {
          finish();
          res.destroy();
        }
      });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", finish);
    });
    const timer = setTimeout(() => end(() => reject(new Error("timed out"))), ms);
    req.on("error", (e) => {
      end(() => reject(new Error(e.message)));
    });
    req.end(soap?.body);
  });
}

function soapEnvelope(st: string, action: string, args: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${st}">${args}</u:${action}></s:Body></s:Envelope>`;
}

/** Finds the gateway's UPnP description URL (SSDP M-SEARCH from `from`). */
async function ssdp(net: PortmapNet, from: string): Promise<string> {
  const s = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.bind(0, from, () => {
        s.removeListener("error", reject);
        resolve();
      });
    });
  } catch (e) {
    s.close();
    throw new Error(message(e));
  }
  s.on("error", () => {});
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = new Promise<string | null>((resolve) => {
      timer = setTimeout(() => resolve(null), net.ssdpWaitMs);
      s.on("message", (m) => {
        for (const l of m.toString().split(/\r?\n/)) {
          const i = l.indexOf(":");
          if (i >= 0 && l.slice(0, i).trim().toLowerCase() === "location") {
            resolve(l.slice(i + 1).trim());
            return;
          }
        }
      });
    });
    for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"]) {
      const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
      await new Promise<void>((resolve) => s.send(m, net.ssdp.port, net.ssdp.addr, () => resolve()));
    }
    const loc = await found;
    clearTimeout(timer);
    if (loc === null) throw new Error("no answer");
    return loc;
  } finally {
    s.close();
  }
}

async function upnpTo(net: PortmapNet, local: string, internal: number, external: number): Promise<{ ip: string | null; sock: PortmapSock }> {
  const loc = await ssdp(net, local);
  const desc = await http(net.httpMs, loc);
  const base = portmapTag(desc, "URLBase") ?? portmapBaseOf(loc);
  if (base === null) throw new Error("bad description");
  const svc = igdService(desc, base);
  if (svc === null) throw new Error("no WAN connection service");
  const { st, url: ctl } = svc;
  const args = `<NewRemoteHost></NewRemoteHost><NewExternalPort>${external}</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>${internal}</NewInternalPort><NewInternalClient>${local}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>Harbor</NewPortMappingDescription><NewLeaseDuration>${LIFETIME}</NewLeaseDuration>`;
  await http(net.httpMs, ctl, { action: `${st}#AddPortMapping`, body: soapEnvelope(st, "AddPortMapping", args) });
  const ext = await http(net.httpMs, ctl, { action: `${st}#GetExternalIPAddress`, body: soapEnvelope(st, "GetExternalIPAddress", "") }).catch(() => null);
  const said = ext === null ? undefined : portmapTag(ext, "NewExternalIPAddress")?.trim();
  const ip = said !== undefined && isIPv4(said) ? said : null;
  return { ip, sock: { ip: ip ?? "0.0.0.0", port: external } };
}

async function pcpMapTo(net: PortmapNet, gw: string, client: string, internal: number, external: number): Promise<PortmapSock> {
  const nonce = nonce12();
  const r = await udpAsk(net.waitMs, gw, net.natPort, pcpRequestTo(client, internal, external, LIFETIME, nonce), 1100);
  return pcpParse(r, nonce);
}

async function pmpMapTo(net: PortmapNet, gw: string, internal: number, external: number): Promise<{ ip: string; port: number }> {
  const ip = pmpPublicParse(await udpAsk(net.waitMs, gw, net.natPort, Uint8Array.from([0, 0]), 12));
  const port = pmpMapParse(await udpAsk(net.waitMs, gw, net.natPort, pmpRequestTo(internal, external, LIFETIME), 16));
  return { ip, port };
}

/** Maps TCP `external` on the router's public IPv4 address to `internal` here (PCP, NAT-PMP, then UPnP): how, and the public address it got. The router may give another external port. */
export async function portmapMapTo(net: PortmapNet, internal: number, external: number): Promise<[string, PortmapSock]> {
  const gw = net.gatewayV4();
  if (gw === null) throw new Error("no default gateway");
  const local = await net.localTo(gw);
  if (local === null || parseIp(local)?.v !== 4) throw new Error("no address towards the router");
  const why: string[] = [];
  try {
    return ["PCP", await pcpMapTo(net, gw, local, internal, external)];
  } catch (e) {
    why.push(`PCP: ${message(e)}`);
  }
  try {
    const p = await pmpMapTo(net, gw, internal, external);
    return ["NAT-PMP", { ip: p.ip, port: p.port }];
  } catch (e) {
    why.push(`NAT-PMP: ${message(e)}`);
  }
  try {
    return ["UPnP", (await upnpTo(net, local, internal, external)).sock];
  } catch (e) {
    why.push(`UPnP: ${message(e)}`);
    throw new Error(why.join(" · "));
  }
}

/** "now", "5m", "3h", "2d": how long ago a unix time was. */
export function portmapAgo(ts: number, nowS: number = nowSecs()): string {
  const d = Math.max(0, nowS - ts);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export interface PortmapOptions {
  kv: Kv;
  net: PortmapNet;
  /** Unix seconds. */
  nowSecs?: () => number;
  /** Milliseconds. */
  clock?: () => number;
}

export interface PortmapCliIo {
  log(line: string): void;
  err(line: string): void;
  firewallBlocksInternet?: (port: number) => boolean;
  firewallFixInternet?: (port: number) => string;
}

function asOutside(t: string | null): [number, string] | null {
  if (t === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const at: unknown = v[0];
  const ip: unknown = v[1];
  if (typeof at !== "number" || !Number.isInteger(at) || typeof ip !== "string") return null;
  const p = parseIp(ip);
  return p ? [at, canon0(ip)] : null;
}

/** Reachability from outside for one Harbor: the state, the router checks and what Settings shows. */
export class Portmap {
  private s: PortmapState = emptyState();
  private readonly kv: Kv;
  private readonly net: PortmapNet;
  private readonly secs: () => number;
  private readonly clock: () => number;
  private stopStart: (() => void) | null = null;

  constructor(o: PortmapOptions) {
    this.kv = o.kv;
    this.net = o.net;
    this.secs = o.nowSecs ?? nowSecs;
    this.clock = o.clock ?? Date.now;
  }

  /** A copy of the state. */
  state(): PortmapState {
    return structuredClone(this.s);
  }

  /** A known phone or PC reached the listener from a public address: proof it's reachable. */
  reached(from: string): void {
    const t = this.secs();
    if (this.s.outside === null || t - this.s.outside[0] > 60) {
      this.s.outside = [t, from];
      this.kv.set("net_outside", JSON.stringify([t, from]));
    }
  }

  /** The public "ip:port" to tell phones and peers, when mapped and actually public. */
  publicAddr(): string | null {
    const m = this.s.mapped?.[1];
    const a = m !== undefined && portmapIsPublic(m.ip) ? m : (this.s.forwarded ?? undefined);
    return a === undefined ? null : portmapSockText(a);
  }

  /** A name the user keeps pointing at this network (dynamic DNS), with the port that reaches this PC there: "name:port" (kv `net_name`, port from `net_forward`, else the API port). */
  publicName(port: number): string | null {
    const name = this.kv.get("net_name")?.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (name === undefined || !portmapValidName(name)) return null;
    const p = parsePort(this.kv.get("net_forward")?.trim()) ?? port;
    return `${name}:${p}`;
  }

  /** The public IPv4 address the internet sees this network as, from an address-echo service over HTTPS. Only asked when a port forward is set: the router doesn't say (no UPnP/NAT-PMP/PCP), and other PCs on the same network can't tell. */
  async askPublicV4(): Promise<string | null> {
    for (const url of this.net.publicUrls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(this.net.publicMs) });
        if (!res.ok) continue;
        const ip = (await res.text()).trim();
        if (isIPv4(ip) && portmapIsPublic(ip)) return ip;
      } catch {
        // Next service.
      }
    }
    return null;
  }

  private forwardPort(): number | null {
    const p = parsePort(this.kv.get("net_forward")?.trim());
    return p === null || p === 0 ? null : p;
  }

  /** The forward set in Settings (kv `net_forward`: the external port), at the current public address. A failed lookup keeps the last address (the network may just be down a moment). */
  async refreshForward(): Promise<void> {
    const ext = this.forwardPort();
    const ip = ext === null ? null : await this.askPublicV4();
    if (ext === null) this.s.forwarded = null;
    else if (ip !== null) this.s.forwarded = { ip, port: ext };
  }

  /** Maps TCP `external` here to `internal` through the router. */
  mapTo(internal: number, external: number): Promise<[string, PortmapSock]> {
    return portmapMapTo(this.net, internal, external);
  }

  /** Tries each method once; the state says what happened. */
  async check(port: number): Promise<PortmapState> {
    const st = emptyState();
    st.checked = this.clock();
    st.outside = this.s.outside;
    const net = this.net;
    const gw = net.gatewayV4();
    if (gw !== null) {
      const local = (await net.localTo(gw)) ?? "0.0.0.0";
      const localV4 = parseIp(local)?.v === 4 ? local : "0.0.0.0";
      try {
        const a = await pcpMapTo(net, gw, localV4, port, port);
        st.tried.push(["PCP", `mapped as ${portmapSockText(a)}`]);
        st.mapped = ["PCP", a];
      } catch (e) {
        st.tried.push(["PCP", message(e)]);
      }
      if (st.mapped === null) {
        try {
          const p = await pmpMapTo(net, gw, port, port);
          st.publicV4 = p.ip;
          st.tried.push(["NAT-PMP", `mapped as ${p.ip}:${p.port}`]);
          st.mapped = ["NAT-PMP", { ip: p.ip, port: p.port }];
        } catch (e) {
          st.tried.push(["NAT-PMP", message(e)]);
        }
      }
      if (st.mapped === null && localV4 !== "0.0.0.0") {
        try {
          const r = await upnpTo(net, localV4, port, port);
          st.publicV4 = r.ip;
          st.tried.push(["UPnP", `mapped as ${portmapSockText(r.sock)}`]);
          st.mapped = ["UPnP", r.sock];
        } catch (e) {
          st.tried.push(["UPnP", message(e)]);
        }
      }
      if (st.mapped !== null && parseIp(st.mapped[1].ip)?.v === 4) st.publicV4 = st.mapped[1].ip;
    } else {
      st.tried.push(["IPv4", "no default gateway"]);
    }
    // IPv6: a pinhole for each global address, where the router speaks PCP.
    const globals = net.lanAddrs().filter((a) => a.includes(":") && portmapIsPublic(a));
    const gw6 = net.gatewayV6();
    if (gw6 !== null && globals.length > 0) {
      const to = gw6.dev === "" ? gw6.ip : `${gw6.ip}%${gw6.dev}`;
      for (const g of globals) {
        const nonce = nonce12();
        try {
          pcpParse(await udpAsk(net.waitMs, to, net.natPort, pcpRequest(g, port, LIFETIME, nonce), 1100), nonce);
          st.pinholes.push(g);
        } catch (e) {
          st.tried.push(["PCP (IPv6)", message(e)]);
          break;
        }
      }
    }
    return st;
  }

  private loadOutside(): void {
    const o = asOutside(this.kv.get("net_outside"));
    if (o !== null) this.s.outside = o;
  }

  /** Keeps the mapping alive while `on()` says so (kv `net_map`); checks every 20 minutes. Returns the function that stops it. Starting twice does nothing. */
  start(port: number, on: () => boolean): () => void {
    if (this.stopStart !== null) return this.stopStart;
    this.loadOutside();
    let stopped = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const wakers = new Set<() => void>();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          wakers.delete(resolve);
          resolve();
        }, ms);
        timers.add(t);
        wakers.add(resolve);
      });
    void (async () => {
      while (!stopped) {
        await this.refreshForward();
        await sleep(this.net.forwardEveryMs);
      }
    })();
    void (async () => {
      while (!stopped) {
        if (on()) {
          const s = await this.check(port);
          const { outside, forwarded } = this.s;
          this.s = { ...s, outside, forwarded };
        } else {
          this.s.mapped = null;
          this.s.pinholes = [];
          this.s.tried = [["Router", "off (Settings)"]];
        }
        await sleep(this.net.everyMs);
      }
    })();
    this.stopStart = () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      for (const w of wakers) w();
      timers.clear();
      wakers.clear();
      this.stopStart = null;
    };
    return this.stopStart;
  }

  /** Settings' lines about reaching this PC from outside: title, detail, good? */
  summary(port: number, ago: (ts: number) => string = (ts) => portmapAgo(ts, this.secs())): [string, string, boolean][] {
    const s = this.s;
    const v: [string, string, boolean][] = [];
    if (s.forwarded !== null) {
      v.push(["IPv4: open (port forward)", `Your router forwards ${portmapSockText(s.forwarded)} to this PC (set by hand on the router)`, true]);
    }
    if (s.forwarded !== null) {
      // Shown above.
    } else if (s.mapped !== null) {
      const [how, a] = s.mapped;
      if (portmapIsPublic(a.ip)) {
        v.push(["IPv4: open", `${how} on your router maps ${portmapSockText(a)} to this PC`, true]);
      } else {
        v.push(["IPv4: behind your provider's shared address", `${how} mapped ${portmapSockText(a)}, but that address is itself behind your provider's NAT, so it can't be reached from the internet`, false]);
      }
    } else if (s.checked === null) {
      v.push(["IPv4: checking…", "Asking your router to open a port", false]);
    } else {
      const why = s.tried.map(([m, r]) => `${m}: ${r}`).join(" · ");
      v.push(["IPv4: not reachable from the internet", `Your router didn't open port ${port} (${why}). A port forward to this PC on the router would do it.`, false]);
    }
    const first = this.net.lanAddrs().find((a) => a.includes(":") && portmapIsPublic(a));
    if (s.outside !== null) {
      v.push(["Reached from the internet", `A paired device reached this PC from ${s.outside[1]}, ${ago(s.outside[0])} ago`, true]);
    } else if (first !== undefined && s.pinholes.length > 0) {
      v.push(["IPv6: open", `This PC is ${first}; your router opened it (PCP)`, true]);
    } else if (first !== undefined) {
      v.push(["IPv6: not confirmed", `This PC has a global IPv6 address (${first}). Whether your router lets connections in is known once your phone reaches it on mobile data.`, false]);
    } else {
      v.push(["IPv6: none", "This PC has no global IPv6 address.", false]);
    }
    return v;
  }

  /** `harbor net`: asks the router now and says whether this PC is reachable from outside. Returns the exit code. */
  async cli(args: string[], io: PortmapCliIo): Promise<number> {
    const port = parsePort(this.kv.get("api_port")) ?? DEFAULT_PORT;
    // `harbor net forward <port|off>` / `harbor net name <name|off>`: what Settings > Phones sets.
    const [cmd, v] = args;
    if (cmd === "forward" && v !== undefined) {
      const p = parsePort(v);
      if (v === "off") this.kv.set("net_forward", "");
      else if (p !== null && p !== 0) this.kv.set("net_forward", v);
      else {
        io.err("usage: harbor net forward <external port|off>");
        return 2;
      }
      io.log(`port forward: ${v} (Harbor picks it up within 5 minutes)`);
      return 0;
    }
    if (cmd === "name" && v !== undefined) {
      if (v === "off") this.kv.set("net_name", "");
      else if (portmapValidName(v)) this.kv.set("net_name", v);
      else {
        io.err("usage: harbor net name <dns name|off>");
        return 2;
      }
      io.log(`public name: ${v}`);
      return 0;
    }
    if (cmd !== undefined) {
      io.err("usage: harbor net [forward <port|off> | name <name|off>]");
      return 2;
    }
    const fwd = this.forwardPort();
    if (fwd !== null) {
      const ip = await this.askPublicV4();
      if (ip !== null) this.s.forwarded = { ip, port: fwd };
      else io.log(`port forward ${fwd} set, but the public address couldn't be learned`);
    }
    this.loadOutside();
    io.log(`asking the router about port ${port}…`);
    const s = await this.check(port);
    for (const [how, r] of s.tried) io.log(`  ${how.padEnd(11)} ${r}`);
    this.s = { ...s, forwarded: this.s.forwarded };
    const name = this.publicName(port);
    if (name !== null) io.log(`public name: ${name}`);
    for (const [title, detail] of this.summary(port)) io.log(`${title}\n  ${detail}`);
    const blocks = io.firewallBlocksInternet ?? firewallBlocksInternet;
    const fix = io.firewallFixInternet ?? firewallFixInternet;
    if (blocks(port)) io.log(`firewall: ufw drops port ${port} from the internet; to let paired devices in:\n  ${fix(port)}`);
    return 0;
  }
}
