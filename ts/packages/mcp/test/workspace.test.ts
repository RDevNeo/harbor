import "./sandbox.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { home } from "@harbor/store";
import { forAccess, forget, note, numbered, replace, resolve, TOOLS, tools, call } from "../src/workspace.ts";
import { expectPerm } from "../../../test/perm.ts";

describe("workspace", () => {
  test("replaces_like_claude_edit: replaces like claude edit", () => {
    expect(replace("a b a", "b", "c", false)).toEqual({ text: "a c a", n: 1 });
    expect(replace("a b a", "a", "x", false)).toMatchObject({ error: expect.stringContaining("2 times") });
    expect(replace("a b a", "a", "x", true)).toEqual({ text: "x b x", n: 2 });
    expect(replace("abc", "z", "y", false)).toMatchObject({ error: expect.stringContaining("isn't in the file") });
    expect(replace("abc", "b", "b", false)).toHaveProperty("error");
    expect(replace("", "", "new file\n", false)).toEqual({ text: "new file\n", n: 1 });
    expect(replace("x", "", "y", false)).toHaveProperty("error");
    expect(replace("one\r\ntwo\r\n", "one\ntwo", "1\n2", false)).toEqual({ text: "1\r\n2\r\n", n: 1 });
  });

  test("a replacement text with dollar signs is kept as written", () => {
    expect(replace("a b", "b", "$& $1", false)).toEqual({ text: "a $& $1", n: 1 });
    expect(replace("b b", "b", "$&", true)).toEqual({ text: "$& $&", n: 2 });
  });

  test("paths_and_numbering: paths and numbering", () => {
    const cwd = "/p/proj";
    expect(resolve(cwd, "")).toBe(cwd);
    // Not normalized (a `..` after a link means what the system says): the system's separator after the folder.
    expect(resolve(cwd, "src/a.rs")).toBe(`${cwd}${sep}src/a.rs`);
    expect(resolve(cwd, "/etc/x")).toBe("/etc/x");
    expect(resolve(cwd, "~/x")).toBe(join(home(), "x"));
    expect(resolve(cwd, "~")).toBe(home());
    expect(numbered("a\r\nb\nc\n", 2, 1)).toBe("     2\tb\n");
    expect(numbered("a\nb", 1, 10)).toBe("     1\ta\n     2\tb\n");
    expect(forAccess("plan", false)).toEqual(["read", "glob", "grep"]);
    expect(forAccess("edits", false)).not.toContain("bash");
    expect(forAccess("full", false)).toHaveLength(TOOLS.length);
    expect(forAccess("plan", true)).toEqual(["read", "glob", "grep"]);
    expect(forAccess("edits", true)).toEqual(["read", "glob", "grep"]);
    expect(forAccess("full", true)).toContain("bash");
    expect(tools(forAccess("plan", false))).toHaveLength(3);
  });

  test("a long line is cut at a character boundary", () => {
    const line = "é".repeat(1500);
    const out = numbered(`${line}\n`, 1, 5);
    expect(out.endsWith("… [line cut]\n")).toBe(true);
    expect(out).not.toContain("�");
    expect(out.length).toBeLessThan(1100);
  });

  test("tool definitions keep the names, required fields and read-only hints", () => {
    const defs = tools(TOOLS) as { name: string; inputSchema: { required: string[] }; annotations?: { readOnlyHint: boolean } }[];
    expect(defs.map((d) => d.name)).toEqual([...TOOLS]);
    expect(defs.map((d) => d.inputSchema.required)).toEqual([["command"], ["file_path"], ["file_path", "content"], ["file_path", "old_string", "new_string"], ["pattern"], ["pattern"]]);
    expect(defs.filter((d) => d.annotations?.readOnlyHint).map((d) => d.name)).toEqual(["read", "glob", "grep"]);
  });

  let dir = "";
  let oldHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harbor-ws-"));
    oldHome = process.env.HOME;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const t = (r: { ok: boolean; content: ({ type: string; text?: string } & Record<string, unknown>)[] }): [boolean, string] => [r.ok, r.content[0]?.text ?? ""];

  test("tools_run_in_the_project: tools run in the project", async () => {
    mkdirSync(join(dir, "sub"));
    const id = -7;
    expect(t(await call(dir, id, "write", { file_path: "sub/f.txt", content: "hello\nworld\n" }))[0]).toBe(true);
    expect(t(await call(dir, id, "read", { file_path: join(dir, "sub/f.txt") }))[1]).toBe("     1\thello\n     2\tworld\n");
    expect(t(await call(dir, id, "edit", { file_path: "sub/f.txt", old_string: "world", new_string: "there" }))[0]).toBe(true);
    expect(readFileSync(join(dir, "sub/f.txt"), "utf8")).toBe("hello\nthere\n");
    expect(t(await call(dir, id, "glob", { pattern: "**/*.txt" }))[1].endsWith("sub/f.txt")).toBe(true);
    expect(t(await call(dir, id, "grep", { pattern: "th.re", output_mode: "content" }))[1]).toContain(":2:there");
    expect(t(await call(dir, id, "bash", { command: "cd sub" }))[0]).toBe(true);
    expect(t(await call(dir, id, "bash", { command: 'basename "$PWD"; ls' }))[1]).toBe("sub\nf.txt");
    expect(t(await call(dir, id, "bash", { command: "echo no >&2; exit 3" }))).toEqual([false, "no\n[exit 3]"]);
    expect(t(await call(dir, id, "bash", { command: "sleep 5", timeout: 1000 }))[1]).toContain("stopped");
    forget(id);
  });

  test("bash forgets its folder with the chat", async () => {
    mkdirSync(join(dir, "sub"));
    await call(dir, -8, "bash", { command: "cd sub" });
    forget(-8);
    expect(t(await call(dir, -8, "bash", { command: 'basename "$PWD"' }))[1]).not.toBe("sub");
    forget(-8);
  });

  test("bash can run in the background and says where its output goes", async () => {
    const [ok, msg] = t(await call(dir, -9, "bash", { command: "echo from the background", run_in_background: true }));
    expect(ok).toBe(true);
    const log = /goes to (\S+)\./.exec(msg)?.[1] ?? "";
    expect(msg).toContain("kill -- -");
    expectPerm(log, 0o600);
    for (let i = 0; i < 100 && !readFileSync(log, "utf8").includes("background"); i++) await Bun.sleep(50);
    expect(readFileSync(log, "utf8")).toBe("from the background\n");
    rmSync(log);
  });

  test("errors say what failed", async () => {
    expect(t(await call(dir, 1, "read", {}))).toEqual([false, "file_path is required"]);
    expect(t(await call(dir, 1, "read", { file_path: dir }))[1]).toContain("is a folder");
    expect(t(await call(dir, 1, "read", { file_path: "nope.txt" }))[1]).toContain("No such file or directory (os error 2)");
    expect(t(await call(dir, 1, "bash", { command: "  " }))).toEqual([false, "command is required"]);
    expect(t(await call(dir, 1, "glob", { pattern: "" }))).toEqual([false, "pattern is required"]);
    expect(t(await call(dir, 1, "nothing", {}))).toEqual([false, "No tool nothing here"]);
    expect(t(await call(dir, 1, "edit", { file_path: "new.txt", old_string: "", new_string: "made\n" }))[1]).toContain("1 replacement)");
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("made\n");
    expect(t(await call(dir, 1, "write", { file_path: "a/b/c.txt", content: "é" }))[1]).toContain("(2 bytes)");
    writeFileSync(join(dir, "bin"), Buffer.from([0xff, 0xfe]));
    expect(t(await call(dir, 1, "edit", { file_path: "bin", old_string: "a", new_string: "b" }))[1]).toContain("valid UTF-8");
    expect(t(await call(dir, 1, "read", { file_path: join(dir, "new.txt"), offset: 9 }))[1]).toBe("(the file has 1 lines)");
    writeFileSync(join(dir, "empty"), "");
    expect(t(await call(dir, 1, "read", { file_path: join(dir, "empty") }))[1]).toContain("is empty");
  });

  test("read pages through a long file and returns images", async () => {
    writeFileSync(join(dir, "long.txt"), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n"));
    const first = t(await call(dir, 1, "read", { file_path: "long.txt" }))[1];
    expect(first.split("\n")[1999]).toBe("  2000\tl2000");
    expect(first).toContain("[2500 lines in all; read on with offset]");
    expect(t(await call(dir, 1, "read", { file_path: "long.txt", offset: 2499, limit: 5 }))[1]).toBe("  2499\tl2499\n  2500\tl2500\n");
    writeFileSync(join(dir, "p.PNG"), Buffer.from([1, 2, 3]));
    expect((await call(dir, 1, "read", { file_path: "p.PNG" })).content).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
  });

  test("glob lists the newest first and stops at 100; grep modes and limits", async () => {
    for (let i = 0; i < 105; i++) writeFileSync(join(dir, `f${i}.log`), `needle ${i}\nhay\n`);
    writeFileSync(join(dir, "old.log"), "needle old\n");
    const old = new Date(2001, 1, 1);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(dir, "f3.log"), old, old);
    const out = t(await call(dir, 1, "glob", { pattern: "*.log" }))[1].split("\n");
    expect(out).toHaveLength(101);
    expect(out[100]).toContain("[106 files in all; the newest 100 shown");
    expect(out.some((l) => l.endsWith("f3.log"))).toBe(false);
    expect(t(await call(dir, 1, "grep", { pattern: "NEEDLE old", "-i": true, output_mode: "count" }))[1]).toMatch(/old\.log:1$/);
    expect(t(await call(dir, 1, "grep", { pattern: "needle", glob: "f1*.log", head_limit: 2 }))[1].split("\n")).toHaveLength(2);
    expect(t(await call(dir, 1, "grep", { pattern: "zzz" }))[1]).toBe("No matches");
    expect(t(await call(dir, 1, "grep", { pattern: "needle \\d+\\nhay", multiline: true, output_mode: "count", path: join(dir, "f1.log") }))[1]).toBe("1");
    expect(t(await call(dir, 1, "grep", { pattern: "(" }))[0]).toBe(false);
  });

  test("glob and grep skip .git", async () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "x.txt"), "needle\n");
    writeFileSync(join(dir, ".hidden.txt"), "needle\n");
    expect(t(await call(dir, 1, "glob", { pattern: "**/*.txt" }))[1]).toBe(join(dir, ".hidden.txt"));
    expect(t(await call(dir, 1, "grep", { pattern: "needle" }))[1]).toBe(join(dir, ".hidden.txt"));
  });

  test("the note names the host, the tools and the project's CLAUDE.md files, outermost first", () => {
    process.env.HOME = dir;
    const proj = join(dir, "a", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "home rules");
    writeFileSync(join(dir, "a", "CLAUDE.md"), "  outer rules  \n");
    writeFileSync(join(proj, "CLAUDE.local.md"), "local rules");
    const n = note(["read", "bash"], proj);
    expect(n).toContain(`the project is ${proj} there`);
    expect(n).toContain("mcp__origin__read, mcp__origin__bash");
    expect(n).not.toContain("home rules");
    expect(n.indexOf("outer rules")).toBeGreaterThan(0);
    expect(n.indexOf("outer rules")).toBeLessThan(n.indexOf("local rules"));
    expect(n).toContain(`Contents of ${join(dir, "a", "CLAUDE.md")} (project instructions on`);
    expect(n).toContain(":\n\nouter rules");
  });

  test("a project outside home gets no memory files", () => {
    process.env.HOME = join(dir, "elsewhere");
    mkdirSync(process.env.HOME, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "not mine");
    expect(note(["read"], dir)).not.toContain("not mine");
  });

  test("symlinked files are read through", async () => {
    writeFileSync(join(dir, "real.txt"), "x\n");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    expect(t(await call(dir, 1, "read", { file_path: "link.txt" }))[1]).toBe("     1\tx\n");
    expect(existsSync(join(dir, "link.txt"))).toBe(true);
  });
});
