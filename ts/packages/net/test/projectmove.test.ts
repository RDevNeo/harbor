import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { blankChat, repoDir, Store, type Chat, type Item, type Mention, type Repo } from "@harbor/store";
import type { Call } from "../src/api.ts";
import { pieces, scanFolder, Unpacker, plainRel, type Entry, wireTarget } from "../src/foldercopy.ts";
import { MovePc, type MoveEngine, type MovePcAccount } from "../src/movepcrun.ts";
import type { MoveSendDeps } from "../src/movepc.ts";
import { checkProject, planDest, ProjectReceiver, parseCheck, type ProjectTargetApp } from "../src/projectmove.ts";
import { manifestOf, movedProject, ProjectMove } from "../src/projectmoverun.ts";
import { newPeer, Shared, type Dest } from "../src/shared.ts";
import { MemKv } from "../src/kv.ts";
import { text, user } from "./fixture.ts";
import { expectPerm } from "../../../test/perm.ts";

// A text file as written, line ends as LF: Git for Windows checks text out with CRLF (its core.autocrlf).
const textOf = (p: string): string => readFileSync(p, "utf8").replaceAll("\r\n", "\n");

// Paths as this system writes them ("\\" on Windows).
const n = normalize;
// Windows runs git and starts processes several times slower: its tests get the time (setDefaultTimeout holds per file).
if (process.platform === "win32") setDefaultTimeout(30_000);

const SID = "0b7c1a7e-1111-4222-8333-944455556666";
const SUB_SID = "0b7c1a7e-9999-4222-8333-944455556666";
const SET_SID = "0b7c1a7e-5555-4222-8333-944455556666";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `projmove-${tag}-`));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", dir, ...args], { encoding: "utf8" }).trim();
}

class FakeEngine implements MoveEngine {
  readonly pending = new Map<number, string[]>();
  readonly transcripts = new Map<number, { items: Item[] }>();
  readonly running_ = new Set<number>();
  readonly log: string[] = [];
  constructor(readonly store: Store) {}
  repo(id: number | null): Repo | undefined {
    return id === null ? undefined : this.store.repos().find((r) => r.id === id);
  }
  running(id: number): boolean {
    return this.running_.has(id);
  }
  worktreeOf(c: Chat): string | null {
    const p = this.store.get(`worktree:${c.role === "sub" ? c.parent : c.id}`);
    return p === null || p === "" ? null : p;
  }
  cwdOf(repo: number | null): string {
    const r = this.repo(repo);
    return r ? repoDir(r) : "/nowhere";
  }
  chatCwd(c: Chat): string {
    return this.worktreeOf(c) ?? this.cwdOf(c.repoId);
  }
  transcript(id: number): { items: Item[] } {
    let t = this.transcripts.get(id);
    if (!t) {
      t = { items: this.store.items(id) };
      this.transcripts.set(id, t);
    }
    return t;
  }
  reload(): void {}
  changed(_id: number | null): void {}
  notice(id: number, icon: string, said: string, detail = ""): void {
    this.transcript(id).items.push({ kind: "notice", icon, text: said, detail });
    this.store.saveItems(id, this.transcript(id).items);
  }
  startTurn(id: number, prompt: string): void {
    this.log.push(`turn ${id}: ${prompt}`);
  }
  send(id: number, said: string, _opts: { files?: string[]; mentions?: Mention[] }): void {
    this.log.push(`send ${id}: ${said}`);
  }
}

interface Pc {
  root: string;
  home: string;
  cfg: string;
  uploads: string;
  store: Store;
  engine: FakeEngine;
  mesh: Shared;
  move: MovePc;
  project: ProjectMove;
  receiver: ProjectReceiver;
}

function pc(name: string): Pc {
  const root = tmp(name);
  const [home, cfg, uploads] = ["home", "cfg", "uploads"].map((d) => join(root, d)) as [string, string, string];
  for (const d of [home, cfg, uploads]) mkdirSync(d, { recursive: true });
  const store = Store.openTemp();
  const engine = new FakeEngine(store);
  const mesh = new Shared();
  mesh.me = { id: `pc:${name}`, name };
  mesh.on = true;
  const accounts: MovePcAccount[] = [{ id: "claude", claude: true, email: "a@example.com", short: "Claude · AB", configDir: cfg, usable: true, usage: [0, 0] }];
  const move = new MovePc({
    store,
    engine,
    mesh,
    forward: async () => ({ status: 200, body: { ok: true } }),
    accounts: () => accounts,
    home,
    uploadsDir: uploads,
    worktreeRoot: join(root, "worktrees"),
    overlays: () => [],
    removeWorktree: async (repo, d) => {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", d]);
    },
    reindex: () => undefined,
  });
  const scratch = join(root, "scratch");
  const project = new ProjectMove({ store, movepc: move, mesh, forward: async () => ({ status: 200, body: {} }), home, scratch, running: (id) => engine.running(id), icon: () => null, touch: () => undefined, sleep: () => Bun.sleep(2), pieceBytes: 64_000 });
  const app: ProjectTargetApp = {
    meName: () => name,
    home,
    kv: store,
    scratch,
    repos: () => store.repos().map((r) => ({ id: r.id, name: r.name, dir: repoDir(r), remote: r.remote, left: movedProject(store, r.id, repoDir(r)) !== null })),
    manifest: (dir) => manifestOf(scanFolder(dir)),
    addProject: (dir, n, remote) => {
      const known = store.repos().find((r) => repoDir(r) === dir);
      const id = known ? known.id : store.addRepo(dir);
      if (remote !== "") store.setRepoRemote(id, remote);
      if (n !== "") store.setRepoName(id, n);
      return id;
    },
    settle: (repo, st) => {
      if (st.name !== "") store.setRepoName(repo, st.name);
      const main = store.chats().find((c) => c.gid === st.main && c.home === "");
      if (main) store.setMainChat(repo, main.id);
      if (st.settled > 0) store.settleProject(repo, true, st.settled);
      return null;
    },
  };
  const receiver = new ProjectReceiver(app);
  return { root, home, cfg, uploads, store, engine, mesh, move, project, receiver };
}

function meet(a: Pc, b: Pc): void {
  a.mesh.peers.set(b.mesh.me.id, newPeer({ id: b.mesh.me.id, name: b.mesh.me.name, online: true, moves: true, projectMoves: true, addr: "127.0.0.1:1", fp: `fp-${b.mesh.me.name}`, accounts: [["claude", "Claude · AB", "claude"]] }));
}

interface Wire {
  http: NonNullable<MoveSendDeps["http"]>;
  /** Pieces answered, and from which one on the link breaks. */
  pieces: number;
  breakAt: number | null;
}

/** `a`'s calls to `b`, answered by b's own routes in this process. */
function wire(a: Pc, b: Pc): Wire {
  let n = 0;
  const w: Wire = {
    pieces: 0,
    breakAt: null,
    http: async (_d: Dest, method: string, path: string, body: { data: string | Uint8Array } | null): Promise<[number, unknown]> => {
      const [p = "", q = ""] = path.split("?");
      const data = body === null ? Buffer.alloc(0) : typeof body.data === "string" ? Buffer.from(body.data) : Buffer.from(body.data);
      const query = new URLSearchParams(q);
      const answer = (r: { status: number; body: unknown }): [number, unknown] => [r.status, JSON.parse(JSON.stringify(r.body)) as unknown];
      if (p === "/mesh/v1/upload") {
        const file = `${++n}-${query.get("name") ?? "f"}`;
        mkdirSync(join(b.uploads, "up"), { recursive: true });
        writeFileSync(join(b.uploads, "up", file), data);
        return [201, { id: `up/${file}` }];
      }
      if (p === "/mesh/v1/project/piece") {
        if (w.breakAt !== null && w.pieces >= w.breakAt) throw new Error("connection refused (connect ECONNREFUSED)");
        w.pieces += 1;
        return answer(await b.receiver.piece(a.mesh.me.id, query.get("move") ?? "", Number(query.get("stream")), Number(query.get("seq")), data));
      }
      const segs = p.split("/").filter((x) => x !== "");
      const json: unknown = data.length === 0 ? null : JSON.parse(data.toString("utf8"));
      if (segs[2] === "project") return answer(await b.receiver.route(a.mesh.me.id, segs[3] ?? "", json));
      const call: Call = { method, path: segs, query: [], body: json, token: "", device: a.mesh.me.id, global: false };
      const r = b.move.route(call);
      if (r === null) return [404, null];
      return answer(await r);
    },
  };
  Object.assign(a.move.d, { send: { http: w.http, askEveryMs: 0, sleep: () => Promise.resolve() } satisfies MoveSendDeps });
  Object.assign(a.project.d, { http: w.http });
  return w;
}

/** A lead with a sub-agent, a settled chat and a main chat in project `repo`, sessions on disk. */
function seedChats(a: Pc, repo: number): { lead: Chat; sub: Chat; settled: Chat } {
  const lead = a.store.createChat(blankChat({ repoId: repo, title: "Fix it", sessionId: SID, started: true, role: "lead", name: "lead", gid: "g-lead" }));
  const sub = a.store.createChat(blankChat({ repoId: repo, title: "Tests", sessionId: SUB_SID, started: true, role: "sub", parent: lead.id, name: "tests", gid: "g-sub" }));
  const settled = a.store.createChat(blankChat({ repoId: repo, title: "Old idea", sessionId: SET_SID, started: true, settled: true, role: "chat", gid: "g-settled" }));
  a.store.saveItems(lead.id, [user("fix the bug"), text("done", 2)]);
  a.store.saveItems(sub.id, [user("write tests")]);
  a.store.saveItems(settled.id, [user("an old idea")]);
  a.store.setMainChat(repo, lead.id);
  const dir = join(a.cfg, "projects", "-old-app");
  mkdirSync(join(dir, SID, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), '{"lead":1}\n');
  writeFileSync(join(dir, SID, "subagents", "agent-1.jsonl"), '{"agent":1}\n');
  writeFileSync(join(dir, `${SUB_SID}.jsonl`), '{"sub":1}\n');
  writeFileSync(join(dir, `${SET_SID}.jsonl`), '{"settled":1}\n');
  return { lead, sub, settled };
}

async function finished(a: Pc, repo: number, ms = 60_000): Promise<NonNullable<ReturnType<ProjectMove["statusOf"]>>> {
  const t = Date.now();
  for (;;) {
    const st = a.project.statusOf(repo);
    if (st && st.state !== "running") return st;
    if (Date.now() - t > ms) throw new Error(`still running: ${st?.stage}`);
    await Bun.sleep(20);
  }
}

function clean(...pcs: Pc[]): void {
  for (const p of pcs) {
    p.store.close();
    rmSync(p.root, { recursive: true, force: true });
  }
}

describe("foldercopy", () => {
  test("a folder comes through pieces as it was: files, modes, links, empty folders", async () => {
    const root = tmp("fc");
    try {
      const src = join(root, "src");
      mkdirSync(join(src, "a/b/c"), { recursive: true });
      mkdirSync(join(src, "empty"));
      writeFileSync(join(src, "a/b/c/deep.txt"), "deep");
      writeFileSync(join(src, ".env"), "SECRET=1\n");
      writeFileSync(join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(src, "big.bin"), Buffer.alloc(300_000, 7));
      writeFileSync(join(src, "zero"), "");
      symlinkSync("a/b/c/deep.txt", join(src, "link"));
      const scan = scanFolder(src);
      expect(scan.files).toBe(5);
      const dst = join(root, "dst");
      mkdirSync(dst);
      const u = new Unpacker(dst, join(root, "aside"));
      for await (const p of pieces(scan.entries, 4096)) await u.push(p);
      await u.finish();
      expect(readFileSync(join(dst, "a/b/c/deep.txt"), "utf8")).toBe("deep");
      expect(readFileSync(join(dst, ".env"), "utf8")).toBe("SECRET=1\n");
      expectPerm(join(dst, "run.sh"), 0o755);
      expect(readFileSync(join(dst, "big.bin")).equals(Buffer.alloc(300_000, 7))).toBe(true);
      expect(readFileSync(join(dst, "zero"), "utf8")).toBe("");
      expect(wireTarget(readlinkSync(join(dst, "link")))).toBe("a/b/c/deep.txt");
      expect(statSync(join(dst, "empty")).isDirectory()).toBe(true);
      expect(manifestOf(scanFolder(dst))).toBe(manifestOf(scan));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("places outside the folder, writes through links and cut streams are refused", async () => {
    const root = tmp("fc-bad");
    try {
      expect(["../x", "/etc/x", "a/../../x", "a//b", "", "a\\b"].map(plainRel)).toEqual([false, false, false, false, false, false]);
      const bad = async (entries: Entry[]) => {
        const dst = mkdtempSync(join(root, "d-"));
        const u = new Unpacker(dst, join(dst, "..", "aside"));
        for await (const p of pieces(entries)) await u.push(p);
        await u.finish();
      };
      await expect(bad([{ rel: "../escape", kind: "dir", mode: 0o755, size: 0, mtime: 0 }])).rejects.toThrow("outside the folder");
      // A checkout's own link can't lead a write outside.
      const out = join(root, "outside");
      mkdirSync(out);
      const dst = join(root, "checkout");
      mkdirSync(dst);
      symlinkSync(out, join(dst, "lib"));
      writeFileSync(join(root, "payload"), "x");
      const u = new Unpacker(dst, join(root, "aside2"));
      const ps: Buffer[] = [];
      for await (const p of pieces([{ rel: "lib/evil", kind: "file", mode: 0o644, size: 1, mtime: 0, src: join(root, "payload") }])) ps.push(p);
      await expect(u.push(Buffer.concat(ps))).rejects.toThrow("isn't a folder");
      expect(existsSync(join(out, "evil"))).toBe(false);
      // Links of the stream: one can't lead a later one outside either.
      await expect(
        bad([
          { rel: "l", kind: "link", mode: 0o777, size: 0, mtime: 0, target: out },
          { rel: "l/x", kind: "link", mode: 0o777, size: 0, mtime: 0, target: "y" },
        ]),
      ).rejects.toThrow();
      expect(existsSync(join(out, "x"))).toBe(false);
      // A stream cut short.
      const cut = mkdtempSync(join(root, "c-"));
      const u2 = new Unpacker(cut, join(root, "aside3"));
      const all: Buffer[] = [];
      for await (const p of pieces([{ rel: "f", kind: "file", mode: 0o644, size: 1, mtime: 0, src: join(root, "payload") }])) all.push(p);
      const whole = Buffer.concat(all);
      await u2.push(whole.subarray(0, whole.length - 1));
      await expect(u2.finish()).rejects.toThrow("cut short");
      await u2.abort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectmove: the target's plan", () => {
  test("the same place under home when free, else the next free name", () => {
    const taken = new Set([n("/h/Documents/acme"), n("/h/Documents/acme-2")]);
    expect(planDest("/h", "Documents/web", (p) => taken.has(p))).toBe(n("/h/Documents/web"));
    expect(planDest("/h", "Documents/acme", (p) => taken.has(p))).toBe(n("/h/Documents/acme-3"));
    expect(planDest("/h", "../../etc", (p) => taken.has(p))).toBe(n("/h/etc"));
    expect(planDest("/h", ".config/systemd/user/x.service.d", (p) => taken.has(p))).toBe(n("/h/x.service.d"));
    expect(planDest("/h", ".hidden", (p) => taken.has(p))).toBe(n("/h/hidden"));
  });

  test("a project here with the same remote is used; a same-named one only with the same files", () => {
    const root = tmp("plan");
    try {
      const mine = join(root, "home/Projects/acme");
      mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, "a.txt"), "1");
      const repos = [{ id: 1, name: "acme", dir: mine, remote: "git@github.com:Example/Acme.git", left: false }];
      const app = { meName: () => "b", home: join(root, "home"), kv: new MemKv(), repos: () => repos, manifest: (d: string) => manifestOf(scanFolder(d)) } as unknown as ProjectTargetApp;
      const ask = (o: Record<string, unknown>) => checkProject(app, "pc:a", parseCheck({ name: "acme", folder: "acme", rel: "Projects/acme", path: "/src/acme", bytes: 10, ...o }));
      expect(ask({ remote: "https://github.com/example/acme" }).existing).toBe(mine);
      expect(ask({ remote: "https://github.com/example/other" }).dest).toBe(join(root, "home/Projects/acme-2"));
      repos[0] = { ...repos[0], remote: "" } as (typeof repos)[0];
      const same = manifestOf(scanFolder(mine));
      expect(ask({ remote: "", manifest: same }).existing).toBe(mine);
      const other = ask({ remote: "", manifest: "different" });
      expect(other.existing).toBeNull();
      expect(other.destLabel).toBe("~/Projects/acme-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectmove: two PCs", () => {
  test("a git project with an unpushed commit, a dirty file and .env moves with its chats; the folder stays here", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      wire(a, b);
      const remote = join(a.root, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      const app = join(a.home, "Documents/app");
      mkdirSync(app, { recursive: true });
      git(app, "init", "-q", "-b", "main");
      writeFileSync(join(app, "README.md"), "hello\n");
      writeFileSync(join(app, "gone.txt"), "bye\n");
      writeFileSync(join(app, ".gitignore"), ".env\nnode_modules/\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "one");
      git(app, "remote", "add", "origin", remote);
      git(app, "push", "-q", "-u", "origin", "main");
      writeFileSync(join(app, "local.txt"), "only here\n");
      git(app, "add", "local.txt");
      git(app, "commit", "-qm", "unpushed");
      const head = git(app, "rev-parse", "HEAD");
      writeFileSync(join(app, "README.md"), "hello, changed\n");
      rmSync(join(app, "gone.txt"));
      writeFileSync(join(app, "new.txt"), "untracked\n");
      writeFileSync(join(app, ".env"), "TOKEN=placeholder\n");
      mkdirSync(join(app, "node_modules/x"), { recursive: true });
      writeFileSync(join(app, "node_modules/x/index.js"), "module.exports = 1;\n");
      const repo = a.store.addRepo(app);
      a.store.setRepoRemote(repo, remote);
      const { lead, sub, settled } = seedChats(a, repo);

      const t = a.project.targets(repo);
      expect(t.why).toBeNull();
      expect(t.targets).toEqual([{ id: "pc:b", name: "b", why: null }]);
      const plan = await a.project.plan(repo, "pc:b");
      expect(plan.mode).toBe("clone");
      expect(plan.destLabel).toBe("~/Documents/app");
      expect(plan.text).toContain(".env");
      expect(plan.text).toContain("Anyone who uses b can read");
      expect(plan.text).toContain("The folder stays on this PC at ~/Documents/app");

      expect(await a.project.start(repo, "pc:b")).toBe("b");
      // While it moves, its chats take no turns here.
      expect(a.move.movingTo(lead.id)).toBe("b");
      const st = await finished(a, repo);
      expect(st.result).toContain("app is on b now, in ~/Documents/app");
      expect(st.state).toBe("done");
      expect(st.moved.sort()).toEqual(["Fix it", "Old idea"]);

      const there = join(b.home, "Documents/app");
      expect(git(there, "rev-parse", "HEAD")).toBe(head);
      expect(git(there, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(textOf(join(there, "README.md"))).toBe("hello, changed\n");
      expect(textOf(join(there, "local.txt"))).toBe("only here\n");
      expect(textOf(join(there, "new.txt"))).toBe("untracked\n");
      expect(textOf(join(there, ".env"))).toBe("TOKEN=placeholder\n");
      expect(textOf(join(there, "node_modules/x/index.js"))).toContain("module.exports");
      expect(existsSync(join(there, "gone.txt"))).toBe(false);
      expect(git(there, "remote", "get-url", "origin")).toBe(remote);
      expect(git(there, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? new.txt", "D gone.txt", "M README.md"]);

      // b owns the project and the chats now: titles, parents, settled, main chat.
      const br = b.store.repos().find((r) => repoDir(r) === there);
      expect(br?.name).toBe("app");
      const bc = b.store.chats();
      const bl = bc.find((c) => c.gid === "g-lead");
      expect(bl?.home).toBe("");
      expect(bl?.repoId).toBe(br?.id ?? -1);
      expect(bc.find((c) => c.gid === "g-sub")?.parent).toBe(bl?.id ?? -1);
      expect(bc.find((c) => c.gid === "g-settled")?.settled).toBe(true);
      expect(b.store.mainChats().get(br?.id ?? -1)).toBe(bl?.id ?? -1);

      // Here: copies of b's, the project marked as moved, its folder untouched.
      for (const id of [lead.id, sub.id, settled.id]) expect(a.store.chat(id)?.home).toBe("pc:b");
      const m = movedProject(a.store, repo);
      expect(m?.name).toBe("b");
      expect(m?.dir).toBe(there);
      expect(textOf(join(app, ".env"))).toBe("TOKEN=placeholder\n");
      expect(a.project.movedLine({ ...lead, home: "" })).toContain("Its old folder is still on this PC at ~/Documents/app");
      expect(a.move.movingTo(lead.id)).toBeNull();
      // No hidden folder is left behind on b.
      expect(execFileSync("ls", ["-a", join(b.home, "Documents")], { encoding: "utf8" }).split("\n").filter((x) => x.includes("harbor-move"))).toEqual([]);
    } finally {
      clean(a, b);
    }
  }, 60_000);

  test("a plain folder is copied whole; a link that breaks halfway leaves nothing there, and trying again works", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const w = wire(a, b);
      const dir = join(a.home, "notes");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(300_000, 3));
      writeFileSync(join(dir, "sub/a.md"), "# a\n");
      writeFileSync(join(dir, ".env"), "X=1\n");
      const repo = a.store.addRepo(dir);
      const lead = a.store.createChat(blankChat({ repoId: repo, title: "Write", role: "chat", gid: "g-w" }));
      // Someone else's project already has the name on b: it goes beside it.
      mkdirSync(join(b.home, "notes"), { recursive: true });
      writeFileSync(join(b.home, "notes/other.md"), "not the same\n");
      b.store.addRepo(join(b.home, "notes"));

      const plan = await a.project.plan(repo, "pc:b");
      expect(plan.mode).toBe("copy");
      expect(plan.destLabel).toBe("~/notes-2");
      expect(plan.text).toContain("everything in it, also hidden files like .env");

      w.breakAt = 1;
      await a.project.start(repo, "pc:b");
      const failed = await finished(a, repo);
      expect(failed.state).toBe("failed");
      expect(failed.result).toContain("the link to b broke after 64 KB of 300 KB (connection refused (connect ECONNREFUSED)): try again when it's steadier");
      expect(failed.result).toContain("Nothing moved: the project and its chats are still here.");
      expect(a.store.chat(lead.id)?.home).toBe("");
      expect(movedProject(a.store, repo)).toBeNull();
      expect(existsSync(join(b.home, "notes-2"))).toBe(false);
      expect(execFileSync("ls", ["-a", b.home], { encoding: "utf8" }).includes("harbor-move")).toBe(false);

      w.breakAt = null;
      await a.project.start(repo, "pc:b");
      const st = await finished(a, repo);
      expect(st.state).toBe("done");
      const there = join(b.home, "notes-2");
      expect(readFileSync(join(there, "big.bin")).equals(Buffer.alloc(300_000, 3))).toBe(true);
      expect(textOf(join(there, ".env"))).toBe("X=1\n");
      expect(textOf(join(b.home, "notes/other.md"))).toBe("not the same\n");
      expect(b.store.repos().find((r) => repoDir(r) === there)?.name).toBe("notes");
      expect(a.store.chat(lead.id)?.home).toBe("pc:b");
    } finally {
      clean(a, b);
    }
  }, 60_000);

  test("a chat that can't move stays and is named; moving again takes the rest without copying the folder again", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      wire(a, b);
      const dir = join(a.home, "site");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<p>hi</p>\n");
      const repo = a.store.addRepo(dir);
      const { lead, settled } = seedChats(a, repo);
      // The settled chat's session is missing here.
      rmSync(join(a.cfg, "projects", "-old-app", `${SET_SID}.jsonl`));
      await a.project.start(repo, "pc:b");
      const st = await finished(a, repo);
      expect(st.state).toBe("partial");
      expect(st.moved).toEqual(["Fix it"]);
      expect(st.stayed).toEqual([{ title: "Old idea", why: "its Claude session isn't on this PC" }]);
      expect(st.result).toContain("Move the project again to try those once more");
      expect(a.store.chat(lead.id)?.home).toBe("pc:b");
      expect(a.store.chat(settled.id)?.home).toBe("");
      expect(movedProject(a.store, repo)).toBeNull();
      // It's back: the second move only takes the chat.
      writeFileSync(join(a.cfg, "projects", "-old-app", `${SET_SID}.jsonl`), '{"settled":1}\n');
      writeFileSync(join(dir, "later.txt"), "after the copy\n");
      const plan = await a.project.plan(repo, "pc:b");
      expect(plan.again).toBe(true);
      await a.project.start(repo, "pc:b");
      const again = await finished(a, repo);
      expect(again.state).toBe("done");
      expect(again.moved).toEqual(["Old idea"]);
      expect(existsSync(join(b.home, "site/later.txt"))).toBe(false);
      expect(movedProject(a.store, repo)?.dir).toBe(join(b.home, "site"));
    } finally {
      clean(a, b);
    }
  }, 60_000);

  test("into a project the target has already: its checkout isn't touched, the work comes as branches", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      wire(a, b);
      const remote = join(a.root, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      const app = join(a.home, "app");
      mkdirSync(app, { recursive: true });
      git(app, "init", "-q", "-b", "main");
      writeFileSync(join(app, "a.txt"), "1\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "one");
      git(app, "remote", "add", "origin", remote);
      git(app, "push", "-q", "-u", "origin", "main");
      const theirs = join(b.home, "work/app");
      execFileSync("git", ["clone", "-q", remote, theirs]);
      writeFileSync(join(theirs, "mine.txt"), "b's own work\n");
      b.store.setRepoRemote(b.store.addRepo(theirs), remote);
      writeFileSync(join(app, "a.txt"), "2\n");
      git(app, "commit", "-qam", "two");
      const two = git(app, "rev-parse", "HEAD");
      writeFileSync(join(app, "a.txt"), "3, not committed\n");
      const repo = a.store.addRepo(app);
      a.store.setRepoRemote(repo, remote);
      const plan = await a.project.plan(repo, "pc:b");
      expect(plan.mode).toBe("existing");
      expect(plan.text).toContain("b already has app in ~/work/app: Harbor uses it and doesn't change its files.");
      await a.project.start(repo, "pc:b");
      const st = await finished(a, repo);
      expect(st.state).toBe("done");
      expect(st.result).toContain("moved-from-a/main");
      expect(textOf(join(theirs, "a.txt"))).toBe("1\n");
      expect(textOf(join(theirs, "mine.txt"))).toBe("b's own work\n");
      expect(git(theirs, "rev-parse", "moved-from-a/main")).toBe(two);
      expect(git(theirs, "show", "moved-from-a/uncommitted:a.txt")).toBe("3, not committed");
      expect(git(theirs, "rev-parse", "moved-from-a/uncommitted^")).toBe(two);
    } finally {
      clean(a, b);
    }
  }, 60_000);

  test("a chat with its own worktree: its branch comes with the commits and it gets a worktree there; a dirty one says so first", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      wire(a, b);
      const remote = join(a.root, "remote.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      const app = join(a.home, "app");
      mkdirSync(app, { recursive: true });
      git(app, "init", "-q", "-b", "main");
      writeFileSync(join(app, "a.txt"), "1\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "one");
      git(app, "remote", "add", "origin", remote);
      git(app, "push", "-q", "-u", "origin", "main");
      const wt = join(a.root, "worktrees", "app-abc123");
      git(app, "worktree", "add", "-q", "-b", "harbor/abc123", wt);
      writeFileSync(join(wt, "feature.txt"), "on the branch\n");
      git(wt, "add", ".");
      git(wt, "commit", "-qm", "feature");
      const tip = git(wt, "rev-parse", "HEAD");
      const repo = a.store.addRepo(app);
      a.store.setRepoRemote(repo, remote);
      const { lead } = seedChats(a, repo);
      a.store.set(`worktree:${lead.id}`, wt);
      writeFileSync(join(wt, "wip.txt"), "not committed\n");
      await expect(a.project.plan(repo, "pc:b")).rejects.toThrow("“Fix it”'s worktree");
      rmSync(join(wt, "wip.txt"));
      await a.project.start(repo, "pc:b");
      const st = await finished(a, repo);
      expect(st.state).toBe("done");
      const bl = b.store.chats().find((c) => c.gid === "g-lead");
      const there = b.store.get(`worktree:${bl?.id ?? -1}`) ?? "";
      expect(there.startsWith(join(b.root, "worktrees"))).toBe(true);
      expect(git(there, "rev-parse", "HEAD")).toBe(tip);
      expect(git(there, "symbolic-ref", "--short", "HEAD")).toBe("harbor/abc123");
      expect(textOf(join(there, "feature.txt"))).toBe("on the branch\n");
      // The branch never went to the remote.
      expect(execFileSync("git", ["-C", remote, "branch", "--list", "harbor/*"], { encoding: "utf8" }).trim()).toBe("");
    } finally {
      clean(a, b);
    }
  }, 60_000);

  test("it says why it can't move: a running chat, a Codex chat, a PC with an older Harbor", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      wire(a, b);
      const dir = join(a.home, "p");
      mkdirSync(dir);
      const repo = a.store.addRepo(dir);
      const { lead } = seedChats(a, repo);
      a.engine.running_.add(lead.id);
      expect(a.project.blocker(repo)).toBe("“Fix it” can't move: it is running: move it once its turn ends");
      expect(a.project.targets(repo).targets[0]?.why).toBe("“Fix it” can't move: it is running: move it once its turn ends");
      a.engine.running_.clear();
      const peer = a.mesh.peers.get("pc:b");
      if (peer) peer.projectMoves = false;
      expect(a.project.targets(repo).targets[0]?.why).toBe("it runs an older Harbor that can't take projects: update it first");
      await expect(a.project.start(repo, "pc:b")).rejects.toThrow("b can't take it: it runs an older Harbor that can't take projects");
      if (peer) peer.projectMoves = true;
      a.store.createChat(blankChat({ repoId: repo, title: "Codex one", account: "codex", gid: "g-codex" }));
      expect(a.project.blocker(repo)).toBe("“Codex one” can't move: it isn't a Claude chat: only Claude chats move to another PC for now");
    } finally {
      clean(a, b);
    }
  }, 30_000);
});
