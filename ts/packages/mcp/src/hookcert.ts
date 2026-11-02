import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createServer as createTcp, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { canon, HEAD_WAIT, header, identity as meshIdentity, type Identity, type Kv, lanPortmapNet, portmapIsPublic, portmapMapTo, portmapSockText, privateIp, Reader, readBody, readChunked, readHead, scopeKey, Throttle, urlEncode, type PortmapSock } from "@harbor/net";
import { now as unixNow, stateDir } from "@harbor/store";
import { type Hook, type Rate, type Tokens, serveHook } from "./control.ts";
import { isObject } from "./json.ts";

export const PORT = 47911;
export const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";
const ALPN_ACME = "acme-tls/1";
const BODY_MAX = 1 << 20;

export interface Status {
  name: string;
  base: string | null;
  /** How port 443 reaches this PC ("UPnP …", or why not). */
  route: string;
  error: string;
  /** When the certificate runs out (unix time). */
  expires: number;
  busy: boolean;
}

function blankStatus(): Status {
  return { name: "", base: null, route: "", error: "", expires: 0, busy: false };
}


export function b64u(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

/** The default name for a public address: an sslip.io name that resolves to it. */
export function sslipName(ip: string): string {
  const text = canon(ip);
  return `${text.replaceAll(text.includes(":") ? ":" : ".", "-")}.sslip.io`;
}

function writeOwned(dir: string, name: string, data: string): void {
  const tmp = `${dir}/${name}.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, `${dir}/${name}`);
}


function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Uint8Array.of(tag, body.length), body]);
  const len: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
  return Buffer.concat([Uint8Array.of(tag, 0x80 | len.length, ...len), body]);
}

const seq = (...p: Uint8Array[]): Buffer => der(0x30, ...p);
const oid = (...b: number[]): Buffer => der(0x06, Uint8Array.from(b));
const octets = (b: Uint8Array): Buffer => der(0x04, b);
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

const ECDSA_SHA256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);
const ACME_IDENTIFIER = oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1f);
const EXTENSION_REQUEST = oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e);

function utcTime(unix: number): Buffer {
  const d = new Date(unix * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return der(0x17, ascii(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}

const dnsNames = (name: string): Buffer => seq(der(0x82, ascii(name)));
const sanExtension = (name: string): Buffer => seq(SUBJECT_ALT_NAME, octets(dnsNames(name)));

function pem(label: string, data: Uint8Array): string {
  const b64 = Buffer.from(data).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function newKey(): { key: KeyObject; spki: Buffer; pem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { key: privateKey, spki: publicKey.export({ type: "spki", format: "der" }), pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export function challengeCert(name: string, keyAuth: string, at: number = unixNow()): { cert: string; der: Buffer; key: string } {
  const k = newKey();
  const digest = createHash("sha256").update(keyAuth).digest();
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const who = seq(der(0x31, seq(COMMON_NAME, der(0x0c, Buffer.from("Harbor ACME challenge")))));
  const extensions = der(0xa3, seq(sanExtension(name), seq(ACME_IDENTIFIER, der(0x01, Uint8Array.of(0xff)), octets(octets(digest)))));
  const tbs = seq(der(0xa0, der(0x02, Uint8Array.of(2))), der(0x02, serial), ECDSA_SHA256, who, seq(utcTime(at - 3600), utcTime(at + 7 * 86400)), who, k.spki, extensions);
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Uint8Array.of(0), sign("sha256", tbs, k.key)));
  return { cert: pem("CERTIFICATE", cert), der: cert, key: k.pem };
}

function certRequest(name: string, key: { key: KeyObject; spki: Buffer }): Buffer {
  const attributes = der(0xa0, seq(EXTENSION_REQUEST, der(0x31, seq(seq(SUBJECT_ALT_NAME, octets(dnsNames(name)))))));
  const info = seq(der(0x02, Uint8Array.of(0)), seq(), key.spki, attributes);
  return seq(info, ECDSA_SHA256, der(0x03, Uint8Array.of(0), sign("sha256", info, key.key)));
}


/** The ACME account key (`acme-account.pem`), kept apart from Harbor's identity. */
export class Account {
  kid: string | null = null;
  private readonly key: KeyObject;

  constructor(pemText: string) {
    this.key = createPrivateKey(pemText);
  }

  static loadOrCreate(dir: string = stateDir()): Account {
    const path = `${dir}/acme-account.pem`;
    if (existsSync(path)) return new Account(readFileSync(path, "utf8"));
    const text = newKey().pem;
    writeOwned(dir, "acme-account.pem", text);
    return new Account(text);
  }

  /** The public key as a JWK (members in the order RFC 7638's thumbprint needs). */
  jwk(): string {
    const j = createPublicKey(this.key).export({ format: "jwk" });
    return `{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`;
  }

  thumbprint(): string {
    return b64u(createHash("sha256").update(this.jwk()).digest());
  }

  /** A JWS for `url` (`payload` undefined: POST-as-GET). */
  jws(url: string, nonce: string, payload?: unknown): string {
    const protectedHeader: Record<string, unknown> = { alg: "ES256", nonce, url };
    if (this.kid !== null) protectedHeader.kid = this.kid;
    else protectedHeader.jwk = JSON.parse(this.jwk());
    const p64 = b64u(Buffer.from(JSON.stringify(protectedHeader)));
    const body = payload === undefined ? "" : b64u(Buffer.from(JSON.stringify(payload)));
    const sig = sign("sha256", Buffer.from(`${p64}.${body}`), { key: this.key, dsaEncoding: "ieee-p1363" });
    return JSON.stringify({ protected: p64, payload: body, signature: b64u(sig) });
  }
}


interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

/** One HTTPS request. Tests against a local ACME server (Pebble) bring their own CA in HARBOR_ACME_CA. */
async function acmeFetch(method: string, url: string, body?: string): Promise<Answer> {
  const init: RequestInit & { tls?: { ca: string } } = { method, signal: AbortSignal.timeout(30_000), redirect: "manual" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/jose+json" };
    init.body = body;
  }
  const ca = process.env.HARBOR_ACME_CA;
  if (ca) init.tls = { ca: readFileSync(ca, "utf8") };
  try {
    const res = await fetch(url, init);
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function field(v: unknown, k: string): unknown {
  return isObject(v) ? v[k] : undefined;
}

function text(v: unknown, k: string): string | undefined {
  const x = field(v, k);
  return typeof x === "string" ? x : undefined;
}

function need(v: unknown, k: string, what = k): string {
  const x = text(v, k);
  if (x === undefined) throw new Error(`no ${what}`);
  return x;
}

class Acme {
  nonce = "";

  private constructor(
    readonly dir: unknown,
    readonly account: Account,
    private pollMs: number,
  ) {}

  static async connect(directory: string, account: Account, pollMs: number): Promise<Acme> {
    const r = await acmeFetch("GET", directory);
    if (r.status !== 200) throw new Error(`the ACME directory answered ${r.status}`);
    const a = new Acme(JSON.parse(r.text) as unknown, account, pollMs);
    await a.freshNonce();
    return a;
  }

  async freshNonce(): Promise<void> {
    const r = await acmeFetch("HEAD", need(this.dir, "newNonce"));
    this.nonce = r.headers.get("replay-nonce") ?? "";
    if (this.nonce === "") throw new Error("no nonce");
  }

  async post(url: string, payload?: unknown): Promise<{ status: number; headers: Headers; body: unknown }> {
    for (let i = 0; i < 2; i++) {
      const r = await acmeFetch("POST", url, this.account.jws(url, this.nonce, payload));
      const n = r.headers.get("replay-nonce");
      if (n !== null) this.nonce = n;
      let v: unknown = null;
      try {
        v = JSON.parse(r.text);
      } catch {
        // an answer that is not JSON
      }
      if (r.status === 400 && (text(v, "type") ?? "").endsWith(":badNonce")) continue;
      if (r.status >= 400) throw new Error(text(v, "detail") ?? `${url} answered ${r.status}`);
      return { status: r.status, headers: r.headers, body: v };
    }
    throw new Error("the ACME server kept refusing the nonce");
  }

  async register(): Promise<void> {
    const r = await this.post(need(this.dir, "newAccount"), { termsOfServiceAgreed: true });
    this.account.kid = r.headers.get("location") ?? "";
    if (this.account.kid === "") throw new Error("no account URL");
  }

  async wait(url: string): Promise<unknown> {
    for (let i = 0; i < 30; i++) {
      const { body } = await this.post(url);
      const s = text(body, "status");
      if (s !== "pending" && s !== "processing") return body;
      await sleep(this.pollMs);
    }
    throw new Error("the ACME server took too long");
  }
}

export interface ObtainOptions {
  challenge: (c: Challenge | null) => void;
  account?: Account;
  pollMs?: number;
}

export interface Challenge {
  name: string;
  cert: string;
  key: string;
}

export async function obtain(directory: string, name: string, o: ObtainOptions): Promise<{ chain: string; key: string }> {
  const a = await Acme.connect(directory, o.account ?? Account.loadOrCreate(), o.pollMs ?? 2000);
  await a.register();
  const order = await a.post(need(a.dir, "newOrder"), { identifiers: [{ type: "dns", value: name }] });
  const orderUrl = order.headers.get("location");
  if (orderUrl === null) throw new Error("no order URL");
  const auths = field(order.body, "authorizations");
  for (const auth of Array.isArray(auths) ? auths : []) {
    if (typeof auth !== "string") throw new Error("bad authorization");
    const az = (await a.post(auth)).body;
    if (field(az, "status") === "valid") continue;
    const challenges = field(az, "challenges");
    const ch = (Array.isArray(challenges) ? challenges : []).find((c) => field(c, "type") === "tls-alpn-01");
    if (ch === undefined) throw new Error("the ACME server offers no TLS-ALPN-01 challenge");
    const keyAuth = `${need(ch, "token")}.${a.account.thumbprint()}`;
    const c = challengeCert(name, keyAuth);
    o.challenge({ name: name.toLowerCase(), cert: c.cert, key: c.key });
    let done: unknown;
    try {
      await a.post(need(ch, "url", "challenge URL"), {});
      done = await a.wait(auth);
    } finally {
      o.challenge(null);
    }
    if (field(done, "status") !== "valid") {
      const list = field(done, "challenges");
      const why = (Array.isArray(list) ? list : []).map((x) => text(field(x, "error"), "detail")).find((d) => d !== undefined) ?? "validation failed";
      throw new Error(`Let's Encrypt couldn't reach ${name}:443 (${why})`);
    }
  }
  const k = newKey();
  await a.post(need(order.body, "finalize", "finalize URL"), { csr: b64u(certRequest(name, k)) });
  const finished = await a.wait(orderUrl);
  const certUrl = text(finished, "certificate");
  if (certUrl === undefined) throw new Error(`the order ended ${JSON.stringify(field(finished, "status") ?? null)}`);
  const r = await acmeFetch("POST", certUrl, a.account.jws(certUrl, a.nonce));
  if (r.status !== 200 || !r.text.includes("BEGIN CERTIFICATE")) throw new Error(`the certificate download answered ${r.status}`);
  return { chain: r.text, key: k.pem };
}


export interface Hello {
  sni: string;
  alpn: string[];
}

/** The server name and protocols in a ClientHello record; empty ones when it has none or isn't readable. */
export function clientHello(b: Uint8Array): Hello {
  const out: Hello = { sni: "", alpn: [] };
  const u16 = (i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  // record header 5, handshake header 4, version 2, random 32
  let i = 5 + 4 + 2 + 32;
  if (b[0] !== 0x16 || b[5] !== 0x01 || i + 1 > b.length) return out;
  i += 1 + (b[i] ?? 0);
  i += 2 + u16(i);
  i += 1 + (b[i] ?? 0);
  if (i + 2 > b.length) return out;
  const end = Math.min(b.length, i + 2 + u16(i));
  i += 2;
  while (i + 4 <= end) {
    const type = u16(i);
    const len = u16(i + 2);
    const data = i + 4;
    if (data + len > end) break;
    if (type === 0 && len >= 5) {
      const n = u16(data + 3);
      if (b[data + 2] === 0 && data + 5 + n <= data + len) out.sni = Buffer.from(b.subarray(data + 5, data + 5 + n)).toString("ascii").toLowerCase();
    } else if (type === 16 && len >= 2) {
      for (let p = data + 2; p < data + len; ) {
        const n = b[p] ?? 0;
        out.alpn.push(Buffer.from(b.subarray(p + 1, p + 1 + n)).toString("ascii"));
        p += 1 + n;
      }
    }
    i = data + len;
  }
  return out;
}

function rewound(s: Socket, first: Buffer): Duplex {
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
  d.push(first);
  s.on("data", (x: Buffer) => {
    if (!d.push(x)) s.pause();
  });
  s.on("end", () => d.push(null));
  s.on("error", (e) => d.destroy(e));
  s.on("close", () => d.destroy());
  return d;
}

const REASONS: Record<number, string> = { 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 413: "Payload Too Large", 429: "Too Many Requests" };
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

async function written(res: Response): Promise<Buffer> {
  const body = Buffer.from(await res.arrayBuffer());
  const lines = [`HTTP/1.1 ${res.status} ${REASONS[res.status] ?? "Status"}`];
  res.headers.forEach((v, k) => {
    if (k !== "content-length" && k !== "connection") lines.push(`${k}: ${v}`);
  });
  lines.push(`Content-Length: ${body.length}`, "Connection: close", "", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n")), body]);
}

function lazyBody(read: () => Promise<Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(c) {
      try {
        const b = await read();
        if (b.length > 0) c.enqueue(b);
        c.close();
      } catch (e) {
        c.error(e);
      }
    },
  });
}


export interface Options {
  /** Settings: `hooks_public` ("1": on) and `hooks_name`. */
  kv: Kv;
  /** The webhooks that are live (their tokens). */
  tokens: Tokens;
  /** A webhook that arrived. */
  send(h: Hook): void;
  /** Something changed that Settings shows. */
  wake(): void;
  /** Harbor's own key, shown until a certificate is in. */
  identity?: () => Identity | null;
  /** Maps port 443 on the router to `internal` here: how, and the public address it got. */
  mapTo?: (internal: number, external: number) => Promise<[string, PortmapSock]>;
  isPublic?: (ip: string) => boolean;
  /** Where Harbor keeps its certificate and account key. */
  dir?: string;
  directory?: string;
  /** Interfaces to listen on (default: every one) and the port. */
  hosts?: string[];
  port?: number;
  rate?: Rate;
  now?: () => number;
  /** How often to look again, ms (default 20 minutes). */
  every?: number;
  pollMs?: number;
}

interface Saved {
  name: string;
  expires: number;
}

const PER_HOST = 12;
const PER_PUBLIC_HOST = 8;

function defaultIdentity(): Identity | null {
  try {
    return meshIdentity();
  } catch {
    return null;
  }
}

export class Hooks {
  private st: Status = blankStatus();
  private challenge: Challenge | null = null;
  private cert: { chain: string; key: string } | null = null;
  private on = false;
  private servers: Server[] = [];
  private sockets = new Set<Socket>();
  private hosts = new Map<string, number>();
  private conns = 0;
  private misses = new Throttle(20, 60_000);
  private failed: number | null = null;
  private lastError = "";
  private force = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private o: Options) {}

  status(): Status {
    return { ...this.st };
  }

  publicBase(): string | null {
    return this.st.base;
  }

  private get dir(): string {
    return this.o.dir ?? stateDir();
  }

  loadSaved(): Saved | null {
    try {
      const chain = readFileSync(`${this.dir}/hooks-cert.pem`, "utf8");
      const key = readFileSync(`${this.dir}/hooks-key.pem`, "utf8");
      const meta: unknown = JSON.parse(readFileSync(`${this.dir}/hooks-cert.json`, "utf8"));
      const name = field(meta, "name");
      const expires = field(meta, "expires");
      if (typeof name !== "string" || typeof expires !== "number" || !chain.includes("BEGIN CERTIFICATE")) return null;
      this.cert = { chain, key };
      return { name, expires };
    } catch {
      return null;
    }
  }

  start(): void {
    this.stopped = false;
    this.saved = this.loadSaved();
    void this.tick();
  }

  private saved: Saved | null = null;

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const s of this.servers) s.close();
    this.servers = [];
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.on = false;
  }

  kick(): void {
    this.force = true;
    clearTimeout(this.timer);
    if (this.ticking) this.again = true;
    else void this.tick();
  }

  private tick(): Promise<void> {
    this.ticking = (async () => {
      do {
        this.again = false;
        this.on = this.o.kv.get("hooks_public") === "1";
        if (this.on) {
          // The port is only opened once it's wanted.
          await this.listen();
          await this.round();
        } else this.st = blankStatus();
        this.o.wake();
      } while (this.again && !this.stopped);
      this.ticking = null;
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.o.every ?? 20 * 60_000);
    })().catch((e: unknown) => {
      this.ticking = null;
      console.error(`harbor: public webhooks: ${e instanceof Error ? e.message : String(e)}`);
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.o.every ?? 20 * 60_000);
    });
    return this.ticking;
  }

  setChallenge(c: Challenge | null): void {
    this.challenge = c;
  }

  settled(): Promise<void> {
    return this.ticking ?? Promise.resolve();
  }

  async round(): Promise<void> {
    const st = this.status();
    st.busy = true;
    st.error = "";
    this.st = { ...st };
    // Port 443 outside → the listener here.
    const port = this.o.port ?? PORT;
    const isPublic = this.o.isPublic ?? portmapIsPublic;
    let pub: string | null = null;
    try {
      const [how, a] = await (this.o.mapTo ?? ((i, e) => portmapMapTo(lanPortmapNet(), i, e)))(port, 443);
      if (a.port === 443 && isPublic(a.ip)) {
        st.route = `${how}: ${a.ip}:443 → this PC`;
        pub = a.ip;
      } else st.route = `${how} mapped ${portmapSockText(a)}, but Let's Encrypt needs port 443 on a public address`;
    } catch (e) {
      st.route = `Your router didn't open port 443 (${e instanceof Error ? e.message : String(e)}). Forward TCP 443 to this PC, port ${PORT}, on the router.`;
    }
    const typed = this.o.kv.get("hooks_name")?.trim().toLowerCase();
    const name = (typed !== undefined && typed !== "" ? typed : undefined) ?? (pub !== null ? sslipName(pub) : undefined) ?? this.saved?.name ?? "";
    st.name = name;
    const have = this.loadSaved();
    const at = (this.o.now ?? unixNow)();
    const fresh = have !== null && have.name === name && have.expires - at > 30 * 86400;
    const forced = this.force;
    this.force = false;
    const waiting = this.failed !== null && Date.now() - this.failed < 6 * 3600_000 && !forced;
    if (name !== "" && !fresh && waiting) {
      st.error = `${this.lastError} (tried again later, or press Check)`;
    } else if (name !== "" && !fresh) {
      const directory = this.o.directory ?? process.env.HARBOR_ACME_DIR ?? LETS_ENCRYPT;
      try {
        const account = Account.loadOrCreate(this.dir);
        const got = await obtain(directory, name, { challenge: (c) => (this.challenge = c), account, pollMs: this.o.pollMs ?? 2000 });
        try {
          writeOwned(this.dir, "hooks-cert.pem", got.chain);
          writeOwned(this.dir, "hooks-key.pem", got.key);
          writeOwned(this.dir, "hooks-cert.json", JSON.stringify({ name, expires: at + 90 * 86400 }));
        } catch (e) {
          st.error = `couldn't save the certificate: ${e instanceof Error ? e.message : String(e)}`;
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.error(`harbor: no certificate for public webhooks: ${why}`);
        this.failed = Date.now();
        this.lastError = why;
        st.error = why;
      }
    } else if (name === "") {
      st.error = "no public address to name: the router doesn't map port 443, and no name is set";
    }
    const now = this.loadSaved();
    if (now !== null && now.name === name) {
      st.base = `https://${now.name}/hooks`;
      st.expires = now.expires;
    } else st.base = null;
    st.busy = false;
    this.st = st;
  }


  private async listen(): Promise<void> {
    if (this.servers.length > 0) return;
    const port = this.o.port ?? PORT;
    for (const host of this.o.hosts ?? ["::", "0.0.0.0"]) {
      const server = createTcp({ pauseOnConnect: true }, (s) => this.accept(s));
      const bound = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen({ port, host, ipv6Only: host === "::" }, () => resolve(true));
      });
      if (bound) this.servers.push(server);
    }
  }

  boundPort(): number | null {
    const a = this.servers[0]?.address();
    return a !== null && a !== undefined && typeof a === "object" ? a.port : null;
  }

  private accept(s: Socket): void {
    s.on("error", () => {});
    // Off: closed without a word.
    const ip = s.remoteAddress;
    if (!this.on || ip === undefined || this.misses.over(ip) || this.conns >= 32) return void s.destroy();
    // Someone trying tokens: after 20 misses a minute, nothing more for that address.
    const key = scopeKey(ip);
    const cap = privateIp(ip) ? PER_HOST : PER_PUBLIC_HOST;
    const n = this.hosts.get(key) ?? 0;
    if (n >= cap) return void s.destroy();
    this.hosts.set(key, n + 1);
    this.conns++;
    this.sockets.add(s);
    s.once("close", () => {
      this.conns--;
      this.sockets.delete(s);
      const left = (this.hosts.get(key) ?? 1) - 1;
      if (left <= 0) this.hosts.delete(key);
      else this.hosts.set(key, left);
    });
    const timer = setTimeout(() => s.destroy(), HEAD_WAIT);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (buf[0] !== 0x16) {
        clearTimeout(timer);
        s.off("data", onData);
        s.end(BAD_REQUEST);
        return;
      }
      if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return;
      clearTimeout(timer);
      s.off("data", onData);
      s.pause();
      void this.secure(s, buf, ip).catch(() => s.destroy());
    };
    s.on("data", onData);
    s.resume();
  }

  /** The certificate a hello gets: the challenge's for a validation handshake, else the one webhooks are served with, else Harbor's own key. Null: none (the handshake is refused). */
  private certFor(h: Hello): { key: string; cert: string } | null {
    if (h.alpn.includes(ALPN_ACME)) {
      const c = this.challenge;
      return c !== null && c.name === h.sni ? { key: c.key, cert: c.cert } : null;
    }
    if (this.cert) return { key: this.cert.key, cert: this.cert.chain };
    const id = (this.o.identity ?? defaultIdentity)();
    return id ? { key: id.key, cert: id.cert } : null;
  }

  private async secure(s: Socket, first: Buffer, ip: string): Promise<void> {
    const pick = this.certFor(clientHello(first));
    if (!pick) return void s.destroy();
    const t = new TLSSocket(rewound(s, first), { isServer: true, ...pick, ALPNProtocols: [ALPN_ACME, "http/1.1"], rejectUnauthorized: false, minVersion: "TLSv1.2" });
    t.on("error", () => t.destroy());
    s.resume();
    await new Promise<void>((resolve) => {
      t.once("secure", () => resolve());
      t.once("close", () => resolve());
    });
    if (t.destroyed) return;
    // The validation only looks at the certificate.
    if (t.alpnProtocol === ALPN_ACME) return void t.end();
    t.setTimeout(10_000, () => t.destroy());
    const out = await this.answer(t);
    if (!out) return void t.destroy();
    if (!out.subarray(0, 12).toString().startsWith("HTTP/1.1 202")) this.misses.hit(ip);
    // The answer is out when the write ends; the client's close_notify is not waited for.
    t.end(out);
    t.once("finish", () => setTimeout(() => t.destroy(), 50));
  }

  private async answer(t: TLSSocket): Promise<Buffer | null> {
    const r = new Reader(t);
    let res: Response;
    try {
      const head = await readHead(r, true);
      const host = header(head, "host") ?? "hooks.invalid";
      const url = `https://${host}${head.path.split("/").map(urlEncode).join("/")}`;
      const init: RequestInit & { duplex?: "half" } = { method: head.method, headers: head.headers };
      if (head.method !== "GET" && head.method !== "HEAD" && (head.chunked || head.len > 0)) {
        init.body = lazyBody(() => (head.chunked ? readChunked(r, BODY_MAX) : readBody(r, Math.min(head.len, BODY_MAX), BODY_MAX)));
        init.duplex = "half";
      }
      const ctx = { tokens: this.o.tokens, send: this.o.send, ...(this.o.rate ? { rate: this.o.rate } : {}) };
      res = await serveHook(new Request(url, init), ctx);
    } catch {
      return Buffer.from(BAD_REQUEST);
    }
    return written(res);
  }
}


let current: Hooks | null = null;

export function start(o: Options): Hooks {
  current?.stop();
  current = new Hooks(o);
  current.start();
  return current;
}

export function kick(): void {
  current?.kick();
}

export function status(): Status {
  return current?.status() ?? blankStatus();
}

export function publicBase(): string | null {
  return current?.publicBase() ?? null;
}

export function stop(): void {
  current?.stop();
  current = null;
}
