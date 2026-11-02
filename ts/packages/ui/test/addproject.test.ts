import { describe, expect, test } from "bun:test";
import { AddProject, cloneCommand, cloneError, type Disk, githubSlug, parseGhList, repoName } from "../src/logic/addproject.ts";

const H = "/h";
const TREE: Record<string, string[]> = {
  "/h": ["/h/Projects", "/h/notes"],
  "/h/Projects": ["/h/Projects/app", "/h/Projects/site"],
  "/": ["/h", "/tmp"],
};
const disk: Disk = {
  home: H,
  subdirs: (d) => TREE[d] ?? [],
  isDir: (p) => p in TREE || Object.values(TREE).some((v) => v.includes(p)),
  exists: (p) => p === "/h/Projects/site/.git",
};
const titles = (ap: AddProject, known = new Set<string>()) => ap.rows(known).map((r) => r.title);

describe("addproject.rs", () => {
  test("sources filter by title; Enter on one opens its step", () => {
    const ap = new AddProject(disk, new Map());
    expect(titles(ap)).toEqual(["New project", "Local folder", "Git URL", "GitHub repository"]);
    ap.query = "git";
    expect(titles(ap)).toEqual(["Git URL", "GitHub repository"]);
    ap.key("down", ap.rows(new Set()));
    expect(ap.key("enter", ap.rows(new Set()))).toEqual({ kind: "step", step: "github" });
  });

  test("new project offers Git and a plain folder under ~/Projects", () => {
    const ap = new AddProject(disk, new Map());
    ap.go("new");
    expect(ap.rows(new Set())).toEqual([]);
    expect(ap.status(0)).toEqual([["Type a name, then Enter", "subtle"]]);
    ap.query = "demo";
    const [git, plain] = ap.rows(new Set());
    expect([git?.title, git?.detail]).toEqual(["Create “demo”", "git init in ~/Projects/demo"]);
    expect(plain?.act).toEqual({ kind: "create", name: "demo", git: false });
  });

  test("local browses down, .. and Backspace go up, Ctrl+Enter adds the folder shown", () => {
    const ap = new AddProject(disk, new Map());
    ap.go("local");
    expect(ap.hint()).toBe("~/");
    expect(titles(ap)).toEqual(["Projects", "notes"]);
    const act = ap.key("enter", ap.rows(new Set()));
    expect(act).toEqual({ kind: "enter", dir: "/h/Projects" });
    ap.enter("/h/Projects");
    expect(titles(ap)).toEqual(["..", "app", "site"]);
    expect(ap.key("add", ap.rows(new Set()))).toEqual({ kind: "add", dir: "/h/Projects" });
    ap.query = "/";
    expect(titles(ap)).toEqual(["Go to /"]);
    ap.query = "";
    ap.key("back", ap.rows(new Set()));
    expect(ap.dir).toBe("/h");
    ap.busy = "Cloning…";
    expect(ap.key("enter", ap.rows(new Set()))).toBeNull();
  });

  test("Backspace on an empty search leaves a step for the sources", () => {
    const ap = new AddProject(disk, new Map());
    ap.go("url");
    ap.query = "x";
    ap.key("back", []);
    expect(ap.step).toBe("url");
    ap.query = "";
    ap.key("back", []);
    expect(ap.step).toBe("sources");
  });

  test("a URL clones into ~/Projects by its repository name", () => {
    const ap = new AddProject(disk, new Map());
    ap.go("url");
    ap.query = "git@example.com:team/tool.git";
    expect(ap.rows(new Set())[0]).toMatchObject({ title: "Clone git@example.com:team/tool.git", detail: "into ~/Projects/tool", act: { kind: "clone", name: "tool" } });
  });

  test("GitHub rows add an existing clone, else clone", () => {
    const ap = new AddProject(disk, new Map([["me/app", "/h/Projects/app"], ["me/oldname", "/h/Projects/Renamed"]]));
    ap.go("github");
    ap.ghLoading = true;
    expect(ap.status(0)).toEqual([["Loading your repositories…", "subtle"]]);
    ap.ghLoading = false;
    ap.gh = {
      ok: [
        ["me/app", "an app"],
        ["me/renamed", ""],
        ["you/site", ""],
        ["you/new", "fresh"],
        ["you/plain", ""],
      ],
    };
    const rows = ap.rows(new Set(["/h/Projects/app"]));
    expect(rows.map((r) => r.detail)).toEqual(["Already in Harbor: ~/Projects/app", "Add your clone at ~/Projects/Renamed", "Add your clone at ~/Projects/site", "fresh", "Clone into ~/Projects/plain"]);
    expect(rows[3]?.act).toEqual({ kind: "clone", url: "you/new", name: "new" });
    ap.query = "you/other";
    expect(titles(ap)).toEqual(["you/other"]);
    ap.gh = { err: "not logged in" };
    expect(ap.status(1)).toEqual([["gh: not logged in", "warn"]]);
  });

  test("names, slugs and commands", () => {
    expect(repoName("https://github.com/a/b.git/")).toBe("b");
    expect(repoName("git@host:a/b")).toBe("b");
    expect(githubSlug('[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Me/Tool.git\n')).toBe("me/tool");
    expect(githubSlug('[remote "origin"]\n\turl = https://github.com/me/x/\n')).toBe("me/x");
    expect(githubSlug('[remote "origin"]\n\turl = https://example.com/me/x\n')).toBeNull();
    expect(githubSlug('[remote "upstream"]\n\turl = https://github.com/me/x\n')).toBeNull();
    expect(cloneCommand("me/x", "/h/Projects/x", true)).toEqual(["gh", "repo", "clone", "me/x", "/h/Projects/x", "--", "-q"]);
    expect(cloneError("Cloning…\nfatal: repository not found\n")).toBe("fatal: repository not found");
    expect(cloneError("")).toBe("Clone failed");
    expect(parseGhList('[{"nameWithOwner":"a/b","description":null},{"nameWithOwner":"c/d","description":"x"}]')).toEqual([
      ["a/b", ""],
      ["c/d", "x"],
    ]);
  });
});
