import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { constants as cryptoConstants } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createServer as tcpServer, type Server as TcpServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { canonical, ipString, isLoopback, isUnspecified, linkLocal, parseIp, word, type Ip } from "./ip.ts";

export const DEFAULT_PORT = 47930;
/** discover.rs's UDP port. */
export const DISCOVER_PORT = 47930;


export interface Identity {
  pem: string;
  key: string;
  cert: string;
  /** DER of the certificate. */
  der: Uint8Array;
  /** SHA-256 of the certificate's SubjectPublicKeyInfo, hex. */
  fp: string;
}

interface Tlv {
  tag: number;
  header: number;
  length: number;
}

function tlv(b: Uint8Array): Tlv | null {
  const tag = b[0];
  const l0 = b[1];
  if (tag === undefined || l0 === undefined) return null;
  if (l0 < 0x80) return { tag, header: 2, length: l0 };
  const n = l0 & 0x7f;
  if (n === 0 || n > 4) return null;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const x = b[2 + i];
    if (x === undefined) return null;
    length = length * 256 + x;
  }
  return { tag, header: 2 + n, length };
}

/** The SubjectPublicKeyInfo (whole TLV) of a DER X.509 certificate. */
export function spki(cert: Uint8Array): Uint8Array | null {
  const outer = tlv(cert);
  if (!outer || outer.tag !== 0x30 || outer.header + outer.length > cert.length) return null;
  const body = cert.subarray(outer.header, outer.header + outer.length);
  const inner = tlv(body);
  if (!inner || inner.tag !== 0x30 || inner.header + inner.length > body.length) return null;
  let tbs = body.subarray(inner.header, inner.header + inner.length);
  // [0] version (optional), serial, signature algorithm, issuer, validity, subject, then the key.
  let skip = tbs[0] === 0xa0 ? 6 : 5;
  while (skip-- > 0) {
    const t = tlv(tbs);
    if (!t || t.header + t.length > tbs.length) return null;
    tbs = tbs.subarray(t.header + t.length);
  }
  const key = tlv(tbs);
  if (!key || key.tag !== 0x30 || key.header + key.length > tbs.length) return null;
  return tbs.subarray(0, key.header + key.length);
}

export function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

export function certFp(cert: Uint8Array): string | null {
  const key = spki(cert);
  return key ? sha256Hex(key) : null;
}

/** A fingerprint as typed or pasted: spaces, colons and dashes dropped, lowercase. */
export function normalizeFp(s: string): string | null {
  const f = s.replace(/[ :-]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(f) ? f : null;
}

/** A fingerprint as people compare it: the first 64 bits in groups of four. */
export function short(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

function pemBlock(pem: string, label: string): string | null {
  const m = pem.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----\\n?`));
  return m ? m[0] : null;
}

function pemDer(block: string): Uint8Array {
  return new Uint8Array(Buffer.from(block.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64"));
}

/** An identity from identity.pem: a PRIVATE KEY and a CERTIFICATE. */
export function parseIdentity(pem: string): Identity {
  const key = pemBlock(pem, "PRIVATE KEY");
  const cert = pemBlock(pem, "CERTIFICATE");
  if (!key) throw new Error("identity key: no private key in the file");
  if (!cert) throw new Error("identity certificate: no certificate in the file");
  const der = pemDer(cert);
  const fp = certFp(der);
  if (!fp) throw new Error("identity certificate: unreadable");
  return { pem, key, cert, der, fp };
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Uint8Array.of(tag, body.length), body]);
  const len: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
  return Buffer.concat([Uint8Array.of(tag, 0x80 | len.length, ...len), body]);
}

const seq = (...p: Uint8Array[]) => der(0x30, ...p);
const oid = (...bytes: number[]) => der(0x06, Uint8Array.from(bytes));
const ascii = (s: string) => new TextEncoder().encode(s);

const ECDSA_SHA256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

/** A new ECDSA P-256 key and a self-signed certificate like rcgen's in tls.rs: valid for a century. */
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = seq(der(0x31, seq(COMMON_NAME, der(0x0c, ascii("Harbor")))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = seq(
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, serial),
    ECDSA_SHA256,
    name,
    seq(der(0x17, ascii("250101000000Z")), der(0x18, ascii("21250101000000Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(seq(SUBJECT_ALT_NAME, der(0x04, seq(der(0x82, ascii("harbor"))))))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Uint8Array.of(0), signature));
  const b64 = Buffer.from(cert).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return parseIdentity(keyPem + certPem);
}

/** Loads `dir/identity.pem`, or makes it (owner-only) the first time; two starting at once: the first wins. */
export function loadOrCreate(dir: string): Identity {
  const path = join(dir, "identity.pem");
  if (existsSync(path)) return parseIdentity(readFileSync(path, "utf8"));
  const id = generateIdentity();
  const tmp = join(dir, `identity.pem.${process.pid}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeSync(fd, id.pem);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch {
    unlinkSync(tmp);
    return parseIdentity(readFileSync(path, "utf8"));
  }
  unlinkSync(tmp);
  return id;
}

/** The DER ECDSA P-256 / SHA-256 signature the account service checks (Identity::sign). */
export function signWith(id: Identity, msg: Uint8Array | string): Uint8Array {
  return new Uint8Array(sign("sha256", typeof msg === "string" ? Buffer.from(msg) : msg, createPrivateKey(id.key)));
}

export function spkiOf(id: Identity): Uint8Array {
  const k = spki(id.der);
  if (!k) throw new Error("identity certificate: unreadable");
  return k;
}


export const WRONG_KEY = "it answers with another key than the one paired here";

/** The fingerprint of what the other side showed; null when it showed no certificate. */
export function peerFp(sock: TLSSocket): string | null {
  const raw = sock.getPeerCertificate(true)?.raw;
  return raw && raw.length > 0 ? certFp(new Uint8Array(raw)) : null;
}

function serverTls(id: Identity) {
  return {
    key: id.key,
    cert: id.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    // Every connection proves its key again: no resumption to reason about.
    secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
  } as const;
}

export interface ClientOptions {
  id: Identity;
  /** The server's fingerprint; null only for pairing, where the code proves who it is. */
  pin: string | null;
  host?: string;
  port?: number;
  /** An established stream to run over instead of a new TCP connection (a relay). */
  stream?: Duplex;
  /** TLS 1.3 like tls.rs; "TLSv1.2" stands in for a phone with an older Android. */
  maxVersion?: "TLSv1.3" | "TLSv1.2";
  /** Connect and handshake timeout, ms (tls.rs: at least 3 s). */
  timeout?: number;
}

/** A pinned TLS connection that shows this identity's certificate; resolves with the server's fingerprint. */
export function connect(o: ClientOptions): Promise<{ sock: TLSSocket; fp: string }> {
  return new Promise((resolve, reject) => {
    const max = o.maxVersion ?? "TLSv1.3";
    const sock = tlsConnect({
      key: o.id.key,
      cert: o.id.cert,
      rejectUnauthorized: false,
      minVersion: max,
      maxVersion: max,
      ...(o.host === undefined ? {} : { host: o.host }),
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.stream === undefined ? {} : { socket: o.stream }),
    });
    const ms = Math.max(o.timeout ?? 3000, 3000);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("TLS: timed out"));
    }, ms);
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`TLS: ${e.message}`));
    });
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const fp = peerFp(sock);
      if (!fp) {
        sock.destroy();
        reject(new Error("TLS: no certificate"));
      } else if (o.pin !== null && fp !== o.pin) {
        sock.destroy();
        reject(new Error(WRONG_KEY));
      } else {
        sock.removeAllListeners("error");
        sock.on("error", () => {});
        resolve({ sock, fp });
      }
    });
  });
}

/** An accepted connection: TLS (with the client's fingerprint, if it showed one) or plain. */
export type Conn =
  | { tls: true; sock: TLSSocket; peer: string | null; remote: string; local: string }
  | { tls: false; sock: Socket; peer: null; remote: string; local: string };

/** A socket with data already read off it, as one stream again. */
export function rewound(s: Duplex, first: Buffer): Duplex {
  const d = new Duplex({
    read() {
      s.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      s.write(chunk, cb);
    },
    final(cb) {
      s.end();
      cb();
    },
    destroy(err, cb) {
      s.destroy();
      cb(err);
    },
  });
  if (first.length > 0) d.push(first);
  s.on("data", (x: Buffer) => {
    if (!d.push(x)) s.pause();
  });
  s.on("end", () => d.push(null));
  s.on("error", (e) => d.destroy(e));
  s.on("close", () => d.destroy());
  return d;
}

export interface AcceptOptions {
  /** The identity TLS answers with; null: TLS isn't available and TLS clients are dropped. */
  id: () => Identity | null;
  /** For connections from the open internet: only keys this returns true for are kept. */
  known?: (fp: string) => boolean;
  /** The whole head (first byte and handshake) must arrive within this, ms. */
  head?: number;
}

/** node:tls can't fail a TLS 1.3 handshake on the client's certificate, so a peer the `known`
 * check refuses is cut off right after it, before any data is read. */
export function accept(s: Socket, o: AcceptOptions): Promise<Conn | null> {
  const remote = s.remoteAddress ?? "";
  const local = s.localAddress ?? "";
  s.setNoDelay(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, o.head ?? 10_000);
    s.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    s.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
    s.once("data", (first: Buffer) => {
      s.pause();
      if (first[0] !== 0x16) {
        clearTimeout(timer);
        s.removeAllListeners("close");
        s.removeAllListeners("error");
        s.on("error", () => {});
        s.unshift(first);
        resolve({ tls: false, sock: s, peer: null, remote, local });
        return;
      }
      const id = o.id();
      if (!id) {
        clearTimeout(timer);
        s.destroy();
        resolve(null);
        return;
      }
      const t = new TLSSocket(rewound(s, first), { isServer: true, ...serverTls(id) });
      t.on("error", () => {
        clearTimeout(timer);
        t.destroy();
        resolve(null);
      });
      t.once("secure", () => {
        clearTimeout(timer);
        const peer = peerFp(t);
        if (o.known && !(peer && o.known(peer))) {
          t.destroy();
          resolve(null);
          return;
        }
        resolve({ tls: true, sock: t, peer, remote, local });
      });
      s.resume();
    });
    s.resume();
  });
}

/** A listener that hands each accepted connection, TLS or plain, to `onConn`. */
export function listen(o: AcceptOptions & { onConn: (c: Conn) => void; public?: (remote: string) => boolean }): TcpServer {
  return tcpServer({ pauseOnConnect: true }, (s) => {
    const pub = o.public?.(s.remoteAddress ?? "") ?? false;
    const opts: AcceptOptions = { id: o.id, ...(o.head === undefined ? {} : { head: o.head }) };
    if (pub && o.known) opts.known = o.known;
    void accept(s, opts).then((c) => {
      if (c) o.onConn(c);
    });
  });
}


export function tailnetIp(s: string): boolean {
  const ip = parseIp(s);
  if (!ip) return false;
  const c = canonical(ip);
  if (c.v === 4) return c.b[0] === 100 && ((c.b[1] ?? 0) & 0xc0) === 64;
  return word(c, 0) === 0xfd7a && word(c, 1) === 0x115c && word(c, 2) === 0xa1e0;
}

/** One key per network a host holds: IPv6 by its /64, so limits can't be dodged within it. */
export function scopeKey(s: string): string {
  const ip = parseIp(s);
  if (!ip) return s;
  const c = canonical(ip);
  if (c.v === 4) return ipString(c);
  const b = new Uint8Array(16);
  b.set(c.b.subarray(0, 8));
  return ipString({ v: 6, b });
}

/** An address on this PC, a private network (LAN, unique-local, link-local) or Tailscale's. */
export function privateIp(s: string): boolean {
  const ip = parseIp(s);
  if (!ip) return false;
  const c = canonical(ip);
  if (c.v === 4) {
    const [a = 0, b = 0] = c.b;
    return isLoopback(c) || a === 10 || (a === 172 && (b & 0xf0) === 16) || (a === 192 && b === 168) || linkLocal(c) || tailnetIp(s);
  }
  return isLoopback(c) || (word(c, 0) & 0xfe00) === 0xfc00 || linkLocal(c);
}

/** The temporary (privacy) and deprecated IPv6 addresses in /proc/net/if_inet6. */
export function temporaryV6(table: string): string[] {
  const out: string[] = [];
  for (const l of table.split("\n")) {
    const f = l.trim().split(/\s+/);
    const hex = f[0];
    const flags = parseInt(f[4] ?? "", 16);
    if (!hex || hex.length !== 32 || Number.isNaN(flags) || (flags & 0x21) === 0) continue;
    const b = Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
    out.push(ipString({ v: 6, b }));
  }
  return out;
}

/** This PC's interfaces: [name, address], loopback, unspecified, link-local and privacy addresses left out. */
export function interfaces(): [string, string][] {
  const out: [string, string][] = [];
  let temp: string[] = [];
  try {
    temp = temporaryV6(readFileSync("/proc/net/if_inet6", "utf8"));
  } catch {
    temp = [];
  }
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      const ip = parseIp(a.address);
      if (!ip || isLoopback(ip) || isUnspecified(ip) || linkLocal(ip)) continue;
      const s = ipString(ip);
      if (temp.includes(s)) continue;
      out.push([name, s]);
    }
  }
  return out;
}

/** Interfaces a phone or another PC can't reach (containers, VMs' bridges). */
export function virtualIf(name: string): boolean {
  return ["docker", "br-", "veth", "virbr", "vmnet", "lxc", "cni", "flannel", "podman"].some((p) => name.startsWith(p));
}

/** The addresses other devices may reach this PC at: the network's own first (IPv4, then IPv6), Tailscale's last. */
export function lanAddrs(env: Record<string, string | undefined> = process.env): string[] {
  const given = env.HARBOR_ADDRS;
  if (given !== undefined) return given.split(",").map((x) => x.trim()).filter((x) => parseIp(x) !== null);
  const v = interfaces()
    .filter(([n]) => !virtualIf(n))
    .map(([, ip]) => ip);
  const key = (ip: string) => (tailnetIp(ip) ? 2 : 0) + (ip.includes(":") ? 1 : 0);
  const sorted = v.map((ip, i) => ({ ip, i })).sort((a, b) => key(a.ip) - key(b.ip) || a.i - b.i).map((x) => x.ip);
  return sorted.filter((ip, i) => sorted[i - 1] !== ip);
}

/** `host:port` for an address (IPv6 in brackets). */
export function hostPort(ip: string, port: number): string {
  const p = parseIp(ip);
  if (!p) return `${ip}:${port}`;
  return p.v === 6 ? `[${ipString(p)}]:${port}` : `${ipString(p)}:${port}`;
}

let tsCache: { at: number; ips: string[] } | null = null;

/** True when `local` is an address of a Tailscale interface of this PC (cached for 30 s). */
export function onTailscaleIf(local: string): boolean {
  if (!tsCache || Date.now() - tsCache.at > 30_000) {
    tsCache = { at: Date.now(), ips: interfaces().filter(([n]) => n.startsWith("tailscale")).map(([, ip]) => ip) };
  }
  return tsCache.ips.includes(scopeless(local));
}

function scopeless(s: string): string {
  const p = parseIp(s);
  return p ? ipString(canonical(p)) : s;
}

/** Plain HTTP still served to not-yet-upgraded clients: both ends on Tailscale, on its interface. */
export function legacy(local: string, peer: string, env: Record<string, string | undefined> = process.env): boolean {
  return env.HARBOR_NO_LEGACY === undefined && tailnetIp(peer) && tailnetIp(local) && onTailscaleIf(local);
}


/** Whether a ufw configuration drops `port` from the local network. */
export function ufwBlocks(conf: string, defaults: string, rules: string, port: number, udp: boolean): boolean {
  return ufwDrops(conf, defaults, rules, port, udp, false);
}

/** ufwBlocks for connections from anywhere (`internet`: only a rule for every source counts). */
export function ufwDrops(conf: string, defaults: string, rules: string, port: number, udp: boolean, internet: boolean): boolean {
  const on = conf.split("\n").some((l) => l.trim() === "ENABLED=yes");
  const drops = defaults.split("\n").some((l) => ['DEFAULT_INPUT_POLICY="DROP"', 'DEFAULT_INPUT_POLICY="REJECT"'].includes(l.trim()));
  if (!on || !drops) return false;
  const u16 = (s: string): number | null => (/^\d+$/.test(s) && Number(s) <= 65535 ? Number(s) : null);
  const allows = rules
    .split("\n")
    .filter((l) => l.startsWith("### tuple ### "))
    .some((l) => {
      const f = l.slice("### tuple ### ".length).split(/\s+/).filter(Boolean);
      if (f.length < 7) return false;
      const [action = "", proto = "", dport = "", , , src = "", dir = ""] = f;
      if (internet && src !== "0.0.0.0/0" && src !== "::/0") return false;
      const portOk =
        dport === "any" ||
        dport.split(",").some((p) => {
          const r = p.split(":");
          if (r.length >= 2) {
            const a = u16(r[0] ?? "");
            const b = u16(r.slice(1).join(":"));
            return a !== null && b !== null && a <= port && port <= b;
          }
          return u16(p) === port;
        });
      const protoOk = proto === "any" || proto === (udp ? "udp" : "tcp");
      return (action === "allow" || action === "limit") && protoOk && portOk && dir === "in";
    });
  return !allows;
}

function readOr(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function ufwFiles() {
  return {
    rules: `${readOr("/etc/ufw/user.rules")}\n${readOr("/etc/ufw/user6.rules")}`,
    conf: readOr("/etc/ufw/ufw.conf"),
    defaults: readOr("/etc/default/ufw"),
  };
}

let fwCache: { at: number; port: number; v: boolean } | null = null;

/** True when ufw keeps other devices on the network from reaching Harbor (TCP or discovery's UDP); cached 20 s. */
export function firewallBlocks(port: number): boolean {
  if (fwCache && fwCache.port === port && Date.now() - fwCache.at < 20_000) return fwCache.v;
  const f = ufwFiles();
  const v = ufwBlocks(f.conf, f.defaults, f.rules, port, false) || ufwBlocks(f.conf, f.defaults, f.rules, DISCOVER_PORT, true);
  fwCache = { at: Date.now(), port, v };
  return v;
}

export function firewallBlocksInternet(port: number): boolean {
  const f = ufwFiles();
  return ufwDrops(f.conf, f.defaults, f.rules, port, false, true);
}

export function firewallFixInternet(port: number): string {
  return `sudo ufw allow ${port}/tcp comment harbor-internet`;
}

/** The commands that let the local network reach Harbor's port and discovery through ufw. */
export function firewallFix(port: number): string {
  const lan = `${[192, 168, 0, 0].join(".")}/16`;
  const ports = port === DISCOVER_PORT ? [port] : [port, DISCOVER_PORT];
  return ["10.0.0.0/8", "172.16.0.0/12", lan, "fc00::/7", "fe80::/10"]
    .flatMap((r) => ports.map((p) => `sudo ufw allow from ${r} to any port ${p} comment harbor`))
    .join(" && ");
}


/** Crockford's base32: no I, L, O, U. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new pairing code: 10 characters (50 bits), shown as "ABCDE-FGHJK". */
export function newCode(): string {
  const s = Array.from(randomBytes(10), (x) => B32[x & 31]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** A code as typed: case, spaces and dashes don't matter; O, I and L read as 0, 1, 1. */
export function normalizeCode(s: string): string {
  return Array.from(s)
    .filter((c) => /^[A-Za-z0-9]$/.test(c))
    .map((c) => {
      const u = c.toUpperCase();
      return u === "O" ? "0" : u === "I" || u === "L" ? "1" : u;
    })
    .join("");
}

/** The key both sides derive from the code (slow on purpose: 100k rounds per guess). */
export function codeKey(code: string): Uint8Array {
  return new Uint8Array(pbkdf2Sync(normalizeCode(code), "harbor-pair-v1", 100_000, 32, "sha256"));
}

/** One side's proof that it knows the code: `role` "join" or "host"; `host`, `join` the fingerprints each saw. */
export function proof(key: Uint8Array, role: string, host: string, join: string): string {
  return createHmac("sha256", key).update(`harbor-pair-v1\n${role}\n${host}\n${join}`).digest("hex");
}

export function proofOk(key: Uint8Array, role: string, host: string, join: string, given: string): boolean {
  const want = Buffer.from(proof(key, role, host, join));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A fixed-window limit per address (IPv6 per /64): at most `max` hits per `window` ms. */
export class Throttle {
  private hits = new Map<string, { at: number; n: number }>();
  constructor(
    private max: number,
    private window: number,
    private now: () => number = () => performance.now(),
  ) {}

  /** Counts one hit; false when `ip` is over the limit. */
  hit(ip: string): boolean {
    const now = this.now();
    if (this.hits.size > 4096) {
      for (const [k, v] of this.hits) if (now - v.at >= this.window) this.hits.delete(k);
      if (this.hits.size > 4096) this.hits.clear();
    }
    const k = scopeKey(ip);
    let e = this.hits.get(k);
    if (!e || now - e.at >= this.window) {
      e = { at: now, n: 0 };
      this.hits.set(k, e);
    }
    e.n += 1;
    return e.n <= this.max;
  }

  /** Over the limit already (without counting). */
  over(ip: string): boolean {
    const e = this.hits.get(scopeKey(ip));
    return e !== undefined && this.now() - e.at < this.window && e.n >= this.max;
  }
}
