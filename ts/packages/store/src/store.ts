import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Item, digest, digestOf, fnvText, itemHash, itemJson, parseItem } from "./item.ts";
import { dataDir, newUuid, now, privateDir } from "./paths.ts";
import { changed as settingChanged } from "./settingsync.ts";
import { SHARED, changed as sharedChanged } from "./wssettings.ts";

const SHARED_KEYS: ReadonlySet<string> = new Set(SHARED);

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

/** Where Move to workspace… put chats and projects (`Store.placement`): only those it moved. */
export interface Placement {
  /** A chat's own workspace. */
  chats: ReadonlyMap<number, string>;
  /** A copy's project's workspace, as its home PC says it. */
  carried: ReadonlyMap<number, string>;
  /** A project's workspace. */
  repos: ReadonlyMap<number, string>;
  /** Share with workspace…: the extra workspaces each shows in too (only those shared; left out: none). */
  shared?: Shares;
  /**
   * The other PCs of this PC's owner, by mesh id: copies of their chats follow their project's
   * move and shares (`carried`) as this PC's own chats do. Another person's chats don't: sharing
   * or moving a project takes the project there, not everyone's chats in it. Left out: none.
   */
  mates?: ReadonlySet<string>;
  /**
   * The chats that are a project's main chat here (`repos.main_chat`). A main chat belongs to its
   * project, not just to its owner: a copy of one follows its project's move and shares whoever's
   * it is, so a project shared with you opens the same main chat as on its owner's PC. Left out: none.
   */
  mains?: ReadonlySet<number>;
}

/** Share with workspace…: workspace ids a chat or project shows in besides its own, the same three ways as `Placement`. */
export interface Shares {
  chats: ReadonlyMap<number, readonly string[]>;
  carried: ReadonlyMap<number, readonly string[]>;
  repos: ReadonlyMap<number, readonly string[]>;
}

export const NO_PLACEMENT: Placement = { chats: new Map(), carried: new Map(), repos: new Map() };
const NO_MATES: ReadonlySet<string> = new Set();

/** A share list as kept in a column: ids joined by commas, each once, none empty. */
export function shareList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")) : typeof v === "string" ? v.split(",") : [];
  return [...new Set(raw.map((x) => x.trim()).filter((x) => x !== ""))];
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
  // Move to workspace: a chat's own, the project's a copy came with (its home PC's), a project's.
  if (!has("chats", "workspace")) db.exec("ALTER TABLE chats ADD COLUMN workspace TEXT NOT NULL DEFAULT '';");
  if (!has("chats", "project_workspace")) db.exec("ALTER TABLE chats ADD COLUMN project_workspace TEXT NOT NULL DEFAULT '';");
  if (!has("repos", "workspace")) db.exec("ALTER TABLE repos ADD COLUMN workspace TEXT NOT NULL DEFAULT '';");
  // Share with workspace: the same three, each a list of workspace ids joined by commas.
  if (!has("chats", "shared")) db.exec("ALTER TABLE chats ADD COLUMN shared TEXT NOT NULL DEFAULT '';");
  if (!has("chats", "project_shared")) db.exec("ALTER TABLE chats ADD COLUMN project_shared TEXT NOT NULL DEFAULT '';");
  if (!has("repos", "shared")) db.exec("ALTER TABLE repos ADD COLUMN shared TEXT NOT NULL DEFAULT '';");
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
  /** Told after a chat's `settled` flag changed (its id), or a project's (null). */
  private settledHooks = new Set<(chat: number | null) => void>();

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
    // WAL with synchronous=NORMAL syncs at checkpoints, not on every commit: a power cut can lose
    // the last commits but never corrupts the database. temp_store=MEMORY: statement journals
    // (INSERT OR REPLACE) and sorts stay off /tmp, so a full /tmp can't fail writes here.
    db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
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

  /**
   * Folds project `from` into `into`, the same project listed twice: `from`'s chats, webhooks and
   * processes go to `into`, which keeps its own path, folder and place in the order, and takes
   * what it lacks of `from`'s main chat and remote (and, with `placement`, of its workspace and
   * shares); then `from` goes.
   */
  foldRepo(from: number, into: number, placement: boolean): void {
    if (from === into) return;
    this.db.transaction(() => {
      const f = this.db.query("SELECT main_chat, workspace, shared, remote, settled FROM repos WHERE id=?1").get(from) as Row | null;
      if (!f) return;
      for (const t of ["chats", "webhooks", "procs"]) this.db.query(`UPDATE ${t} SET repo_id=?2 WHERE repo_id=?1`).run(from, into);
      this.db
        .query(
          `UPDATE repos SET
             main_chat = CASE WHEN main_chat = 0 THEN ?2 ELSE main_chat END,
             workspace = CASE WHEN workspace = '' AND ?6 THEN ?3 ELSE workspace END,
             shared = CASE WHEN shared = '' AND ?6 THEN ?4 ELSE shared END,
             remote = CASE WHEN remote = '' THEN ?5 ELSE remote END,
             settled = MIN(settled, ?7)
           WHERE id=?1`,
        )
        .run(into, num(f.main_chat), text(f.workspace), text(f.shared), text(f.remote), placement ? 1 : 0, num(f.settled));
      this.db.query("DELETE FROM repos WHERE id=?1").run(from);
      for (const k of [`project_pc:${from}`, `project_moved:${from}`, `project_settled:${from}`]) this.del(k);
    })();
    this.saved.clear();
  }

  removeRepo(id: number): void {
    this.db.query("DELETE FROM repos WHERE id=?1").run(id);
    this.saved.clear();
  }

  setRepoRemote(id: number, remote: string): void {
    this.db.query("UPDATE repos SET remote=?2 WHERE id=?1").run(id, remote);
  }

  /** The project's name in the sidebar (its folder's name when added). */
  setRepoName(id: number, name: string): void {
    this.db.query("UPDATE repos SET name=?2 WHERE id=?1").run(id, name);
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

  /**
   * The workspaces chats and projects were moved to (Move to workspace…), only those set: `chats`
   * a chat's own, `carried` the project's a copy came with from its home PC, `repos` a project's.
   */
  placement(): Placement {
    const chats = new Map<number, string>();
    const carried = new Map<number, string>();
    const shared = { chats: new Map<number, string[]>(), carried: new Map<number, string[]>(), repos: new Map<number, string[]>() };
    const list = (m: Map<number, string[]>, id: number, v: unknown) => {
      const l = shareList(v);
      if (l.length > 0) m.set(id, l);
    };
    for (const r of this.db.query("SELECT id, workspace, project_workspace, shared, project_shared FROM chats WHERE workspace != '' OR project_workspace != '' OR shared != '' OR project_shared != ''").all() as Row[]) {
      if (text(r.workspace) !== "") chats.set(num(r.id), text(r.workspace));
      if (text(r.project_workspace) !== "") carried.set(num(r.id), text(r.project_workspace));
      list(shared.chats, num(r.id), r.shared);
      list(shared.carried, num(r.id), r.project_shared);
    }
    const repos = new Map<number, string>();
    for (const r of this.db.query("SELECT id, workspace, shared FROM repos WHERE workspace != '' OR shared != ''").all() as Row[]) {
      if (text(r.workspace) !== "") repos.set(num(r.id), text(r.workspace));
      list(shared.repos, num(r.id), r.shared);
    }
    const mains = new Set((this.db.query("SELECT main_chat FROM repos WHERE main_chat != 0").all() as Row[]).map((r) => num(r.main_chat)));
    return { chats, carried, repos, shared, mates: this.mates(), mains };
  }

  /** The other PCs of this PC's owner (`Placement.mates`); the hub sets it from the account's directory. */
  mates: () => ReadonlySet<string> = () => NO_MATES;

  /** Chat `id`'s own shares (Share with workspace…): the workspaces it shows in besides its own. */
  setChatShares(id: number, ws: readonly string[]): void {
    this.db.query("UPDATE chats SET shared=?2 WHERE id=?1").run(id, shareList(ws).join(","));
  }

  /** A copy's project's shares, as its home PC says them. */
  setCarriedShares(id: number, ws: readonly string[]): void {
    this.db.query("UPDATE chats SET project_shared=?2 WHERE id=?1").run(id, shareList(ws).join(","));
  }

  /** Project `id`'s shares. */
  setRepoShares(id: number, ws: readonly string[]): void {
    this.db.query("UPDATE repos SET shared=?2 WHERE id=?1").run(id, shareList(ws).join(","));
  }

  /** Chat `id`'s own workspace ("": none, its project's or its PC's applies). */
  setChatWorkspace(id: number, ws: string): void {
    this.db.query("UPDATE chats SET workspace=?2 WHERE id=?1").run(id, ws);
  }

  /** A copy's project's workspace, as its home PC says it. */
  setCarriedWorkspace(id: number, ws: string): void {
    this.db.query("UPDATE chats SET project_workspace=?2 WHERE id=?1").run(id, ws);
  }

  /** Project `id`'s workspace ("": its PC's). */
  setRepoWorkspace(id: number, ws: string): void {
    this.db.query("UPDATE repos SET workspace=?2 WHERE id=?1").run(id, ws);
  }

  /** The PC of the mesh project `repo`'s copies last came from ("" none): where its folder is when it isn't on this PC. */
  projectPc(repo: number): string {
    return this.get(`project_pc:${repo}`) ?? "";
  }

  setProjectPc(repo: number, pc: string): void {
    if (this.projectPc(repo) !== pc) this.set(`project_pc:${repo}`, pc);
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
      this.settledChanged(null);
      return;
    }
    this.db.query("UPDATE repos SET settled=0 WHERE id=?1").run(repo);
    for (const id of this.settledWith(repo)) {
      const c = this.chat(id);
      if (c && c.repoId === repo && c.settled) this.saveChat({ ...c, settled: false });
    }
    this.set(key, "");
    this.settledChanged(null);
  }

  /**
   * `f` hears every change of a chat's `settled` flag (the chat's id) and of a project's (null),
   * whoever made it: a chat's own settle, a project's settle or unsettle, new activity waking a
   * settled project. The hub announces them, so other PCs and phones see them at once.
   * Returns the way to stop listening.
   */
  onSettled(f: (chat: number | null) => void): () => void {
    this.settledHooks.add(f);
    return () => this.settledHooks.delete(f);
  }

  private settledChanged(chat: number | null): void {
    for (const f of this.settledHooks) {
      try {
        f(chat);
      } catch {
        // A listener's failure doesn't undo the save.
      }
    }
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
  private wake(c: Chat, created: boolean): boolean {
    if (c.repoId === null) return false;
    const at = num((this.db.query("SELECT settled FROM repos WHERE id=?1").get(c.repoId) as Row | null)?.settled ?? 0);
    if (at === 0 || (created ? foreign(c) : c.updated <= at)) return false;
    const back = this.settledWith(c.repoId).includes(c.id);
    this.db.query("UPDATE repos SET settled=0 WHERE id=?1").run(c.repoId);
    this.set(`project_settled:${c.repoId}`, "");
    if (back && c.settled) c.settled = false;
    return true;
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

  /** The chat with this gid's id, without reading the others; null: none. */
  chatIdByGid(gid: string): number | null {
    const r = this.db.query("SELECT id FROM chats WHERE gid=?1").get(gid) as { id: number } | null;
    return r ? r.id : null;
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
    if (this.wake(c, true)) this.settledChanged(null);
    return c;
  }

  saveChat(c: Chat): void {
    const woke = this.wake(c, false);
    const was = this.db.query("SELECT settled FROM chats WHERE id=?1").get(c.id) as Row | null;
    this.db
      .query(
        `UPDATE chats SET repo_id=?2, title=?3, session_id=?4, started=?5, account=?6, model=?7, effort=?8,
           access=?9, settled=?10, updated=?11, device=?12, role=?13, parent=?14, name=?15, retired=?16 WHERE id=?1`,
      )
      .run(c.id, c.repoId, c.title, c.sessionId, +c.started, c.account, c.model, c.effort, c.access, +c.settled, c.updated, c.device, c.role, c.parent, c.name, +c.retired);
    if (woke) this.settledChanged(null);
    if (was !== null && (num(was.settled) !== 0) !== c.settled) this.settledChanged(c.id);
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

  /** A chat's first saved item (null: none yet). */
  firstItem(chatId: number): Item | null {
    const r = this.db.query("SELECT body FROM items WHERE chat_id=?1 ORDER BY seq LIMIT 1").get(chatId) as Row | null;
    return r ? parseItem(text(r.body)) : null;
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
    const before = SHARED_KEYS.has(k) ? this.get(k) : null;
    this.db.query("INSERT OR REPLACE INTO kv(k, v) VALUES(?1, ?2)").run(k, v);
    // A setting that follows the account goes to its other devices; one of the workspace to its PCs.
    settingChanged(k);
    if (SHARED_KEYS.has(k)) sharedChanged(this, k, before, v);
  }

  del(k: string): void {
    this.db.query("DELETE FROM kv WHERE k=?1").run(k);
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

  /** Every chat's notices with this icon, in order: (chat id, detail). Only those rows are read. */
  noticeDetails(icon: string): [number, string][] {
    const prefix = `{"kind":"notice","icon":${JSON.stringify(icon)}`;
    const rows = this.db.query(`SELECT chat_id, body FROM items WHERE substr(body, 1, ?1) = ?2 ORDER BY chat_id, seq`).all(prefix.length, prefix) as Row[];
    const out: [number, string][] = [];
    for (const r of rows) {
      const it = parseItem(text(r.body));
      if (it?.kind === "notice") out.push([num(r.chat_id), it.detail]);
    }
    return out;
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
