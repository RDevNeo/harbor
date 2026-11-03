import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import type { SentVia } from "@harbor/store";
import { type Call, type ConnPeer, MAX_AUDIO } from "./api.ts";
import { exchange, get, http, httpPart, httpRaw, jsonBody } from "./client.ts";
import { err, header, ok, parseJson, query, readBody, segments, type Reader, type Reply, type Request } from "./http.ts";
import type { Hub, PairedPhone } from "./hub.ts";
import { isLoopback, parseIp, routeTo, type Ip } from "./ip.ts";
import { kvJson, now, type Kv } from "./kv.ts";
import { allowedJson, cleanAddrs, dest, downOf, label, loadAllowed, newPeer, peerId, socketAddr, type Allowed, type Dest, type Me, type Node, type Peer } from "./shared.ts";
import { codeKey, connect, DEFAULT_PORT, hostPort, newCode, normalizeCode, normalizeFp, privateIp, proof, proofOk, tailnetIp, Throttle, type Identity } from "./tls.ts";
import { Ordered, type Json } from "./wire.ts";

/** Who a forwarded call is from: its label ("Pixel 8 (Sam)"), the device id, the person and device kind when known, and the stable device id (`Item` user's `dev`). */
export type Sender = [label: string, device: string, who?: string, via?: SentVia | "", dev?: string];

const POLL = 20_000;
const CALL_WAIT = 60_000;
export const CODE_TTL = 600;
const CODE_TRIES = 5;
const PEERS_KEY = "mesh_peers";
/** movepc.rs VERSION: this PC takes moved chats from peers that say at least this. */
export const MOVES_VERSION = 1;

/** The app's side of the mesh (mesh.rs on Rust's UI thread). */
export interface MeshApp {
  /** What `hello` says beyond id, name, epoch, keys and addresses. */
  helloExtra(): { version: string; accounts: Json[]; update: Json; owner: string; github: string; owner_suggested: boolean };
  /** `GET /mesh/v1/chats`: this PC's own chats changed after `since` (all when `full`). */
  chats(since: number, full: boolean): { chats: Json[]; update: Json } | Promise<{ chats: Json[]; update: Json }>;
  /** `GET /mesh/v1/chats/{id}/items`; null: not one of this PC's own chats. */
  items(chat: number, since: number): Json | null;
  /** A peer's chats list: copies made or updated; returns [home id, since] of those whose items to fetch. */
  applyChats(peer: string, epoch: number, body: Record<string, unknown>): [number, number][] | Promise<[number, number][]>;
  applyItems(peer: string, epoch: number, homeId: number, body: Record<string, unknown>): void;
  /** `POST /mesh/v1/call` and the other calls answered by the app (memory, adopt, phones…). */
  route(call: Call): Promise<Reply>;
  /** A peer came, went or changed. */
  peersChanged?(): void;
}

export interface MeshDeps {
  hub: Hub;
  kv: Kv;
  id: () => Identity | null;
  app: MeshApp;
  /** The workspace's PCs from the account directory (account.ts `meshPeers`). */
  workspacePeers?: () => Allowed[];
  /** This PC's addresses as "host:port" (mesh.rs `my_addrs`). */
  myAddrs: () => string[];
  /** `GET /v1/app`'s APK versionCode this PC serves (0: none). */
  apkCode?: () => number;
  uploadsDir: string;
  /** api.ts's upload, for `/mesh/v1/upload`. */
  upload: (r: Reader, req: Request) => Promise<Reply>;
  /** `POST /mesh/v1/transcribe`: a recording from a peer, transcribed here (voice package). */
  transcribe?: (wav: Uint8Array, lang: string) => Promise<Reply>;
  /** `POST /mesh/v1/deliver`: what Devices › Send on that PC sent, taken by this one (`receiveDelivery`). */
  deliver?: (from: string, kind: string, name: string, len: number, read: (len: number, max: number) => Promise<Buffer>) => Promise<Reply>;
  notes?: { last(): number; ownSince(since: number): [Json[], number] };
  env?: Record<string, string | undefined>;
  wake?: () => void;
}

/** `tailscale status --json`, or an empty object when Tailscale isn't installed or doesn't answer. */
export function tailscaleStatus(env: Record<string, string | undefined> = process.env): unknown {
  if (!Bun.which("tailscale", { PATH: env.PATH ?? "" })) return {};
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, ...(env === process.env ? {} : { env: env as NodeJS.ProcessEnv }) });
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return {};
  }
}

/** This PC's peer id and name: HARBOR_MESH_ID, else kv `mesh_id`, else "ts:<MagicDNS name>" when Tailscale knows one, else "pc:<hostname>", kept in kv. */
export function readMe(kv: Kv, env: Record<string, string | undefined> = process.env, status: () => unknown = () => tailscaleStatus(env)): Me {
  let id = env.HARBOR_MESH_ID ?? "";
  if (id === "") {
    id = kv.get("mesh_id") ?? "";
    if (id === "") {
      id = parseMe(status())[0].id;
      if (id === "") id = `pc:${hostname().split(".")[0] ?? ""}`;
      kv.set("mesh_id", id);
    }
  }
  return { id, name: env.HARBOR_MESH_NAME ?? label(id) };
}

export interface PairCode {
  code: string;
  expires: number;
  tries: number;
  paired: string;
}

export function loadCode(kv: Kv): PairCode | null {
  const v = kvJson<unknown>(kv, "mesh_pair", null);
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== "string" || typeof o.expires !== "number") return null;
  return { code: o.code, expires: o.expires, tries: typeof o.tries === "number" ? o.tries : 0, paired: typeof o.paired === "string" ? o.paired : "" };
}

function saveCode(kv: Kv, c: PairCode): void {
  kv.set("mesh_pair", JSON.stringify({ code: c.code, expires: c.expires, tries: c.tries, paired: c.paired }));
}

/** A new pairing code, saved for the listener; sharing turns on. */
export function showCode(kv: Kv): PairCode {
  const c = { code: newCode(), expires: now() + CODE_TTL, tries: 0, paired: "" };
  saveCode(kv, c);
  kv.set("mesh_enabled", "1");
  return c;
}

function peerJson(p: Peer): Ordered {
  return new Ordered([
    ["id", p.id],
    ["name", p.name],
    ["addr", p.addr],
    ["dns", p.dns],
    ["seen", p.seen],
    ["version", p.version],
    ["accounts", p.accounts],
    ["node", p.node],
    ["phones", p.phones],
    ["fp", p.fp],
    ["addrs", p.addrs],
    ["owner", p.owner],
    ["github", p.github],
    ["owner_suggested", p.owner_suggested],
  ]);
}

/** kv `mesh_peers`: what this PC knows about its peers, for when they're off. */
export function loadPeers(kv: Kv): Map<string, Peer> {
  const v = kvJson<unknown>(kv, PEERS_KEY, {});
  const out = new Map<string, Peer>();
  if (typeof v !== "object" || v === null) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as Record<string, unknown>;
    const s = (f: string) => (typeof o[f] === "string" ? (o[f] as string) : "");
    out.set(
      k,
      newPeer({
        id: s("id") || k,
        name: s("name"),
        addr: s("addr"),
        dns: s("dns"),
        seen: typeof o.seen === "number" ? o.seen : 0,
        version: s("version"),
        node: s("node"),
        phones: o.phones === true,
        fp: s("fp"),
        addrs: Array.isArray(o.addrs) ? o.addrs.filter((a): a is string => typeof a === "string") : [],
        owner: s("owner"),
        github: s("github"),
        owner_suggested: o.owner_suggested === true,
      }),
    );
  }
  return out;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const cut = (v: unknown, n: number) => Array.from(typeof v === "string" ? v : "").slice(0, n).join("");
const uint = (s: string | null) => (s !== null && /^\d+$/.test(s) ? Number(s) : 0);

/** "host:port" addresses as phones list them: bare IPs at the first one's port, "ip:port" otherwise. */
export function ipsAndPort(addrs: string[]): [string[], number] {
  const sa = addrs.map(socketAddr).filter((x): x is NonNullable<typeof x> => x !== null);
  const port = sa[0]?.port ?? 0;
  const out: string[] = [];
  for (const a of sa) {
    const e = a.port === port ? a.ip : a.text;
    if (!out.includes(e)) out.push(e);
  }
  return [out, port];
}

type Target = { kind: "key"; fp: string } | { kind: "plain"; addr: string };

const targetKey = (t: Target) => (t.kind === "key" ? `fp:${t.fp}` : `addr:${t.addr}`);

export class Mesh {
  readonly pairTries = new Throttle(10, 60_000);
  private running = new Set<string>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(readonly d: MeshDeps) {
    d.hub.mesh.workspacePeers = d.workspacePeers ?? (() => []);
    d.hub.mesh.allowed = loadAllowed(d.kv);
    for (const [k, p] of loadPeers(d.kv)) d.hub.mesh.peers.set(k, p);
  }

  private env(k: string): string | undefined {
    return (this.d.env ?? process.env)[k];
  }

  private myFp(): string {
    return this.d.id()?.fp ?? "";
  }

  /** Changes the allowed list: kv `mesh_allowed` is the truth (a terminal writes it too). */
  updateAllowed(f: (list: Allowed[]) => void): void {
    const list = loadAllowed(this.d.kv);
    f(list);
    this.d.kv.set("mesh_allowed", allowedJson(list));
    this.d.hub.mesh.allowed = list;
  }

  /** kv `mesh_enabled` and `mesh_allowed` again (they may change from a terminal). */
  reread(): void {
    this.d.hub.mesh.on = this.d.kv.get("mesh_enabled") === "1";
    this.d.hub.mesh.allowed = loadAllowed(this.d.kv);
  }

  private savePeers(): void {
    const v: Record<string, Json> = {};
    for (const [k, p] of this.d.hub.mesh.peers) v[k] = peerJson(p);
    this.d.kv.set(PEERS_KEY, JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, p]) => [k, Object.fromEntries((p as Ordered).entries)]))));
    this.d.app.peersChanged?.();
    this.d.wake?.();
  }

  private aboutMe(): Json {
    const me = this.d.hub.mesh.me;
    return { fp: this.myFp(), id: me.id, name: me.name, addrs: this.d.myAddrs(), port: this.d.hub.port };
  }

  /** Who is calling: its peer id when it may share chats with this PC; null (remembered as asking) when not. */
  who(from: ConnPeer, req: Request): string | null {
    const shared = this.d.hub.mesh;
    const says = (k: string) => cut(header(req, k) ?? "", 60);
    if (from.via.kind === "loopback") {
      if (this.env("HARBOR_MESH_LOOPBACK") !== "1") return null;
      const id = says("x-harbor-id");
      return id === "" ? "loopback" : id;
    }
    if (from.via.kind !== "tls" || from.via.fp === null) return null;
    const fp = from.via.fp;
    const a = shared.allowedFp(fp);
    if (a) {
      const port = [...a.addrs, ...shared.addrsOfFp(fp)].map((x) => socketAddr(x)?.port).find((p) => p !== undefined) ?? DEFAULT_PORT;
      shared.hint(fp, hostPort(from.ip, port));
      return peerId(a);
    }
    if (shared.seen.size < 64 || shared.seen.has(fp)) {
      const s = shared.seen.get(fp) ?? { node: "", fp, name: "", asked: 0, refuses: false };
      s.fp = fp;
      const name = says("x-harbor-name");
      if (name !== "") s.name = name;
      s.asked = now();
      shared.seen.set(fp, s);
    }
    return null;
  }

  /** A PC of the mesh this one admits, with sharing on (mesh.rs `admitted`). */
  admitted(from: ConnPeer, req: Request): boolean {
    return this.d.hub.mesh.on && this.who(from, req) !== null;
  }

  private async json(r: Reader, req: Request): Promise<Record<string, unknown>> {
    try {
      return obj(parseJson(await readBody(r, req.len, 4 << 20)));
    } catch {
      return {};
    }
  }

  /** A `/mesh/…` request on the API listener (mesh.rs `serve` and `mesh_route`). */
  async serve(from: ConnPeer, req: Request, r: Reader): Promise<Reply> {
    const hub = this.d.hub;
    const shared = hub.mesh;
    if (!shared.on) return err(403, "this PC doesn't share its chats (Settings › Devices)");
    const segs = segments(req.path);
    const is = (m: string, ...p: string[]) => req.method === m && segs.length === p.length && p.every((x, i) => segs[i] === x);
    if (is("POST", "mesh", "v1", "pair")) return this.pairServe(from, req, r);
    const peer = this.who(from, req);
    if (peer === null) {
      const me = shared.me.name;
      return { status: 403, body: { error: `${me} doesn't share chats with this PC yet: pair them in Settings › Devices`, harbor: true, name: me } };
    }
    if (is("GET", "mesh", "v1", "hello")) {
      const x = this.d.app.helloExtra();
      const me = shared.me;
      return ok({
        id: me.id,
        name: me.name,
        version: x.version,
        epoch: hub.epoch,
        accounts: x.accounts,
        revoked: hub.revoked,
        phones: hub.enabled,
        fp: this.myFp(),
        addrs: this.d.myAddrs(),
        port: hub.port,
        owner: x.owner,
        github: x.github,
        owner_suggested: x.owner_suggested,
        update: x.update,
        moves: MOVES_VERSION,
      });
    }
    if (is("GET", "mesh", "v1", "events")) {
      const since = uint(query(req, "since"));
      if (uint(query(req, "epoch")) !== hub.epoch) return ok({ epoch: hub.epoch, rev: hub.rev() });
      const deadline = performance.now() + POLL;
      let at = since;
      for (;;) {
        const left = Math.max(0, deadline - performance.now());
        const [rev, chats] = await hub.wait(at, left);
        const own = chats.some((c) => !shared.foreign.has(c));
        const gone = shared.gone.some(([g]) => g > since);
        if (own || gone || left === 0 || rev <= at) return ok({ epoch: hub.epoch, rev });
        at = rev;
      }
    }
    if (is("GET", "mesh", "v1", "chats")) {
      const since = uint(query(req, "since"));
      const full = since === 0 || uint(query(req, "epoch")) !== hub.epoch;
      const rev = hub.rev();
      const { chats, update } = await this.d.app.chats(since, full);
      const gone = full ? [] : shared.gone.filter(([g]) => g > since).map(([, id]) => id);
      return ok({ epoch: hub.epoch, rev, full, chats, gone, phones: hub.enabled, update });
    }
    if (req.method === "GET" && segs.length === 5 && segs[0] === "mesh" && segs[1] === "v1" && segs[2] === "chats" && segs[4] === "items") {
      const c = segs[3] ?? "";
      const since = uint(query(req, "epoch")) === hub.epoch ? uint(query(req, "since")) : 0;
      const v = /^-?\d+$/.test(c) ? this.d.app.items(Number(c), since) : null;
      return v === null ? err(404, "no such chat") : ok(v);
    }
    if (is("GET", "mesh", "v1", "notes")) {
      const since = uint(query(req, "since"));
      if (!this.d.notes) return err(404, "unknown mesh call");
      const [notes, last] = since === 0 ? [[], this.d.notes.last()] : this.d.notes.ownSince(since);
      return ok({ notes, last });
    }
    if (is("GET", "mesh", "v1", "phones")) {
      const phones = hub
        .localPhones()
        .filter((p) => p.seen > 0 || p.alive > 0)
        .map((p: PairedPhone) => ({ group: p.group, name: p.name, seen: p.seen, app: p.app, alive: p.alive, platform: p.platform }));
      const a = shared.about();
      return ok({ phones, apk: this.d.apkCode?.() ?? 0, owner: a.owner ?? null, github: a.github ?? null, owner_suggested: a.owner_suggested ?? null });
    }
    if (is("POST", "mesh", "v1", "upload")) {
      return this.d.upload(r, { ...req, query: [["name", query(req, "name") ?? "file"]] });
    }
    if (is("POST", "mesh", "v1", "transcribe") && this.d.transcribe) {
      if (req.len > MAX_AUDIO) return err(413, "recording too long");
      let wav: Buffer;
      try {
        wav = await readBody(r, req.len, MAX_AUDIO);
      } catch {
        return err(413, "recording too long");
      }
      return this.d.transcribe(wav, query(req, "lang") ?? "auto");
    }
    if (is("POST", "mesh", "v1", "deliver") && this.d.deliver) {
      return this.d.deliver(shared.nameOf(peer), query(req, "kind") ?? "", query(req, "name") ?? "file", req.len, (len, max) => readBody(r, len, max));
    }
    if (is("POST", "mesh", "v1", "lease")) {
      const b = await this.json(r, req);
      const chat = typeof b.chat === "number" && Number.isInteger(b.chat) && !shared.foreign.has(b.chat) ? b.chat : null;
      if (chat === null) return err(404, "no such chat");
      const s = (k: string) => cut(b[k], 60);
      const on = b.on === true;
      let changed: boolean;
      if (b.view === true) changed = hub.setViewing(chat, s("device"), s("label"), s("kind") !== "away", on);
      else {
        const draft = typeof b.draft === "object" && b.draft !== null && !Array.isArray(b.draft) ? (b.draft as Record<string, unknown>) : typeof b.text === "string" ? { text: b.text } : null;
        changed = hub.report(chat, s("device"), s("kind"), s("label"), on, draft, () => null);
      }
      if (changed) this.d.wake?.();
      return ok({ ok: true });
    }
    if (is("POST", "mesh", "v1", "revoke")) {
      const b = await this.json(r, req);
      this.mergeRevoked(Array.isArray(b.groups) ? b.groups.filter((g): g is string => typeof g === "string") : []);
      this.d.wake?.();
      return ok({ ok: true });
    }
    const body = await this.json(r, req);
    return this.d.app.route({ method: req.method, path: segs, query: req.query, body, token: "", device: peer, global: false });
  }

  /** `POST /mesh/v1/pair`: the caller proves the code for both keys of this connection; each side allows the other. */
  private async pairServe(from: ConnPeer, req: Request, r: Reader): Promise<Reply> {
    if (from.via.kind !== "tls" || from.via.fp === null) return err(403, "pairing needs TLS and a key");
    const theirs = from.via.fp;
    if (!privateIp(from.ip)) return err(403, "pairing is for your own network");
    if (!this.pairTries.hit(from.ip)) return err(429, "too many tries: wait a minute");
    const body = await this.json(r, req);
    const code = loadCode(this.d.kv);
    if (!code || code.paired !== "" || code.expires <= now() || code.tries >= CODE_TRIES) return err(404, "no pairing code is shown on this PC (or it ran out): show a new one");
    const mine = this.myFp();
    const key = codeKey(code.code);
    if (theirs === mine || !proofOk(key, "join", mine, theirs, typeof body.proof === "string" ? body.proof : "")) {
      code.tries += 1;
      saveCode(this.d.kv, code);
      return err(403, "wrong code");
    }
    const name = cut(body.name, 60);
    const id = cut(body.id, 80);
    const addrs = cleanAddrs(Array.isArray(body.addrs) ? body.addrs : []);
    const port = typeof body.port === "number" && Number.isInteger(body.port) && body.port >= 0 && body.port <= 65535 ? body.port : DEFAULT_PORT;
    const here = hostPort(from.ip, port);
    const list = [here, ...addrs.filter((a) => a !== here)];
    this.updateAllowed((l) => {
      const keep = l.filter((a) => a.fp !== theirs && (id === "" || a.id !== id));
      l.length = 0;
      l.push(...keep, { node: "", name, fp: theirs, id, addrs: list });
    });
    code.paired = name === "" ? "a PC" : name;
    saveCode(this.d.kv, code);
    return ok({ ...(this.aboutMe() as Record<string, Json>), proof: proof(key, "host", mine, theirs) });
  }

  /** This PC typed `code` shown on the PC at `addr` ("host[:port]"); both end up allowing each other. */
  async pairJoin(addr: string, codeText: string): Promise<Allowed> {
    const code = normalizeCode(codeText);
    if (code.length !== 10) throw new Error("a pairing code has 10 letters and digits");
    const a = addr.trim();
    const sa = socketAddr(a);
    const target = sa ? sa.text : parseIp(a) ? hostPort(a, DEFAULT_PORT) : a.includes(":") ? a : `${a}:${DEFAULT_PORT}`;
    const t = socketAddr(target);
    const id = this.d.id();
    if (!id) throw new Error("no TLS identity");
    let host: string;
    let sock: import("node:tls").TLSSocket;
    try {
      const c = await connect({ id, pin: null, host: t ? t.ip : target.split(":")[0] ?? target, port: t ? t.port : DEFAULT_PORT });
      host = c.fp;
      sock = c.sock;
    } catch (e) {
      throw new Error(`${target} didn't answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const key = codeKey(code);
    const me = this.d.hub.mesh.me;
    const body = jsonBody({ proof: proof(key, "join", host, id.fp), id: me.id, name: me.name, addrs: this.d.myAddrs(), port: this.d.hub.port });
    const ans = await exchange(sock, target, "POST", "/mesh/v1/pair", { ctype: body.ctype, data: Buffer.from(String(body.data)) });
    const v = obj(ans.body.length > 0 ? JSON.parse(Buffer.from(ans.body).toString()) : null);
    if (ans.status !== 200) throw new Error(typeof v.error === "string" ? v.error : `${target} answered ${ans.status}`);
    if (!proofOk(key, "host", host, id.fp, typeof v.proof === "string" ? v.proof : "")) throw new Error("the PC that answered doesn't know the code: not paired");
    const used = t ? t.text : target;
    const addrs = [used, ...cleanAddrs(Array.isArray(v.addrs) ? v.addrs : []).filter((x) => x !== used)];
    const entry: Allowed = { node: "", name: cut(v.name, 60), fp: host, id: cut(v.id, 80), addrs };
    this.updateAllowed((l) => {
      const keep = l.filter((x) => x.fp !== entry.fp && (entry.id === "" || x.id !== entry.id));
      l.length = 0;
      l.push(...keep, entry);
    });
    return entry;
  }

  /** Pairings removed on another PC: their phones' tokens here go too. */
  mergeRevoked(groups: string[]): void {
    const hub = this.d.hub;
    const fresh = groups.filter((g) => g.length >= 16 && !hub.revoked.includes(g));
    if (fresh.length === 0) return;
    hub.revoked.push(...fresh);
    hub.tokens = hub.tokens.filter((t) => !fresh.includes(t.group));
    hub.tokensDirty = true;
  }

  /** A typing or viewing lease for a copy goes to its home PC; false when the chat is this PC's own. */
  forwardLease(chat: number, view: boolean, device: string, kind: string, lbl: string, on: boolean, draft: Record<string, unknown> | null): boolean {
    const home = this.d.hub.mesh.homes.get(chat);
    if (!home) return false;
    const p = this.d.hub.mesh.peer(home[0]);
    if (!p?.online) return true;
    const body: Record<string, Json> = { chat: home[1], view, device, kind, label: lbl, on };
    if (draft) {
      const { files: _files, ...rest } = draft;
      body.text = (rest.text ?? null) as Json;
      body.draft = rest as Json;
    }
    void http({ ...dest(p), as: this.d.id() ?? undefined }, "POST", "/mesh/v1/lease", jsonBody(body), 5_000).catch(() => undefined);
    return true;
  }

  /** The online home PC of a copy (`chat` is this PC's id for it); null for this PC's own chats. */
  private homeOf(chat: number): Dest | null {
    const home = this.d.hub.mesh.homes.get(chat);
    const p = home ? this.d.hub.mesh.peer(home[0]) : null;
    return p?.online ? { ...dest(p), as: this.d.id() ?? undefined } : null;
  }

  /** An image of a chat that runs on another PC (`/v1/image` here for a copy): fetched from that PC,
   * since its paths are that PC's files. Null when the chat is this PC's, or the PC is off or has no such image. */
  async homeImage(chat: number, path: string, max: number | null): Promise<{ status: number; ctype: string; body: Uint8Array } | null> {
    const d = this.homeOf(chat);
    if (!d) return null;
    try {
      const a = await httpRaw(d, "GET", `/mesh/v1/image?path=${encodeURIComponent(path)}${max !== null ? `&max=${max}` : ""}`, null, 20_000);
      return a.status === 200 && a.ctype.startsWith("image/") ? { status: 200, ctype: a.ctype, body: a.body } : null;
    } catch {
      return null;
    }
  }

  /** A video of a chat that runs on another PC (`/v1/media` here for a copy), at most MEDIA_PART of it per
   * ranged ask; a PC that doesn't do ranges answers with the whole file, which goes on as it came. */
  async homeMedia(chat: number, path: string, range: string | null): Promise<{ status: number; ctype: string; body: Uint8Array; range?: string } | null> {
    const d = this.homeOf(chat);
    if (!d) return null;
    try {
      const a = await httpPart(d, "GET", `/mesh/v1/media?path=${encodeURIComponent(path)}`, null, range === null ? "" : partOf(range), 120_000);
      if (!(a.status === 200 || a.status === 206) || !(a.ctype.startsWith("video/") || a.ctype.startsWith("image/"))) return null;
      return a.range !== "" ? { status: a.status, ctype: a.ctype, body: a.body, range: a.range } : { status: a.status, ctype: a.ctype, body: a.body };
    } catch {
      return null;
    }
  }

  /** `GET /v1/hubs` for a phone: this PC and the others it shares chats with. */
  hubs(): Json {
    const hub = this.d.hub;
    const me = hub.mesh.me;
    const addrs = hub.net.addrs;
    const ip = addrs.find((a) => tailnetIp(a)) ?? addrs[0] ?? "";
    const out: Json[] = [{ id: me.id, name: me.name, host: ip, ip, port: hub.port, fp: this.myFp(), addrs, online: true, phones: true, self: true }];
    const peers: Peer[] = hub.mesh.on ? [...hub.mesh.peers.values()] : [];
    for (const a of hub.mesh.workspacePeers()) {
      if (!peers.some((p) => p.fp === a.fp)) peers.push(newPeer({ id: peerId(a), name: a.name, addr: a.addrs[0] ?? "", fp: a.fp, addrs: a.addrs, phones: true }));
    }
    for (const p of peers) {
      const [ips, port] = ipsAndPort([p.addr, ...p.addrs.filter((a) => a !== p.addr)]);
      const pip = ips.find((i) => tailnetIp(i)) ?? ips.find((i) => parseIp(i) !== null) ?? "";
      const e: Record<string, Json> = { id: p.id, name: p.name, host: pip, ip: pip, port, fp: p.fp, addrs: ips, online: p.online, phones: p.phones, seen: p.seen };
      const down = hub.mesh.down.get(p.id);
      if (down && !p.online) e.down = down;
      out.push(e);
    }
    return { hubs: out };
  }

  /** The peers to follow now: keys on the allowed list and the workspace's, plus loopback test peers. */
  targets(): Target[] {
    const shared = this.d.hub.mesh;
    const allowed = [...shared.allowed];
    for (const a of shared.workspacePeers()) if (!allowed.some((x) => x.fp === a.fp)) allowed.push(a);
    const mine = this.myFp();
    const v: Target[] = allowed.filter((a) => a.fp !== "" && a.fp !== mine).map((a) => ({ kind: "key", fp: a.fp }));
    for (const a of (this.env("HARBOR_MESH_PEERS") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "")) {
      const sa = socketAddr(a);
      const ip = sa ? parseIp(sa.ip) : null;
      if (sa && ip && isLoopback(ip) && this.env("HARBOR_MESH_LOOPBACK") === "1") v.push({ kind: "plain", addr: sa.text });
    }
    return v;
  }

  /** Starts following peers (every 5 s new targets get a worker); sharing is kv `mesh_enabled`. */
  start(): void {
    if (this.loop) return;
    const tick = () => {
      this.reread();
      if (!this.d.hub.mesh.on) return;
      for (const t of this.targets()) {
        const k = targetKey(t);
        if (this.running.has(k)) continue;
        this.running.add(k);
        void this.worker(t).finally(() => this.running.delete(k));
      }
    };
    tick();
    this.loop = setInterval(tick, 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private offline(id: string | null): void {
    if (id === null) return;
    const p = this.d.hub.mesh.peers.get(id);
    if (p?.online) {
      p.online = false;
      this.savePeers();
    }
  }

  /** Keeps this PC's copies of one peer's chats up to date, for as long as it's a peer. */
  private async worker(target: Target): Promise<void> {
    const shared = this.d.hub.mesh;
    let backoff = 2_000;
    let known: string | null = target.kind === "key" ? (shared.allowedFp(target.fp) ? peerId(shared.allowedFp(target.fp) as Allowed) : null) : null;
    while (!this.stopped) {
      if (!shared.on) {
        this.offline(known);
        await Bun.sleep(3_000);
        continue;
      }
      let dests: Dest[];
      if (target.kind === "key") {
        if (!shared.allowedFp(target.fp)) {
          this.offline(known);
          return;
        }
        dests = shared.addrsOfFp(target.fp).map((addr) => ({ addr, fp: target.fp }));
        const as = this.d.id() ?? undefined;
        for (const x of dests) x.as = as;
      } else dests = [{ addr: target.addr, fp: "" }];
      const fp = dests[0]?.fp ?? "";
      const port = socketAddr(dests[0]?.addr ?? "")?.port ?? DEFAULT_PORT;
      const relays: Dest[] =
        target.kind === "key" ? [...shared.peers.values()].filter((p) => p.online && p.fp !== "" && p.fp !== target.fp && !p.via).map((p) => ({ ...dest(p), as: this.d.id() ?? undefined })) : [];
      const at = `127.0.0.1:${port}`;
      let answer: [number, unknown] | null = null;
      let used: Dest = { addr: "", fp: "" };
      const errors: string[] = [];
      for (const dd of [...dests, ...relays.map((rl) => ({ addr: at, fp, via: rl, as: rl.as }))]) {
        try {
          answer = await http(dd, "GET", "/mesh/v1/hello", null, 8_000);
          used = dd;
          break;
        } catch (e) {
          if (!dd.via) errors.push(noRoute(dd.addr) ? "Network is unreachable (os error 101)" : e instanceof Error ? e.message : String(e));
        }
      }
      if (known !== null) {
        const want = answer ? undefined : downOf(errors);
        if (shared.down.get(known) !== want) {
          if (want) shared.down.set(known, want);
          else shared.down.delete(known);
          this.savePeers();
        }
      }
      if (!answer || answer[0] !== 200) {
        if (target.kind === "key" && answer && answer[0] === 403) {
          const s = shared.seen.get(target.fp) ?? { node: "", fp: target.fp, name: "", asked: 0, refuses: true };
          s.name = shared.allowedFp(target.fp)?.name ?? "";
          s.refuses = true;
          shared.seen.set(target.fp, s);
        }
        this.offline(known);
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
        continue;
      }
      const hello = obj(answer[1]);
      if (target.kind === "key") {
        const s = shared.seen.get(target.fp);
        if (s) s.refuses = false;
      }
      const id = typeof hello.id === "string" ? hello.id : "";
      if (id === "" || id === shared.me.id) return;
      known = id;
      backoff = 2_000;
      const epoch = typeof hello.epoch === "number" ? hello.epoch : 0;
      this.mergeRevoked(Array.isArray(hello.revoked) ? hello.revoked.filter((g): g is string => typeof g === "string") : []);
      const hport = typeof hello.port === "number" ? hello.port : null;
      const addrs = cleanAddrs(Array.isArray(hello.addrs) ? hello.addrs : []);
      if ((addrs.length === 0 || hport === null) && !used.via) addrs.unshift(used.addr);
      if (target.kind === "key") {
        const name = cut(hello.name, 60);
        const a = shared.allowedFp(target.fp);
        const keep = [...(used.via ? [] : [used.addr]), ...addrs.filter((x) => x !== used.addr)];
        if (a && (a.id !== id || a.name !== name || JSON.stringify(a.addrs) !== JSON.stringify(keep))) {
          this.updateAllowed((l) => {
            const e = l.find((x) => x.fp === target.fp);
            if (e) {
              e.id = id;
              e.name = name;
              e.addrs = keep;
            }
          });
        }
      }
      const p = shared.peers.get(id) ?? newPeer({ id });
      p.name = typeof hello.name === "string" ? hello.name : "";
      if (!used.via) p.addr = used.addr;
      p.fp = used.fp;
      p.via = used.via;
      p.addrs = addrs;
      p.online = true;
      p.seen = now();
      p.node = "";
      p.phones = typeof hello.phones === "boolean" ? hello.phones : true;
      p.version = typeof hello.version === "string" ? hello.version : "";
      p.owner = cut(hello.owner, 80);
      p.github = cut(hello.github, 60);
      p.owner_suggested = hello.owner_suggested === true;
      p.update = hello.update ?? null;
      p.moves = typeof hello.moves === "number" && hello.moves >= MOVES_VERSION;
      p.accounts = (Array.isArray(hello.accounts) ? hello.accounts : []).map((x) => {
        const o = obj(x);
        const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
        return [s("id"), s("short"), s("kind")] as [string, string, string];
      });
      shared.peers.set(id, p);
      this.savePeers();
      const still = () => (target.kind === "key" ? shared.allowedFp(target.fp) !== null : true);
      try {
        await this.sync(used, id, epoch, still);
      } catch {
        // it stopped answering: tried again below
      }
      this.offline(known);
      await Bun.sleep(1_000);
    }
  }

  /** Follows a peer until it stops answering or restarts (its epoch changes). */
  private async sync(d: Dest, id: string, epoch: number, still: () => boolean): Promise<void> {
    let since = 0;
    while (!this.stopped && still() && this.d.hub.mesh.on) {
      const chats = obj(await get(d, `/mesh/v1/chats?since=${since}&epoch=${epoch}`, 30_000));
      if (chats.epoch !== epoch) return;
      const rev = typeof chats.rev === "number" ? chats.rev : 0;
      const p = this.d.hub.mesh.peers.get(id);
      if (p) {
        let changed = false;
        if ("update" in chats && JSON.stringify(p.update) !== JSON.stringify(chats.update)) {
          p.update = chats.update;
          changed = true;
        }
        if (typeof chats.phones === "boolean" && p.phones !== chats.phones) {
          p.phones = chats.phones;
          changed = true;
        }
        if (changed) this.savePeers();
      }
      const wants = await this.d.app.applyChats(id, epoch, chats);
      for (const [hid, isince] of wants) {
        const body = obj(await get(d, `/mesh/v1/chats/${hid}/items?since=${isince}&epoch=${epoch}`, 60_000));
        if (body.epoch !== epoch) return;
        this.d.app.applyItems(id, epoch, hid, body);
      }
      this.d.wake?.();
      since = rev;
      const ev = obj(await get(d, `/mesh/v1/events?since=${since}&epoch=${epoch}`, POLL + 10_000));
      if (ev.epoch !== epoch) return;
    }
  }

  /** A call forwarded to a chat's home PC: its files first (uploads there), then the call. */
  async forward(d: Dest, name: string, method: string, path: string[], body: Record<string, unknown>, files: { name: string; data: Uint8Array }[], sender: Sender, ctx: Json): Promise<Reply> {
    const off = err(503, `${name} is off or unreachable: the chat is read-only until it's back`);
    const ids: Json[] = [];
    for (const f of files) {
      try {
        const [st, v] = await http(d, "POST", `/mesh/v1/upload?name=${encodeURIComponent(f.name)}`, { ctype: "application/octet-stream", data: f.data }, CALL_WAIT);
        if (st !== 201) return { status: st, body: v as Json };
        ids.push((obj(v).id ?? null) as Json);
      } catch {
        return off;
      }
    }
    const b: Record<string, Json> = { ...(body as Record<string, Json>) };
    if (files.length > 0) b.files = ids;
    const call: Record<string, Json> = { method, path, body: b, sender: sender[0], device: sender[1] };
    if (sender[2]) call.who = sender[2];
    if (sender[3]) call.via = sender[3];
    if (sender[4]) call.dev = sender[4];
    if (ctx !== null) call.ctx = ctx;
    try {
      const [status, v] = await http(d, "POST", "/mesh/v1/call", jsonBody(call), CALL_WAIT);
      return { status, body: v as Json };
    } catch {
      return off;
    }
  }
}

/** `tailscale status --json`: this PC's id and name, and its node. */
export function parseMe(v: unknown): [Me, Node | null] {
  const self = obj(obj(v).Self);
  const dns = typeof self.DNSName === "string" ? self.DNSName : "";
  const l = dns.split(".")[0] ?? "";
  const me = l === "" ? { id: "", name: "" } : { id: `ts:${l}`, name: l };
  const id = typeof self.ID === "string" ? self.ID : "";
  const node = id === "" ? null : { id, label: l, user: typeof self.UserID === "number" ? self.UserID : null, tagged: Array.isArray(self.Tags) && self.Tags.length > 0 };
  return [me, node];
}

/** `tailscale whois --json <ip>`: the node at that address. */
export function parseWhois(v: unknown): Node | null {
  const n = obj(obj(v).Node);
  const id = typeof n.StableID === "string" ? n.StableID : "";
  if (id === "") return null;
  const lbl = (typeof n.Name === "string" ? n.Name : "").split(".")[0] ?? "";
  const up = obj(obj(v).UserProfile).ID;
  const user = typeof up === "number" ? up : typeof n.User === "number" ? n.User : null;
  return { id, label: lbl, user, tagged: Array.isArray(n.Tags) && n.Tags.length > 0 };
}

/** A peer in `tailscale status --json`: its node. */
export function statusNode(p: unknown): Node | null {
  const o = obj(p);
  const id = typeof o.ID === "string" ? o.ID : "";
  if (id === "") return null;
  return { id, label: (typeof o.DNSName === "string" ? o.DNSName : "").split(".")[0] ?? "", user: typeof o.UserID === "number" ? o.UserID : null, tagged: Array.isArray(o.Tags) && o.Tags.length > 0 };
}

/** The most of a file one ranged mesh answer carries. */
export const MEDIA_PART = 8 << 20;

/** A Range header's value cut to at most MEDIA_PART bytes; anything else goes on as it is. */
export function partOf(range: string): string {
  const m = range.trim().match(/^bytes=(\d+)-(.*)$/);
  if (!m?.[1]) return range;
  const from = Number(m[1]);
  const last = from + MEDIA_PART - 1;
  const to = m[2] !== undefined && /^\d+$/.test(m[2]) ? Math.min(Number(m[2]), last) : last;
  return `bytes=${from}-${to}`;
}

/** A forwarded call about a chat (`tail` after `/v1/chats/{id}`) that may start a turn. */
export function startsTurn(method: string, tail: string[]): boolean {
  return method === "POST" && (["send", "continue", "continue_on", "slash", "resume"].includes(tail[0] ?? "") || tail.at(-1) === "steer");
}

/** A phone's call about a chat that the chat's home PC answers for a copy. */
export function forHome(method: string, p: string[]): boolean {
  if (p.length < 3 || p[0] !== "v1" || p[1] !== "chats") return false;
  const sub = p[3] ?? "";
  return (["POST", "PATCH", "DELETE"].includes(method) && !["move", "mention", "snooze", "main"].includes(sub)) || (method === "GET" && ["slash", "commit", "move_targets"].includes(sub));
}

/** No route leads to `addr` from this PC (Linux): Bun calls that "connection refused", which would read as Harbor not running there. */
function noRoute(addr: string): boolean {
  const sa = socketAddr(addr);
  const ip = sa ? parseIp(sa.ip) : null;
  if (!ip) return false;
  let tables;
  try {
    tables = { v4: readFileSync("/proc/net/route", "utf8"), v6: readFileSync("/proc/net/ipv6_route", "utf8") };
  } catch {
    return false;
  }
  const own = Object.values(networkInterfaces())
    .flat()
    .flatMap((i): Ip[] => {
      const p = i ? parseIp(i.address) : null;
      return p ? [p] : [];
    });
  return !routeTo(ip, tables, own);
}
