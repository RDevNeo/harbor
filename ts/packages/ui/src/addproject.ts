import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "@harbor/agents";
import { addFolder, gitRemote } from "@harbor/net";
import { homedir } from "node:os";
import { home, projectsdir, repoDir, type Store } from "@harbor/store";
import { type Act, AddProject, cloneCommand, cloneError, type Disk, githubSlug, nameProblem, type PaletteKey, parseGhList, type Row, STEP_LABEL, type StatusTone, untrustedKey } from "./logic/addproject.ts";
import type { Pixels } from "./logos.ts";

/** The overlay's properties and callbacks (addproject.slint `AddProjectOverlay`). */
export interface AddProjectView {
  rows: { glyph: string; logo: boolean; title: string; detail: string }[];
  statuses: { text: string; tone: StatusTone }[];
  selected: number;
  label: string;
  hint: string;
  local: boolean;
  can_back: boolean;
  github: Pixels;
  query: string;
  edited: (t: string) => void;
  key: (k: PaletteKey | "esc") => void;
  hover: (i: number) => void;
  back: () => void;
  add: () => void;
  open_files: () => void;
}

export const realDisk = (): Disk => ({
  home: home(),
  subdirs(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)))))
        .map((e) => join(dir, e.name))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch {
      return [];
    }
  },
  isDir,
  exists: existsSync,
});

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Your repositories and your organisations' ones, via `gh`. */
export async function ghRepos(): Promise<{ ok: [string, string][] } | { err: string }> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const list = async (owner: string | null) => {
    const r = await run(["repo", "list", ...(owner ? [owner] : []), "--limit", "300", "--json", "nameWithOwner,description"]);
    if (r.code !== 0) throw new Error(r.err.trim());
    return parseGhList(r.out);
  };
  try {
    const all = await list(null);
    const orgs = await run(["org", "list"]).catch(() => ({ out: "" }));
    for (const org of orgs.out.split("\n").map((l) => l.trim()).filter(Boolean)) all.push(...(await list(org).catch(() => [])));
    return { ok: all };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

/** "owner/repo" (lowercase) of each discovered repository's GitHub origin → its folder. */
export function localClones(): Map<string, string> {
  const clones = new Map<string, string>();
  for (const p of git.discover()) {
    try {
      const s = githubSlug(readFileSync(join(p, ".git/config"), "utf8"));
      if (s !== null) clones.set(s, p);
    } catch {}
  }
  return clones;
}

/** New project `name` in `projectsDir`: its folder, with `git init` when `git`. Throws why it can't. */
export function createProject(projectsDir: string, name: string, git: boolean, tilde: (p: string) => string): string {
  const bad = nameProblem(name);
  if (bad !== null) throw new Error(bad);
  const dir = join(projectsDir, name.trim());
  if (existsSync(dir)) throw new Error(`${tilde(dir)} already exists`);
  mkdirSync(dir, { recursive: true });
  if (git) {
    const r = Bun.spawnSync(["git", "init", "-q", dir], { stdio: ["ignore", "ignore", "pipe"] });
    if (r.exitCode !== 0) throw new Error(`git init failed: ${cloneError(r.stderr.toString())}`);
  }
  return dir;
}

/** Clones `url` into `dir` (`gh` for a GitHub owner/repo): null when it worked, else the error. */
export async function cloneProject(url: string, dir: string, github: boolean, projectsDir: string): Promise<string | null> {
  mkdirSync(projectsDir, { recursive: true });
  const p = Bun.spawn(cloneCommand(url, dir, github), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return code === 0 ? null : cloneError(err);
}

/**
 * Drives the "Add project" palette in `view`: `added` gets each folder added as a project,
 * `done` closes it, `openUrl` shows a folder in the file manager.
 */
export function attachAddProject(view: AddProjectView, store: Store, github: Pixels, hooks: { added(id: number): void; done(): void; openUrl(u: string): void }, disk = realDisk()) {
  const ap = new AddProject({ projects: projectsdir.projectsDir(store, disk.home), ...disk }, localClones());
  let rows: Row[] = [];
  const known = () => new Set(store.repos().flatMap((r) => [r.path, repoDir(r)]));

  const show = () => {
    rows = ap.rows(known());
    ap.sel = Math.min(ap.sel, Math.max(0, rows.length - 1));
    view.rows = rows.map((r) => ({ glyph: r.icon.kind === "glyph" ? r.icon.glyph : "", logo: r.icon.kind === "logo", title: r.title, detail: r.detail }));
    view.statuses = ap.status(rows.length).map(([text, tone]) => ({ text, tone }));
    view.selected = ap.sel;
    view.label = STEP_LABEL[ap.step];
    view.hint = ap.hint();
    view.local = ap.step === "local";
    view.can_back = ap.step !== "sources";
    if (view.query !== ap.query) view.query = ap.query;
  };

  const addPath = (dir: string): boolean => {
    if (!isDir(dir)) {
      ap.error = `Not a folder: ${ap.tilde(dir)}`;
      return false;
    }
    hooks.added(addFolder(store, dir, gitRemote(dir), homedir()));
    hooks.done();
    return true;
  };

  const run = async (act: Act) => {
    ap.error = null;
    switch (act.kind) {
      case "step":
        ap.go(act.step);
        if (act.step === "github" && ap.gh === null && !ap.ghLoading) {
          ap.ghLoading = true;
          void ghRepos().then((r) => {
            ap.gh = r;
            ap.ghLoading = false;
            show();
          });
        }
        break;
      case "enter":
        ap.enter(act.dir);
        break;
      case "add":
        if (addPath(act.dir)) return;
        break;
      case "create":
        try {
          if (addPath(createProject(ap.projectsDir(), act.name, act.git, (p) => ap.tilde(p)))) return;
        } catch (e) {
          ap.error = e instanceof Error ? e.message : String(e);
        }
        break;
      case "clone": {
        const dir = join(ap.projectsDir(), act.name);
        if (existsSync(dir)) {
          ap.error = `${ap.tilde(dir)} already exists`;
          break;
        }
        ap.busy = `Cloning ${act.url}…`;
        void cloneProject(act.url, dir, ap.step === "github", ap.projectsDir()).then((e) => {
          ap.busy = null;
          if (e === null) {
            store.set(untrustedKey(dir), "1");
            if (addPath(dir)) return;
          } else ap.error = e;
          show();
        });
        break;
      }
    }
    show();
  };

  view.edited = (t) => {
    ap.query = t;
    ap.sel = 0;
    ap.error = null;
    show();
  };
  view.key = (k) => {
    if (k === "esc") return hooks.done();
    const act = ap.key(k, rows);
    if (act) void run(act);
    else show();
  };
  view.hover = (i) => {
    ap.sel = i;
    view.selected = i;
  };
  view.back = () => {
    ap.go("sources");
    show();
  };
  view.add = () => {
    if (ap.busy === null) void run({ kind: "add", dir: ap.dir });
  };
  view.open_files = () => hooks.openUrl(ap.dir);
  view.github = github;
  show();
  return ap;
}
