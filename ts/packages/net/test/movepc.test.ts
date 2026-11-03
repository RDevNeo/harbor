import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemKv } from "../src/kv.ts";
import { newPeer, type Dest } from "../src/shared.ts";
import { wire, type Json } from "../src/wire.ts";
import {
  MOVE_MAX_FILES,
  MovepcLocal,
  NO_MOVE_CODE,
  apiMoveTargets,
  askMoveTargets,
  codeState,
  deadlineMs,
  fetchWorktree,
  gitHead,
  gitHeadLabel,
  matchProject,
  moveAdopt,
  moveCheck,
  moveCheckBody,
  moveOutcomeText,
  movePayload,
  movePcBlocker,
  movePcTargets,
  moveReconcile,
  movedHereDetail,
  normalizeRemote,
  pickAccount,
  placeSessionFiles,
  pushBranch,
  receivedChat,
  remoteUrl,
  safeRel,
  sendHandoff,
  sessionDir,
  sessionFiles,
  validSid,
  type MoveAccount,
  type MoveCandidate,
  type MoveHandoff,
  type MoveTargetApp,
} from "../src/movepc.ts";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `movepc-${tag}-`));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", dir, ...args], { encoding: "utf8" });
}

const SID = "0b7c1a7e-1111-4222-8333-944455556666";
const NOWHERE: Dest = { addr: "127.0.0.1:1", fp: "" };

describe("movepc", () => {
  test("remotes_compare_by_host_and_path", () => {
    const all = ["git@github.com:Sam/App.git", "https://github.com/sam/app", "https://github.com/sam/app.git/", "ssh://git@github.com:22/sam/app", "https://token@github.com/sam/app"];
    for (const u of all) expect(normalizeRemote(u)).toBe("github.com/sam/app");
    expect(normalizeRemote("git@gitlab.com:sam/app.git")).not.toBe(normalizeRemote("git@github.com:sam/app.git"));
  });

  test("projects_match_by_remote_then_name", () => {
    const c = (id: number, name: string, folder: string, remote: string): MoveCandidate => ({ id, name, folder, remote });
    const here = [c(1, "app", "app", "git@github.com:sam/other.git"), c(2, "work", "app-clone", "https://github.com/sam/app"), c(3, "notes", "notes", "")];
    // The remote wins over a folder of the same name.
    expect(matchProject(here, "git@github.com:sam/app.git", "app", "app")).toBe(2);
    // A different repository with the same name isn't it.
    expect(matchProject(here, "git@github.com:sam/third.git", "app", "app")).toBeNull();
    // No remote on either side: the name decides.
    expect(matchProject(here, "", "notes", "notes")).toBe(3);
    expect(matchProject(here, "git@github.com:sam/notes.git", "notes", "notes")).toBe(3);
    expect(matchProject(here, "", "nothing", "nothing")).toBeNull();
  });

  test("accounts_prefer_the_same_login_then_the_default", () => {
    const a = (id: string, email: string, w: number) => ({ id, email, usage: [w, 0] as [number, number] });
    const here = [a("claude", "sam@example.com", 0.9), a("claude2", "kim@example.com", 0.1), a("claude3", "", 0.5)];
    expect(pickAccount(here, "KIM@example.com", "claude")).toBe("claude2");
    expect(pickAccount(here, "lee@example.com", "claude3")).toBe("claude3");
    // No default among them: the most quota left.
    expect(pickAccount(here, "", "gone")).toBe("claude2");
    expect(pickAccount([], "sam@example.com", "claude")).toBeNull();
  });

  test("session_files_stay_in_their_folder", () => {
    expect(safeRel(SID, `${SID}.jsonl`)).toBe(true);
    expect(safeRel(SID, `${SID}/subagents/agent-1.jsonl`)).toBe(true);
    expect(safeRel(SID, "other.jsonl")).toBe(false);
    expect(safeRel(SID, `${SID}/../../.ssh/authorized_keys`)).toBe(false);
    expect(safeRel(SID, `/${SID}/x`)).toBe(false);
    expect(safeRel(SID, `${SID}x/y`)).toBe(false);
    expect(safeRel("../x", "../x.jsonl")).toBe(false);
    expect(!validSid("a/b") && !validSid("") && validSid(SID)).toBe(true);
  });

  test("sessions_are_gathered_and_placed_under_the_project_slug", () => {
    const root = tmp("place");
    const env = { home: join(root, "home"), overlays: () => [] as string[] };
    const sid = "5d1e0c55-aaaa-4bbb-8ccc-0123456789ab";
    try {
      const cfg = join(root, "from");
      const old = join(cfg, "projects", "-src-app");
      mkdirSync(join(old, sid, "subagents"), { recursive: true });
      writeFileSync(join(old, `${sid}.jsonl`), '{"a":1}\n');
      writeFileSync(join(old, sid, "subagents", "agent-1.jsonl"), "{}\n");
      const files = sessionFiles(env, cfg, sid);
      if (files === null) throw new Error("found");
      files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      expect(files.map(([r]) => r)).toEqual([`${sid}.jsonl`, `${sid}/subagents/agent-1.jsonl`]);
      // On the target: its account's folder for its own path of the project.
      const cwd = join(root, "elsewhere", "app");
      mkdirSync(cwd, { recursive: true });
      const dir = sessionDir(env.home, join(root, "to"), cwd);
      placeSessionFiles(dir, sid, files);
      expect(readFileSync(join(dir, `${sid}.jsonl`), "utf8")).toBe('{"a":1}\n');
      expect(existsSync(join(dir, sid, "subagents", "agent-1.jsonl"))).toBe(true);
      // A bad place: nothing written.
      const other = join(root, "other");
      const first = files[0];
      if (!first) throw new Error("no files");
      expect(() =>
        placeSessionFiles(other, sid, [
          [`${sid}.jsonl`, first[1]],
          ["../evil", first[1]],
        ]),
      ).toThrow();
      expect(existsSync(other)).toBe(false);
      expect(sessionFiles(env, cfg, "no-such-session")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dirty_folders_dont_move", async () => {
    const root = tmp("code");
    const plain = tmp("plain");
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "commit", "-q", "--allow-empty", "-m", "x");
      git(root, "remote", "add", "origin", "git@github.com:sam/app.git");
      const env = { home: tmp("home") };
      const c = await codeState(env, root, false);
      expect([c.branch, normalizeRemote(c.remote)]).toEqual(["main", "github.com/sam/app"]);
      expect(c.sha).not.toBe("");
      writeFileSync(join(root, "new.txt"), "x");
      const e = await codeState(env, root, false).catch((x: Error) => x.message);
      expect(e).toContain("1 uncommitted change");
      expect(e).toContain("commit or stash");
      // Not a git folder: nothing to check.
      expect(await codeState(env, plain, false)).toEqual(NO_MOVE_CODE);
      rmSync(env.home, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("movepc beyond the Rust tests", () => {
  test("a worktree branch is pushed and checked out on the other side", async () => {
    const root = tmp("wt");
    try {
      const remote = join(root, "remote.git");
      const src = join(root, "src");
      const dst = join(root, "dst");
      const wtRoot = join(root, "worktrees");
      mkdirSync(remote);
      git(remote, "init", "-q", "--bare");
      mkdirSync(src);
      git(src, "init", "-q", "-b", "main");
      git(src, "commit", "-q", "--allow-empty", "-m", "base");
      git(src, "remote", "add", "origin", remote);
      git(src, "push", "-q", "origin", "main");
      git(src, "checkout", "-q", "-b", "harbor/ab12cd");
      writeFileSync(join(src, "f.txt"), "work");
      git(src, "add", "f.txt");
      git(src, "commit", "-q", "-m", "work");
      expect(await remoteUrl(src)).toBe(remote);
      expect((await gitHead(src))?.branch).toBe("harbor/ab12cd");
      await pushBranch(src, "harbor/ab12cd", remote);
      execFileSync("git", ["clone", "-q", remote, dst]);
      const dir = await fetchWorktree({ root: wtRoot, newId: () => "ffffff" }, dst, "harbor/ab12cd", remote);
      expect(dir).toBe(join(wtRoot, "dst-ab12cd"));
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("work");
      const head = await gitHead(dir);
      expect(head && gitHeadLabel(head)).toBe("harbor/ab12cd");
      // The folder name is taken: a fresh id.
      const again = await fetchWorktree({ root: wtRoot, newId: () => "ffffff" }, dst, "harbor/ab12cd", remote).catch((e: Error) => e.message);
      expect(again).toContain("couldn't check out harbor/ab12cd");
      await expect(pushBranch(src, "nope", remote)).rejects.toThrow("couldn't push nope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the handoff asks, uploads and adopts; only the answer decides", async () => {
    const root = tmp("send");
    try {
      const file = join(root, "s.jsonl");
      writeFileSync(file, "{}\n");
      const calls: string[] = [];
      const h: MoveHandoff = {
        dest: NOWHERE,
        peer: "laptop",
        check: moveCheckBody({ gid: "g1", email: "a@example.com", project: null, from: "desk", code: { branch: "b", sha: "1", worktree: false, remote: "" } }),
        payload: Buffer.from("{}"),
        sessions: [[SID, [[`${SID}.jsonl`, file]]]],
        push: null,
      };
      const http = async (_d: Dest, method: string, path: string, body: { data: string | Uint8Array } | null): Promise<[number, unknown]> => {
        calls.push(`${method} ${path}`);
        if (path === "/mesh/v1/adopt/check") return [200, { ok: true, owns: false }];
        if (path.startsWith("/mesh/v1/upload")) return [201, { id: `u/${calls.length}` }];
        const sent = JSON.parse(typeof body?.data === "string" ? body.data : "{}") as Record<string, unknown>;
        expect(sent.payload).toBe("u/2");
        expect(sent.sessions).toEqual([{ sid: SID, files: [{ rel: `${SID}.jsonl`, upload: "u/3" }] }]);
        return [200, { ok: true, ids: { g1: 41 } }];
      };
      const done = await sendHandoff(h, { http });
      expect(done).toEqual({ kind: "done", ids: new Map([["g1", 41]]) });
      expect(calls).toEqual(["POST /mesh/v1/adopt/check", "POST /mesh/v1/upload?name=move.json", `POST /mesh/v1/upload?name=${SID}.part`, "POST /mesh/v1/adopt"]);

      const old = await sendHandoff(h, { http: async () => [404, null] });
      expect(old).toEqual({ kind: "refused", why: "laptop runs an older Harbor: update it first" });
      const no = await sendHandoff(h, { http: async () => [200, { ok: false, why: "no project" }] });
      expect(no).toEqual({ kind: "refused", why: "no project" });

      // adopt gets no answer; the target says it never took the chat.
      let n = 0;
      const lost = async (_d: Dest, _m: string, path: string): Promise<[number, unknown]> => {
        if (path === "/mesh/v1/adopt/check") return n++ === 0 ? [200, { ok: true }] : [200, { owns: false, busy: false }];
        if (path.startsWith("/mesh/v1/upload")) return [201, { id: "u/x" }];
        return [503, { error: "slow" }];
      };
      expect(await sendHandoff(h, { http: lost, sleep: async () => undefined })).toEqual({ kind: "refused", why: "laptop didn't take it (slow)" });
      // ... or it never answers at all.
      n = 0;
      const silent = async (_d: Dest, _m: string, path: string): Promise<[number, unknown]> => {
        if (path === "/mesh/v1/adopt/check") return n++ === 0 ? [200, { ok: true }] : [200, { owns: false, busy: true }];
        if (path.startsWith("/mesh/v1/upload")) return [201, { id: "u/x" }];
        throw new Error("timed out");
      };
      expect(await sendHandoff(h, { http: silent, sleep: async () => undefined })).toEqual({ kind: "unknown", why: "timed out" });
      expect(moveOutcomeText("laptop", { kind: "unknown", why: "timed out" }).notice).toContain("no answer yet (timed out)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the target checks, plans and adopts", async () => {
    const root = tmp("adopt");
    try {
      const uploads = join(root, "uploads");
      mkdirSync(join(uploads, "up"), { recursive: true });
      const payload = { chats: [{ gid: "g1", title: "t", session_id: SID, started: true, role: "chat", parent: null, name: "", items: [] }] };
      writeFileSync(join(uploads, "up", "move.json"), JSON.stringify(payload));
      writeFileSync(join(uploads, "up", "s.part"), "{}\n");
      writeFileSync(join(uploads, "up", "bad.part"), "{}\n");
      const accounts: MoveAccount[] = [{ id: "claude", email: "a@example.com", usable: true, usage: [0, 0], configDir: join(root, "cfg"), short: "Claude" }];
      const taken: string[] = [];
      const app: MoveTargetApp = {
        meName: () => "laptop",
        home: join(root, "home"),
        accounts: () => accounts,
        defaultAccount: () => "claude",
        candidates: () => [{ id: 5, name: "app", folder: "app", remote: "" }],
        repo: (id) => (id === 5 ? { name: "app", dir: join(root, "app") } : null),
        isCheckout: async () => true,
        owned: (g) => (taken.includes(g) ? new Map([[g, 9]]) : null),
        chatOf: () => null,
        adopting: new Set(),
        uploadsDir: uploads,
        worktree: { root: join(root, "wt"), newId: () => "000000" },
        removeWorktree: async () => undefined,
        take: (_peer, chats) => {
          taken.push("g1");
          return new Map([["g1", chats.length + 8]]);
        },
      };
      mkdirSync(join(root, "app"));
      const check = moveCheckBody({ gid: "g1", email: "A@example.com", project: { name: "app", folder: "app", remote: "" }, from: "desk", code: { branch: "", sha: "", worktree: false, remote: "" } });
      expect((await moveCheck(app, "pc1", check)).body).toEqual({ ok: true, owns: false, project: "app", account: "Claude" });
      expect((await moveCheck(app, "pc1", { ...check, kind: "codex" })).body).toEqual({ ok: false, owns: false, why: "laptop only takes Claude chats for now" });
      expect((await moveCheck(app, "pc1", { gid: "" })).status).toBe(400);
      expect((await moveCheck(app, "pc1", { gid: "g2" })).body).toEqual({ ok: false, owns: false, busy: false });
      const missing = { ...check, project: { name: "zzz", folder: "zzz", remote: "git@github.com:a/b.git" } };
      expect(((await moveCheck(app, "pc1", missing)).body as { why: string }).why).toBe("laptop has no project for zzz (git@github.com:a/b.git): clone it there and add it to Harbor first");

      const body = { ...check, payload: "up/move.json", sessions: [{ sid: SID, files: [{ rel: `${SID}.jsonl`, upload: "up/s.part" }] }], deadline_ms: deadlineMs() };
      expect((await moveAdopt(app, "pc1", { ...body, deadline_ms: 1 })).body).toEqual({ error: "the call came too late" });
      const escape = { ...body, sessions: [{ sid: SID, files: [{ rel: "../x", upload: "up/bad.part" }] }] };
      expect((await moveAdopt(app, "pc1", escape)).body).toEqual({ error: "refused a session file outside its folder: ../x" });
      expect((await moveAdopt(app, "pc1", { ...body, payload: "up/none.json" })).status).toBe(400);
      const r = await moveAdopt(app, "pc1", body);
      expect(r.body).toEqual({ ok: true, ids: { g1: 9 } });
      expect(readFileSync(join(sessionDir(app.home, join(root, "cfg"), join(root, "app")), `${SID}.jsonl`), "utf8")).toBe("{}\n");
      expect(existsSync(join(uploads, "up", "move.json"))).toBe(false);
      expect(app.adopting.size).toBe(0);
      // A call that comes again after the answer was lost: already ours.
      expect((await moveAdopt(app, "pc1", body)).body).toEqual({ ok: true, ids: { g1: 9 } });
      expect(MOVE_MAX_FILES).toBe(4000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blockers, targets and reconciling", () => {
    const sub = { id: 2, name: "helper", device: "", claude: true, running: false };
    const lead = { id: 1, name: "lead", device: "", claude: true, running: false };
    const base = { foreignHome: null, isSub: false, meshOn: true, movingTo: null, chats: [lead, sub] };
    expect(movePcBlocker(base)).toBeNull();
    expect(movePcBlocker({ ...base, foreignHome: "desk" })).toBe("this chat is desk's: move it from there");
    expect(movePcBlocker({ ...base, meshOn: false })).toBe("this PC doesn't share chats with other PCs (Settings › Workspace)");
    expect(movePcBlocker({ ...base, chats: [lead, { ...sub, running: true }] })).toBe("its sub-agent helper is running: move it once its turn ends");
    expect(movePcBlocker({ ...base, chats: [lead, { ...sub, claude: false }] })).toBe("its sub-agent helper isn't a Claude chat: only Claude chats move to another PC for now");
    expect(movePcBlocker({ ...base, chats: [lead, { ...sub, device: "ssh:1" }] })).toBe("its sub-agent helper runs on another device than its lead");

    const hosts = [
      newPeer({ id: "me", name: "desk", online: true }),
      newPeer({ id: "a", name: "a-pc", online: true, moves: true, accounts: [["claude", "Claude", "claude"]] }),
      newPeer({ id: "b", name: "", online: true, moves: false }),
      newPeer({ id: "c", name: "c-pc", online: false, fp: "fp-c" }),
      newPeer({ id: "d", name: "hidden", online: false, fp: "fp-d" }),
    ];
    const targets = movePcTargets({ blocker: null, meId: "me", hosts, allowedFp: (fp) => fp === "fp-c", downOf: () => "harbor" });
    expect(targets.map((t) => [t.id, t.why])).toEqual([
      ["a", null],
      ["b", "it runs an older Harbor: update it first"],
      ["c", "Harbor isn't running there"],
    ]);
    expect(apiMoveTargets(null, targets, "x has 2 uncommitted changes: commit or stash them first")).toMatchObject({ why: "x has 2 uncommitted changes: commit or stash them first" });

    const moving = new Map<string, [string, string]>([
      ["g1", ["a", "a-pc"]],
      ["g2", ["a", "a-pc"]],
      ["g3", ["z", "z-pc"]],
    ]);
    const r = moveReconcile(moving, new Set(["g2"]), "a", { chats: [{ gid: "g1", id: 7 }], full: true });
    expect(r.release.map(([g]) => g)).toEqual(["g1"]);
    expect(r.stays).toEqual([]);
    expect(moveReconcile(moving, new Set(), "a", { chats: [], full: true }).stays).toEqual([
      ["g1", "a-pc"],
      ["g2", "a-pc"],
    ]);
    expect(moveReconcile(moving, new Set(), "a", { chats: [], full: false }).stays).toEqual([]);
  });

  test("pending moves are kept in kv; texts", async () => {
    const kv = new MemKv();
    const l = new MovepcLocal();
    l.moving.set("g1", ["a", "a-pc"]);
    l.save(kv);
    expect(kv.get("move_pc")).toBe('{"g1":["a","a-pc"]}');
    const m = new MovepcLocal();
    m.load(kv);
    expect(m.movingTo("g1", 1)).toBe("a-pc");
    m.relocating.set(2, "dev");
    expect(m.movingTo("g9", 2)).toBe("dev");
    kv.set("move_pc", "[1]");
    m.load(kv);
    expect(m.moving.size).toBe(0);

    expect(movedHereDetail({ accountShort: "Claude", project: "~/app", worktreeName: null, from: "desk", code: { branch: "main", sha: "abc" }, checkout: { label: "dev", sha: "def" } })).toBe(
      "It runs as Claude here, in ~/app. On desk it was on main at abc; here the checkout is on dev at def.",
    );
    expect(receivedChat({ gid: "g", items: [1] })).toMatchObject({ gid: "g", role: "chat", parent: null, started: false, items: [1] });
    const items: Json = [{ a: 1 }];
    expect(movePayload([{ gid: "g", title: "", session_id: "", started: false, model: "", effort: "", access: "", settled: false, retired: false, role: "chat", parent: null, name: "", items }]).toString()).toBe(
      wire({ chats: [{ access: "", effort: "", gid: "g", items, model: "", name: "", parent: null, retired: false, role: "chat", session_id: "", settled: false, started: false, title: "" }] }),
    );
    const http = async (_d: Dest, _m: string, path: string, body: { data: string | Uint8Array } | null): Promise<[number, unknown]> => {
      expect(path).toBe("/mesh/v1/call");
      expect(body?.data).toBe('{"body":null,"method":"GET","path":["v1","chats","12","move_targets"]}');
      return [200, { why: null, targets: [{ id: "a", name: "a-pc", why: "off" }] }];
    };
    expect(await askMoveTargets(NOWHERE, 12, http)).toEqual({ why: null, targets: [{ id: "a", name: "a-pc", why: "off" }] });
    await expect(askMoveTargets(NOWHERE, 12, async () => [404, null])).rejects.toThrow("its PC runs an older Harbor");
  });
});
