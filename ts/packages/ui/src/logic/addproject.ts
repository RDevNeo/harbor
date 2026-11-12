import { paths as osPaths } from "@harbor/os";
import { basename, dirname, join } from "node:path";
import { ICONS } from "../icons.ts";

export type Step = "sources" | "new" | "local" | "url" | "github";

export type Act =
  | { kind: "step"; step: Step }
  | { kind: "add"; dir: string }
  /** Browse this directory. */
  | { kind: "enter"; dir: string }
  /** A new folder in the Projects folder: a Git repository (`git init`) or a plain folder. */
  | { kind: "create"; name: string; git: boolean }
  | { kind: "clone"; url: string; name: string };

export type Icon = { kind: "glyph"; glyph: string } | { kind: "logo"; name: "github" };

export interface Row {
  icon: Icon;
  title: string;
  detail: string;
  act: Act;
}

/** What the palette reads from disk. */
export interface Disk {
  home: string;
  /** Where new projects and clones go (the Projects folder setting); left out: ~/Projects. */
  projects?: string;
  /** Visible (non-dot) subdirectories, sorted by name. */
  subdirs(dir: string): string[];
  isDir(p: string): boolean;
  exists(p: string): boolean;
}

/** GitHub repositories (owner/name, description) from `gh repo list`, or why they couldn't be listed. */
export type GhList = { ok: [string, string][] } | { err: string };

/** addproject.rs `AddProject`: the "Add project" palette's state. */
export class AddProject {
  step: Step = "sources";
  query = "";
  sel = 0;
  dir: string;
  dirs: string[];
  gh: GhList | null = null;
  ghLoading = false;
  /** Clone in progress ("Cloning owner/repo…"). */
  busy: string | null = null;
  error: string | null = null;

  constructor(
    readonly disk: Disk,
    /** "owner/repo" (lowercase) of each discovered repository's GitHub origin → its folder. */
    readonly clones: Map<string, string>,
  ) {
    this.dir = disk.home;
    this.dirs = disk.subdirs(disk.home);
  }

  /** Shows a step from its top. */
  go(s: Step): void {
    this.step = s;
    this.query = "";
    this.sel = 0;
  }

  /** Browses `dir` in the Local step. */
  enter(dir: string): void {
    this.dirs = this.disk.subdirs(dir);
    this.dir = dir;
    this.query = "";
    this.sel = 0;
  }

  projectsDir(): string {
    return this.disk.projects ?? join(this.disk.home, "Projects");
  }

  tilde(p: string): string {
    return osPaths.tilde(p, this.disk.home);
  }

  expand(p: string): string {
    const t = p.trim();
    if (t === "~") return this.disk.home;
    return t.startsWith("~/") ? join(this.disk.home, t.slice(2)) : t;
  }

  rows(known: ReadonlySet<string>): Row[] {
    const q = this.query.trim();
    const ql = q.toLowerCase();
    const g = (glyph: string): Icon => ({ kind: "glyph", glyph });
    const v: Row[] = [];
    switch (this.step) {
      case "sources":
        for (const r of SOURCES) if (!ql || r.title.toLowerCase().includes(ql)) v.push(r);
        break;
      case "new":
        if (q) {
          const dir = this.tilde(join(this.projectsDir(), q));
          v.push({ icon: g(ICONS.FOLDER_GIT), title: `Create “${q}”`, detail: `git init in ${dir}`, act: { kind: "create", name: q, git: true } });
          v.push({ icon: g(ICONS.FOLDER), title: `Create “${q}” without Git`, detail: `Plain folder in ${dir}, no Git or GitHub`, act: { kind: "create", name: q, git: false } });
        }
        break;
      case "local": {
        const typed = this.expand(q);
        if ((q.startsWith("/") || q.startsWith("~")) && this.disk.isDir(typed)) v.push({ icon: g(ICONS.FOLDER), title: `Go to ${this.tilde(typed)}`, detail: "", act: { kind: "enter", dir: typed } });
        if (!ql && this.dir !== this.disk.home && dirname(this.dir) !== this.dir) v.push({ icon: g(ICONS.ARROW_UP), title: "..", detail: "", act: { kind: "enter", dir: dirname(this.dir) } });
        for (const p of this.dirs) {
          const name = basename(p);
          if (name.toLowerCase().includes(ql)) v.push({ icon: g(ICONS.FOLDER), title: name, detail: "", act: { kind: "enter", dir: p } });
        }
        break;
      }
      case "url":
        if (q) {
          const name = repoName(q);
          v.push({ icon: g(ICONS.LINK), title: `Clone ${q}`, detail: `into ${this.tilde(join(this.projectsDir(), name))}`, act: { kind: "clone", url: q, name } });
        }
        break;
      case "github":
        if (q.includes("/") && !q.includes(" ")) v.push(this.ghRow(q, "", known));
        if (this.gh && "ok" in this.gh) {
          for (const [full, desc] of this.gh.ok) {
            if ((full.toLowerCase().includes(ql) || desc.toLowerCase().includes(ql)) && full !== q) v.push(this.ghRow(full, desc, known));
          }
        }
        break;
    }
    return v;
  }

  /** A GitHub repository row: adds your existing clone when there is one, else clones. */
  ghRow(full: string, desc: string, known: ReadonlySet<string>): Row {
    const name = repoName(full);
    const target = join(this.projectsDir(), name);
    const fullL = full.toLowerCase();
    const owner = fullL.split("/")[0] ?? "";
    // Exact origin match, else a folder of the same name from the same owner
    // (repositories renamed on GitHub keep their old origin URL locally).
    let local = this.clones.get(fullL) ?? [...this.clones].find(([slug, p]) => slug.split("/")[0] === owner && basename(p).toLowerCase() === name.toLowerCase())?.[1] ?? null;
    if (local === null && this.disk.exists(join(target, ".git"))) local = target;
    const icon: Icon = { kind: "logo", name: "github" };
    if (local !== null) return { icon, title: full, detail: known.has(local) ? `Already in Harbor: ${this.tilde(local)}` : `Add your clone at ${this.tilde(local)}`, act: { kind: "add", dir: local } };
    return { icon, title: full, detail: desc || `Clone into ${this.tilde(target)}`, act: { kind: "clone", url: full, name } };
  }

  hint(): string {
    switch (this.step) {
      case "sources":
        return "Search…";
      case "new":
        return "Project name";
      case "local":
        return `${this.tilde(this.dir)}/`.replace("//", "/");
      case "url":
        return "https://… or git@…";
      case "github":
        return "Search your repositories, or type owner/repo";
    }
  }

  /** The status lines over the list, each with its tone. */
  status(rows: number): [string, StatusTone][] {
    const v: [string, StatusTone][] = [];
    if (this.busy !== null) v.push([this.busy, "subtle"]);
    if (this.error !== null) v.push([this.error, "error"]);
    if (this.step === "github") {
      if (this.gh && "err" in this.gh) v.push([`gh: ${this.gh.err}`, "warn"]);
      else if (this.ghLoading) v.push(["Loading your repositories…", "subtle"]);
    }
    if (rows === 0 && this.busy === null && !this.ghLoading) v.push([this.empty(), "subtle"]);
    return v;
  }

  private empty(): string {
    if (this.step === "new") return "Type a name, then Enter";
    if (this.step === "url") return "Paste a URL, then Enter";
    if (this.step === "local" && !this.query) return "No subdirectories";
    return "No match";
  }

  /** The palette's keys over `rows`: the act to run, if any. */
  key(k: PaletteKey, rows: Row[]): Act | null {
    const n = rows.length;
    if (k === "up" && n > 0) this.sel = (this.sel + n - 1) % n;
    if (k === "down" && n > 0) this.sel = (this.sel + 1) % n;
    this.sel = Math.min(this.sel, Math.max(0, n - 1));
    if (this.busy !== null && (k === "enter" || k === "add")) return null;
    if (k === "enter") return rows[this.sel]?.act ?? null;
    if (k === "add" && this.step === "local") return { kind: "add", dir: this.dir };
    if (k === "back" && !this.query && this.step !== "sources") {
      if (this.step === "local" && dirname(this.dir) !== this.dir) this.enter(dirname(this.dir));
      else this.go("sources");
    }
    return null;
  }
}

export type StatusTone = "subtle" | "error" | "warn";
/** `add` is Ctrl+Enter (add the folder being browsed); `back` is Backspace. */
export type PaletteKey = "up" | "down" | "enter" | "add" | "back";

export const STEP_LABEL: Record<Step, string> = {
  sources: "Sources",
  new: "New project",
  local: "Directories",
  url: "Git URL",
  github: "GitHub repository",
};

const SOURCES: Row[] = [
  { icon: { kind: "glyph", glyph: ICONS.FOLDER }, title: "New project", detail: "A new folder from a name, with or without Git", act: { kind: "step", step: "new" } },
  { icon: { kind: "glyph", glyph: ICONS.FOLDER_PLUS }, title: "Local folder", detail: "Browse a folder on disk", act: { kind: "step", step: "local" } },
  { icon: { kind: "glyph", glyph: ICONS.LINK }, title: "Git URL", detail: "Clone from a remote URL", act: { kind: "step", step: "url" } },
  { icon: { kind: "logo", name: "github" }, title: "GitHub repository", detail: "Clone GitHub owner/repo", act: { kind: "step", step: "github" } },
];

export const FOOTER_KEYS: [string, string][] = [
  ["↑ ↓", "Navigate"],
  ["Enter", "Select"],
  ["Backspace", "Back"],
  ["Esc", "Close"],
];

/** "https://github.com/a/b.git" / "git@host:a/b" → "b". */
export function repoName(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  const last = t.split(/[/:]/).pop() ?? "";
  return last.replace(/(\.git)+$/, "");
}

/** Why `name` can't be a new project's folder name, or null when it can. */
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (t === "") return "Type a name for the project";
  if (t.includes("/") || t.includes("\\") || t.includes("\0")) return "A project's name can't hold / or \\";
  if (t === "." || t === "..") return `“${t}” can't be a project's name`;
  return null;
}

/** The setting that marks a project folder as not trusted. */
export function untrustedKey(dir: string): string {
  return `untrusted:${dir}`;
}

/** "owner/repo" of a repository's github.com origin, from its .git/config text. */
export function githubSlug(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("[")) inOrigin = l === '[remote "origin"]';
    else if (inOrigin && l.startsWith("url = ")) {
      const url = l.slice(6);
      const i = url.indexOf("github.com/");
      const rest = url.startsWith("git@github.com:") ? url.slice(15) : i >= 0 ? url.slice(i + 11) : null;
      return rest === null ? null : rest.replace(/\/+$/, "").replace(/(\.git)+$/, "").toLowerCase();
    }
  }
  return null;
}

/** The command that clones `url` into `dir`: `gh` for a GitHub owner/repo, else `git`. */
export function cloneCommand(url: string, dir: string, github: boolean): string[] {
  return github ? ["gh", "repo", "clone", url, dir, "--", "-q"] : ["git", "clone", "-q", url, dir];
}

/** A failed clone's message: the last line of its stderr. */
export function cloneError(stderr: string): string {
  return stderr.trim().split("\n").pop() || "Clone failed";
}

/** `gh repo list --json nameWithOwner,description` output → (owner/name, description). */
export function parseGhList(json: string): [string, string][] {
  const v: unknown = JSON.parse(json);
  if (!Array.isArray(v)) return [];
  const str = (r: unknown, k: string): string => {
    const x: unknown = typeof r === "object" && r !== null ? Reflect.get(r, k) : undefined;
    return typeof x === "string" ? x : "";
  };
  return v.map((r: unknown): [string, string] => [str(r, "nameWithOwner"), str(r, "description")]);
}
