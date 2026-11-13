// Continue anywhere's portable parts (carry.ts): paths moved between Linux, macOS and Windows, and the work in a
// folder carried between two clones of one repository with git itself.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continuedNotice, gitApply, gitSnapshot, packFolder, remapPaths, remapSession, sessionParts, unpackFolder, type PathSpace, type WorkIndex, workLines } from "../src/carry.ts";

const root = mkdtempSync(join(tmpdir(), "hcarry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const linux: PathSpace = { cwd: "/home/sam/Projects/app", home: "/home/sam", win: false };
const mac: PathSpace = { cwd: "/Users/sam/Projects/app", home: "/Users/sam", win: false };
const win: PathSpace = { cwd: "C:\\Users\\sam\\Projects\\app", home: "C:\\Users\\sam", win: true };

describe("paths across PCs", () => {
  test("Linux to macOS: the folder and the home", () => {
    expect(remapPaths("edit /home/sam/Projects/app/src/a.ts and /home/sam/.config/x", linux, mac)).toBe("edit /Users/sam/Projects/app/src/a.ts and /Users/sam/.config/x");
  });
  test("Linux to Windows: separators of what follows turn too", () => {
    expect(remapPaths("cd /home/sam/Projects/app/src && cat /home/sam/Projects/app/b/c.ts:12", linux, win)).toBe("cd C:\\Users\\sam\\Projects\\app\\src && cat C:\\Users\\sam\\Projects\\app\\b\\c.ts:12");
  });
  test("Windows to Linux, either separator, any case", () => {
    expect(remapPaths("C:\\Users\\sam\\Projects\\app\\src\\a.ts", win, linux)).toBe("/home/sam/Projects/app/src/a.ts");
    expect(remapPaths("c:/users/sam/Projects/app/x.ts", win, linux)).toBe("/home/sam/Projects/app/x.ts");
  });
  test("a longer name that only starts like the folder stays", () => {
    expect(remapPaths("/home/sam/Projects/app2/x and /home/samuel/y", linux, mac)).toBe("/Users/sam/Projects/app2/x and /home/samuel/y");
  });
  test("the project's folder elsewhere than under home", () => {
    const from = { cwd: "/srv/work/app", home: "/home/sam", win: false };
    const to = { cwd: "D:\\code\\app", home: "C:\\Users\\kim", win: true };
    expect(remapPaths('{"file":"/srv/work/app/lib/x.ts"} ~ /home/sam/notes.md', from, to)).toBe('{"file":"D:\\code\\app\\lib\\x.ts"} ~ C:\\Users\\kim\\notes.md');
  });
  test("a session's lines: strings in JSON moved, keys and other text kept", async () => {
    const lines = [
      JSON.stringify({ type: "user", cwd: "/home/sam/Projects/app", sessionId: "s1", message: { content: [{ type: "tool_use", input: { file_path: "/home/sam/Projects/app/src/a.ts" } }] } }),
      "",
      "not json /home/sam/Projects/app/x",
    ].join("\n");
    const out = await remapSession(lines, linux, win);
    const first = JSON.parse(out.split("\n")[0] as string);
    expect(first.cwd).toBe("C:\\Users\\sam\\Projects\\app");
    expect(first.message.content[0].input.file_path).toBe("C:\\Users\\sam\\Projects\\app\\src\\a.ts");
    expect(first.sessionId).toBe("s1");
    expect(out.split("\n")[2]).toBe("not json C:\\Users\\sam\\Projects\\app\\x");
  });
  test("a session's parts: appending changes only the last ones", () => {
    const a = new Uint8Array(2500).fill(1);
    const b = new Uint8Array(3100).fill(1);
    const pa = sessionParts(a, 1000);
    const pb = sessionParts(b, 1000);
    expect(pa.length).toBe(3);
    expect(pb.length).toBe(4);
    expect(pb.slice(0, 2)).toEqual(pa.slice(0, 2));
    expect(pb[2]).not.toBe(pa[2]);
  });
});

// ---- git

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const scratch = join(root, "scratch");
let wtn = 0;
const worktree = (repo: string) => async (head: string) => {
  const d = join(root, `wt-${++wtn}`);
  git(repo, "worktree", "add", "-q", "--detach", d, head);
  return d;
};
const read = (p: string) => readFileSync(p, "utf8");

function origin(): { bare: string; clone: (name: string) => string } {
  const bare = join(root, `origin-${Math.random().toString(36).slice(2)}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = join(root, `seed-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "a.txt"), "one\n");
  writeFileSync(join(seed, "del.txt"), "bye\n");
  writeFileSync(join(seed, ".gitignore"), "ignored/\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c1");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return {
    bare,
    clone: (name) => {
      const d = join(root, name);
      execFileSync("git", ["clone", "-q", bare, d], { stdio: "ignore" });
      return d;
    },
  };
}

/** The folder's work as carried, and the chain the next PC records. */
async function snap(dir: string, chain: [string, string][] = []) {
  const s = await gitSnapshot(dir, { scratch, name: "app", worktree: false, chain });
  if (s === null) throw new Error("no snapshot");
  return s;
}
const chainAfter = (w: WorkIndex): [string, string][] => [[w.head, w.tree], ...w.chain];

describe("work in a git folder", () => {
  test("a clean pushed folder carries nothing but where it is", async () => {
    const o = origin();
    const a = o.clone("clean-a");
    const s = await snap(a);
    expect(s.index.dirty).toBe(false);
    expect(s.index.commits).toBe(0);
    expect(s.bytes).toBeNull();
  });

  test("unpushed commits and uncommitted changes go to a fresh clone, and back to the first PC after more work", async () => {
    const o = origin();
    const a = o.clone("pc-a");
    writeFileSync(join(a, "a.txt"), "two\n");
    git(a, "commit", "-q", "-am", "c2 (unpushed)");
    writeFileSync(join(a, "a.txt"), "three\n");
    writeFileSync(join(a, "new.txt"), "brand new\n");
    rmSync(join(a, "del.txt"));
    mkdirSync(join(a, "ignored"));
    writeFileSync(join(a, "ignored", "big.bin"), "x");
    const s = await snap(a);
    expect(s.index.commits).toBe(1);
    expect(s.index.dirty).toBe(true);
    expect(s.bytes).not.toBeNull();
    // A's own folder isn't touched by the snapshot.
    expect(git(a, "status", "--porcelain")).toContain("?? new.txt");
    expect(git(a, "for-each-ref", "refs/harbor")).toBe("");

    const b = o.clone("pc-b");
    const done = await gitApply(b, s.index, s.bytes, { scratch, inPlace: true, worktree: worktree(b) });
    expect(done.how).toBe("moved");
    expect(git(b, "rev-parse", "HEAD")).toBe(s.index.head);
    expect(read(join(b, "a.txt"))).toBe("three\n");
    expect(read(join(b, "new.txt"))).toBe("brand new\n");
    expect(existsSync(join(b, "del.txt"))).toBe(false);
    expect(existsSync(join(b, "ignored"))).toBe(false);
    expect(git(b, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? new.txt", "D del.txt", "M a.txt"]);

    // B goes on: a commit and another change; A comes back exactly as it was published.
    writeFileSync(join(b, "b.txt"), "from b\n");
    git(b, "add", "b.txt");
    git(b, "commit", "-q", "-m", "c3 on b");
    writeFileSync(join(b, "new.txt"), "edited on b\n");
    rmSync(join(b, "a.txt"));
    const sb = await snap(b, chainAfter(s.index));
    const back = await gitApply(a, sb.index, sb.bytes, { scratch, inPlace: true, worktree: worktree(a) });
    expect(back.how).toBe("moved");
    expect(git(a, "rev-parse", "HEAD")).toBe(sb.index.head);
    expect(read(join(a, "new.txt"))).toBe("edited on b\n");
    expect(existsSync(join(a, "a.txt"))).toBe(false);
    expect(read(join(a, "b.txt"))).toBe("from b\n");
    // Ignored files here stay.
    expect(existsSync(join(a, "ignored", "big.bin"))).toBe(true);

    // Once more is a no-op.
    const again = await gitApply(a, sb.index, sb.bytes, { scratch, inPlace: true, worktree: worktree(a) });
    expect(again.how).toBe("same");
  });

  test("changes here that the carried work didn't come from stay: it goes in a worktree", async () => {
    const o = origin();
    const a = o.clone("conf-a");
    writeFileSync(join(a, "a.txt"), "a's edit\n");
    const s = await snap(a);
    const b = o.clone("conf-b");
    writeFileSync(join(b, "a.txt"), "b's own edit\n");
    const done = await gitApply(b, s.index, s.bytes, { scratch, inPlace: true, worktree: worktree(b) });
    expect(done.how).toBe("worktree");
    expect(read(join(b, "a.txt"))).toBe("b's own edit\n");
    expect(read(join(done.dir, "a.txt"))).toBe("a's edit\n");
    expect(git(done.dir, "symbolic-ref", "--short", "HEAD")).toBe("main-continued");
  });

  test("commits here the carried work doesn't have stay on their branch", async () => {
    const o = origin();
    const a = o.clone("div-a");
    writeFileSync(join(a, "a.txt"), "a\n");
    git(a, "commit", "-q", "-am", "a's commit");
    const s = await snap(a);
    const b = o.clone("div-b");
    writeFileSync(join(b, "a.txt"), "b\n");
    git(b, "commit", "-q", "-am", "b's commit");
    const mine = git(b, "rev-parse", "HEAD");
    const done = await gitApply(b, s.index, s.bytes, { scratch, inPlace: true, worktree: worktree(b) });
    expect(done.how).toBe("worktree");
    expect(git(b, "rev-parse", "HEAD")).toBe(mine);
    expect(git(done.dir, "rev-parse", "HEAD")).toBe(s.index.head);
  });

  test("another chat working in the folder: a worktree even when it could move on", async () => {
    const o = origin();
    const a = o.clone("busy-a");
    writeFileSync(join(a, "n.txt"), "n\n");
    const s = await snap(a);
    const b = o.clone("busy-b");
    const done = await gitApply(b, s.index, s.bytes, { scratch, inPlace: false, worktree: worktree(b) });
    expect(done.how).toBe("worktree");
    expect(existsSync(join(b, "n.txt"))).toBe(false);
    expect(read(join(done.dir, "n.txt"))).toBe("n\n");
  });

  test("a pushed commit with no bundle is fetched from the remote", async () => {
    const o = origin();
    const b = o.clone("late-b");
    const a = o.clone("late-a");
    writeFileSync(join(a, "a.txt"), "pushed later\n");
    git(a, "commit", "-q", "-am", "pushed");
    git(a, "push", "-q", "origin", "HEAD:main");
    const s = await snap(a);
    expect(s.bytes).toBeNull();
    const done = await gitApply(b, s.index, null, { scratch, inPlace: true, worktree: worktree(b) });
    expect(done.how).toBe("moved");
    expect(read(join(b, "a.txt"))).toBe("pushed later\n");
  });
});

describe("a folder without Git", () => {
  test("packed and unpacked; heavy folders left out; nothing written outside", async () => {
    const src = join(root, "plain-src");
    mkdirSync(join(src, "sub"), { recursive: true });
    mkdirSync(join(src, "node_modules", "x"), { recursive: true });
    writeFileSync(join(src, "a.md"), "hello");
    writeFileSync(join(src, "sub", "b.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(src, "node_modules", "x", "i.js"), "skip");
    const p = await packFolder(src);
    expect(p.why).toBe("");
    expect(p.files).toBe(2);
    const dst = join(root, "plain-dst");
    expect(await unpackFolder(p.bytes as Uint8Array, dst)).toBe(2);
    expect(read(join(dst, "a.md"))).toBe("hello");
    expect([...readFileSync(join(dst, "sub", "b.bin"))]).toEqual([0, 1, 2, 255]);
    expect(existsSync(join(dst, "node_modules"))).toBe(false);
    expect((await packFolder(src, 3)).why).toContain("too big");
  });
});

describe("what the chat is told", () => {
  test("the notice", () => {
    const w = { kind: "git", commits: 2, dirty: true, why: "" } as WorkIndex;
    const n = continuedNotice("Desk", "Tower", { session: "resumed", work: workLines(w, { dir: "/x", how: "moved", kept: "" }, "Tower", "", "") });
    expect(n.text).toBe("Continued on Desk — Tower is off");
    expect(n.detail).toContain("2 unpushed commits and uncommitted changes came from Tower.");
  });
});
