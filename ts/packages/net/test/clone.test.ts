import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@harbor/store";
import {
  CloneState,
  cloneAction,
  cloneFetch,
  cloneFetchInto,
  cloneFolderJson,
  cloneNormalize,
  cloneProjectOwner,
  clonePlace,
  cloneRun,
  cloneSame,
  cloneable,
  findClone,
  homeRelative,
  ranOnOwnerDrops,
  type CloneRepo,
} from "../src/clone.ts";
import type { ProcOptions, ProcOutput, Spawner } from "../src/proc.ts";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `clone-${tag}-`));
}

const repo = (id: number, over: Partial<CloneRepo> = {}): CloneRepo => ({ id, name: `p${id}`, path: `/home/owner/code/p${id}`, dir: `/home/owner/code/p${id}`, remote: "", ...over });

interface Call {
  program: string;
  args: string[];
  o: ProcOptions;
}

function recorder(over: (c: Call) => ProcOutput | null = () => null): { run: Spawner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Spawner = async (program, args, o) => {
    const c = { program, args, o };
    calls.push(c);
    return over(c) ?? { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { run, calls };
}

describe("clone", () => {
  test("remotes_normalize", () => {
    const all = [
      "git@github.com:Owner/Proj.git",
      "https://github.com/owner/proj",
      "https://github.com/owner/proj.git",
      "https://github.com/owner/proj/",
      "ssh://git@github.com/owner/proj.git",
      "ssh://git@github.com:22/owner/proj",
      "https://user:token@github.com/owner/proj.git",
      "  http://github.com/owner/proj  ",
    ];
    for (const a of all) expect(cloneNormalize(a)).toBe("github.com/owner/proj");
    expect(cloneNormalize("git@gitlab.example.com:group/sub/proj.git")).toBe("gitlab.example.com/group/sub/proj");
    expect(cloneNormalize("")).toBe("");
    expect(cloneSame("git@github.com:a/b.git", "https://github.com/A/B")).toBe(true);
    expect(cloneSame("git@github.com:a/b.git", "git@github.com:a/c.git")).toBe(false);
    expect(cloneSame("", "")).toBe(false);
  });

  test("only_network_remotes_are_cloned", async () => {
    for (const ok of ["https://github.com/o/p.git", "git@github.com:o/p.git", "ssh://git@host.example/o/p", "git://host.example/p", "host.example:p.git"]) expect(cloneable(ok)).toBe(true);
    for (const bad of ["", "--upload-pack=touch /tmp/x", "-u x", "ext::sh -c touch% /tmp/x", "file:///tmp/repo", "/tmp/repo", "../repo", "https://-x/p", "a b:c"]) expect(cloneable(bad)).toBe(false);
    await expect(cloneRun("--upload-pack=true", "/nonexistent/x")).rejects.toThrow("isn't a git remote to clone from");
  });

  test("maps_paths_relative_to_home", () => {
    const home = "/home/me";
    expect(homeRelative("/home/owner/Documents/x/proj", home, "proj")).toBe("/home/me/Documents/x/proj");
    expect(homeRelative("/Users/owner/code/proj", home, "proj")).toBe("/home/me/code/proj");
    expect(homeRelative("/root/proj", home, "proj")).toBe("/home/me/proj");
    expect(homeRelative("/srv/git/proj", home, "proj")).toBe("/home/me/proj");
    expect(homeRelative("/home/owner", home, "proj")).toBe("/home/me/owner");
  });

  test("finds_an_existing_clone", () => {
    const d = tmp("find");
    try {
      const mine = join(d, "mine");
      const other = join(d, "other");
      mkdirSync(mine);
      mkdirSync(other);
      const gone = join(d, "gone");
      const dirs: [string, string][] = [
        [gone, "git@github.com:o/p.git"],
        [other, "https://github.com/o/q"],
        [mine, "https://github.com/O/P"],
      ];
      expect(findClone(dirs, "git@github.com:o/p.git")).toBe(mine);
      expect(findClone(dirs, "git@github.com:o/z.git")).toBeNull();
      expect(findClone([[mine, ""]], "")).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("picks_a_free_place", () => {
    const d = tmp("place");
    try {
      const want = join(d, "proj");
      const origins = new Map([
        [want, "https://github.com/o/other"],
        [join(d, "proj-2"), "git@github.com:o/p.git"],
      ]);
      const origin = (p: string) => origins.get(p) ?? null;
      // Nothing there: clone into it.
      expect(clonePlace(want, "git@github.com:o/p.git", origin)).toEqual({ kind: "free", dir: want });
      // Another repository there: the next free name.
      mkdirSync(join(want, "src"), { recursive: true });
      expect(clonePlace(want, "git@github.com:o/q.git", origin)).toEqual({ kind: "free", dir: join(d, "proj-2") });
      // The same repository beside it: that one.
      mkdirSync(join(d, "proj-2/src"), { recursive: true });
      expect(clonePlace(want, "https://github.com/o/p", origin)).toEqual({ kind: "found", dir: join(d, "proj-2") });
      // An empty folder is free.
      mkdirSync(join(d, "proj-3"));
      expect(clonePlace(want, "git@github.com:o/q.git", origin)).toEqual({ kind: "free", dir: join(d, "proj-3") });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("clone beyond the Rust tests", () => {
  test("cloneRun uses gh for a signed-in GitHub repository, git otherwise, and says what failed", async () => {
    const d = tmp("run");
    try {
      const gh = recorder();
      await cloneRun("git@github.com:o/p.git", join(d, "a/b"), { run: gh.run, ghSignedIn: async () => true });
      expect(gh.calls[0]?.program).toBe("gh");
      expect(gh.calls[0]?.args).toEqual(["repo", "clone", "o/p", join(d, "a/b"), "--", "-q"]);
      expect(gh.calls[0]?.o.env).toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
      expect(existsSync(join(d, "a"))).toBe(true);

      const git = recorder();
      await cloneRun("git@github.com:o/p.git", join(d, "c"), { run: git.run, ghSignedIn: async () => false });
      expect(git.calls[0]).toMatchObject({ program: "git", args: ["clone", "-q", "--", "git@github.com:o/p.git", join(d, "c")] });

      const fail = recorder(() => ({ code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("Cloning into 'x'...\nfatal: repository not found\n\n") }));
      await expect(cloneRun("https://example.org/o/p", join(d, "e"), { run: fail.run })).rejects.toThrow("fatal: repository not found");
      const quiet = recorder(() => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
      await expect(cloneRun("https://example.org/o/p", join(d, "e"), { run: quiet.run })).rejects.toThrow("the clone failed");
      const broken: Spawner = async () => {
        throw new Error("not found");
      };
      await expect(cloneRun("https://example.org/o/p", join(d, "e"), { run: broken })).rejects.toThrow("git: not found");
      // gh's own sign-in check runs through the runner too.
      const probe = recorder((c) => (c.program === "gh" && c.args[0] === "auth" ? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : null));
      await cloneRun("https://github.com/o/p", join(d, "f"), { run: probe.run });
      expect(probe.calls.map((c) => c.program)).toEqual(["gh", "git"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("cloneFetch reuses a clone of the same remote and skips one of another", async () => {
    const d = tmp("fetch");
    try {
      const want = join(d, "proj");
      mkdirSync(join(want, "src"), { recursive: true });
      const asked: string[] = [];
      const seen = (origin: Record<string, string>) =>
        recorder((c) => {
          const dir = c.args[c.args.indexOf("-C") + 1] ?? "";
          if (c.args.includes("get-url")) {
            asked.push(dir);
            const u = origin[dir];
            return u === undefined ? { code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("no origin") } : { code: 0, stdout: Buffer.from(`${u}\n`), stderr: Buffer.alloc(0) };
          }
          return null;
        });
      const same = seen({ [want]: "https://github.com/O/P" });
      expect(await cloneFetch("git@github.com:o/p.git", want, { run: same.run })).toBe(want);
      expect(same.calls.some((c) => c.args[0] === "clone")).toBe(false);
      // Another repository there: clone beside it.
      const other = seen({ [want]: "https://github.com/o/other" });
      expect(await cloneFetch("git@github.com:o/p.git", want, { run: other.run, ghSignedIn: async () => false })).toBe(`${want}-2`);
      expect(other.calls.at(-1)?.args).toEqual(["clone", "-q", "--", "git@github.com:o/p.git", `${want}-2`]);
      // Clone here into a folder the person picked.
      const picked = join(d, "picked");
      mkdirSync(picked);
      const into = seen({});
      expect(await cloneFetchInto("git@github.com:o/p.git", picked, "p", d, { run: into.run, ghSignedIn: async () => false })).toBe(picked);
      expect(into.calls.at(-1)?.args.at(-1)).toBe(picked);
      writeFileSync(join(picked, "x.txt"), "x");
      expect(await cloneFetchInto("git@github.com:o/p.git", picked, "p", d, { run: seen({}).run, ghSignedIn: async () => false })).toBe(join(picked, "p"));
      expect(await cloneFetchInto("git@github.com:o/p.git", picked, "p", d, { run: seen({ [picked]: "https://github.com/o/p" }).run })).toBe(picked);
      // No remote: only a folder with files will do.
      expect(await cloneFetchInto("", picked, "p", d)).toBe(picked);
      await expect(cloneFetchInto("", join(d, "none"), "p", d)).rejects.toThrow("doesn't hold its files (it has no Git remote to clone): pick the folder that does");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a turn without its folder waits for a clone, uses another project's, or is held", () => {
    const d = tmp("turn");
    try {
      const st = new CloneState();
      const mine = repo(1, { remote: "git@github.com:o/p.git", dir: join(d, "missing") });
      const same = repo(2, { remote: "https://github.com/o/p", dir: d });
      const turn = { chat: 10, prompt: "go", files: [], home: "/home/me" };
      expect(st.forTurn({ ...turn, worktreeLost: true, repo: mine, repos: [mine] })).toEqual({ kind: "skip" });
      expect(st.forTurn({ ...turn, worktreeLost: false, repo: same, repos: [same] })).toEqual({ kind: "skip" });
      expect(st.forTurn({ ...turn, worktreeLost: false, repo: mine, repos: [mine, same] })).toEqual({ kind: "use", repo: 1, dir: d });
      expect(st.held.size).toBe(0);
      const start = st.forTurn({ ...turn, worktreeLost: false, repo: mine, repos: [mine] });
      expect(start).toEqual({ kind: "start", repo: 1, want: "/home/me/code/p1" });
      expect(st.begin(mine, "/home/me/code/p1", "/home/me")).toEqual({ text: "Cloning p1…", detail: "git@github.com:o/p.git into ~/code/p1" });
      expect(st.forTurn({ ...turn, chat: 11, worktreeLost: false, repo: mine, repos: [mine] })).toEqual({ kind: "wait" });
      expect(st.held.get(1)?.map((h) => h.chat)).toEqual([10, 11]);
      // No remote: held for "Use a folder here".
      const plain = repo(3, { dir: join(d, "nope") });
      expect(st.forTurn({ ...turn, worktreeLost: false, repo: plain, repos: [plain] })).toEqual({ kind: "skip" });
      expect(st.held.get(3)?.length).toBe(1);
      expect(st.begin(plain, "/home/me/x", "/home/me").text).toBe("Looking for p3 in ~/x…");

      // The clone worked: a notice per chat, the turn starts (or queues behind a running one).
      const out = st.finished({ repo: mine, repoId: 1, result: { ok: true, dir: join(d, "cloned") }, repos: [mine], home: "/home/me", turnRunning: (c) => c === 11, missingFolder: () => null });
      expect(out).toMatchObject({ kind: "ok", untrusted: true });
      if (out.kind === "ok") {
        expect(out.steps.map((s) => s.do)).toEqual(["notice", "start", "notice", "queue"]);
        expect(out.steps[0]).toEqual({ do: "notice", chat: 10, text: `p1 is at ${join(d, "cloned")}` });
      }
      expect(st.running.has(1)).toBe(false);
      expect(st.held.has(1)).toBe(false);

      // It failed: the turns stay held, each chat gets the reason once.
      st.forTurn({ ...turn, worktreeLost: false, repo: mine, repos: [mine] });
      st.forTurn({ ...turn, worktreeLost: false, repo: mine, repos: [mine] });
      st.running.set(1, "x");
      const bad = st.finished({ repo: mine, repoId: 1, result: { ok: false, error: "no access" }, repos: [mine], home: "/home/me", turnRunning: () => false, missingFolder: () => "p1 isn't here." });
      expect(bad).toEqual({ kind: "failed", error: "no access", errors: [{ chat: 10, text: "p1 isn't here.\nCloning it here failed: no access" }] });
      expect(st.failed.get(1)).toBe("no access");
      expect(st.held.get(1)?.length).toBe(2);
      st.dropChat(10);
      expect(st.held.get(1)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("clone here, the folder line and run on the owner", () => {
    const d = tmp("line");
    try {
      const st = new CloneState();
      const r = repo(1, { remote: "git@github.com:o/p.git", dir: join(d, "missing"), path: "/home/owner/code/p1" });
      const chat = { foreign: false, repo: r };
      expect(st.cloneHere({ chat: null, picked: "/x" })).toEqual({ ok: false, error: "no such chat here" });
      expect(st.cloneHere({ chat: { foreign: true, repo: r }, picked: "/x" })).toEqual({ ok: false, error: "no such chat here" });
      expect(st.cloneHere({ chat: { foreign: false, repo: null }, picked: "/x" })).toEqual({ ok: false, error: "this chat has no project" });
      expect(st.cloneHere({ chat: { foreign: false, repo: { ...r, dir: d } }, picked: "/x" })).toEqual({ ok: false, error: "p1 is already on this PC" });
      expect(st.cloneHere({ chat, picked: "rel/path" })).toEqual({ ok: false, error: "give a full path" });
      st.failed.set(1, "old");
      expect(st.cloneHere({ chat, picked: "/x" })).toEqual({ ok: true, repo: r });
      expect(st.failed.has(1)).toBe(false);
      st.running.set(1, "/x");
      expect(st.cloneHere({ chat, picked: "/x" })).toEqual({ ok: false, error: "p1 is being cloned already" });
      st.running.delete(1);

      const line = (owner: [string, string] | null) => st.folderLine({ chat: { foreign: false, device: "" }, repo: r, worktreeLost: false, owner, home: "/home/me" });
      expect(line(null)?.text).toBe("p1's folder (/home/owner/code/p1) isn't on this PC.");
      expect(line(["pc:o", "owner-pc"])?.text).toBe("p1 isn't on this PC: it's on owner-pc.");
      expect(line(["pc:o", "owner-pc"])?.suggested).toBe("/home/me/code/p1");
      const plain = { ...r, remote: "" };
      expect(st.folderLine({ chat: { foreign: false, device: "" }, repo: plain, worktreeLost: false, owner: ["pc:o", "owner-pc"], home: "/home/me" })?.text).toBe("p1 isn't on this PC: it's on owner-pc, without Git to clone it.");
      st.failed.set(1, "no access");
      expect(line(null)?.text).toBe("p1 isn't on this PC and couldn't be cloned: no access");
      st.running.set(1, "/home/me/code/p1");
      expect(line(null)).toMatchObject({ text: "Cloning p1 into ~/code/p1…", cloning: true });
      expect(st.folderLine({ chat: { foreign: true, device: "" }, repo: r, worktreeLost: false, owner: null, home: "/home/me" })).toBeNull();
      expect(st.folderLine({ chat: { foreign: false, device: "ssh:1" }, repo: r, worktreeLost: false, owner: null, home: "/home/me" })).toBeNull();
      expect(st.folderLine({ chat: { foreign: false, device: "" }, repo: { ...r, dir: d }, worktreeLost: false, owner: null, home: "/home/me" })).toBeNull();
      expect(cloneAction({ cloneable: false })[0]).toBe("Use a folder here");
      st.running.clear();
      st.failed.clear();
      expect(cloneFolderJson(line(["pc:o", "owner-pc"]))).toEqual({
        text: "p1 isn't on this PC: it's on owner-pc.",
        cloning: false,
        owner: { id: "pc:o", name: "owner-pc" },
        suggested: "/home/me/code/p1",
        action: "Clone here",
        action_note: "The project is cloned into this folder on the PC, or used from it when it's already there.",
      });
      expect(cloneFolderJson(null)).toBeNull();

      const files = join(d, "f.txt");
      writeFileSync(files, "x");
      const items: Item[] = [
        { kind: "user", text: "first", files: [], at: 1, mentions: [], sender: "", intent: "" },
        { kind: "user", text: "last", files: [files, join(d, "gone.txt")], at: 2, mentions: [], sender: "", intent: "" },
      ];
      const c = { foreign: false, id: 5, account: "claude", model: "m", effort: "e", access: "a", repo: r };
      const owner: [string, string] = ["pc:o", "owner-pc"];
      expect(st.takeRunOnOwner({ chat: c, owner: null, ownerOnline: true, items })).toEqual({ ok: false, error: "no other PC shares this project" });
      expect(st.takeRunOnOwner({ chat: c, owner, ownerOnline: false, items })).toEqual({ ok: false, error: "owner-pc is off: try again once it's back" });
      expect(st.takeRunOnOwner({ chat: c, owner, ownerOnline: true, items: [] })).toEqual({ ok: false, error: "this chat has no message to send" });
      const last = st.takeRunOnOwner({ chat: c, owner, ownerOnline: true, items });
      expect(last).toMatchObject({ ok: true, peer: "pc:o", text: "last", files: [files] });
      if (last.ok) expect(last.body).toEqual({ project: { name: "p1", path: "/home/owner/code/p1", remote: "git@github.com:o/p.git" }, account: "claude", model: "m", effort: "e", access: "a", device: "", text: "last" });
      st.held.set(1, [{ chat: 5, prompt: "waiting", files: ["/a"] }]);
      expect(st.takeRunOnOwner({ chat: c, owner, ownerOnline: true, items })).toMatchObject({ ok: true, text: "waiting", files: ["/a"] });
      expect(st.held.get(1)).toEqual([]);

      expect(cloneProjectOwner(1, [{ repoId: 1, foreign: false, home: "", homeName: "" }, { repoId: 1, foreign: true, home: "pc:o", homeName: "owner-pc" }])).toEqual(["pc:o", "owner-pc"]);
      expect(cloneProjectOwner(2, [])).toBeNull();
      expect(ranOnOwnerDrops({ started: false, foreign: false }, false)).toBe(true);
      expect(ranOnOwnerDrops({ started: true, foreign: false }, false)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
