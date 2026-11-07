// The account vault: what follows the account to every PC it signs in on, besides the settings
// (settingsync): the integrations' sign-ins (Gmail, GitHub, Convex, the OAuth and key apps), the
// keys the user saved for agents, and the single-host integrations' sessions (WhatsApp, Discord),
// encrypted (vaultcrypto.ts) through the account service's `/v1/vault`. The key is the account's:
// the service keeps it for the account's own signed-in PCs (`/v1/vault/key`), so a new PC opens the
// vault on its first round with no other PC on. Nothing to set up, nothing to write down.
//
// Items: one per file or key, named by its source ("f:gmail.accounts/x.json", "s:OPENAI_KEY",
// "b:whatsapp"). The newest change of an item wins (its `at`, ms): the service keeps the newer
// write and answers a losing one with the row that won. A deleted item is a row too, so a
// sign-out of an integration on one PC signs it out on all of them. A PC that joins a vault takes
// what's newer of each side: a file's change time stands for its `at` the first time.
//
// The single-host integrations (singlehost.ts) also keep a lease here: which PC runs them.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privateDir, writePrivate } from "@harbor/store";
import type { Identity } from "./tls.ts";
import type { Json } from "./wire.ts";
import { checks, decodeItem, encodeItem, hashOf, KEY_BYTES, leaseRow, open, rowId, seal } from "./vaultcrypto.ts";

/** One item as this PC has it now: `at` is when it last changed here (ms; a file's change time). */
export interface VaultLocal {
  id: string;
  data: Uint8Array;
  at: number;
}

/** Where items live on this PC. Item names start with the source's `prefix`. */
export interface VaultSource {
  prefix: string;
  /** What this PC has now. Null: the source takes no part now (a single-host integration another PC runs): nothing of it is sent, and nothing missing counts as deleted. */
  list(): VaultLocal[] | null;
  /** Takes the account's value (null: deleted). Called also while the source takes no part: it keeps the value aside then. */
  write(id: string, data: Uint8Array | null): void;
  /** Everything of the account this PC has, taking part or not (a sign-out takes it all away). Default `list()`. */
  all?(): VaultLocal[];
  /** Takes this PC's copy away (a sign-out of the account): the vault keeps it. Default `write(id, null)`. */
  wipe?(id: string): void;
  /** What else of the account the source keeps here (caches), on a sign-out. */
  wipeExtra?(): void;
  /**
   * A mark kept beside the items (a file in their folder): the vault writes which vault they're
   * synced with. Missing (the folder was wiped, the data restored from elsewhere): what this PC
   * knew of them is forgotten and they join again (the newer side of each wins), so a lost folder
   * never reads as "deleted everything" on every PC.
   */
  stamp?: { get(): string | null; set(v: string): void };
}

/** A call to the account service's `/v1/vault` with this PC's Harbor token. Throws on failure. */
export type VaultCall = (method: "GET" | "PUT", path: string, body?: Json) => Promise<unknown>;

export interface VaultRow {
  id: string;
  v: string | null;
  at: number;
  by: string;
  seq: number;
}

export interface VaultDevice {
  fp: string;
  name: string;
  seen: number;
}

export interface VaultOptions {
  /** Where `vault.json` lives (the private state directory). */
  stateDir: string;
  identity: () => Identity;
  sources: () => readonly VaultSource[];
  clock?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Something the window shows changed (who runs a single-host integration). */
  onChange?: () => void;
}

export type VaultStateName = "off" | "locked" | "open";

export interface VaultStatus {
  /** Locked: the vault was made by a Harbor that kept its key on its PCs, and none of them has handed it to the service yet. */
  state: VaultStateName;
  /** Items held in the vault. */
  items: number;
  syncedAt: number;
  error: string;
  /** The account's PCs, as the service lists them. */
  devices: VaultDevice[];
}

interface Entry {
  id: string;
  /** SHA-256 of the item's bytes, "" when deleted. */
  h: string;
  at: number;
}

interface Saved {
  /** The account whose items this PC holds ("" before any). */
  account: string;
  epoch: string;
  /** The vault key (base64), "" while locked. */
  vk: string;
  cursor: number;
  rows: Record<string, Entry>;
  /** The account that signed out and left items here it couldn't put in the vault. */
  left?: string;
}

const blank = (account = ""): Saved => ({ account, epoch: "", vk: "", cursor: 0, rows: {} });

/** The recovery code's item of Harbor 0.162-0.164: dropped once the service holds the key. */
const OLD_RECOVERY_ITEM = "~recovery";
/** Rows per PUT (the service takes 64) and about how many bytes. */
const BATCH = 48;
const BATCH_BYTES = 1500 << 10;
/** A lease nobody renewed for this long is free. */
export const LEASE_TTL = 180_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");

function parseRow(v: unknown): VaultRow | null {
  if (!isObj(v) || typeof v.id !== "string" || !(typeof v.v === "string" || v.v === null) || typeof v.at !== "number" || typeof v.seq !== "number") return null;
  return { id: v.id, v: v.v, at: v.at, by: typeof v.by === "string" ? v.by : "", seq: v.seq };
}

function parseJson<T>(s: string | null | undefined, ok: (v: Record<string, unknown>) => boolean): T | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return isObj(v) && ok(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

const isMeta = (v: Record<string, unknown>) => typeof v.epoch === "string" && typeof v.check === "string";

/** Who runs a single-host integration now (vault row `lease:<hash>`). */
export interface Lease {
  /** The PC's key fingerprint, mesh id and name. */
  fp: string;
  id: string;
  name: string;
  /** What the host says of its account (the linked number's name): Settings shows it on the other PCs. */
  account: string;
  seq: number;
  /** Renewed within LEASE_TTL. */
  valid: boolean;
  mine: boolean;
}

export class Vault {
  private readonly o: VaultOptions;
  private saved: Saved;
  private vk: Uint8Array | null = null;
  /** Every row that isn't an item: meta, leases. */
  private others = new Map<string, VaultRow>();
  private loaded = false;
  private devs: VaultDevice[] = [];
  /** The service's clock at `serverAt` (this PC's ms). */
  private serverNow = 0;
  private serverAt = 0;
  /** The service keeps this vault's key (its answer to the last GET); false: this PC hands it over. */
  private held = true;
  private err = "";
  private syncedAt = 0;
  private last: VaultCall | null = null;
  private running: Promise<void> | null = null;
  /** Called after each round, with the vault open or not (singlehost.ts). */
  afterSync: (() => Promise<void>)[] = [];
  /** Called first on a sign-out (singlehost.ts stops what runs here, for its newest session to go out). */
  beforeLeave: (() => Promise<void>)[] = [];
  /** Called on a sign-out once the vault has what changed here (singlehost.ts gives its leases back). */
  afterLeave: (() => Promise<void>)[] = [];

  constructor(o: VaultOptions) {
    this.o = o;
    this.saved = this.load();
    if (this.saved.vk !== "") this.vk = new Uint8Array(Buffer.from(this.saved.vk, "base64"));
    // What Harbor 0.162-0.164 kept for its per-PC key wraps and recovery code: the vault key is the service's to hand out now.
    rmSync(join(o.stateDir, "vault-device.json"), { force: true });
    for (const [row, e] of Object.entries(this.saved.rows)) if (e.id.startsWith("~")) delete this.saved.rows[row];
    delete (this.saved as { fresh?: boolean }).fresh;
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  private log(s: string): void {
    this.o.log?.(s);
  }

  private path(): string {
    return join(this.o.stateDir, "vault.json");
  }

  private load(): Saved {
    const s = parseJson<Saved>(existsSync(this.path()) ? readFileSync(this.path(), "utf8") : null, (v) => typeof v.account === "string" && isObj(v.rows));
    return s ? { ...blank(), ...s } : blank();
  }

  private save(): void {
    try {
      privateDir(this.o.stateDir);
      writePrivate(this.path(), JSON.stringify(this.saved));
    } catch (e) {
      this.log(`couldn't save the vault's state: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private changed(): void {
    this.o.onChange?.();
  }

  private myFp(): string {
    return this.o.identity().fp;
  }

  /** The service's clock now, as last heard. */
  serverTime(): number {
    return this.serverNow === 0 ? this.now() : this.serverNow + (this.now() - this.serverAt);
  }

  status(): VaultStatus {
    const state: VaultStateName = this.saved.account === "" ? "off" : this.vk ? "open" : "locked";
    const items = Object.values(this.saved.rows).filter((e) => e.h !== "").length;
    return { state, items, syncedAt: this.syncedAt, error: this.err, devices: this.devs };
  }

  isOpen(): boolean {
    return this.vk !== null && this.saved.account !== "";
  }

  /** `fp` is a PC signed in to this account (the service's list). */
  isMine(fp: string): boolean {
    return fp !== "" && this.devs.some((d) => d.fp === fp);
  }

  deviceName(fp: string): string {
    return this.devs.find((d) => d.fp === fp)?.name ?? "";
  }

  /** One round (the account loop, about every 20 s, and at once on a push): never two at once. */
  sync(account: string, call: VaultCall): Promise<void> {
    if (this.running) return this.running;
    this.running = this.round(account, call).finally(() => (this.running = null));
    return this.running;
  }

  /** The vault's state, but the sync time: a round that changed nothing tells nobody. */
  private shown(): string {
    const { syncedAt: _, ...rest } = this.status();
    return JSON.stringify(rest);
  }

  private async round(account: string, call: VaultCall): Promise<void> {
    const before = this.shown();
    this.last = call;
    try {
      if (this.saved.account !== account) this.adopt(account);
      await this.fetch(call);
      if (await this.keys(call)) await this.items(call);
      this.err = "";
      this.syncedAt = this.now();
    } catch (e) {
      this.err = e instanceof Error ? e.message : String(e);
      this.log(`sync: ${this.err}`);
    }
    for (const f of this.afterSync) {
      try {
        await f();
      } catch (e) {
        this.log(`after sync: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.shown() !== before) this.changed();
  }

  /** This PC now holds `account`'s items. Another account's left here go aside first (into the state directory), never into this account's vault. */
  private adopt(account: string): void {
    const before = this.saved.account !== "" ? this.saved.account : (this.saved.left ?? "");
    if (before !== "" && before !== account) this.setAside(before);
    this.saved = blank(account);
    this.vk = null;
    this.others.clear();
    this.pending.clear();
    this.loaded = false;
    this.held = true;
    this.save();
  }

  private setAside(account: string): void {
    const dir = privateDir(join(this.o.stateDir, "vault-left", `${account.replace(/[^A-Za-z0-9_-]/g, "_")}-${this.now()}`));
    let n = 0;
    for (const src of this.o.sources()) {
      for (const it of everything(src)) {
        try {
          writePrivate(join(dir, `${encodeURIComponent(it.id)}`), Buffer.from(it.data).toString("base64"));
          (src.wipe ?? ((id: string) => src.write(id, null)))(it.id);
          n++;
        } catch (e) {
          this.log(`couldn't set ${it.id} aside: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        src.wipeExtra?.();
      } catch {
        // a cache left behind
      }
    }
    if (n > 0) this.log(`set aside ${n} item(s) another account left on this PC (${dir})`);
  }

  private async fetch(call: VaultCall): Promise<VaultRow[]> {
    const since = this.loaded ? this.saved.cursor : 0;
    const r = await call("GET", `/v1/vault?since=${since}`);
    if (!isObj(r) || !Array.isArray(r.items)) throw new Error("an odd answer from the vault");
    if (typeof r.now === "number") {
      this.serverNow = r.now;
      this.serverAt = this.now();
    }
    if (typeof r.held === "boolean") this.held = r.held;
    if (Array.isArray(r.devices)) {
      this.devs = r.devices.flatMap((d: unknown) => (isObj(d) && typeof d.fp === "string" ? [{ fp: d.fp, name: text(d, "name"), seen: typeof d.seen === "number" ? d.seen : 0 }] : []));
    }
    const rows = r.items.map(parseRow).filter((x): x is VaultRow => x !== null);
    // Kept until the vault is open to read them (a waiting PC's rounds still move the cursor on).
    for (const x of rows) if (x.id.startsWith("i:") && (this.pending.get(x.id)?.seq ?? -1) < x.seq) this.pending.set(x.id, x);
    for (const x of rows) {
      if (!x.id.startsWith("i:")) this.others.set(x.id, x);
      this.saved.cursor = Math.max(this.saved.cursor, x.seq);
    }
    if (!this.loaded && typeof r.seq === "number") this.saved.cursor = Math.max(this.saved.cursor, r.seq);
    this.loaded = true;
    return rows;
  }

  /** Item rows fetched and not yet merged, by row. */
  private pending = new Map<string, VaultRow>();

  private async put(call: VaultCall, set: { id: string; v: string | null; at: number; prev?: number }[]): Promise<{ id: string; ok: boolean; seq?: number; cur?: VaultRow | null }[]> {
    const r = await call("PUT", "/v1/vault", { set: set as unknown as Json });
    if (!isObj(r) || !Array.isArray(r.results)) throw new Error("an odd answer from the vault");
    if (typeof r.now === "number") {
      this.serverNow = r.now;
      this.serverAt = this.now();
    }
    return r.results.map((x: unknown) => {
      const o = isObj(x) ? x : {};
      const cur = o.cur === null ? null : parseRow(o.cur);
      const row = { id: text(o, "id"), ok: o.ok === true, ...(typeof o.seq === "number" ? { seq: o.seq } : {}), ...(o.cur !== undefined ? { cur } : {}) };
      // What this PC wrote, as the service now holds it.
      if (row.ok && row.seq !== undefined) {
        const mine = set.find((s) => s.id === row.id);
        if (mine && !mine.id.startsWith("i:")) this.others.set(mine.id, { id: mine.id, v: mine.v, at: mine.at, by: this.myFp(), seq: row.seq });
      } else if (cur && !row.id.startsWith("i:")) this.others.set(cur.id, cur);
      return row;
    });
  }

  private meta(): { epoch: string; check: string } | null {
    const m = this.others.get("meta");
    return m && m.v !== null ? parseJson<{ epoch: string; check: string }>(m.v, isMeta) : null;
  }

  /**
   * The vault key: the account service's, made with the vault on the first PC's ask and handed to
   * each of the account's PCs. A PC that has a key the service doesn't (a vault made by Harbor
   * 0.162-0.164, which kept it on the PCs) hands it over. True when open.
   */
  private async keys(call: VaultCall): Promise<boolean> {
    let meta = this.meta();
    // The vault started over (no PC could open it): this PC joins the new one with what it has.
    if (this.vk && (!meta || meta.epoch !== this.saved.epoch)) this.dropKey();
    if (this.vk && meta) {
      if (!this.held) await this.handOver(call, meta.epoch);
      return true;
    }
    const r = await call("GET", "/v1/vault/key");
    if (!isObj(r) || typeof r.key !== "string" || typeof r.epoch !== "string") {
      this.log("waiting for a PC of the account that has the vault's key to hand it to the service");
      return false;
    }
    const vk = new Uint8Array(Buffer.from(r.key, "base64"));
    // Made just now: its meta row came after this round's fetch.
    if (!meta || meta.epoch !== r.epoch) {
      await this.fetch(call);
      meta = this.meta();
    }
    if (vk.length !== KEY_BYTES || !meta || meta.epoch !== r.epoch || !checks(vk, meta.epoch, meta.check)) throw new Error("the account service's vault key doesn't open this vault");
    this.setKey(vk, meta.epoch);
    return true;
  }

  private setKey(vk: Uint8Array, epoch: string): void {
    this.vk = vk;
    this.saved.vk = Buffer.from(vk).toString("base64");
    this.saved.epoch = epoch;
    this.save();
    this.log("open");
  }

  private dropKey(): void {
    this.vk = null;
    this.saved = { ...blank(this.saved.account) };
    this.save();
    this.log("the vault changed elsewhere: joining it again");
  }

  /** Gives the service this PC's key (checked against the vault's meta row there); the old recovery code's item goes. */
  private async handOver(call: VaultCall, epoch: string): Promise<void> {
    const vk = this.vk;
    if (!vk) return;
    await call("PUT", "/v1/vault/key", { key: Buffer.from(vk).toString("base64"), epoch });
    this.held = true;
    const id = rowId(vk, OLD_RECOVERY_ITEM);
    const r = await this.put(call, [{ id, v: null, at: this.now() }]);
    // Written at this PC's clock or later: once more just after it.
    const cur = r[0]?.cur;
    if (r[0]?.ok === false && cur && cur.v !== null) await this.put(call, [{ id, v: null, at: cur.at + 1 }]);
    this.log("handed the vault's key to the account service");
  }

  private rowOf(id: string): string {
    const vk = this.vk;
    if (!vk) throw new Error("the vault is locked");
    return rowId(vk, id);
  }

  private sealItem(p: { id: string; data: Uint8Array | null }): { row: string; v: string } {
    const vk = this.vk;
    if (!vk) throw new Error("the vault is locked");
    const row = rowId(vk, p.id);
    return { row, v: seal(vk, row, this.saved.epoch, encodeItem(p)) };
  }

  private openRow(r: VaultRow): { id: string; data: Uint8Array | null } | null {
    const vk = this.vk;
    if (!vk || r.v === null) return null;
    const b = open(vk, r.id, this.saved.epoch, r.v);
    return b ? decodeItem(b) : null;
  }

  private sourceOf(id: string, srcs: readonly VaultSource[]): VaultSource | undefined {
    return srcs.find((s) => id.startsWith(s.prefix));
  }

  /** Merges the fetched items, then sends what changed here. */
  private async items(call: VaultCall): Promise<void> {
    const local = new Map<string, VaultLocal>();
    const partOf = new Map<VaultSource, boolean>();
    const srcs = this.o.sources();
    const mark = `${this.saved.account}:${this.saved.epoch}`;
    for (const s of srcs) {
      if (s.stamp && s.stamp.get() !== mark) {
        let n = 0;
        for (const [row, e] of Object.entries(this.saved.rows)) {
          if (e.id.startsWith(s.prefix)) {
            delete this.saved.rows[row];
            n++;
          }
        }
        if (n > 0) this.log(`${s.prefix} items: their folder isn't the one synced before, so they join again`);
        try {
          s.stamp.set(mark);
        } catch {
          // a read-only folder: they join again next round
        }
      }
      const l = s.list();
      partOf.set(s, l !== null);
      for (const it of l ?? []) local.set(it.id, it);
    }
    const takes = (id: string): boolean => {
      const s = this.sourceOf(id, srcs);
      return s !== undefined && partOf.get(s) === true;
    };
    const merge = (r: VaultRow): void => {
      const p = this.openRow(r);
      if (!p) {
        if (r.v !== null) this.log(`an item that doesn't open (${r.id})`);
        return;
      }
      const rh = p.data === null ? "" : hashOf(p.data);
      const e = this.saved.rows[r.id];
      if (e && e.h === rh && e.at >= r.at) return;
      const src = this.sourceOf(p.id, srcs);
      if (!src) return;
      const mine = local.get(p.id);
      const lh = mine ? hashOf(mine.data) : "";
      if (takes(p.id) && lh !== rh) {
        const changedHere = e ? lh !== e.h : mine !== undefined;
        const hereAt = e ? this.now() : (mine?.at ?? 0);
        // This PC's newer change stays: it goes out below and the service picks.
        if (changedHere && hereAt > r.at) return;
      }
      if (lh !== rh || !takes(p.id)) src.write(p.id, p.data);
      if (p.data === null) local.delete(p.id);
      else local.set(p.id, { id: p.id, data: p.data, at: r.at });
      this.saved.rows[r.id] = { id: p.id, h: rh, at: r.at };
    };
    const fetched = [...this.pending.values()].sort((x, y) => x.seq - y.seq);
    this.pending.clear();
    for (const r of fetched) merge(r);
    // What changed here.
    const set: { id: string; v: string | null; at: number; meta: Entry }[] = [];
    const now = this.now();
    const seen = new Set<string>();
    for (const it of local.values()) {
      if (!takes(it.id)) continue;
      const row = this.rowOf(it.id);
      seen.add(row);
      const e = this.saved.rows[row];
      const h = hashOf(it.data);
      if (e && e.h === h) continue;
      const at = e ? Math.max(now, e.at + 1) : it.at;
      set.push({ id: row, v: this.sealItem({ id: it.id, data: it.data }).v, at, meta: { id: it.id, h, at } });
    }
    for (const [row, e] of Object.entries(this.saved.rows)) {
      if (e.h === "" || seen.has(row) || !takes(e.id)) continue;
      const s = this.sealItem({ id: e.id, data: null });
      const at = Math.max(now, e.at + 1);
      set.push({ id: row, v: s.v, at, meta: { id: e.id, h: "", at } });
    }
    let i = 0;
    while (i < set.length) {
      const batch: typeof set = [];
      let bytes = 0;
      while (i < set.length && batch.length < BATCH && (batch.length === 0 || bytes + (set[i]?.v?.length ?? 0) < BATCH_BYTES)) {
        const x = set[i++];
        if (!x) break;
        batch.push(x);
        bytes += x.v?.length ?? 0;
      }
      const res = await this.put(
        call,
        batch.map(({ id, v, at }) => ({ id, v, at })),
      );
      for (const x of batch) {
        const r = res.find((y) => y.id === x.id);
        if (r?.ok) this.saved.rows[x.id] = x.meta;
        else if (r?.cur) merge(r.cur);
      }
      this.save();
    }
    this.save();
  }

  // ---- leases of the single-host integrations

  lease(app: string): Lease | null {
    const vk = this.vk;
    if (!vk) return null;
    const row = this.others.get(leaseRow(vk, app));
    if (!row || row.v === null) return null;
    const b = open(vk, row.id, this.saved.epoch, row.v);
    const v = b ? parseJson<Record<string, unknown>>(b.toString("utf8"), (x) => typeof x.fp === "string") : null;
    if (!v) return null;
    const fp = text(v, "fp");
    return { fp, id: text(v, "id"), name: text(v, "name"), account: text(v, "account"), seq: row.seq, valid: this.serverTime() - row.seq < LEASE_TTL, mine: fp === this.myFp() };
  }

  /** Takes (or renews) the lease: a free one, this PC's own, or (`force`: a new sign-in here) anyone's. True when this PC holds it. */
  async claim(app: string, who: { id: string; name: string; account: string }, force = false): Promise<boolean> {
    const vk = this.vk;
    const call = this.last;
    if (!vk || !call) return false;
    const cur = this.lease(app);
    if (cur && cur.valid && !cur.mine && !force) return false;
    const row = leaseRow(vk, app);
    const prev = this.others.get(row)?.seq ?? 0;
    const v = seal(vk, row, this.saved.epoch, Buffer.from(JSON.stringify({ fp: this.myFp(), ...who })));
    const r = await this.put(call, [{ id: row, v, at: this.now(), prev }]);
    if (r[0]?.ok) return true;
    // Someone else wrote it meanwhile: a forced claim tries once more against what's there now.
    if (force && r[0]?.cur) return (await this.put(call, [{ id: row, v, at: this.now(), prev: r[0].cur.seq }]))[0]?.ok === true;
    return false;
  }

  async release(app: string): Promise<void> {
    const vk = this.vk;
    const call = this.last;
    const cur = this.lease(app);
    if (!vk || !call || !cur?.mine) return;
    const row = leaseRow(vk, app);
    await this.put(call, [{ id: row, v: null, at: this.now(), prev: cur.seq }]);
  }

  // ---- signing out of the account

  /**
   * The account signs out of this PC: its single-host integrations are handed back, what changed
   * here goes to the vault, and then this PC's copies go (the vault has them). When the vault
   * couldn't take everything, nothing is removed, and the next account that signs in here finds it
   * set aside, not in its vault.
   */
  async leave(): Promise<void> {
    // A round in flight finishes first: it may be sending what changed here.
    await this.running?.catch(() => {});
    const account = this.saved.account;
    if (account === "") return;
    for (const f of this.beforeLeave) {
      try {
        await f();
      } catch (e) {
        this.log(`before sign-out: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const call = this.last;
    let safe = false;
    if (call && this.vk) {
      try {
        await this.fetch(call);
        await this.items(call);
        safe = this.allSent();
      } catch (e) {
        this.log(`final sync: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const f of this.afterLeave) {
      try {
        await f();
      } catch (e) {
        this.log(`after sign-out: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (safe) {
      for (const src of this.o.sources()) {
        for (const it of everything(src)) (src.wipe ?? ((id: string) => src.write(id, null)))(it.id);
        try {
          src.wipeExtra?.();
        } catch {
          // a cache left behind
        }
      }
      this.saved = blank();
      this.log("signed out: this PC's copies are gone, the vault keeps them");
    } else {
      this.saved = { ...blank(), left: account };
      this.log("signed out without reaching the vault: this PC keeps its copies");
    }
    this.vk = null;
    this.held = true;
    this.others.clear();
    this.pending.clear();
    this.loaded = false;
    this.last = null;
    this.save();
    this.changed();
  }

  /** Every item this PC has is in the vault as it is here. */
  private allSent(): boolean {
    for (const src of this.o.sources()) {
      for (const it of src.list() ?? []) {
        const e = this.saved.rows[this.rowOf(it.id)];
        if (!e || e.h !== hashOf(it.data)) return false;
      }
    }
    return true;
  }

  /** For tests. */
  get internals(): { saved: Saved; others: Map<string, VaultRow> } {
    return { saved: this.saved, others: this.others };
  }
}

function everything(src: VaultSource): VaultLocal[] {
  return src.all ? src.all() : (src.list() ?? []);
}

/** Removes a folder's item files that the vault wrote, for sources made of files. */
export function removeQuiet(p: string): void {
  rmSync(p, { force: true, recursive: true });
}
