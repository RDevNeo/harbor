import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankChat, repoDir, Store, type Chat, type Item, type Mention, type Repo } from "@harbor/store";
import type { Call } from "../src/api.ts";
import type { Reply } from "../src/http.ts";
import { MovePc, type MoveEngine, type MovePcAccount } from "../src/movepcrun.ts";
import { sessionDir, type MoveSendDeps } from "../src/movepc.ts";
import { newPeer, Shared, type Dest } from "../src/shared.ts";
import { text, user } from "./fixture.ts";

const SID = "0b7c1a7e-1111-4222-8333-944455556666";
const SUB_SID = "0b7c1a7e-9999-4222-8333-944455556666";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `movepcrun-${tag}-`));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", dir, ...args], { encoding: "utf8" });
}

async function until(what: string, f: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
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

  reload(): void {
    this.log.push("reload");
  }

  changed(id: number | null): void {
    this.log.push(`changed ${id}`);
  }

  notice(id: number, icon: string, said: string, detail = ""): void {
    this.transcript(id).items.push({ kind: "notice", icon, text: said, detail });
    this.store.saveItems(id, this.transcript(id).items);
  }

  startTurn(id: number, prompt: string): void {
    this.log.push(`turn ${id}: ${prompt}`);
  }

  send(id: number, said: string, opts: { files?: string[]; mentions?: Mention[] }): void {
    this.log.push(`send ${id}: ${said} ${JSON.stringify(opts.files ?? [])}`);
  }

  /** Each chat's session provider (engine.ts `sessionKind`), and the hand-overs asked for. */
  readonly kinds = new Map<number, string>();
  readonly handovers: [number, string][] = [];

  sessionKind(c: Chat): string | undefined {
    return this.kinds.get(c.id);
  }

  handOver(id: number, from?: string): boolean {
    this.handovers.push([id, from ?? ""]);
    return true;
  }

  notices(id: number): string[] {
    return this.transcript(id).items.flatMap((i) => (i.kind === "notice" ? [i.text] : []));
  }
}

interface Forwarded {
  path: string[];
  body: Record<string, unknown>;
  files: string[];
}

interface Pc {
  root: string;
  app: string;
  cfg: string;
  home: string;
  uploads: string;
  store: Store;
  engine: FakeEngine;
  mesh: Shared;
  move: MovePc;
  forwarded: Forwarded[];
  toasts: string[];
  removed: string[];
  /** What the next forwarded call answers. */
  fwd: { reply: Reply };
}

function pc(name: string, over: { project?: boolean; claude?: boolean; accounts?: MovePcAccount[]; level?: () => string } = {}): Pc {
  const root = tmp(name);
  const [app, cfg, home, uploads] = ["app", "cfg", "home", "uploads"].map((d) => join(root, d)) as [string, string, string, string];
  for (const d of [home, cfg, uploads]) mkdirSync(d, { recursive: true });
  mkdirSync(app, { recursive: true });
  const store = Store.openTemp();
  if (over.project !== false) store.addRepo(app);
  const engine = new FakeEngine(store);
  const mesh = new Shared();
  mesh.me = { id: `pc:${name}`, name };
  mesh.on = true;
  const accounts: MovePcAccount[] = over.accounts ?? [{ id: "claude", claude: over.claude !== false, email: "a@example.com", short: "Claude · AB", configDir: cfg, usable: over.claude !== false, usage: [0, 0] }];
  const forwarded: Forwarded[] = [];
  const toasts: string[] = [];
  const removed: string[] = [];
  const fwd: { reply: Reply } = { reply: { status: 200, body: { ok: true } } };
  const move = new MovePc({
    store,
    engine,
    mesh,
    forward: async (_d, _n, _m, path, body, files) => {
      forwarded.push({ path, body, files: files.map((f) => f.name) });
      return fwd.reply;
    },
    accounts: () => accounts,
    home,
    uploadsDir: uploads,
    worktreeRoot: join(root, "worktrees"),
    overlays: () => [],
    removeWorktree: async (_r, d) => {
      removed.push(d);
    },
    reindex: () => undefined,
    ...(over.level ? { shareLevel: over.level, accessOf: (k: string) => (k === "opencode" ? ["full"] : ["full", "edits", "plan"]) } : {}),
  });
  move.onToast = (t) => toasts.push(t);
  return { root, app, cfg, home, uploads, store, engine, mesh, move, forwarded, toasts, removed, fwd };
}

function meet(a: Pc, b: Pc): void {
  a.mesh.peers.set(b.mesh.me.id, newPeer({ id: b.mesh.me.id, name: b.mesh.me.name, online: true, moves: true, addr: "127.0.0.1:1", fp: `fp-${b.mesh.me.name}`, accounts: [["claude", "Claude · AB", "claude"]] }));
}

/** `a`'s calls to `b` answered by b's own routes in this process; uploads land in b's uploads folder. */
interface Link {
  askEveryMs: number;
  http: NonNullable<MoveSendDeps["http"]>;
}

function useSend(p: Pc, send: MoveSendDeps): void {
  Object.assign(p.move.d, { send });
}

function wire(a: Pc, b: Pc, gate?: { path: string; open: Promise<void> }): Link {
  let n = 0;
  return {
    askEveryMs: 0,
    http: async (_d: Dest, method: string, path: string, body: { data: string | Uint8Array } | null): Promise<[number, unknown]> => {
      const [p, q = ""] = path.split("?");
      const data = body === null ? "" : typeof body.data === "string" ? body.data : Buffer.from(body.data);
      if (gate && p === gate.path) await gate.open;
      if (p === "/mesh/v1/upload") {
        const file = `${++n}-${decodeURIComponent(q.replace("name=", ""))}`;
        mkdirSync(join(b.uploads, "up"), { recursive: true });
        writeFileSync(join(b.uploads, "up", file), data);
        return [201, { id: `up/${file}` }];
      }
      const call: Call = { method, path: (p ?? "").split("/").filter((s) => s !== ""), query: [], body: JSON.parse(String(data)) as unknown, token: "", device: a.mesh.me.id, global: false };
      const r = b.move.route(call);
      if (r === null) return [404, null];
      const reply = await r;
      return [reply.status, JSON.parse(JSON.stringify(reply.body)) as unknown];
    },
  };
}

interface Seeded {
  lead: Chat;
  sub: Chat;
}

/** A started lead with a sub-agent in the project, their transcripts and sessions on disk. */
function seed(a: Pc): Seeded {
  const repo = a.store.repos()[0];
  const lead = a.store.createChat(blankChat({ repoId: repo?.id ?? null, title: "Fix it", sessionId: SID, started: true, model: "claude-opus-5-5", effort: "medium", role: "lead", name: "lead", gid: "g-lead" }));
  const sub = a.store.createChat(blankChat({ repoId: repo?.id ?? null, title: "Tests", sessionId: SUB_SID, started: true, role: "sub", parent: lead.id, name: "tests", gid: "g-sub" }));
  a.store.saveItems(lead.id, [user("fix the bug"), text("done", 2)]);
  a.store.saveItems(sub.id, [user("write tests")]);
  const dir = join(a.cfg, "projects", "-old-app");
  mkdirSync(join(dir, SID, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), '{"lead":1}\n');
  writeFileSync(join(dir, SID, "subagents", "agent-1.jsonl"), '{"agent":1}\n');
  writeFileSync(join(dir, `${SUB_SID}.jsonl`), '{"sub":1}\n');
  return { lead, sub };
}

function clean(...pcs: Pc[]): void {
  for (const p of pcs) {
    p.store.close();
    rmSync(p.root, { recursive: true, force: true });
  }
}

describe("movepcrun: the sender", () => {
  test("a chat that can't move says why, before anything is sent", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead, sub } = seed(a);
      a.engine.running_.add(lead.id);
      await expect(a.move.movePc(lead.id, b.mesh.me.id)).rejects.toThrow("it is running: move it once its turn ends");
      a.engine.running_.clear();
      await expect(a.move.movePc(sub.id, b.mesh.me.id)).rejects.toThrow("a sub-agent moves with its lead: move the lead");
      await expect(a.move.movePc(lead.id, "pc:nobody")).rejects.toThrow("that PC isn't one of this PC's");
      a.mesh.on = false;
      await expect(a.move.movePc(lead.id, b.mesh.me.id)).rejects.toThrow("this PC doesn't share chats with other PCs (Settings › Workspace)");
      a.mesh.on = true;
      const old = a.mesh.peers.get(b.mesh.me.id);
      if (old) old.moves = false;
      await expect(a.move.movePc(lead.id, b.mesh.me.id)).rejects.toThrow("b can't take it: it runs an older Harbor: update it first");
      expect(a.move.local.moving.size).toBe(0);
      expect(a.store.get("move_pc")).toBeNull();
    } finally {
      clean(a, b);
    }
  });

  test("a chat with uncommitted changes where it works does not move", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead } = seed(a);
      git(a.app, "init", "-q", "-b", "main");
      writeFileSync(join(a.app, "f.txt"), "1\n");
      git(a.app, "add", ".");
      git(a.app, "commit", "-qm", "one");
      expect((await a.move.targets(lead.id)).why).toBeNull();
      writeFileSync(join(a.app, "g.txt"), "2\n");
      const t = await a.move.targets(lead.id);
      expect(t.why).toContain("has 1 uncommitted change: commit or stash them first");
      expect(t.targets.map((x) => x.why)).toEqual([t.why]);
      await expect(a.move.movePc(lead.id, b.mesh.me.id)).rejects.toThrow("commit or stash them first");
      // The menu does not wait for git: the first look says nothing, the next shows it.
      expect(a.move.targetsNow(lead.id).why).toBeNull();
      await until("the code's state", () => a.move.targetsNow(lead.id).why !== null);
      expect(a.move.targetsNow(lead.id).targets[0]?.why).toContain("uncommitted");
    } finally {
      clean(a, b);
    }
  });

  test("the targets say why a PC can't take the chat", async () => {
    const a = pc("a");
    try {
      const { lead } = seed(a);
      const add = (id: string, o: Partial<Parameters<typeof newPeer>[0]>) => a.mesh.peers.set(id, newPeer({ id, name: id.slice(3), addr: "127.0.0.1:1", ...o }));
      add("pc:ok", { online: true, moves: true, accounts: [["claude", "Claude", "claude"]] });
      add("pc:old", { online: true, moves: false, accounts: [["claude", "Claude", "claude"]] });
      add("pc:codex", { online: true, moves: true, accounts: [["codex", "Codex", "codex"]] });
      add("pc:off", { online: false, fp: "fp-off" });
      a.mesh.workspacePeers = () => [{ node: "", name: "off", fp: "fp-off", id: "pc:off", addrs: [] }];
      a.mesh.down.set("pc:off", "harbor");
      add("pc:gone", { online: false, fp: "fp-gone" });
      const t = await a.move.targets(lead.id);
      expect(t.why).toBeNull();
      expect(t.targets.map((x) => [x.id, x.why])).toEqual([
        ["pc:codex", "it has no Claude account"],
        ["pc:ok", null],
        ["pc:old", "it runs an older Harbor: update it first"],
        ["pc:off", "Harbor isn't running there"],
      ]);
      const json: unknown = await a.move.targetsJson(lead.id);
      expect(json).toEqual({ why: null, targets: t.targets });
      a.mesh.on = false;
      const off = await a.move.targets(lead.id);
      expect(off.why).toBe("this PC doesn't share chats with other PCs (Settings › Workspace)");
      expect(new Set(off.targets.map((x) => x.why))).toEqual(new Set([off.why]));
    } finally {
      clean(a);
    }
  });

  test("a move that is refused resumes the chat here: its waiting turn runs and held messages are sent here", async () => {
    const a = pc("a");
    const b = pc("b", { project: false });
    try {
      meet(a, b);
      const { lead } = seed(a);
      let open = (): void => undefined;
      const gate = new Promise<void>((r) => (open = r));
      useSend(a, wire(a, b, { path: "/mesh/v1/adopt/check", open: gate }));
      expect(await a.move.movePc(lead.id, b.mesh.me.id)).toBe("b");
      expect(a.move.movingTo(lead.id)).toBe("b");
      expect(JSON.parse(a.store.get("move_pc") ?? "")).toEqual({ "g-lead": ["pc:b", "b"] });
      expect(a.move.blocker(lead.id)).toBe("it's moving to b");
      // Sent while it moves: kept, not run.
      expect(a.move.hold(lead.id, "while it moves", ["/tmp/x.png"], [])).toBe(true);
      a.engine.pending.set(lead.id, ["woke up", "again"]);
      open();
      await until("the notice", () => a.engine.notices(lead.id).length > 0);
      expect(a.engine.notices(lead.id)).toEqual(["Couldn't move to b: b has no project named app: copy its folder there and add it to Harbor first"]);
      expect(a.toasts).toEqual(["Couldn't move to b: b has no project named app: copy its folder there and add it to Harbor first"]);
      expect(a.move.movingTo(lead.id)).toBeNull();
      expect(a.store.get("move_pc")).toBe("{}");
      expect(a.engine.log.filter((l) => l.startsWith("turn") || l.startsWith("send"))).toEqual([`turn ${lead.id}: woke up\n\n---\n\nagain`, `send ${lead.id}: while it moves ["/tmp/x.png"]`]);
      expect(a.move.hold(lead.id, "after", [], [])).toBe(false);
      expect(a.store.chats().find((c) => c.id === lead.id)?.home).toBe("");
      expect(a.forwarded).toEqual([]);
      expect(readdirSync(b.uploads)).toEqual([]);
    } finally {
      clean(a, b);
    }
  });

  test("a move that is done turns the chats into copies of the target's and sends what was held there", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead, sub } = seed(a);
      a.store.set(`worktree:${lead.id}`, join(a.root, "wt"));
      let open = (): void => undefined;
      const gate = new Promise<void>((r) => (open = r));
      useSend(a, wire(a, b, { path: "/mesh/v1/adopt", open: gate }));
      expect(await a.move.movePc(lead.id, b.mesh.me.id)).toBe("b");
      expect(a.move.hold(lead.id, "held one", [], [])).toBe(true);
      expect(a.move.hold(sub.id, "for the sub-agent", [], [])).toBe(true);
      a.engine.pending.set(lead.id, ["waiting turn"]);
      open();
      await until("the copies", () => a.store.chats().find((c) => c.id === lead.id)?.home === "pc:b");
      await until("what was held", () => a.forwarded.length === 3);

      const bLead = b.store.chats().find((c) => c.gid === "g-lead");
      const bSub = b.store.chats().find((c) => c.gid === "g-sub");
      expect(bLead).toMatchObject({ home: "", homeId: 0, repoId: b.store.repos()[0]?.id, account: "claude", title: "Fix it", sessionId: SID, started: true, role: "lead", name: "lead", model: "claude-opus-5-5" });
      expect(bSub).toMatchObject({ home: "", role: "sub", parent: bLead?.id, name: "tests", sessionId: SUB_SID });
      expect(b.store.items(bLead?.id ?? 0).slice(0, 2)).toEqual([user("fix the bug"), text("done", 2)]);
      expect(b.store.items(bSub?.id ?? 0)).toEqual([user("write tests")]);
      const dir = sessionDir(b.home, b.cfg, b.app);
      expect(readFileSync(join(dir, `${SID}.jsonl`), "utf8")).toBe('{"lead":1}\n');
      expect(readFileSync(join(dir, SID, "subagents", "agent-1.jsonl"), "utf8")).toBe('{"agent":1}\n');
      expect(readFileSync(join(dir, `${SUB_SID}.jsonl`), "utf8")).toBe('{"sub":1}\n');
      await until("the arrival notice", () => b.engine.notices(bLead?.id ?? 0).length > 0);
      expect(b.engine.notices(bLead?.id ?? 0)).toEqual(["Moved here from a"]);
      const detail = b.engine.transcript(bLead?.id ?? 0).items.find((i) => i.kind === "notice");
      expect(detail?.kind === "notice" && detail.detail).toBe(`It runs as Claude · AB here, in ${b.app}.`);
      expect(readdirSync(join(b.uploads, "up"))).toEqual([]);

      const copies = a.store.chats();
      expect(copies.find((c) => c.id === lead.id)).toMatchObject({ home: "pc:b", homeId: bLead?.id, sessionId: "" });
      expect(copies.find((c) => c.id === sub.id)).toMatchObject({ home: "pc:b", homeId: bSub?.id, sessionId: "" });
      expect(a.store.get("move_pc")).toBe("{}");
      expect(a.store.get(`worktree:${lead.id}`)).toBe("");
      expect(a.removed).toEqual([join(a.root, "wt")]);
      expect(a.toasts).toEqual(["Moved to b: it goes on there"]);
      expect(a.engine.log).toContain("reload");
      expect(a.engine.transcripts.has(lead.id)).toBe(false);
      expect(a.engine.log.filter((l) => l.startsWith("turn") || l.startsWith("send"))).toEqual([]);
      // What waited goes to the chat's new home, in order, as that PC's own ids.
      expect(a.forwarded.map((f) => [f.path.join("/"), f.body.text])).toEqual([
        [`v1/chats/${bLead?.id}/send`, "waiting turn"],
        [`v1/chats/${bLead?.id}/send`, "held one"],
        [`v1/chats/${bSub?.id}/send`, "for the sub-agent"],
      ]);
      expect(a.forwarded[0]?.body.mode).toBe("queue");
      // Asked again after the answer: the target already owns it.
      expect(a.move.blocker(lead.id)).toBe("this chat is b's: move it from there");
    } finally {
      clean(a, b);
    }
  });

  test("a move Auto chose tells the target, which remembers it as Auto's; a hand-picked move back drops it", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      meet(b, a);
      const { lead } = seed(a);
      const sent: unknown[] = [];
      const link = wire(a, b);
      useSend(a, {
        askEveryMs: 0,
        http: async (d, method, path, body, wait) => {
          if (path.startsWith("/mesh/v1/upload") && path.includes("move.json")) sent.push(JSON.parse(Buffer.from(body?.data ?? "").toString("utf8")));
          return link.http(d, method, path, body, wait);
        },
      });
      // B already had a stale marker for the sub-agent: a move that doesn't say Auto for it clears it.
      b.store.set("auto_pc:g-sub", "pc:x");
      expect(await a.move.movePc(lead.id, b.mesh.me.id, true)).toBe("b");
      // The sender records Auto's choice at the moment the move is recorded.
      expect(a.store.get("auto_pc:g-lead")).toBe("pc:b");
      await until("the copies", () => a.store.chats().find((c) => c.id === lead.id)?.home === "pc:b");
      // Only the lead carries the flag.
      const chats = (sent[0] as { chats: { gid: string; auto_placed?: boolean }[] }).chats;
      expect(chats.map((c) => [c.gid, c.auto_placed])).toEqual([
        ["g-lead", true],
        ["g-sub", undefined],
      ]);
      // On B the chat is its own (home ""), Auto's place: this PC ("").
      const bLead = b.store.chats().find((c) => c.gid === "g-lead");
      expect(bLead).toMatchObject({ home: "", device: "" });
      expect(b.store.get("auto_pc:g-lead")).toBe("");
      expect(b.store.get("auto_pc:g-sub")).toBeNull();
      // A's copy still says Auto put it on B.
      expect(a.store.get("auto_pc:g-lead")).toBe("pc:b");

      // Moved back by hand: A's chat is its own again and no longer Auto's; B's copy keeps its marker for "" (not where the
      // chat is now, so it shows no label).
      useSend(b, wire(b, a));
      await until("b sees the chat idle", () => b.move.blocker(bLead?.id ?? 0) === null);
      expect(await b.move.movePc(bLead?.id ?? 0, a.mesh.me.id)).toBe("a");
      await until("back on a", () => a.store.chats().find((c) => c.id === lead.id)?.home === "");
      expect(a.store.get("auto_pc:g-lead")).toBeNull();
      expect(b.store.get("auto_pc:g-lead")).toBe("");
    } finally {
      clean(a, b);
    }
  });

  test("a hand-picked move isn't Auto's: no flag, and a marker left by an Auto move that failed is dropped", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead } = seed(a);
      const sent: unknown[] = [];
      const link = wire(a, b);
      useSend(a, {
        askEveryMs: 0,
        http: async (d, method, path, body, wait) => {
          if (path.startsWith("/mesh/v1/upload") && path.includes("move.json")) sent.push(JSON.parse(Buffer.from(body?.data ?? "").toString("utf8")));
          return link.http(d, method, path, body, wait);
        },
      });
      a.store.set("auto_pc:g-lead", "pc:b");
      // An older peer's move.json has no field at all: the target clears what it had.
      b.store.set("auto_pc:g-lead", "");
      expect(await a.move.movePc(lead.id, b.mesh.me.id)).toBe("b");
      expect(a.store.get("auto_pc:g-lead")).toBeNull();
      await until("the copies", () => a.store.chats().find((c) => c.id === lead.id)?.home === "pc:b");
      expect((sent[0] as { chats: Record<string, unknown>[] }).chats.some((c) => "auto_placed" in c)).toBe(false);
      expect(b.store.get("auto_pc:g-lead")).toBeNull();
    } finally {
      clean(a, b);
    }
  });

  test("a move without an answer stays pending, and the target's chat list settles it", async () => {
    const make = async () => {
      const a = pc("a");
      const b = pc("b");
      meet(a, b);
      const { lead } = seed(a);
      const link = wire(a, b);
      useSend(a, {
        askEveryMs: 0,
        http: async (d, method, path, body, wait) => {
          if (path === "/mesh/v1/adopt") return [503, { error: "slow" }];
          if (path === "/mesh/v1/adopt/check" && !String(body?.data).includes('"kind"')) return [200, { owns: false, busy: true }];
          return link.http(d, method, path, body, wait);
        },
      });
      await a.move.movePc(lead.id, b.mesh.me.id);
      await until("no answer", () => a.engine.notices(lead.id).length > 0);
      return { a, b, lead };
    };
    const one = await make();
    try {
      expect(one.a.engine.notices(one.lead.id)).toEqual(["Moving to b: no answer yet (slow). The chat stays here and takes no turns until b answers."]);
      expect(one.a.move.movingTo(one.lead.id)).toBe("b");
      expect(one.a.move.local.sending.size).toBe(0);
      expect(JSON.parse(one.a.store.get("move_pc") ?? "")).toEqual({ "g-lead": ["pc:b", "b"] });
      // After a restart it is still pending.
      const again = new MovePc(one.a.move.d);
      again.load();
      expect(again.movingTo(one.lead.id)).toBe("b");
      // A list that does not have it, but is not full: nothing yet.
      one.a.move.reconcile("pc:b", { chats: [], full: false });
      expect(one.a.move.movingTo(one.lead.id)).toBe("b");
      // The target lists it as its own: the move happened.
      one.a.move.reconcile("pc:other", { chats: [{ gid: "g-lead", id: 5 }], full: true });
      expect(one.a.move.movingTo(one.lead.id)).toBe("b");
      one.a.move.reconcile("pc:b", { chats: [{ gid: "g-lead", id: 55 }, { gid: "g-sub", id: 56 }], full: true });
      expect(one.a.move.movingTo(one.lead.id)).toBeNull();
      expect(one.a.store.chats().filter((c) => c.home === "pc:b").map((c) => [c.gid, c.homeId])).toEqual([
        ["g-lead", 55],
        ["g-sub", 56],
      ]);
    } finally {
      clean(one.a, one.b);
    }
    const two = await make();
    try {
      two.a.move.hold(two.lead.id, "later", [], []);
      // A full list without it: it did not take the chat, and the chat goes on here.
      two.a.move.reconcile("pc:b", { chats: [], full: true });
      expect(two.a.move.movingTo(two.lead.id)).toBeNull();
      expect(two.a.engine.notices(two.lead.id).at(-1)).toBe("b didn't take the chat: it stays on this PC");
      expect(two.a.engine.log.filter((l) => l.startsWith("send"))).toEqual([`send ${two.lead.id}: later []`]);
      expect(two.a.store.get("move_pc")).toBe("{}");
      expect(two.a.store.chats().find((c) => c.id === two.lead.id)?.home).toBe("");
    } finally {
      clean(two.a, two.b);
    }
  });

  test("a copy asks its home PC for the targets and has it do the move", async () => {
    const a = pc("a");
    try {
      a.mesh.peers.set("pc:h", newPeer({ id: "pc:h", name: "home", online: true, moves: true, addr: "127.0.0.1:1" }));
      const copy = a.store.createChat(blankChat({ title: "Theirs", gid: "g-copy", home: "pc:h", homeId: 9, role: "lead", name: "lead" }));
      const asked: string[] = [];
      useSend(a, {
        http: async (_d, _m, path, body) => {
          asked.push(`${path} ${String(body?.data)}`);
          return [200, { why: null, targets: [{ id: "pc:c", name: "gamma", why: null }] }];
        },
      });
      expect(a.move.targetsNow(copy.id)).toEqual({ why: "Asking its PC…", targets: [] });
      await until("the answer", () => a.move.targetsNow(copy.id).targets.length === 1);
      expect(a.move.targetsNow(copy.id)).toEqual({ why: null, targets: [{ id: "pc:c", name: "gamma", why: null }] });
      expect(asked).toEqual(['/mesh/v1/call {"body":null,"method":"GET","path":["v1","chats","9","move_targets"]}']);
      a.fwd.reply = { status: 202, body: { ok: true, moving: true, to: "gamma" } };
      expect(await a.move.movePc(copy.id, "pc:c")).toBe("gamma");
      expect(a.forwarded).toEqual([{ path: ["v1", "chats", "9", "move_pc"], body: { pc: "pc:c" }, files: [] }]);
      a.fwd.reply = { status: 409, body: { error: "gamma can't take it" } };
      await expect(a.move.movePc(copy.id, "pc:c")).rejects.toThrow("gamma can't take it");
      const home = a.mesh.peers.get("pc:h");
      if (home) home.moves = false;
      await expect(a.move.movePc(copy.id, "pc:c")).rejects.toThrow("home runs an older Harbor that can't move chats: update it first");
      if (home) home.online = false;
      expect((await a.move.targets(copy.id)).why).toBe("home is off: it moves the chat");
    } finally {
      clean(a);
    }
  });
});

describe("movepcrun: the target", () => {
  test("only the adopt calls are answered, and the deadline is this PC's own", async () => {
    const b = pc("b");
    try {
      const call = (path: string[], body: unknown, method = "POST"): Call => ({ method, path, query: [], body, token: "", device: "pc:a", global: false });
      expect(b.move.route(call(["mesh", "v1", "call"], {}))).toBeNull();
      expect(b.move.route(call(["mesh", "v1", "adopt", "x"], {}))).toBeNull();
      expect(b.move.route(call(["mesh", "v1", "adopt"], {}, "GET"))).toBeNull();
      const checked = await b.move.route(call(["mesh", "v1", "adopt", "check"], { gid: "" }));
      const body: unknown = checked?.body;
      expect(typeof body === "object" && body !== null ? Reflect.get(body, "error") : null).toBe("no chat");
      // A deadline the caller wrote is overwritten: this call is not too late.
      const r = await b.move.route(call(["mesh", "v1", "adopt"], { gid: "g1", kind: "codex", deadline_ms: 1 }));
      expect(r?.body).toEqual({ error: "b only takes Claude chats for now" });
      const late = await b.move.route(call(["mesh", "v1", "adopt"], "not an object"));
      expect(late?.body).toEqual({ error: "no chat" });
    } finally {
      clean(b);
    }
  });

  test("a copy of the chat on the target becomes the chat, and a sub-agent keeps its lead", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead } = seed(a);
      const copy = b.store.createChat(blankChat({ title: "old", gid: "g-lead", home: "pc:a", homeId: lead.id, role: "lead", name: "lead", updated: 5 }));
      b.store.saveItems(copy.id, [user("stale")]);
      useSend(a, wire(a, b));
      await a.move.movePc(lead.id, b.mesh.me.id);
      await until("the copy to turn", () => b.store.chats().find((c) => c.id === copy.id)?.home === "");
      const now = b.store.chats().find((c) => c.id === copy.id);
      expect(now).toMatchObject({ gid: "g-lead", title: "Fix it", homeId: 0, repoId: b.store.repos()[0]?.id });
      await until("the arrival notice", () => b.store.items(copy.id).length === 3);
      expect(b.store.items(copy.id).slice(0, 2)).toEqual([user("fix the bug"), text("done", 2)]);
      expect(b.store.chats().filter((c) => c.gid === "g-lead").length).toBe(1);
      expect(b.store.chats().find((c) => c.gid === "g-sub")?.parent).toBe(copy.id);
      // Asking again (its answer was lost): this PC owns the chats.
      const owns = await b.move.route({ method: "POST", path: ["mesh", "v1", "adopt", "check"], query: [], body: { gid: "g-lead" }, token: "", device: "pc:a", global: false });
      expect(owns?.body).toEqual({ ok: true, owns: true, ids: { "g-lead": copy.id, "g-sub": b.store.chats().find((c) => c.gid === "g-sub")?.id } });
      expect(existsSync(join(sessionDir(b.home, b.cfg, b.app), `${SID}.jsonl`))).toBe(true);
    } finally {
      clean(a, b);
    }
  });

  test("a chat that belongs to another PC here is not taken", async () => {
    const a = pc("a");
    const b = pc("b");
    try {
      meet(a, b);
      const { lead } = seed(a);
      b.mesh.peers.set("pc:c", newPeer({ id: "pc:c", name: "gamma", online: true }));
      b.store.createChat(blankChat({ title: "gamma's", gid: "g-lead", home: "pc:c", homeId: 3, role: "lead", name: "lead" }));
      useSend(a, wire(a, b));
      await a.move.movePc(lead.id, b.mesh.me.id);
      await until("the refusal", () => a.engine.notices(lead.id).length > 0);
      expect(a.engine.notices(lead.id)).toEqual(["Couldn't move to b: this chat belongs to gamma here, not to you"]);
      expect(a.store.chats().find((c) => c.id === lead.id)?.home).toBe("");
    } finally {
      clean(a, b);
    }
  });
});

describe("movepcrun: a started chat switched to another PC's account", () => {
  const acct = (id: string, kind: string, cfg: string | null): MovePcAccount => ({ id, kind, claude: kind === "claude", email: `${id}@example.com`, short: id, configDir: cfg, usable: kind === "claude", ready: true, usage: [0, 0] });

  test("a Codex chat goes on with the target's OpenCode in a new session, within what the target shares", async () => {
    let level = "edit";
    const a = pc("a", { accounts: [acct("codex", "codex", null)] });
    const b = pc("b", { accounts: [acct("claude", "claude", null), acct("opencode", "opencode", null)], level: () => level });
    try {
      meet(a, b);
      const peer = a.mesh.peers.get("pc:b");
      if (peer) peer.accountMoves = true;
      const repo = a.store.repos()[0];
      const lead = a.store.createChat(blankChat({ repoId: repo?.id ?? null, title: "Port it", sessionId: "thread-1", started: true, account: "codex", model: "gpt-5", effort: "high", access: "full", role: "lead", name: "lead", gid: "g-cx" }));
      a.store.saveItems(lead.id, [user("port the parser"), text("ported", 2)]);
      a.engine.kinds.set(lead.id, "codex");
      // A plain move of a Codex chat is still refused; a switch to one of b's accounts isn't.
      await expect(a.move.movePc(lead.id, "pc:b")).rejects.toThrow("only Claude chats move to another PC for now");
      useSend(a, wire(a, b));
      const want = { account: "opencode", kind: "opencode", model: "nvidia/glm" };
      // b shares "edit" with a: OpenCode runs with full access only, so b refuses it.
      expect(await a.move.movePc(lead.id, "pc:b", false, want)).toBe("b");
      await until("the refusal", () => a.engine.notices(lead.id).length > 0);
      expect(a.engine.notices(lead.id)).toEqual(["Couldn't move to b: b lets this PC's chats only edit files there, and OpenCode runs with full access only"]);
      expect(b.store.chats()).toEqual([]);
      level = "full";
      await a.move.movePc(lead.id, "pc:b", false, want);
      await until("the copy", () => a.store.chats().find((c) => c.id === lead.id)?.home === "pc:b");
      const there = b.store.chats().find((c) => c.gid === "g-cx");
      expect(there).toMatchObject({ account: "opencode", model: "nvidia/glm", effort: "", access: "full", started: true, sessionId: "thread-1" });
      expect(b.store.items(there?.id ?? 0).slice(0, 2)).toEqual([user("port the parser"), text("ported", 2)]);
      // No Codex session went along: b goes on in a new one, with the conversation so far.
      expect(b.engine.handovers).toEqual([[there?.id ?? 0, "Codex on a"]]);
      expect(existsSync(join(b.cfg, "projects"))).toBe(false);
    } finally {
      clean(a, b);
    }
  });

  test("a Claude chat switched to another Claude login there keeps its session, at most read-only when that's what b shares", async () => {
    const a = pc("a");
    const b = pc("b", { accounts: [acct("claude", "claude", null), acct("claude2", "claude", "")], level: () => "read" });
    const cfg2 = join(b.root, "claude2");
    const two = b.move.d.accounts().find((x) => x.id === "claude2");
    if (two) two.configDir = cfg2;
    try {
      meet(a, b);
      const peer = a.mesh.peers.get("pc:b");
      if (peer) peer.accountMoves = true;
      const { lead, sub } = seed(a);
      useSend(a, wire(a, b));
      await a.move.movePc(lead.id, "pc:b", false, { account: "claude2", kind: "claude", model: "" });
      await until("the copy", () => a.store.chats().find((c) => c.id === lead.id)?.home === "pc:b");
      const bLead = b.store.chats().find((c) => c.gid === "g-lead");
      expect(bLead).toMatchObject({ account: "claude2", access: "plan", model: "claude-opus-5-5", effort: "medium", sessionId: SID });
      expect(b.store.chats().find((c) => c.gid === "g-sub")).toMatchObject({ account: "claude2", access: "plan" });
      // Its session came along, into that login's profile: no new session.
      expect(readFileSync(join(sessionDir(b.home, cfg2, b.app), `${SID}.jsonl`), "utf8")).toBe('{"lead":1}\n');
      expect(b.engine.handovers).toEqual([]);
      expect(sub.id).toBeGreaterThan(0);
    } finally {
      clean(a, b);
    }
  });

  test("a PC whose Harbor can't take such a switch says so in the targets", async () => {
    const a = pc("a", { accounts: [acct("codex", "codex", null)] });
    const b = pc("b");
    try {
      meet(a, b);
      const lead = a.store.createChat(blankChat({ title: "x", sessionId: "t", started: true, account: "codex", role: "lead", name: "lead", gid: "g-old" }));
      await expect(a.move.movePc(lead.id, "pc:b", false, { account: "claude", kind: "claude", model: "" })).rejects.toThrow("b can't take it: it runs an older Harbor: update it to switch to its accounts");
    } finally {
      clean(a, b);
    }
  });
});
