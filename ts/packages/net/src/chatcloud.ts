// The workspace cloud: every PC's chats (metadata and the whole transcript) and projects follow the account to its
// other PCs and to its workspaces' members, with the PC that holds them off. A new PC signed in to the account, or one
// whose sibling is off, lists them and opens them read-only; a message sent to one carries it on here (failover.ts
// takes the copy over, with the history seeded into a new agent session as a switch of provider does).
//
// How: each PC publishes its own chats (home "") to the account service's `/v1/cloud` under its own workspace (the
// workspace the PC is in: the people who reach its chats over the mesh), encrypted with that workspace's key, which
// the service keeps and hands to the signed-in PCs of the workspace's members (`/v1/cloud/key`), as the account
// vault's key is (vault.ts). Each PC reads every workspace its account is a member of. A chat is one metadata row
// (its chat JSON, as the mesh sends it, with its transcript's count, digest and chunk hashes) plus its transcript in
// chunks (append-only, so a running chat rewrites only its last chunk). Copies are made through the mesh's own
// replica (meshstore.ts `applyChats`/`applyItems`), as if from that PC, so the window, the phone, the read-only
// state and failover treat them exactly like copies the mesh made, and the mesh takes over again once the PC is on.
//
// The live mesh stays the source while a PC is on: its chats aren't applied from here then, and a copy newer than
// the cloud's (the mesh brought it) is never rolled back. The service holds the keys, so it is trusted as the vault
// is; rows are bound to the PC that wrote them (the service records its key's fingerprint, and a reader takes a
// chat only from the PC the directory lists with that fingerprint).
//
// An account service without `/v1/cloud` (not deployed yet) answers 404: the feature is off, and asked again hourly.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { digest as digestItems, itemJson, parseItem, privateDir, writePrivate, type Item } from "@harbor/store";
import type { Json } from "./wire.ts";

/** One of this PC's chats, as the cloud publishes it. */
export interface CloudOwnChat {
  /** Its id here (the mesh's home id). */
  hid: number;
  /** Running now: it's published at most every RUNNING_GAP_MS (and once it stops). */
  running: boolean;
  /** Its saved transcript's length and digest (cached by the store). */
  summary(): { count: number; digest: bigint };
  /** Its chat JSON as the mesh sends it, the fields that don't change by the second. */
  meta(): Record<string, Json>;
  items(): Item[];
}

/** One of this PC's projects. */
export interface CloudProject {
  /** Its folder on the PC that publishes it. */
  path: string;
  name: string;
  remote: string;
  branch: string;
  workspace: string;
  shared: string[];
}

export interface CloudSource {
  chats(): CloudOwnChat[];
  projects(): CloudProject[];
}

/** A PC of the account's workspaces (its mesh id and name). */
export interface CloudPc {
  id: string;
  name: string;
}

/** Where copies go (the mesh's replica in the app; a fake in tests). */
export interface CloudSink {
  /** The PC whose key has fingerprint `fp`, as the directory lists it now; null: not one of the account's workspaces' PCs. */
  pcOf(fp: string): CloudPc | null;
  /** The mesh follows that PC now (its chats come from it, not from here). */
  online(pc: string): boolean;
  /** This PC's copy of chat `hid` of PC `pc`, or null when there is none. */
  copy(pc: string, hid: number): { count: number; digest: bigint; updated: number } | null;
  /** Copies made or updated from chat JSONs (as the mesh's `applyChats` takes them), and copies gone. */
  chats(pc: CloudPc, chats: Record<string, Json>[], gone: number[]): void | Promise<void>;
  /** A copy's transcript: cut to `count`, then `items` (seq → item) put in place. */
  items(pc: string, hid: number, count: number, items: ReadonlyMap<number, Item>): void;
  /** Projects of PC `pc` (made here when missing, remembered as that PC's). */
  projects(pc: CloudPc, list: CloudProject[]): void;
}

export type CloudCall = (method: "GET" | "PUT" | "POST", path: string, body?: Json) => Promise<unknown>;

/** What a round needs from the account loop. */
export interface CloudContext {
  /** The account signed in here. */
  account: string;
  /** This PC's workspace ("" none: nothing is published). */
  mine: string;
  /** Every workspace the account is a member of (read). */
  workspaces: readonly string[];
  call: CloudCall;
}

export interface ChatCloudOptions {
  stateDir: string;
  /** This PC's key fingerprint and mesh id. */
  fp: () => string;
  meId: () => string;
  source: CloudSource;
  sink: CloudSink;
  clock?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Tests: smaller chunks. */
  chunkItems?: number | undefined;
  chunkBytes?: number | undefined;
}

export interface CloudStatus {
  state: "off" | "unsupported" | "on";
  /** Own chats published, chats of other PCs known. */
  published: number;
  known: number;
  error: string;
  syncedAt: number;
}

/** A chat running now is published at most this often (each publish rewrites its last chunk and its metadata). */
export const RUNNING_GAP_MS = 180_000;
/** Lists of the other PCs' chats are fetched at most this often (a round of the account loop is about 20 s). */
const PULL_EVERY_MS = 45_000;
/** An account service without `/v1/cloud` is asked again after this long. */
const UNSUPPORTED_MS = 3_600_000;
/** After the workspace's room ran out, publishing waits this long. */
const FULL_MS = 3_600_000;
const CHUNK_ITEMS = 64;
const CHUNK_BYTES = 768 << 10;
/** An item bigger than this (a huge tool output) goes up with its long texts cut. */
const ITEM_BYTES = 1 << 20;
const BATCH = 48;
const BATCH_BYTES = 3 << 20;
/** What one round sends and fetches at most (the rest goes on the next round). */
const ROUND_SEND = 4 << 20;
const ROUND_FETCH = 16 << 20;
const INFO = "harbor-cloud-v1";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
const hexDigest = (d: bigint): string => d.toString(16).padStart(16, "0");

/** Gives the event loop a turn after every 8 ms of work (a first upload of hundreds of chats never holds the window). */
function yielder(): () => Promise<void> {
  let at = performance.now();
  return async () => {
    if (performance.now() - at < 8) return;
    await new Promise<void>((r) => setImmediate(r));
    at = performance.now();
  };
}

// ---- crypto: one key per workspace; row ids are keyed hashes, values AES-256-GCM bound to the workspace, epoch and row.

function subkey(key: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `${INFO} ${label}`, 32));
}

export function cloudRowId(key: Uint8Array, prefix: "m" | "k" | "p", name: string): string {
  return `${prefix}:${createHmac("sha256", subkey(key, "ids")).update(name).digest("hex").slice(0, 40)}`;
}

export function cloudSeal(key: Uint8Array, ws: string, epoch: string, row: string, plain: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", subkey(key, "rows"), iv);
  c.setAAD(Buffer.from(`${ws}\n${epoch}\n${row}`));
  const ct = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return `c1.${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64")}`;
}

export function cloudOpen(key: Uint8Array, ws: string, epoch: string, row: string, text: string): Buffer | null {
  if (!text.startsWith("c1.")) return null;
  const box = Buffer.from(text.slice(3), "base64");
  if (box.length < 28) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", subkey(key, "rows"), box.subarray(0, 12));
    d.setAAD(Buffer.from(`${ws}\n${epoch}\n${row}`));
    d.setAuthTag(box.subarray(box.length - 16));
    return gunzipSync(Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]), { maxOutputLength: 64 << 20 });
  } catch {
    return null;
  }
}

// ---- transcripts in chunks

/** A chunk: its first item's seq and the hash of its items. */
export type Chunk = [start: number, hash: string];

/** An item as it goes up: as saved, or (a huge one) with its long texts cut so a chunk stays within the service's row size. */
export function cloudItem(it: Item): { json: string; item: Item } {
  const j = itemJson(it);
  if (j.length <= ITEM_BYTES) return { json: j, item: it };
  const cut = (v: unknown): unknown => {
    if (typeof v === "string" && v.length > 64 << 10) return `${v.slice(0, 64 << 10)}\n… (cut in the cloud copy: ${v.length} characters)`;
    if (Array.isArray(v)) return v.map(cut);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  const small: Item = parseItem(JSON.stringify(cut(JSON.parse(j)))) ?? { kind: "notice", icon: "info", text: "An item too large for the cloud copy", detail: "" };
  return { json: itemJson(small), item: small };
}

/**
 * Cuts a transcript into chunks, greedily from its start: at most `maxItems` items and about `maxBytes` each. The
 * cut of a prefix depends on the prefix alone, so appending to a chat changes only its last chunk (and adds new ones).
 */
export function chunkTranscript(items: readonly string[], maxItems = CHUNK_ITEMS, maxBytes = CHUNK_BYTES): { chunks: Chunk[]; parts: string[][] } {
  const chunks: Chunk[] = [];
  const parts: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  let start = 0;
  const flush = () => {
    if (cur.length === 0) return;
    chunks.push([start, sha(cur.join("\n"))]);
    parts.push(cur);
    start += cur.length;
    cur = [];
    bytes = 0;
  };
  for (const j of items) {
    if (cur.length > 0 && (cur.length >= maxItems || bytes + j.length > maxBytes)) flush();
    cur.push(j);
    bytes += j.length;
  }
  flush();
  return { chunks, parts };
}

/**
 * The first chunk a copy needs from the cloud: the first that differs from what was applied, moved back to the
 * chunk holding the copy's end when the copy is shorter (patchItems leaves a gap out).
 */
export function firstNeeded(want: readonly Chunk[], had: readonly Chunk[], copyCount: number): number {
  let i = 0;
  while (i < want.length && i < had.length && want[i]?.[0] === had[i]?.[0] && want[i]?.[1] === had[i]?.[1]) i++;
  while (i > 0 && (want[i]?.[0] ?? Number.MAX_SAFE_INTEGER) > copyCount) i--;
  return i;
}

// ---- saved state

interface PubChat {
  mh: string;
  digest: string;
  chunks: Chunk[];
  at: number;
}

interface WsKey {
  epoch: string;
  key: string;
}

/** A chat of another PC, as its metadata row says. */
interface Known {
  by: string;
  pc: string;
  hid: number;
  chat: Record<string, Json>;
  count: number;
  digest: string;
  chunks: Chunk[];
  /** Its row's ciphertext hash: what was applied is compared with it. */
  mh: string;
  gone?: boolean;
}

interface KnownProject {
  by: string;
  pc: string;
  p: CloudProject;
  h: string;
}

interface WsState {
  epoch: string;
  cursor: number;
  chats: Record<string, Known>;
  projects: Record<string, KnownProject>;
}

interface Applied {
  mh: string;
  digest: string;
  chunks: Chunk[];
}

interface Saved {
  account: string;
  keys: Record<string, WsKey>;
  /** What this PC published: in which workspace (and its key's epoch), by chat id and project path. */
  pub: { ws: string; epoch: string; chats: Record<string, PubChat>; projects: Record<string, string> };
  read: Record<string, WsState>;
  /** What was applied here of each copy (by "pc\0hid"), and of each project row. */
  applied: Record<string, Applied>;
  appliedProjects: Record<string, string>;
}

const blank = (account = ""): Saved => ({ account, keys: {}, pub: { ws: "", epoch: "", chats: {}, projects: {} }, read: {}, applied: {}, appliedProjects: {} });

/** A row to send, in its group. */
interface Out {
  g: number;
  id: string;
  v: string | null;
}

interface Row {
  id: string;
  v: string | null;
  by: string;
  seq: number;
}

function parseRow(v: unknown): Row | null {
  if (!isObj(v) || typeof v.id !== "string" || !(typeof v.v === "string" || v.v === null) || typeof v.seq !== "number") return null;
  return { id: v.id, v: v.v, by: typeof v.by === "string" ? v.by : "", seq: v.seq };
}

const chunksOf = (v: unknown): Chunk[] =>
  Array.isArray(v) ? v.flatMap((c) => (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "string" ? [[c[0], c[1]] as Chunk] : [])) : [];

/** The service answered 404: it has no `/v1/cloud` yet. */
function notThere(e: unknown): boolean {
  return isObj(e) && (e as { code?: unknown }).code === 404;
}

export class ChatCloud {
  private readonly o: ChatCloudOptions;
  private saved: Saved;
  private running: Promise<void> | null = null;
  private unsupportedAt = 0;
  private fullAt = 0;
  private pulledAt = 0;
  private err = "";
  private syncedAt = 0;
  /** Set by `poke`: something here changed, publish on the next round. */
  private dirty = true;

  constructor(o: ChatCloudOptions) {
    this.o = o;
    this.saved = this.load();
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  private log(s: string): void {
    this.o.log?.(s);
  }

  private path(): string {
    return join(this.o.stateDir, "cloud.json");
  }

  private load(): Saved {
    try {
      if (!existsSync(this.path())) return blank();
      const v: unknown = JSON.parse(readFileSync(this.path(), "utf8"));
      if (isObj(v) && typeof v.account === "string" && isObj(v.pub) && isObj(v.read)) return { ...blank(), ...(v as unknown as Saved) };
    } catch {
      // started over
    }
    return blank();
  }

  private save(): void {
    try {
      privateDir(this.o.stateDir);
      writePrivate(this.path(), JSON.stringify(this.saved));
    } catch (e) {
      this.log(`couldn't save the cloud's state: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  status(): CloudStatus {
    const state = this.saved.account === "" ? "off" : this.unsupportedAt !== 0 ? "unsupported" : "on";
    const known = Object.values(this.saved.read).reduce((n, w) => n + Object.values(w.chats).filter((c) => !c.gone).length, 0);
    return { state, published: Object.keys(this.saved.pub.chats).length, known, error: this.err, syncedAt: this.syncedAt };
  }

  /** Something of this PC's changed (a chat, a project): it goes up on the next round. */
  poke(): void {
    this.dirty = true;
  }

  /** One round (from the account loop): never two at once, never waited for by the loop. */
  sync(ctx: CloudContext): Promise<void> {
    if (this.running) return this.running;
    this.running = this.round(ctx).finally(() => (this.running = null));
    return this.running;
  }

  /** Signed out: what's kept of the account goes (the copies stay, as the mesh's do). */
  leave(): void {
    this.saved = blank();
    this.save();
  }

  private async round(ctx: CloudContext): Promise<void> {
    if (ctx.account === "") return;
    if (this.unsupportedAt !== 0 && this.now() - this.unsupportedAt < UNSUPPORTED_MS) return;
    if (this.saved.account !== ctx.account) {
      this.saved = blank(ctx.account);
      this.save();
    }
    try {
      if (ctx.mine !== "" && this.now() - this.fullAt >= FULL_MS) await this.publish(ctx);
      if (this.now() - this.pulledAt >= PULL_EVERY_MS) {
        this.pulledAt = this.now();
        for (const ws of ctx.workspaces) await this.pull(ctx, ws);
        // Workspaces the account left: what was known of them goes (their copies stay, as the mesh's do).
        for (const ws of Object.keys(this.saved.read)) if (!ctx.workspaces.includes(ws)) delete this.saved.read[ws];
        this.save();
      }
      await this.applyAll(ctx);
      this.unsupportedAt = 0;
      this.err = "";
      this.syncedAt = this.now();
    } catch (e) {
      if (notThere(e)) {
        if (this.unsupportedAt === 0) this.log("the account service has no workspace cloud yet: chats sync over the mesh only");
        this.unsupportedAt = this.now();
        return;
      }
      this.err = e instanceof Error ? e.message : String(e);
      this.log(`sync: ${this.err}`);
    } finally {
      this.save();
    }
  }

  private async key(ctx: CloudContext, ws: string, fresh = false): Promise<{ key: Uint8Array; epoch: string }> {
    const had = this.saved.keys[ws];
    if (had && !fresh) return { key: new Uint8Array(Buffer.from(had.key, "base64")), epoch: had.epoch };
    const r = await ctx.call("GET", `/v1/cloud/key?ws=${encodeURIComponent(ws)}`);
    if (!isObj(r) || typeof r.key !== "string" || typeof r.epoch !== "string") throw new Error("an odd answer from the workspace cloud");
    const key = new Uint8Array(Buffer.from(r.key, "base64"));
    if (key.length !== 32) throw new Error("the workspace cloud's key is not a key");
    this.saved.keys[ws] = { key: r.key, epoch: r.epoch };
    return { key, epoch: r.epoch };
  }

  // ---- publishing this PC's chats and projects

  private async publish(ctx: CloudContext): Promise<void> {
    const ws = ctx.mine;
    const { key, epoch } = await this.key(ctx, ws);
    const fp = this.o.fp();
    const me = this.o.meId();
    if (this.saved.pub.ws !== ws || this.saved.pub.epoch !== epoch) {
      // A new workspace (the PC moved) or a new key there: everything goes up again. The rows left in the old one are
      // the same chats; they go with the PC's key when it's removed.
      this.saved.pub = { ws, epoch, chats: {}, projects: {} };
      this.dirty = true;
    }
    const p = this.saved.pub;
    const now = this.now();
    // Rows in groups (a chat's chunks and its metadata, last): a group is taken as sent only when all of it was.
    const rows: Out[] = [];
    let bytes = 0;
    let group = 0;
    const add = (g: number, id: string, v: string | null) => {
      rows.push({ g, id, v });
      bytes += v?.length ?? 0;
    };
    const dones = new Map<number, () => void>();
    const seal = (row: string, plain: string) => cloudSeal(key, ws, epoch, row, Buffer.from(plain));
    // Projects (a few: all of them looked at whenever something changed here).
    if (this.dirty) {
      const seen = new Set<string>();
      for (const pr of this.o.source.projects()) {
        seen.add(pr.path);
        const plain = JSON.stringify({ pc: me, ...pr });
        const h = sha(plain);
        if (p.projects[pr.path] === h) continue;
        const id = cloudRowId(key, "p", `${fp}\0${pr.path}`);
        const g = ++group;
        add(g, id, seal(id, plain));
        dones.set(g, () => (p.projects[pr.path] = h));
      }
      for (const path of Object.keys(p.projects)) {
        if (seen.has(path)) continue;
        const g = ++group;
        add(g, cloudRowId(key, "p", `${fp}\0${path}`), null);
        dones.set(g, () => delete p.projects[path]);
      }
    }
    // Chats: the most recently changed first; a running one at most every RUNNING_GAP_MS.
    let deferred = false;
    let cut = false;
    const own = this.o.source.chats();
    const metas = own.map((c) => ({ c, meta: c.meta() }));
    metas.sort((a, b) => Number(b.meta.updated ?? 0) - Number(a.meta.updated ?? 0));
    const turn = yielder();
    for (const { c, meta } of metas) {
      await turn();
      if (bytes >= ROUND_SEND) {
        cut = true;
        break;
      }
      const sd = hexDigest(c.summary().digest);
      const mh = sha(JSON.stringify(meta));
      const k = String(c.hid);
      const had = p.chats[k];
      if (had && had.mh === mh && had.digest === sd) continue;
      if (had && c.running && now - had.at < RUNNING_GAP_MS) {
        deferred = true;
        continue;
      }
      const sent = c.items().map(cloudItem);
      const { chunks, parts } = chunkTranscript(
        sent.map((x) => x.json),
        this.o.chunkItems,
        this.o.chunkBytes,
      );
      const g = ++group;
      const before = new Map((had?.chunks ?? []).map(([st, h]) => [st, h]));
      const after = new Set(chunks.map(([st]) => st));
      chunks.forEach(([st, h], i) => {
        if (before.get(st) === h) return;
        const id = cloudRowId(key, "k", `${fp}\0${c.hid}\0${st}`);
        add(g, id, seal(id, JSON.stringify(parts[i] ?? [])));
      });
      for (const st of before.keys()) if (!after.has(st)) add(g, cloudRowId(key, "k", `${fp}\0${c.hid}\0${st}`), null);
      const id = cloudRowId(key, "m", `${fp}\0${c.hid}`);
      // The digest of what went up (the live transcript, with huge items cut), which a copy is checked against.
      const digest = hexDigest(digestItems(sent.map((x) => x.item)));
      add(g, id, seal(id, JSON.stringify({ pc: me, hid: c.hid, chat: meta, count: sent.length, digest, chunks })));
      dones.set(g, () => (p.chats[k] = { mh, digest: sd, chunks, at: now }));
    }
    if (!cut) {
      const ids = new Set(own.map((c) => String(c.hid)));
      for (const [k, had] of Object.entries(p.chats)) {
        if (ids.has(k)) continue;
        const g = ++group;
        for (const [st] of had.chunks) add(g, cloudRowId(key, "k", `${fp}\0${k}\0${st}`), null);
        add(g, cloudRowId(key, "m", `${fp}\0${k}`), null);
        dones.set(g, () => delete p.chats[k]);
      }
    }
    const failed = await this.put(ctx, ws, rows);
    for (const [g, done] of dones) if (!failed.has(g)) done();
    this.dirty = deferred || cut || failed.size > 0;
  }

  /** Sends rows in batches; gives the groups not all taken (the room ran out, or a row is another PC's). */
  private async put(ctx: CloudContext, ws: string, rows: readonly Out[]): Promise<Set<number>> {
    const failed = new Set<number>();
    let i = 0;
    while (i < rows.length) {
      const batch: Out[] = [];
      let bytes = 0;
      while (i < rows.length && batch.length < BATCH && (batch.length === 0 || bytes + (rows[i]?.v?.length ?? 0) < BATCH_BYTES)) {
        const r = rows[i++];
        if (!r) break;
        batch.push(r);
        bytes += r.v?.length ?? 0;
      }
      const r = await ctx.call("PUT", `/v1/cloud?ws=${encodeURIComponent(ws)}`, { set: batch.map(({ id, v }) => ({ id, v })) });
      if (!isObj(r) || !Array.isArray(r.results)) throw new Error("an odd answer from the workspace cloud");
      const res = new Map<string, Record<string, unknown>>();
      for (const x of r.results) if (isObj(x) && typeof x.id === "string") res.set(x.id, x);
      let full = false;
      for (const row of batch) {
        const x = res.get(row.id);
        if (x?.ok === true) continue;
        failed.add(row.g);
        const why = x ? str(x, "why") : "";
        if (why === "full") full = true;
        else if (why === "owned") this.log(`a row of this PC's is another PC's (${row.id})`);
      }
      if (full) {
        this.log("the workspace's room in the cloud is full: older chats aren't sent");
        this.fullAt = this.now();
        for (const rest of rows.slice(i)) failed.add(rest.g);
        break;
      }
    }
    return failed;
  }

  // ---- reading the workspaces' chats

  private wsState(ws: string, epoch: string): WsState {
    let st = this.saved.read[ws];
    if (!st || st.epoch !== epoch) {
      st = { epoch, cursor: 0, chats: {}, projects: {} };
      this.saved.read[ws] = st;
    }
    return st;
  }

  private async pull(ctx: CloudContext, ws: string): Promise<void> {
    let k = await this.key(ctx, ws);
    let st = this.wsState(ws, k.epoch);
    const fp = this.o.fp();
    for (let page = 0; page < 20; page++) {
      const r = await ctx.call("GET", `/v1/cloud?ws=${encodeURIComponent(ws)}&since=${st.cursor}`);
      if (!isObj(r) || !Array.isArray(r.items)) throw new Error("an odd answer from the workspace cloud");
      const epoch = str(r, "epoch");
      if (epoch !== "" && epoch !== k.epoch) {
        // The workspace's key changed: its rows started over.
        k = await this.key(ctx, ws, true);
        st = this.wsState(ws, k.epoch);
        continue;
      }
      for (const raw of r.items) {
        const row = parseRow(raw);
        if (!row) continue;
        st.cursor = Math.max(st.cursor, row.seq);
        if (row.by === fp) continue;
        if (row.id.startsWith("m:")) this.takeChat(st, k, ws, row);
        else if (row.id.startsWith("p:")) this.takeProject(st, k, ws, row);
      }
      if (r.more !== true) break;
    }
  }

  private takeChat(st: WsState, k: { key: Uint8Array; epoch: string }, ws: string, row: Row): void {
    const had = st.chats[row.id];
    if (row.v === null) {
      if (had) had.gone = true;
      return;
    }
    const b = cloudOpen(k.key, ws, k.epoch, row.id, row.v);
    let v: unknown = null;
    try {
      v = b ? JSON.parse(b.toString("utf8")) : null;
    } catch {
      v = null;
    }
    if (!isObj(v) || typeof v.pc !== "string" || typeof v.hid !== "number" || !isObj(v.chat)) {
      this.log(`a chat that doesn't open (${row.id})`);
      return;
    }
    st.chats[row.id] = {
      by: row.by,
      pc: v.pc,
      hid: v.hid,
      chat: v.chat as Record<string, Json>,
      count: typeof v.count === "number" ? v.count : 0,
      digest: str(v, "digest"),
      chunks: chunksOf(v.chunks),
      mh: sha(row.v),
    };
  }

  private takeProject(st: WsState, k: { key: Uint8Array; epoch: string }, ws: string, row: Row): void {
    if (row.v === null) {
      delete st.projects[row.id];
      return;
    }
    const b = cloudOpen(k.key, ws, k.epoch, row.id, row.v);
    let v: unknown = null;
    try {
      v = b ? JSON.parse(b.toString("utf8")) : null;
    } catch {
      v = null;
    }
    if (!isObj(v) || typeof v.pc !== "string" || typeof v.path !== "string") return;
    const p: CloudProject = {
      path: v.path,
      name: str(v, "name"),
      remote: str(v, "remote"),
      branch: str(v, "branch"),
      workspace: str(v, "workspace"),
      shared: Array.isArray(v.shared) ? v.shared.filter((x): x is string => typeof x === "string") : [],
    };
    st.projects[row.id] = { by: row.by, pc: v.pc, p, h: sha(row.v) };
  }

  /** Makes or updates the copies of the chats of PCs that are off, from what's known of each workspace. */
  private async applyAll(ctx: CloudContext): Promise<void> {
    const sink = this.o.sink;
    const me = this.o.meId();
    let fetched = 0;
    // A chat another PC took over while its PC was off (failover.ts) is listed by both: the newest of a gid is the one.
    const best = new Map<string, { updated: number; count: number; row: string }>();
    for (const st of Object.values(this.saved.read)) {
      for (const [row, c] of Object.entries(st.chats)) {
        const gid = typeof c.chat.gid === "string" ? c.chat.gid : "";
        if (gid === "" || c.gone) continue;
        const updated = typeof c.chat.updated === "number" ? c.chat.updated : 0;
        const b = best.get(gid);
        if (!b || updated > b.updated || (updated === b.updated && (c.count > b.count || (c.count === b.count && row > b.row)))) best.set(gid, { updated, count: c.count, row });
      }
    }
    for (const [ws, st] of Object.entries(this.saved.read)) {
      if (!ctx.workspaces.includes(ws)) continue;
      const kk = this.saved.keys[ws];
      if (!kk || kk.epoch !== st.epoch) continue;
      const key = new Uint8Array(Buffer.from(kk.key, "base64"));
      // Projects, by PC.
      const byPc = new Map<string, { pc: CloudPc; list: CloudProject[]; rows: [string, string][] }>();
      for (const [id, pr] of Object.entries(st.projects)) {
        if (this.saved.appliedProjects[id] === pr.h) continue;
        const pc = sink.pcOf(pr.by);
        if (!pc || pc.id !== pr.pc || pc.id === me) continue;
        const e = byPc.get(pc.id) ?? { pc, list: [], rows: [] };
        e.list.push(pr.p);
        e.rows.push([id, pr.h]);
        byPc.set(pc.id, e);
      }
      for (const e of byPc.values()) {
        sink.projects(e.pc, e.list);
        for (const [id, h] of e.rows) this.saved.appliedProjects[id] = h;
      }
      // Chats.
      // Parents before their sub-agents (a copy names its parent by the copy made of it).
      const order = Object.entries(st.chats).sort((a, b) => Number(a[1].chat.role === "sub") - Number(b[1].chat.role === "sub"));
      const turn = yielder();
      for (const [id, c] of order) {
        await turn();
        const pc = sink.pcOf(c.by);
        // Only from the PC the directory lists with the key that wrote it; never this PC's own.
        if (!pc || pc.id !== c.pc || pc.id === me) continue;
        if (sink.online(pc.id)) continue;
        const gid = typeof c.chat.gid === "string" ? c.chat.gid : "";
        if (!c.gone && gid !== "" && best.get(gid)?.row !== id) continue;
        const ak = `${pc.id}\0${c.hid}`;
        const done = this.saved.applied[ak];
        const copy = sink.copy(pc.id, c.hid);
        if (c.gone) {
          if (copy) await sink.chats(pc, [], [c.hid]);
          delete this.saved.applied[ak];
          delete st.chats[id];
          continue;
        }
        // Applied already: the copy matches, or there is none to keep (this PC took the chat over, or it was removed here).
        if (done && done.mh === c.mh && (copy ? hexDigest(copy.digest) === c.digest : done.digest === c.digest)) continue;
        // The mesh brought a newer copy than the cloud has: it stays.
        const updated = typeof c.chat.updated === "number" ? c.chat.updated : 0;
        if (copy && (copy.updated > updated || (copy.updated === updated && copy.count > c.count))) continue;
        if (fetched >= ROUND_FETCH) continue;
        if (!copy || !done || done.mh !== c.mh) await sink.chats(pc, [{ ...c.chat, id: c.hid }], []);
        const now = sink.copy(pc.id, c.hid);
        if (!now) {
          // Not taken as a copy (the chat is this PC's own now): left alone until it changes there.
          this.saved.applied[ak] = { mh: c.mh, digest: c.digest, chunks: [] };
          continue;
        }
        if (hexDigest(now.digest) === c.digest && now.count === c.count) {
          this.saved.applied[ak] = { mh: c.mh, digest: c.digest, chunks: c.chunks };
          continue;
        }
        const from = firstNeeded(c.chunks, done?.chunks ?? [], now.count);
        const want = c.chunks.slice(from);
        const got = await this.chunks(ctx, ws, key, st.epoch, c.by, pc.id, c.hid, want);
        if (got === null) continue;
        fetched += got.bytes;
        sink.items(pc.id, c.hid, c.count, got.items);
        const after = sink.copy(pc.id, c.hid);
        const whole = after !== null && hexDigest(after.digest) === c.digest;
        if (!whole && from > 0) {
          // Not what the cloud has: all of it again next round.
          this.saved.applied[ak] = { mh: c.mh, digest: "", chunks: [] };
          continue;
        }
        if (!whole) this.log(`a copy of ${pc.name}'s chat ${c.hid} doesn't match the cloud's digest after a full fetch`);
        this.saved.applied[ak] = { mh: c.mh, digest: c.digest, chunks: c.chunks };
      }
    }
  }

  /** The chunks `want` of a chat (fetched by id), as seq → item; null when one is missing or doesn't open. */
  private async chunks(
    ctx: CloudContext,
    ws: string,
    key: Uint8Array,
    epoch: string,
    by: string,
    pc: string,
    hid: number,
    want: readonly Chunk[],
  ): Promise<{ items: Map<number, Item>; bytes: number } | null> {
    const ids = new Map<string, number>();
    for (const [st] of want) ids.set(cloudRowId(key, "k", `${by}\0${hid}\0${st}`), st);
    const rows = new Map<string, Row>();
    let bytes = 0;
    let left = [...ids.keys()];
    while (left.length > 0) {
      const ask = left.slice(0, 64);
      const r = await ctx.call("POST", `/v1/cloud/rows?ws=${encodeURIComponent(ws)}`, { ids: ask });
      if (!isObj(r) || !Array.isArray(r.items)) throw new Error("an odd answer from the workspace cloud");
      let n = 0;
      for (const raw of r.items) {
        const row = parseRow(raw);
        if (!row || !ids.has(row.id)) continue;
        rows.set(row.id, row);
        bytes += row.v?.length ?? 0;
        n++;
      }
      if (n === 0) break;
      left = left.filter((x) => !rows.has(x));
    }
    const items = new Map<number, Item>();
    for (const [id, st] of ids) {
      const row = rows.get(id);
      if (!row || row.v === null || row.by !== by) {
        this.log(`a part of ${pc}'s chat ${hid} isn't in the cloud yet`);
        return null;
      }
      const b = cloudOpen(key, ws, epoch, id, row.v);
      let list: unknown = null;
      try {
        list = b ? JSON.parse(b.toString("utf8")) : null;
      } catch {
        list = null;
      }
      if (!Array.isArray(list)) return null;
      list.forEach((j, i) => {
        const it = typeof j === "string" ? parseItem(j) : null;
        if (it) items.set(st + i, it);
      });
    }
    return { items, bytes };
  }

  /** For tests. */
  get internals(): Saved {
    return this.saved;
  }
}
