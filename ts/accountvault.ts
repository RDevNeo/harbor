// What the account vault (packages/net/src/vault.ts) carries on this PC, and the single-host
// integrations' controller.
//
// Items:
// - "f:<path>": the integrations' sign-ins under dataDir/apps: Gmail's accounts and own client,
//   GitHub's gh login (hosts.yml, config.yml), Convex's login, the OAuth and key apps (Vercel,
//   Linear, Sentry, Supabase, Context7), and which MCP servers are off;
// - "s:<name>": each key the user saved for agents (secrets.json). Agents still need the user's
//   approval for each use on each PC: the grants are this PC's (kv `secret_grants`), not synced;
// - "b:whatsapp", "b:discord": a single-host integration's session (WhatsApp's linked-device keys,
//   Discord's local storage, where its token is), sent only by the PC that runs it.
//
// Single host: WhatsApp's linked-device keys must not run on two PCs at once (WhatsApp drops or
// bans a device whose keys show up twice), and Discord's session neither (one token from two
// places looks stolen). One PC of the account runs each: the one holding the vault's lease for it
// (renewed every minute, free after three minutes without). The others don't run it: their tools
// reach the host PC over the mesh (`POST /mesh/v1/app`, answered only for PCs signed in to the
// same account), and Settings shows "Runs on <PC>". A sign-in or link on a PC takes it over at
// once; a host PC that signs out hands it back with its newest session; when the host PC is gone
// for longer than the lease, the next of the account's PCs takes it with the session the vault has.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, relative } from "node:path";
import { apps, discord, discordsetup, remotehost, whatsapp, whatsappsetup } from "./packages/mcp/src/index.ts";
import { type Dest, type Vault, type VaultLocal, type VaultSource, vaultcrypto } from "./packages/net/src/index.ts";
import { secrets } from "./packages/store/src/index.ts";

/** The vault's mark in a folder (vault.ts `stamp`): a file beside the items. */
function stampAt(p: () => string): { get(): string | null; set(v: string): void } {
  return {
    get: () => {
      try {
        return readFileSync(p(), "utf8");
      } catch {
        return null;
      }
    },
    set: (v) => writeBytes(p(), Buffer.from(v)),
  };
}

/** Writes through a temporary file, owner-only. */
function writeBytes(p: string, data: Uint8Array): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.vault-tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** Files under `dir` (relative paths), recursively; no links. */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, base, out);
    else if (st.isFile() && !n.endsWith(".vault-tmp")) out.push(relative(base, p));
  }
  return out;
}

// ---- the integrations' files

/** The files that are a sign-in, under dataDir/apps. */
export function signInFiles(): string[] {
  const keyed = apps.APPS.filter((a) => a.auth.kind === "oauth" || a.auth.kind === "key").map((a) => `${a.id}.json`);
  return ["gmail.json", "github/hosts.yml", "github/config.yml", "convex/.convex/config.json", "mcp-off.json", ...keyed];
}

/** Folders whose every file is one (Gmail's accounts, one file per address, and its default). */
const SIGN_IN_DIRS = ["gmail.accounts"];

function allowedFile(rel: string): boolean {
  if (!vaultcrypto.safeName(rel)) return false;
  if (signInFiles().includes(rel)) return true;
  const parts = rel.split("/");
  return parts.length === 2 && SIGN_IN_DIRS.includes(parts[0] ?? "") && !(parts[1] ?? "").endsWith(".tmp");
}

export function fileSource(root: () => string = () => apps.dir()): VaultSource {
  const listAll = (): VaultLocal[] => {
    const r = root();
    const rels = [...signInFiles(), ...SIGN_IN_DIRS.flatMap((d) => walk(join(r, d)).map((n) => `${d}/${n}`))];
    const out: VaultLocal[] = [];
    for (const rel of new Set(rels)) {
      const p = join(r, rel);
      if (!allowedFile(rel) || !isFile(p)) continue;
      try {
        out.push({ id: `f:${rel}`, data: new Uint8Array(readFileSync(p)), at: Math.floor(statSync(p).mtimeMs) });
      } catch {
        // gone meanwhile
      }
    }
    return out;
  };
  return {
    prefix: "f:",
    stamp: stampAt(() => join(root(), ".vault-stamp")),
    list: listAll,
    write(id, data) {
      const rel = id.slice(2);
      if (!allowedFile(rel)) return;
      const p = join(root(), rel);
      if (data === null) rmSync(p, { force: true });
      else writeBytes(p, data);
    },
  };
}

// ---- the keys saved for agents

export function secretSource(path: string = secrets.secretsPath()): VaultSource {
  const enc = (s: secrets.Secret): Uint8Array => Buffer.from(JSON.stringify({ name: s.name, description: s.description, value: s.value, updated: s.updated }));
  return {
    prefix: "s:",
    stamp: stampAt(() => `${path}.vault-stamp`),
    list: () => secrets.load(path).map((s) => ({ id: `s:${s.name}`, data: enc(s), at: s.updated * 1000 })),
    write(id, data) {
      const name = id.slice(2);
      if (secrets.envName(name) !== name) return;
      if (data === null) {
        secrets.put(name, null, path);
        return;
      }
      try {
        const v = JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>;
        if (typeof v.value !== "string") return;
        secrets.put(name, { name, value: v.value, description: typeof v.description === "string" ? v.description : "", updated: typeof v.updated === "number" ? v.updated : 0 }, path);
      } catch {
        // not a key
      }
    },
  };
}

// ---- the single-host integrations

/** What the controller needs of one single-host integration. */
export interface SingleApp {
  name: string;
  /** Its folder (dataDir/apps/<name>): remote.json and the account's newest session (when another PC runs it) go here. */
  root(): string;
  /** It's linked or signed in on this PC. */
  linkedHere(): boolean;
  /** The linked account as Settings shows it. */
  accountHere(): string;
  /** The session's files, relative to `root()`. */
  sessionFiles(): string[];
  /** Its host process runs here. */
  running(): Promise<boolean>;
  /** Stops its host here (the link stays). */
  stop(): Promise<void>;
  /** Takes the session away from this PC (and its local caches, `extra`). */
  wipe(extra: boolean): void;
  /** One request to the host here (the mesh route), and the ops another PC may send. */
  request(req: Record<string, unknown>, waitMs: number): Promise<unknown>;
  ops: readonly string[];
  /** The least time between two session uploads while it runs (its keys change with use). */
  gapMs: number;
}

const canConnect = (sock: string): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createConnection({ path: sock });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

export function whatsappApp(): SingleApp {
  const root = () => whatsappsetup.root();
  return {
    name: whatsapp.NAME,
    root,
    linkedHere: () => existsSync(whatsappsetup.linkedPath()),
    accountHere: () => {
      const l = whatsappsetup.linked();
      return l ? (l.name !== "" ? l.name : l.jid.split("@")[0] ?? "") : "";
    },
    sessionFiles: () => [...walk(whatsappsetup.authDir()).map((n) => `auth/${n}`), ...(isFile(whatsappsetup.linkedPath()) ? ["linked.json"] : [])],
    running: () => canConnect(whatsappsetup.socket()),
    stop: async () => {
      await whatsapp.ask({ op: "stop" }, 15_000).catch(() => {});
    },
    wipe: (extra) => {
      whatsappsetup.wipe();
      if (extra) for (const f of ["wa.db", "wa.db-shm", "wa.db-wal", "notices.jsonl"]) rmSync(join(root(), f), { force: true });
    },
    request: (req, waitMs) => whatsapp.requestHere(req, waitMs),
    ops: ["status", "call", "signout", "cancel", "uncode"],
    gapMs: 5 * 60_000,
  };
}

export function discordApp(): SingleApp {
  const root = () => discordsetup.root();
  const profileRel = () => relative(root(), discordsetup.profile());
  return {
    name: discord.NAME,
    root,
    linkedHere: () => existsSync(discordsetup.accountPath()),
    accountHere: () => discord.accountName() ?? "",
    sessionFiles: () => {
      const p = profileRel();
      const out = walk(join(root(), p, "Local Storage")).map((n) => `${p}/Local Storage/${n}`);
      for (const f of ["Cookies", "Preferences"]) if (isFile(join(root(), p, f))) out.push(`${p}/${f}`);
      if (isFile(discordsetup.accountPath())) out.push(relative(root(), discordsetup.accountPath()));
      return out;
    },
    running: () => canConnect(discordsetup.socket()),
    stop: async () => {
      await discord.ask(discordsetup.socket(), { op: "stop" }, 15_000).catch(() => {});
    },
    wipe: (extra) => {
      rmSync(discordsetup.accountPath(), { force: true });
      const p = discordsetup.profile();
      if (extra) rmSync(p, { recursive: true, force: true });
      else {
        rmSync(join(p, "Local Storage"), { recursive: true, force: true });
        for (const f of ["Cookies", "Cookies-journal"]) rmSync(join(p, f), { force: true });
      }
    },
    request: (req, waitMs) => discord.requestHere(req as never, waitMs),
    ops: ["status", "call", "signout", "cancel"],
    gapMs: 30 * 60_000,
  };
}

/** The account's newest session while another PC runs it: taken when this PC takes over. */
const stagingPath = (a: SingleApp): string => join(a.root(), "vault-session.bin");

export interface SingleHostOptions {
  vault: Vault;
  /** This PC in the mesh. */
  me: () => { id: string; name: string };
  /** How to reach a PC of the mesh by its id (and key), or null when it isn't one now. */
  dest: (id: string, fp: string) => Dest | null;
  clock?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

/** How long a sign-in or link started here holds the lease before it's linked. */
const LINKING_MS = 15 * 60_000;

/** Renews a held lease when it's older than this (the vault's round comes about every 20 s). */
const RENEW_AFTER = 60_000;

/** Decides, after each vault round, which PC runs each single-host integration, and makes this PC act on it. */
export class SingleHost {
  private readonly o: SingleHostOptions;
  readonly apps: readonly SingleApp[];
  /** Per app: the session as last packed, and what it was packed from. */
  private snaps = new Map<string, { sig: string; data: Buffer; at: number }>();
  private forced = new Set<string>();
  /** When a sign-in or link started here (ms): the lease stays while the user scans the QR or types the code. */
  private claimedAt = new Map<string, number>();
  private blocked = new Set<string>();

  constructor(o: SingleHostOptions, list: readonly SingleApp[] = [whatsappApp(), discordApp()]) {
    this.o = o;
    this.apps = list;
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  private log(s: string): void {
    this.o.log?.(s);
  }

  /** Wires it to the vault and the integrations. */
  attach(): void {
    const v = this.o.vault;
    v.afterSync.push(() => this.tick());
    v.beforeLeave.push(() => this.leaving());
    v.afterLeave.push(() => this.left());
    remotehost.onSignInHere((name) => this.claimHere(name));
    whatsapp.setHostGate(() => this.mayRun(whatsapp.NAME));
  }

  /** The vault's sources for the sessions. */
  sources(): VaultSource[] {
    return this.apps.map((a) => this.source(a));
  }

  private holds(a: SingleApp): boolean {
    const l = this.o.vault.lease(a.name);
    return l !== null && l.mine && l.valid;
  }

  /** May this PC run its own host of `name` now: not while another of the account's PCs holds it. */
  mayRun(name: string): boolean {
    return !this.blocked.has(name);
  }

  private snapshot(a: SingleApp): Buffer | null {
    if (!a.linkedHere()) return null;
    const files = a.sessionFiles();
    const sig = files
      .map((f) => {
        try {
          const st = statSync(join(a.root(), f));
          return `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
        } catch {
          return `${f}:-`;
        }
      })
      .sort()
      .join("\n");
    const old = this.snaps.get(a.name);
    if (old && old.sig === sig) return old.data;
    // Its keys change as it's used: sent at most every gapMs, except a new link (no snapshot yet) and a hand-back.
    if (old && !this.forced.has(a.name) && this.now() - old.at < a.gapMs) return old.data;
    const entries: [string, Uint8Array][] = [];
    for (const f of files) {
      try {
        entries.push([f, readFileSync(join(a.root(), f))]);
      } catch {
        // written meanwhile: the next pack has it
      }
    }
    const data = vaultcrypto.packFiles(entries);
    this.snaps.set(a.name, { sig, data, at: this.now() });
    this.forced.delete(a.name);
    return data;
  }

  private restore(a: SingleApp, data: Uint8Array): boolean {
    const files = vaultcrypto.unpackFiles(data);
    if (files === null) {
      this.log(`${a.name}: the vault's session doesn't unpack`);
      return false;
    }
    a.wipe(false);
    for (const [name, bytes] of files) writeBytes(join(a.root(), name), bytes);
    this.snaps.delete(a.name);
    return true;
  }

  private source(a: SingleApp): VaultSource {
    const id = `b:${a.name}`;
    const all = (): VaultLocal[] => {
      const d = this.snapshot(a);
      return d === null ? [] : [{ id, data: d, at: this.now() }];
    };
    return {
      prefix: id,
      stamp: stampAt(() => join(a.root(), ".vault-stamp")),
      list: () => (this.holds(a) ? all() : null),
      all,
      write: (_id, data) => {
        if (this.holds(a)) {
          // Another PC of the account linked it and this one held it: its session wins.
          if (data === null) a.wipe(false);
          else this.restore(a, data);
          return;
        }
        if (data === null) rmSync(stagingPath(a), { force: true });
        else writeBytes(stagingPath(a), data);
      },
      wipe: () => {
        a.wipe(false);
        rmSync(stagingPath(a), { force: true });
      },
      wipeExtra: () => {
        a.wipe(true);
        rmSync(stagingPath(a), { force: true });
        remotehost.writeRemote(a.root(), null);
      },
    };
  }

  private who(a: SingleApp): { id: string; name: string; account: string } {
    const me = this.o.me();
    return { id: me.id, name: me.name, account: a.accountHere() };
  }

  /** After each vault round. */
  async tick(): Promise<void> {
    const v = this.o.vault;
    for (const a of this.apps) {
      try {
        if (!v.isOpen()) {
          // No vault (signed out, locked): each PC as it was alone.
          this.blocked.delete(a.name);
          remotehost.writeRemote(a.root(), null);
          continue;
        }
        const l = v.lease(a.name);
        if (l && l.valid && !l.mine) {
          this.blocked.add(a.name);
          if (await a.running()) {
            this.log(`${a.name} runs on ${l.name} now: stopping it here`);
            await a.stop();
          }
          const me = this.o.me();
          remotehost.writeRemote(a.root(), { pc: { id: l.id, name: l.name, dest: this.o.dest(l.id, l.fp) ?? { addr: "", fp: l.fp } }, me, account: l.account, at: this.now() });
          continue;
        }
        remotehost.writeRemote(a.root(), null);
        const staged = existsSync(stagingPath(a));
        if (l && l.valid && l.mine) {
          this.blocked.delete(a.name);
          const who = this.who(a);
          const linking = this.now() - (this.claimedAt.get(a.name) ?? 0) < LINKING_MS;
          if (!a.linkedHere() && !staged && !linking) await v.release(a.name);
          else if (v.serverTime() - l.seq > RENEW_AFTER || who.account !== l.account) await v.claim(a.name, who);
          continue;
        }
        // Nobody runs it: this PC takes it when it has the session (its own, or the account's newest).
        if (!a.linkedHere() && !staged) {
          this.blocked.delete(a.name);
          continue;
        }
        this.blocked.add(a.name);
        if (await v.claim(a.name, this.who(a))) {
          this.takeStaged(a);
          this.blocked.delete(a.name);
          this.log(`${a.name} runs on this PC now`);
        }
      } catch (e) {
        this.log(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The account's newest session, kept while another PC ran it, replaces what's here. */
  private takeStaged(a: SingleApp): void {
    const p = stagingPath(a);
    if (!existsSync(p)) return;
    try {
      if (this.restore(a, readFileSync(p))) rmSync(p, { force: true });
    } catch (e) {
      this.log(`${a.name}: couldn't take the session over: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A sign-in or link starts here: this PC takes it over now (the one running it stops within a round). */
  async claimHere(name: string): Promise<void> {
    const a = this.apps.find((x) => x.name === name);
    const v = this.o.vault;
    if (!a || !v.isOpen()) return;
    if (await v.claim(name, this.who(a), true)) {
      remotehost.writeRemote(a.root(), null);
      rmSync(stagingPath(a), { force: true });
      this.blocked.delete(name);
      this.forced.add(name);
      this.claimedAt.set(name, this.now());
    }
  }

  /** The account signs out here: what runs here stops and its newest session goes to the vault. */
  private async leaving(): Promise<void> {
    for (const a of this.apps) {
      if (!this.holds(a)) continue;
      if (await a.running()) await a.stop();
      this.forced.add(a.name);
      this.blocked.add(a.name);
    }
  }

  private async left(): Promise<void> {
    for (const a of this.apps) {
      if (this.holds(a)) await this.o.vault.release(a.name).catch(() => {});
      remotehost.writeRemote(a.root(), null);
      this.blocked.delete(a.name);
    }
  }

  /** `POST /mesh/v1/app {app, req, wait}` from the PC with key `fp`: a request to the host here, for the account's own PCs only. */
  async serveMesh(fp: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
    const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const a = this.apps.find((x) => x.name === b.app);
    if (!a) return { status: 404, body: { error: "no such app" } };
    if (fp === undefined || !this.o.vault.isMine(fp)) return { status: 403, body: { error: `This PC runs ${a.name} for its own account's PCs only.` } };
    if (!this.holds(a)) return { status: 409, body: { error: `${this.o.me().name} doesn't run ${a.name} now: try again in a minute.` } };
    const req = typeof b.req === "object" && b.req !== null && !Array.isArray(b.req) ? (b.req as Record<string, unknown>) : {};
    if (!a.ops.includes(String(req.op ?? ""))) return { status: 400, body: { error: "not an op for another PC" } };
    const wait = typeof b.wait === "number" && b.wait > 0 ? Math.min(b.wait, 700_000) : 60_000;
    try {
      return { status: 200, body: { ok: true, result: await a.request(req, wait) } };
    } catch (e) {
      return { status: 200, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
  }
}
