import { closeSync, createReadStream, existsSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  bearer,
  err,
  header,
  HttpError,
  parseJson,
  query,
  readBody,
  readHead,
  Reader,
  response,
  segments,
  sendBytes,
  sendJson,
  type Reply,
  type Request,
} from "./http.ts";
import { APP_INBOX, deviceId, draftFileOf, POLL, safeName, type Hub, type Level, type PhoneClaims, type Via } from "./hub.ts";
import { canon, isLoopback, parseIp } from "./ip.ts";
import { now } from "./kv.ts";
import { accept, legacy, privateIp, scopeKey, Throttle, type Conn, type Identity } from "./tls.ts";
import type { Json } from "./wire.ts";

const MAX_JSON = 2 << 20;
export const MAX_AUDIO = 16_000 * 2 * 600 + 4096;
const MAX_UPLOAD = 200 << 20;
export const HEAD_WAIT = 10_000;
export const OLD_PAIRING = "This PC now uses Google accounts: update Harbor on this phone (Settings › Update), then sign in with Google.";
export const ALIVE_WAIT_MS = 240_000;
export const ALIVE_EVERY_S = 900;

/** A call for the app (api.rs `Call`). */
export interface Call {
  method: string;
  path: string[];
  query: [string, string][];
  body: unknown;
  token: string;
  device: string;
  global: boolean;
}

/** Who is on the other end of a connection. */
export interface ConnPeer {
  ip: string;
  via: Via;
}

export interface Account {
  isToken(t: string): boolean;
  /** The token's claims when it lets this phone (key `fp`) in; throws with why not. */
  admit(t: string, fp: string): PhoneClaims;
  knownDevice(fp: string): boolean;
}

export interface FileAnswer {
  status: number;
  ctype: string;
  body: Uint8Array;
  range?: string;
}

/** What the listener needs from the rest of Harbor. */
export interface ApiDeps {
  hub: Hub;
  id: () => Identity | null;
  uploadsDir: string;
  /** The app's routes (api.rs `api_route`), for every call not served here. */
  route: (call: Call) => Promise<Reply>;
  account: Account | null;
  /** `GET /v1/app`: {version_code, url, hub}. */
  appInfo: () => Json;
  /** The APK this PC serves, if any. */
  apk: () => string | null;
  /** `/mesh/…` (mesh.rs `serve`); the body is still on the reader. */
  mesh: (peer: ConnPeer, req: Request, r: Reader) => Promise<Reply>;
  /** A peer that may share chats with this PC (mesh.rs `admitted`). */
  meshAdmitted: (peer: ConnPeer, req: Request) => boolean;
  /** `POST /relay/v1/<fp>/<port>` (relay.ts); it owns the connection from then on. */
  relay: (peer: ConnPeer, req: Request, r: Reader, w: Duplex) => Promise<void>;
  /** `GET /v1/hubs` (mesh.rs `hubs`). */
  hubs: () => Json;
  versions?: () => Json;
  /** A typing lease for another PC's chat goes to that PC: true when it was forwarded. */
  forwardLease?: (chat: number, view: boolean, device: string, kind: string, label: string, on: boolean, draft: Record<string, unknown> | null) => boolean;
  /** An image of another PC's chat, from that PC. */
  homeImage?: (chat: number, path: string, max: number | null) => Promise<FileAnswer | null>;
  homeMedia?: (chat: number, path: string, range: string | null) => Promise<FileAnswer | null>;
  /** `/v1/image`: a card's image, scaled (media package). */
  image?: (path: string, max: number | null) => Promise<FileAnswer>;
  /** `/v1/media`'s checks (media.rs `check`): null when the file may be served, else why not. */
  mediaCheck?: (path: string) => string | null;
  mime?: (path: string) => string;
  /** Where a shown file is now: itself, or its kept copy once a temp file is gone (media.rs `located`). */
  located?: (path: string) => string;
  mediaWait?: (path: string) => Promise<void>;
  /** `POST /v1/transcribe` (voice package): the WAV body and the query. */
  transcribe?: (wav: Uint8Array, q: [string, string][]) => Promise<Reply>;
  /** The router opened the port and a public address reached it (portmap.rs `reached`). */
  reached?: (ip: string) => void;
  /** This PC's window should look again (Rust's `wake`). */
  wake?: () => void;
  env?: Record<string, string | undefined>;
}

/** Calls refused lately (unix s, why), newest last: Settings › Phones shows a few. */
export const REFUSED: [number, string][] = [];

function noteRefused(ip: string, why: string): void {
  const line = `${ip}: ${why}`;
  const i = REFUSED.findIndex(([, l]) => l === line);
  if (i >= 0) REFUSED.splice(i, 1);
  REFUSED.push([now(), line]);
  if (REFUSED.length > 20) REFUSED.splice(0, REFUSED.length - 20);
}

export function refusedText(status: number, why: string): string {
  const w = why.length > 0 ? why[0]?.toUpperCase() + why.slice(1) : why;
  return status === 401 && !w.includes("sign in") ? `${w}. Sign in again in Harbor for Android.` : `${w}.`;
}

/** Whether `/app.apk` is served: to anyone on this network, from the internet to a signed-in phone or an old pairing. */
export function apkAllowed(pub: boolean, who: { level: Level | null } | null): boolean {
  return !pub || (who !== null && (who.level === null || who.level === "legacy"));
}

/** The bytes a Range header asks of a file of `len` bytes: [first, last], "past" when it starts beyond, null for all. */
export function byteRange(h: string | null, len: number): [number, number] | "past" | null {
  const m = h?.trim().match(/^bytes=([^-]*)-(.*)$/);
  if (!m) return null;
  const [, f = "", t = ""] = m;
  if (f === "") {
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n > 0 && len > 0 ? [Math.max(0, len - n), len - 1] : null;
  }
  if (!/^\d+$/.test(f) || (t !== "" && !/^\d+$/.test(t))) return null;
  const from = Number(f);
  const to = t === "" ? Number.MAX_SAFE_INTEGER : Number(t);
  if (from > to) return null;
  return from < len ? [from, Math.min(to, len - 1)] : "past";
}

class Slots {
  n = 0;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.n >= this.max) return false;
    this.n += 1;
    return true;
  }
  give(): void {
    this.n -= 1;
  }
}

const PER_HOST = 12;
const PER_PUBLIC_HOST = 8;

export class Api {
  readonly fails = new Throttle(30, 60_000);
  private conns = new Slots(64);
  private publicConns = new Slots(24);
  private hosts = new Map<string, number>();
  private servers: Server[] = [];

  constructor(readonly d: ApiDeps) {}

  private env(k: string): string | undefined {
    return (this.d.env ?? process.env)[k];
  }

  /** Who makes a call: a signed-in phone (level null) or a pairing token from before accounts. */
  caller(peer: ConnPeer, req: Request): { token: string; level: Level | null } {
    const t = bearer(req);
    if (t === null) throw new HttpError(401, "no token");
    if (this.d.account?.isToken(t)) {
      if (peer.via.kind !== "tls" || peer.via.fp === null) throw new HttpError(401, "a sign-in needs the phone's own key (TLS)");
      const fp = peer.via.fp;
      let c: PhoneClaims;
      try {
        c = this.d.account.admit(t, fp);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        throw new HttpError(m.includes("workspace") || m.includes("removed") ? 403 : 401, m);
      }
      return { token: this.d.hub.accountPhone(c, fp), level: null };
    }
    try {
      return { token: t, level: this.d.hub.auth(t, peer.via) };
    } catch (e) {
      throw new HttpError(401, e instanceof Error ? e.message : String(e));
    }
  }

  /** Keys known here, for connections from the internet. */
  known(fp: string): boolean {
    return this.d.hub.tokens.some((t) => t.fp === fp) || this.d.hub.mesh.allowedFp(fp) !== null || (this.d.account?.knownDevice(fp) ?? false);
  }

  private isPublic(ip: string): boolean {
    return !privateIp(ip) || this.env("HARBOR_TEST_PUBLIC") !== undefined;
  }

  /** Listens on `addrs` (HARBOR_LISTEN, else every interface) at the hub's port. */
  async listen(addrs?: string[]): Promise<string[]> {
    const want = addrs ?? (this.env("HARBOR_LISTEN")?.split(",").map((s) => s.trim()).filter((s) => s !== "") ?? ["::", "0.0.0.0"]);
    const bound: string[] = [];
    let error = "";
    for (const ip of want) {
      const s = createServer({ pauseOnConnect: true }, (sock) => this.onSocket(sock));
      const r = await new Promise<string | null>((resolve) => {
        s.once("error", (e) => resolve(e.message));
        s.listen({ host: ip, port: this.d.hub.port, ipv6Only: false }, () => resolve(null));
      });
      if (r === null) {
        bound.push(ip);
        this.servers.push(s);
      } else if (ip === "0.0.0.0" && bound.includes("::")) bound.push(ip);
      else error = `${ip}:${this.d.hub.port}: ${r}`;
    }
    this.d.hub.net = { ...this.d.hub.net, bound, error };
    return bound;
  }

  /** The port the first listener got (for tests with port 0). */
  port(): number {
    const a = this.servers[0]?.address();
    return typeof a === "object" && a !== null ? a.port : this.d.hub.port;
  }

  close(): void {
    for (const s of this.servers) s.close();
    this.servers = [];
  }

  private onSocket(sock: import("node:net").Socket): void {
    if (!this.d.hub.active()) {
      sock.destroy();
      return;
    }
    const ip = canon(sock.remoteAddress ?? "");
    const key = scopeKey(ip);
    const cap = privateIp(ip) ? PER_HOST : PER_PUBLIC_HOST;
    const n = this.hosts.get(key) ?? 0;
    if (n >= cap) {
      sock.destroy();
      return;
    }
    const pub = !privateIp(ip);
    if (pub && !this.publicConns.take()) {
      sock.destroy();
      return;
    }
    if (!this.conns.take()) {
      if (pub) this.publicConns.give();
      sock.destroy();
      return;
    }
    this.hosts.set(key, n + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.conns.give();
      if (pub) this.publicConns.give();
      const m = (this.hosts.get(key) ?? 1) - 1;
      if (m <= 0) this.hosts.delete(key);
      else this.hosts.set(key, m);
    };
    sock.once("close", release);
    void this.serve(sock, ip).catch(() => sock.destroy());
  }

  private async serve(sock: import("node:net").Socket, ip: string): Promise<void> {
    const local = canon(sock.localAddress ?? ip);
    if (this.fails.over(ip)) {
      sock.destroy();
      return;
    }
    const pub = this.isPublic(ip);
    const conn: Conn | null = await accept(sock, {
      id: this.d.id,
      head: pub ? 5_000 : HEAD_WAIT,
      ...(pub ? { known: (fp: string) => this.known(fp) } : {}),
    });
    if (!conn) {
      if (pub) this.fails.hit(ip);
      return;
    }
    const lo = parseIp(ip);
    const via: Via = conn.tls
      ? { kind: "tls", fp: conn.peer }
      : lo && isLoopback(lo)
        ? { kind: "loopback" }
        : legacy(local, ip, this.d.env ?? process.env)
          ? { kind: "legacy" }
          : { kind: "refused" };
    if (pub) {
      if (!(via.kind === "tls" && via.fp !== null && this.known(via.fp))) {
        conn.sock.destroy();
        return;
      }
      this.d.reached?.(ip);
    }
    const w: Duplex = conn.sock;
    const r = new Reader(w);
    const idle = setTimeout(() => w.destroy(), HEAD_WAIT);
    let req: Request;
    try {
      req = await readHead(r);
    } catch (e) {
      clearTimeout(idle);
      if (e instanceof HttpError) sendJson(w, e.status, { error: e.message });
      else w.destroy();
      return;
    }
    clearTimeout(idle);
    conn.sock.setTimeout(30_000, () => conn.sock.destroy());
    await this.handle({ ip, via }, req, r, w, pub);
  }

  /** One request, its head read: api.rs `serve` from the head on. */
  async handle(peer: ConnPeer, req: Request, r: Reader, w: Duplex, pub: boolean): Promise<void> {
    const hub = this.d.hub;
    const ip = peer.ip;
    if (peer.via.kind === "refused") return sendJson(w, 426, { error: "Harbor answers other devices over TLS only" });
    const segs = segments(req.path);
    const is = (...p: string[]) => segs.length === p.length && p.every((x, i) => segs[i] === x);
    if (segs[0] === "relay" && req.method === "POST") {
      if (!hub.mesh.on) return sendJson(w, 403, { error: "this PC doesn't share its chats (Settings › Devices)" });
      return this.d.relay(peer, req, r, w);
    }
    const onlyPaired = () => {
      this.fails.hit(ip);
      sendJson(w, 403, { error: "only for paired PCs" });
    };
    if (is("mesh", "v1", "app.apk") && req.method === "GET") {
      const paired = peer.via.kind === "tls" && peer.via.fp !== null && hub.mesh.allowedFp(peer.via.fp) !== null;
      if (!paired || !hub.mesh.on) return onlyPaired();
      return this.serveApk(w, false);
    }
    if (is("mesh", "v1", "image") && req.method === "GET") {
      if (!(hub.mesh.on && this.d.meshAdmitted(peer, req))) return onlyPaired();
      return this.serveImage(w, query(req, "path") ?? "", maxOf(req));
    }
    if (is("mesh", "v1", "media") && req.method === "GET") {
      if (!(hub.mesh.on && this.d.meshAdmitted(peer, req))) return onlyPaired();
      return this.serveMedia(w, query(req, "path") ?? "", header(req, "range"));
    }
    if (segs[0] === "mesh") {
      const reply = await this.d.mesh(peer, req, r);
      if (reply.status === 401 || reply.status === 403) this.fails.hit(ip);
      return sendJson(w, reply.status, reply.body);
    }
    if (!hub.enabled) {
      w.destroy();
      return;
    }
    let who: { token: string; level: Level | null } | null = null;
    let refusal: HttpError | null = null;
    try {
      who = this.caller(peer, req);
    } catch (e) {
      refusal = e instanceof HttpError ? e : new HttpError(401, String(e));
    }
    if ((req.method === "GET" || req.method === "HEAD") && is("app.apk") && apkAllowed(pub, who)) return this.serveApk(w, req.method === "HEAD");
    if (!who) {
      const e = refusal ?? new HttpError(401, "no token");
      this.fails.hit(ip);
      noteRefused(ip, e.message);
      return sendJson(w, e.status, { error: refusedText(e.status, e.message), signin: e.status === 401 });
    }
    const { token, level } = who;
    if (level === "legacy") {
      if (req.method === "GET" && is("v1", "app")) return sendJson(w, 200, this.d.appInfo());
      noteRefused(ip, "a pairing from before accounts");
      return sendJson(w, 401, { error: OLD_PAIRING, signin: true, upgrade: true });
    }
    const device = Array.from(header(req, "x-harbor-device") ?? "").slice(0, 60).join("");
    const global = header(req, "x-harbor-ids") === "global";
    hub.seen.set(token, [device, now()]);
    hub.ips.set(token, ip);
    const saidText = header(req, "x-harbor-app")?.trim() ?? "";
    const said = /^[+]?\d+$/.test(saidText) && Number(saidText) > 0 ? Number(saidText) : null;
    const inbox = segs[0] === "v1" && segs[1] === "inbox";
    if (said !== null || inbox) hub.apps.set(token, said ?? Math.max(hub.apps.get(token) ?? 0, APP_INBOX));
    const plat = Array.from(header(req, "x-harbor-platform") ?? "")
      .filter((c) => !isCtl(c))
      .slice(0, 240)
      .join("");
    if (plat.trim() !== "") hub.platforms.set(token, plat);
    const body = async (max: number): Promise<unknown> => {
      try {
        return parseJson(await readBody(r, req.len, max));
      } catch {
        return null;
      }
    };
    const m = req.method;
    if (m === "GET" && is("v1", "app")) return sendJson(w, 200, this.d.appInfo());
    if (m === "GET" && is("v1", "versions") && this.d.versions) return sendJson(w, 200, this.d.versions());
    if (m === "GET" && is("v1", "events")) {
      const sinceText = query(req, "since") ?? "";
      const since = /^\d+$/.test(sinceText) ? Number(sinceText) : 0;
      const [rev, chats, stateChanged] = await hub.wait(since, POLL);
      let state = stateChanged;
      let changed: Json[];
      if (global) {
        state = state || chats.some((c) => !hub.mesh.gids.has(c));
        changed = chats.flatMap((c) => {
          const g = hub.mesh.gids.get(c);
          return g === undefined ? [] : [g];
        });
      } else changed = chats;
      const n = hub.inboxFor(hub.groupOf(token)).length;
      return sendJson(w, 200, { rev, changed_chats: changed, state_changed: state, inbox: n });
    }
    if (m === "GET" && is("v1", "inbox")) return sendJson(w, 200, { items: hub.inboxFor(hub.groupOf(token)) });
    if (m === "GET" && segs.length === 3 && segs[0] === "v1" && segs[1] === "inbox") return this.serveParcel(w, hub.groupOf(token), segs[2] ?? "");
    if (m === "POST" && segs.length === 4 && segs[0] === "v1" && segs[1] === "inbox" && segs[3] === "done") {
      const b = obj(await body(4096));
      const e = typeof b.error === "string" && b.error !== "" ? `On the phone: ${Array.from(b.error).slice(0, 300).join("")}` : null;
      const found = hub.delivered(hub.groupOf(token), segs[2] ?? "", e);
      return sendJson(w, found ? 200 : 404, found ? { ok: true } : { error: "nothing waits with that id" });
    }
    if (m === "GET" && is("v1", "hubs")) return sendJson(w, 200, this.d.hubs());
    if (m === "POST" && is("v1", "alive")) {
      const b = obj(await body(4096));
      return sendJson(w, 200, await this.alive(token, b));
    }
    if (m === "POST" && segs.length === 4 && segs[0] === "v1" && segs[1] === "chats" && segs[3] === "typing") {
      const c = segs[2] ?? "";
      const chat = /^-?\d+$/.test(c) ? Number(c) : hub.mesh.byGid(c);
      if (chat === null) return sendJson(w, 404, { error: "no such chat" });
      const b = obj(await body(512 << 10));
      const on = typeof b.typing === "boolean" ? b.typing : true;
      const draft = typeof b.draft === "object" && b.draft !== null && !Array.isArray(b.draft) ? (b.draft as Record<string, unknown>) : typeof b.text === "string" ? { text: b.text } : null;
      const kind = b.kind === "pc" ? "pc" : "phone";
      const named = hub.tokens.find((t) => t.token === token)?.name ?? "";
      const label = device !== "" ? device : named !== "" ? named : kind === "pc" ? "A PC" : "Phone";
      if (this.d.forwardLease?.(chat, false, deviceId(token), kind, label, on, draft)) return sendJson(w, 200, { ok: true });
      if (hub.report(chat, deviceId(token), kind, label, on, draft, (id) => draftFileOf(this.d.uploadsDir, id))) this.d.wake?.();
      return sendJson(w, 200, { ok: true });
    }
    if (m === "GET" && is("v1", "image")) {
      const path = query(req, "path") ?? "";
      const max = maxOf(req);
      const chat = chatOf(hub, query(req, "chat"));
      if (chat !== null && this.d.homeImage) {
        const a = await this.d.homeImage(chat, path, max);
        if (a) return sendBytes(w, 200, a.ctype, a.body);
      }
      return this.serveImage(w, path, max);
    }
    if (m === "GET" && is("v1", "media")) {
      const path = query(req, "path") ?? "";
      const chat = chatOf(hub, query(req, "chat"));
      const range = header(req, "range");
      if (chat !== null && this.d.homeMedia) {
        const a = await this.d.homeMedia(chat, path, range);
        if (a) return sendBytes(w, a.status, a.ctype, a.body, a.range ? `Accept-Ranges: bytes\r\nContent-Range: ${a.range}\r\n` : "");
      }
      return this.serveMedia(w, path, range);
    }
    if (m === "POST" && is("v1", "transcribe") && this.d.transcribe) {
      if (req.len > MAX_AUDIO) return sendJson(w, 413, { error: "recording too long" });
      const wav = await r.take(req.len);
      if (wav.length !== req.len) return sendJson(w, 400, { error: "short body" });
      const rep = await this.d.transcribe(wav, req.query);
      return sendJson(w, rep.status, rep.body);
    }
    if (m === "POST" && is("v1", "upload")) {
      const up = await this.upload(r, req);
      return sendJson(w, up.status, up.body);
    }
    if (req.len > MAX_JSON) return sendJson(w, 413, { error: "body too large" });
    const raw = await r.take(req.len);
    if (raw.length !== req.len) return sendJson(w, 400, { error: "short body" });
    let parsed: unknown;
    try {
      parsed = parseJson(raw);
    } catch (e) {
      return sendJson(w, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    const call: Call = { method: m, path: segs, query: req.query, body: parsed, token, device, global };
    this.d.wake?.();
    let reply: Reply;
    try {
      reply = await withTimeout(this.d.route(call), 30_000, err(503, "Harbor did not answer in time"));
    } catch (e) {
      reply = err(500, e instanceof Error ? e.message : String(e));
    }
    return sendJson(w, reply.status, reply.body);
  }

  /** `POST /v1/alive`: recorded for Devices; the notes since `since` (0: none, from now). */
  async alive(token: string, body: Record<string, unknown>): Promise<Json> {
    this.d.hub.alive.set(token, [now(), Date.now()]);
    const out: Record<string, Json> = { ok: true, every_s: ALIVE_EVERY_S };
    const since = typeof body.since === "number" && Number.isInteger(body.since) && body.since >= 0 ? body.since : null;
    const notes = this.d.hub.notes;
    if (since !== null && notes) {
      const wait = typeof body.wait_ms === "number" && Number.isInteger(body.wait_ms) && body.wait_ms >= 0 ? Math.min(body.wait_ms, ALIVE_WAIT_MS) : 0;
      const [list, last] = since === 0 ? [[], notes.last()] : await notes.wait(since, wait);
      out.notes = list as Json[];
      out.last = last;
    }
    return out;
  }

  private serveApk(w: Duplex, headOnly: boolean): void {
    const path = this.d.apk();
    if (path === null) return sendJson(w, 404, { error: "this Harbor has no phone app yet (Settings › Phones › Download)" });
    let len: number;
    try {
      len = statSync(path).size;
    } catch {
      return sendJson(w, 404, { error: "the app file is unreadable" });
    }
    w.write(response(200, "application/vnd.android.package-archive", len, 'Content-Disposition: attachment; filename="harbor.apk"\r\n'));
    if (headOnly) {
      w.end();
      return;
    }
    createReadStream(path).pipe(w);
  }

  private serveParcel(w: Duplex, group: string, id: string): void {
    const p = this.d.hub.parcel(group, id);
    if (!p?.path) return sendJson(w, 404, { error: "nothing waits with that id" });
    let len: number;
    try {
      len = statSync(p.path).size;
    } catch {
      return sendJson(w, 404, { error: "the file is gone from the PC" });
    }
    w.write(response(200, "application/octet-stream", len));
    let sent = 0;
    let told = performance.now();
    const f = createReadStream(p.path);
    f.on("data", (c) => {
      sent += c.length;
      if (performance.now() - told > 200) {
        p.report(sent, false, null);
        told = performance.now();
      }
    });
    f.on("end", () => p.report(sent, false, null));
    f.pipe(w);
  }

  private async serveImage(w: Duplex, path: string, max: number | null): Promise<void> {
    if (!this.d.image) return sendJson(w, 404, { error: "no such image: images aren't served by this Harbor yet" });
    const a = await this.d.image(path, max);
    if (a.status !== 200) return sendJson(w, a.status, { error: Buffer.from(a.body).toString() });
    sendBytes(w, 200, a.ctype, a.body);
  }

  private async serveMedia(w: Duplex, path: string, range: string | null): Promise<void> {
    await this.d.mediaWait?.(path);
    const why = this.d.mediaCheck ? this.d.mediaCheck(path) : "media isn't served by this Harbor yet";
    if (why !== null) return sendJson(w, 404, { error: `no such media: ${why}` });
    const file = this.d.located?.(path) ?? path;
    let len: number;
    try {
      len = statSync(file).size;
    } catch {
      return sendJson(w, 404, { error: "unreadable file" });
    }
    const mime = this.d.mime?.(path) ?? "application/octet-stream";
    const br = byteRange(range, len);
    if (br === "past") {
      w.end(response(416, mime, 0, `Content-Range: bytes */${len}\r\n`));
      return;
    }
    if (br === null) {
      w.write(response(200, mime, len, "Accept-Ranges: bytes\r\n"));
      createReadStream(file).pipe(w);
      return;
    }
    const [from, to] = br;
    w.write(response(206, mime, to - from + 1, `Accept-Ranges: bytes\r\nContent-Range: bytes ${from}-${to}/${len}\r\n`));
    createReadStream(file, { start: from, end: to }).pipe(w);
  }

  /** `POST /v1/upload?name=&chat=`: the raw body into uploads/<chat or pending>/<ms>-<name>. */
  async upload(r: Reader, req: Request): Promise<Reply> {
    if (req.len > MAX_UPLOAD) return err(413, "files up to 200 MB");
    let chatQ = query(req, "chat");
    if (chatQ !== null && !/^-?\d+$/.test(chatQ)) {
      const id = this.d.hub.mesh.byGid(chatQ);
      chatQ = id === null ? null : String(id);
    }
    const sub = chatQ ?? "pending";
    const dir = join(this.d.uploadsDir, sub);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      return err(500, e instanceof Error ? e.message : String(e));
    }
    const stamp = Date.now();
    const name = safeName(query(req, "name") ?? "file");
    let file = "";
    let fd = -1;
    for (let n = 0; n <= 1000; n++) {
      file = n === 0 ? `${stamp}-${name}` : `${stamp}-${n}-${name}`;
      if (existsSync(join(dir, file))) continue;
      try {
        fd = openSync(join(dir, file), "wx");
        break;
      } catch {
        fd = -1;
      }
    }
    const path = join(dir, file);
    if (fd < 0) return err(400, "upload failed: no free name");
    try {
      let left = req.len;
      while (left > 0) {
        const b = await r.take(Math.min(left, 1 << 20));
        if (b.length === 0) throw new Error("short body");
        writeSync(fd, b);
        left -= b.length;
      }
    } catch (e) {
      closeSync(fd);
      rmSync(path, { force: true });
      return err(400, `upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    closeSync(fd);
    return { status: 201, body: { id: `${sub}/${file}`, path } };
  }
}

function isCtl(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return n < 0x20 || (n >= 0x7f && n <= 0x9f);
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function maxOf(req: Request): number | null {
  const m = query(req, "max");
  return m !== null && /^\d+$/.test(m) ? Number(m) : null;
}

function chatOf(hub: Hub, c: string | null): number | null {
  if (c === null) return null;
  return /^-?\d+$/.test(c) ? Number(c) : hub.mesh.byGid(c);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
