import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Item, digest, digestOf, fnvText, itemHash, itemJson, parseItem } from "./item.ts";
import { dataDir, newUuid, now, privateDir } from "./paths.ts";
import { changed as settingChanged } from "./settingsync.ts";

export interface Repo {
  id: number;
  path: string;
  name: string;
  /** Manual order in the sidebar. */
  sort: number;
  /** Its git remote (origin's URL; "" when unknown). */
  remote: string;
  /** This PC's own folder for a project another PC shares; null: `path`. */
  local: string | null;
}

export function repoDir(r: Pick<Repo, "path" | "local">): string {
  return r.local ?? r.path;
}

export type Access = "full" | "edits" | "plan" | "ask";

export function parseAccess(s: string): Access {
  return s === "edits" || s === "plan" || s === "ask" ? s : "full";
}

export type Role = "lead" | "sub" | "chat";

export function parseRole(s: string): Role {
  return s === "lead" ? "lead" : s === "sub" ? "sub" : "chat";
}

export interface Timer {
  id: number;
  chatId: number;
  at: number;
  reason: string;
}

export interface ProcRow {
  id: number;
  lead: number;
  repoId: number | null;
  owner: number;
  name: string;
  cmd: string;
  cwd: string;
  pid: number;
  /** Start time from /proc/<pid>/stat, so a reused pid isn't mistaken for ours. */
  startTicks: number;
  log: string;
  url: string | null;
}

export interface Webhook {
  id: number;
  repoId: number;
  name: string;
  token: string;
  description: string;
  hits: number;
  lastHit: number;
}

export interface Chat {
  id: number;
  /** null = "No project": runs in the home directory. */
  repoId: number | null;
  title: string;
  /** Claude Code session id; set on creation and passed with `--resume` afterwards. */
  sessionId: string;
  /** True once the first turn has run, so later turns resume instead of creating. */
  started: boolean;
  /** Provider account id ("claude", "claude2", "codex", …). */
  account: string;
  model: string;
  effort: string;
  access: Access;
  settled: boolean;
  updated: number;
  role: Role;
  /** The lead of a subagent. */
  parent: number | null;
  /** Short handle agents use to address each other. */
  name: string;
  /** The device its agent runs on; "" is this PC. */
  device: string;
  /** Globally unique id: the same chat has it on every PC. */
  gid: string;
  /** The PC whose Harbor owns the chat; "" is this one. */
  home: string;
  /** The chat's id on its home PC (0 for this PC's own chats). */
  homeId: number;
  /** A subagent its lead retired: off the team for good, its transcript kept. */
  retired: boolean;
}

export function foreign(c: Pick<Chat, "home">): boolean {
  return c.home !== "";
}

export function blankChat(over: Partial<Chat> = {}): Chat {
  return {
    id: 0,
    repoId: null,
    title: "",
    sessionId: "",
    started: false,
    account: "claude",
    model: "",
    effort: "",
    access: "full",
    settled: false,
    updated: 0,
    role: "chat",
    parent: null,
    name: "",
    device: "",
    gid: "",
    home: "",
    homeId: 0,
    retired: false,
    ...over,
  };
}

type Row = Record<string, string | number | null>;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

function migrate(db: Database): void {
  const v = num((db.query("PRAGMA user_version").get() as Row).user_version);
  if (v < 1) {
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE chats_v1(
        id INTEGER PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        title TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
        account TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '',
        access TEXT NOT NULL DEFAULT 'full', settled INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      INSERT INTO chats_v1(id, repo_id, title, session_id, started, model, access, updated)
        SELECT id, repo_id, title, session_id, started,
               CASE model WHEN 'opus' THEN 'claude-opus-5-5' WHEN 'sonnet' THEN 'claude-sonnet-5-5'
                          WHEN 'haiku' THEN 'claude-haiku-5-5' ELSE model END,
               CASE permission_mode WHEN 'acceptEdits' THEN 'edits' WHEN 'plan' THEN 'plan' ELSE 'full' END,
               updated FROM chats;
      DROP TABLE chats;
      ALTER TABLE chats_v1 RENAME TO chats;
      PRAGMA user_version=1;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
  if (v < 2) {
    db.exec(`BEGIN;
      ALTER TABLE repos ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE repos ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chats ADD COLUMN role TEXT NOT NULL DEFAULT 'chat';
      ALTER TABLE chats ADD COLUMN parent INTEGER;
      ALTER TABLE chats ADD COLUMN name TEXT NOT NULL DEFAULT '';
      CREATE TABLE timers(id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE webhooks(id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      UPDATE repos SET sort = id;
      PRAGMA user_version=2;
      COMMIT;`);
  }
  if (v < 3) {
    db.exec(`CREATE TABLE IF NOT EXISTS procs(id INTEGER PRIMARY KEY, lead INTEGER NOT NULL, repo_id INTEGER,
        owner INTEGER NOT NULL, name TEXT NOT NULL, cmd TEXT NOT NULL, cwd TEXT NOT NULL,
        pid INTEGER NOT NULL, start_ticks INTEGER NOT NULL, log TEXT NOT NULL, url TEXT);
      PRAGMA user_version=3;`);
  }
  if (v < 4) {
    db.exec(`BEGIN;
      ALTER TABLE timers ADD COLUMN kind TEXT NOT NULL DEFAULT 'wake';
      PRAGMA user_version=4;
      COMMIT;`);
  }
  if (v < 5) {
    db.exec(`BEGIN;
      ALTER TABLE chats ADD COLUMN device TEXT NOT NULL DEFAULT '';
      PRAGMA user_version=5;
      COMMIT;`);
  }
  if (v < 6) {
    db.exec(`BEGIN;
      ALTER TABLE chats ADD COLUMN gid TEXT NOT NULL DEFAULT '';
      ALTER TABLE chats ADD COLUMN home TEXT NOT NULL DEFAULT '';
      ALTER TABLE chats ADD COLUMN home_id INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version=6;
      COMMIT;`);
    const ids = db.query("SELECT id FROM chats WHERE gid=''").all() as Row[];
    const set = db.prepare("UPDATE chats SET gid=?2 WHERE id=?1");
    for (const r of ids) set.run(num(r.id), newUuid());
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS chats_gid ON chats(gid);");
  }
  if (v < 7) {
    db.exec(`BEGIN;
      UPDATE repos SET settled=0;
      PRAGMA user_version=7;
      COMMIT;`);
  }
  if (v < 8) {
    const cols = (db.query("SELECT name FROM pragma_table_info('repos')").all() as Row[]).map((r) => text(r.name));
    for (const col of ["remote", "local"]) {
      if (!cols.includes(col)) db.exec(`ALTER TABLE repos ADD COLUMN ${col} TEXT NOT NULL DEFAULT '';`);
    }
    db.exec("PRAGMA user_version=8;");
  }
  const has = (table: string, col: string): boolean =>
    num((db.query(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name='${col}'`).get() as Row).n) > 0;
  if (!has("repos", "main_chat")) db.exec("ALTER TABLE repos ADD COLUMN main_chat INTEGER NOT NULL DEFAULT 0;");
  if (!has("chats", "retired")) db.exec("ALTER TABLE chats ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;");
}

function chatFrom(r: Row): Chat {
  return {
    id: num(r.id),
    repoId: r.repo_id === null ? null : num(r.repo_id),
    title: text(r.title),
    sessionId: text(r.session_id),
    started: num(r.started) !== 0,
    account: text(r.account),
    model: text(r.model),
    effort: text(r.effort),
    access: parseAccess(text(r.access)),
    settled: num(r.settled) !== 0,
    updated: num(r.updated),
    role: parseRole(text(r.role)),
    parent: r.parent === null ? null : num(r.parent),
    name: text(r.name),
    device: text(r.device),
    gid: text(r.gid),
    home: text(r.home),
    homeId: num(r.home_id),
    retired: num(r.retired) !== 0,
  };
}

const CHAT_COLS = `id, repo_id, title, session_id, started, account, model, effort, access, settled, updated, role, parent, name, device,
  gid, home, home_id, retired`;

const temp = new Set<string>();
process.on("exit", () => {
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

export class Store {
  readonly db: Database;
  /** Per chat, a hash of each item as it is saved (by seq): a save writes only what changed. */
  private saved = new Map<number, bigint[]>();
  /** Per chat, its saved transcript's length and digest as peers compare them; dropped when it's written. */
  private sums = new Map<number, { count: number; digest: bigint }>();

  private constructor(db: Database) {
    this.db = db;
  }

  /** The database in Harbor's data folder, owner-only like the Rust app makes it. */
  static open(dir: string = dataDir()): Store {
    privateDir(dir);
    const path = join(dir, "harbor.db");
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    const store = Store.openAt(path);
    for (const f of readdirSync(dir)) {
      if (f.startsWith("harbor.db")) {
        try {
          chmodSync(join(dir, f), 0o600);
        } catch {
          // a file that went away
        }
      }
    }
    return store;
  }

  static openAt(path: string): Store {
    const db = new Database(path, { create: true });
    db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS repos(
        id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(
        id INTEGER PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        title TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL, permission_mode TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items(
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(chat_id, seq));
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    migrate(db);
    return new Store(db);
  }

    static openTemp(): Store {
    const dir = join(process.env.TMPDIR || "/tmp", `harbor-test-${newUuid()}`);
    privateDir(dir);
    temp.add(dir);
    return Store.openAt(join(dir, "harbor.db"));
  }

  close(): void {
    this.db.close();
  }

  repos(): Repo[] {
    const rows = this.db.query("SELECT id, path, name, sort, remote, local FROM repos ORDER BY sort, name COLLATE NOCASE").all() as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      path: text(r.path),
      name: text(r.name),
      sort: num(r.sort),
      remote: text(r.remote),
      local: text(r.local) === "" ? null : text(r.local),
    }));
  }

  addRepo(path: string): number {
    const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
    this.db
      .query("INSERT OR IGNORE INTO repos(path, name, sort) VALUES(?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM repos))")
      .run(path, name);
    return num((this.db.query("SELECT id FROM repos WHERE path=?1").get(path) as Row).id);
  }

  removeRepo(id: number): void {
    this.db.query("DELETE FROM repos WHERE id=?1").run(id);
    this.saved.clear();
  }

  setRepoRemote(id: number, remote: string): void {
    this.db.query("UPDATE repos SET remote=?2 WHERE id=?1").run(id, remote);
  }

  /** This PC's folder for a shared project (null: back to its own `path`). */
  setRepoLocal(id: number, local: string | null): void {
    this.db.query("UPDATE repos SET local=?2 WHERE id=?1").run(id, local ?? "");
  }

    mainChats(): Map<number, number> {
    const rows = this.db.query("SELECT id, main_chat FROM repos WHERE main_chat != 0").all() as Row[];
    return new Map(rows.map((r) => [num(r.id), num(r.main_chat)]));
  }

  setMainChat(repo: number, chat: number | null): void {
    this.db.query("UPDATE repos SET main_chat=?2 WHERE id=?1").run(repo, chat ?? 0);
  }

  /** Settled projects (`repos.settled`, unused since the Rust schema 7): project id → when, in seconds. */
  settledProjects(): Map<number, number> {
    const rows = this.db.query("SELECT id, settled FROM repos WHERE settled != 0").all() as Row[];
    return new Map(rows.map((r) => [num(r.id), num(r.settled)]));
  }

  /**
   * Settles project `repo` and its own leads that aren't settled yet (they're remembered), or
   * unsettles it and brings those leads back. Copies of other PCs' chats aren't touched: the
   * sidebar shows every chat of a settled project under Settled.
   */
  settleProject(repo: number, on: boolean, at: number = now()): void {
    const key = `project_settled:${repo}`;
    if (on) {
      const all = this.chats().filter((c) => c.repoId === repo);
      const leads = all.filter((c) => c.role === "lead" && !c.settled && !foreign(c));
      // Chats saved first (no wake: the project isn't settled yet); then the time, never before their last activity.
      for (const c of leads) this.saveChat({ ...c, settled: true });
      this.db.query("UPDATE repos SET settled=?2 WHERE id=?1").run(repo, Math.max(at, 1, ...all.map((c) => c.updated)));
      this.set(key, JSON.stringify(leads.map((c) => c.id)));
      return;
    }
    this.db.query("UPDATE repos SET settled=0 WHERE id=?1").run(repo);
    for (const id of this.settledWith(repo)) {
      const c = this.chat(id);
      if (c && c.repoId === repo && c.settled) this.saveChat({ ...c, settled: false });
    }
    this.set(key, "");
  }

  /** The chats settling project `repo` settled. */
  private settledWith(repo: number): number[] {
    try {
      const v: unknown = JSON.parse(this.get(`project_settled:${repo}`) || "[]");
      return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
    } catch {
      return [];
    }
  }

  /**
   * New activity in a settled project unsettles it: a new chat of this PC, or a chat of it saved
   * with a newer time than the settle. The active chat comes back with it when the settle had
   * settled it (`c` is changed in place, so the caller's copy agrees); the others stay settled.
   */
  private wake(c: Chat, created: boolean): void {
    if (c.repoId === null) return;
    const at = num((this.db.query("SELECT settled FROM repos WHERE id=?1").get(c.repoId) as Row | null)?.settled ?? 0);
    if (at === 0 || (created ? foreign(c) : c.updated <= at)) return;
    const back = this.settledWith(c.repoId).includes(c.id);
    this.db.query("UPDATE repos SET settled=0 WHERE id=?1").run(c.repoId);
    this.set(`project_settled:${c.repoId}`, "");
    if (back && c.settled) c.settled = false;
  }

  saveRepoMeta(r: Pick<Repo, "id" | "sort">): void {
    this.db.query("UPDATE repos SET sort=?2 WHERE id=?1").run(r.id, r.sort);
  }

  private timersOf(kind: string): Timer[] {
    const rows = this.db.query("SELECT id, chat_id, at, reason FROM timers WHERE kind=?1 ORDER BY at").all(kind) as Row[];
    return rows.map((r) => ({ id: num(r.id), chatId: num(r.chat_id), at: num(r.at), reason: text(r.reason) }));
  }

  timers(): Timer[] {
    return this.timersOf("wake");
  }

  addTimer(chatId: number, at: number, reason: string): number {
    return Number(this.db.query("INSERT INTO timers(chat_id, at, reason) VALUES(?1, ?2, ?3)").run(chatId, at, reason).lastInsertRowid);
  }

  /** Continuations after a usage limit; `reason` holds their details (JSON). */
  limitTimers(): Timer[] {
    return this.timersOf("limit");
  }

  addLimitTimer(chatId: number, at: number, reason: string): number {
    return Number(
      this.db.query("INSERT INTO timers(chat_id, at, reason, kind) VALUES(?1, ?2, ?3, 'limit')").run(chatId, at, reason).lastInsertRowid,
    );
  }

  deleteTimer(id: number): void {
    this.db.query("DELETE FROM timers WHERE id=?1").run(id);
  }

  procs(): ProcRow[] {
    const rows = this.db.query("SELECT id, lead, repo_id, owner, name, cmd, cwd, pid, start_ticks, log, url FROM procs").all() as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      lead: num(r.lead),
      repoId: r.repo_id === null ? null : num(r.repo_id),
      owner: num(r.owner),
      name: text(r.name),
      cmd: text(r.cmd),
      cwd: text(r.cwd),
      pid: num(r.pid),
      startTicks: num(r.start_ticks),
      log: text(r.log),
      url: r.url === null ? null : text(r.url),
    }));
  }

  addProc(p: Omit<ProcRow, "id">): number {
    return Number(
      this.db
        .query("INSERT INTO procs(lead, repo_id, owner, name, cmd, cwd, pid, start_ticks, log, url) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
        .run(p.lead, p.repoId, p.owner, p.name, p.cmd, p.cwd, p.pid, p.startTicks, p.log, p.url).lastInsertRowid,
    );
  }

  setProcUrl(id: number, url: string): void {
    this.db.query("UPDATE procs SET url=?2 WHERE id=?1").run(id, url);
  }

  deleteProc(id: number): void {
    this.db.query("DELETE FROM procs WHERE id=?1").run(id);
  }

  webhooks(): Webhook[] {
    const rows = this.db.query("SELECT id, repo_id, name, token, description, hits, last_hit FROM webhooks ORDER BY created").all() as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      repoId: num(r.repo_id),
      name: text(r.name),
      token: text(r.token),
      description: text(r.description),
      hits: num(r.hits),
      lastHit: num(r.last_hit),
    }));
  }

  addWebhook(repoId: number, name: string, token: string, description: string): void {
    this.db
      .query("INSERT INTO webhooks(repo_id, name, token, description, created) VALUES(?1, ?2, ?3, ?4, ?5)")
      .run(repoId, name, token, description, now());
  }

  hitWebhook(id: number): void {
    this.db.query("UPDATE webhooks SET hits = hits + 1, last_hit = ?2 WHERE id=?1").run(id, now());
  }

  deleteWebhook(id: number): void {
    this.db.query("DELETE FROM webhooks WHERE id=?1").run(id);
  }

  chats(): Chat[] {
    return (this.db.query(`SELECT ${CHAT_COLS} FROM chats ORDER BY updated DESC`).all() as Row[]).map(chatFrom);
  }

  /** A lead's sub-agents, without reading the other chats. */
  subs(parent: number): Chat[] {
    return (this.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE parent=?1 ORDER BY updated DESC`).all(parent) as Row[]).map(chatFrom);
  }

  /** One chat, without reading the others. */
  chat(id: number): Chat | undefined {
    const r = this.db.query(`SELECT ${CHAT_COLS} FROM chats WHERE id=?1`).get(id) as Row | null;
    return r ? chatFrom(r) : undefined;
  }

    createChat(chat: Chat): Chat {
    const c = { ...chat };
    // A copy of another PC's chat keeps its time; a new one starts now.
    if (!foreign(c)) c.updated = now();
    if (c.gid === "") c.gid = newUuid();
    const r = this.db
      .query(
        `INSERT INTO chats(repo_id, title, session_id, started, account, model, effort, access, settled, updated, role, parent, name, device,
           gid, home, home_id, retired)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      )
      .run(c.repoId, c.title, c.sessionId, +c.started, c.account, c.model, c.effort, c.access, +c.settled, c.updated, c.role, c.parent, c.name, c.device, c.gid, c.home, c.homeId, +c.retired);
    c.id = Number(r.lastInsertRowid);
    this.wake(c, true);
    return c;
  }

  saveChat(c: Chat): void {
    this.wake(c, false);
    this.db
      .query(
        `UPDATE chats SET repo_id=?2, title=?3, session_id=?4, started=?5, account=?6, model=?7, effort=?8,
           access=?9, settled=?10, updated=?11, device=?12, role=?13, parent=?14, name=?15, retired=?16 WHERE id=?1`,
      )
      .run(c.id, c.repoId, c.title, c.sessionId, +c.started, c.account, c.model, c.effort, c.access, +c.settled, c.updated, c.device, c.role, c.parent, c.name, +c.retired);
  }

  /** Which PC owns a chat ("" and 0: this one), after it moved between PCs. */
  setHome(id: number, home: string, homeId: number): void {
    this.db.query("UPDATE chats SET home=?2, home_id=?3 WHERE id=?1").run(id, home, homeId);
  }

  deleteChat(id: number): void {
    this.db.query("DELETE FROM chats WHERE id=?1").run(id);
    // Nor be a project's main chat: the next one is started fresh.
    this.db.query("UPDATE repos SET main_chat=0 WHERE main_chat=?1").run(id);
    // Ids can be reused: a new chat with this one must not look saved.
    this.saved.delete(id);
    this.sums.delete(id);
  }

  items(chatId: number): Item[] {
    const rows = this.db.query("SELECT body FROM items WHERE chat_id=?1 ORDER BY seq").all(chatId) as Row[];
    const out: Item[] = [];
    for (const r of rows) {
      const it = parseItem(text(r.body));
      if (it) out.push(it);
    }
    return out;
  }

  /** A saved transcript's length and digest (item.ts `digest`), read once and kept until it's written again. */
  summary(chatId: number): { count: number; digest: bigint } {
    let v = this.sums.get(chatId);
    if (!v) {
      const items = this.items(chatId);
      v = { count: items.length, digest: digest(items) };
      this.sums.set(chatId, v);
    }
    return v;
  }

  /** Saves a chat's transcript: only items new or changed since the last save are written, and items past its end are deleted. */
  saveItems(chatId: number, items: readonly Item[]): void {
    const hashes = items.map(itemHash);
    const saved = this.saved.get(chatId) ?? this.savedHashes(chatId);
    this.saved.delete(chatId);
    if (saved.length === hashes.length && saved.every((h, i) => h === hashes[i])) {
      this.saved.set(chatId, saved);
      return;
    }
    // On any failure the cache stays empty for the chat, so the next save compares with the database.
    this.sums.delete(chatId);
    const write = this.db.transaction(() => {
      const put = this.db.query("INSERT OR REPLACE INTO items(chat_id, seq, body) VALUES(?1, ?2, ?3)");
      items.forEach((it, i) => {
        if (saved[i] !== hashes[i]) put.run(chatId, i, itemJson(it));
      });
      if (saved.length > items.length) this.db.query("DELETE FROM items WHERE chat_id=?1 AND seq>=?2").run(chatId, items.length);
    });
    try {
      write();
      this.saved.set(chatId, hashes);
      this.sums.set(chatId, { count: items.length, digest: digestOf(hashes) });
    } catch (e) {
      console.error(`harbor: can't save the transcript of chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The hashes of a chat's items as the database has them, by seq. */
  private savedHashes(chatId: number): bigint[] {
    const v: bigint[] = [];
    const rows = this.db.query("SELECT seq, body FROM items WHERE chat_id=?1 ORDER BY seq").all(chatId) as Row[];
    for (const r of rows) {
      const seq = num(r.seq);
      if (seq < 0) continue;
      // A gap never matches an item, so the item there gets written.
      while (v.length < seq) v.push(0n);
      v.push(fnvText(text(r.body)));
    }
    return v;
  }

  get(k: string): string | null {
    const r = this.db.query("SELECT v FROM kv WHERE k=?1").get(k) as Row | null;
    return r ? text(r.v) : null;
  }

  set(k: string, v: string): void {
    this.db.query("INSERT OR REPLACE INTO kv(k, v) VALUES(?1, ?2)").run(k, v);
    // A setting that follows the account goes to its other devices.
    settingChanged(k);
  }

  /** Every key starting with `prefix`, with its value (non-empty ones only). */
  withPrefix(prefix: string): [string, string][] {
    const rows = this.db.query("SELECT k, v FROM kv WHERE substr(k, 1, length(?1)) = ?1 AND v != ''").all(prefix) as Row[];
    return rows.map((r) => [text(r.k), text(r.v)]);
  }

  /** `set` for a setting that came from the account: not sent back. */
  setQuiet(k: string, v: string): void {
    this.db.query("INSERT OR REPLACE INTO kv(k, v) VALUES(?1, ?2)").run(k, v);
  }

  /** Every chat's turn results, (chat id, item). Only result rows are parsed. */
  results(): [number, Item][] {
    const rows = this.db.query(`SELECT chat_id, body FROM items WHERE body LIKE '{"kind":"result"%'`).all() as Row[];
    const out: [number, Item][] = [];
    for (const r of rows) {
      const it = parseItem(text(r.body));
      if (it) out.push([num(r.chat_id), it]);
    }
    return out;
  }
}

/** Every chat's turn results from the database file, read on a connection of its own. */
export function results(dir: string = dataDir()): [number, Item][] {
  try {
    const db = new Database(join(dir, "harbor.db"), { readonly: true });
    try {
      const rows = db.query(`SELECT chat_id, body FROM items WHERE body LIKE '{"kind":"result"%'`).all() as Row[];
      const out: [number, Item][] = [];
      for (const r of rows) {
        const it = parseItem(text(r.body));
        if (it) out.push([num(r.chat_id), it]);
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
