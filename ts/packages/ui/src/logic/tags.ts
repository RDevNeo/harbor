// The phone asks the same ranked lists (`GET /v1/chats/{id}/tags`, android/PROTOCOL.md).
import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IconName } from "../icons.ts";
import { replace } from "./slash.ts";
import { tagsyntax } from "@harbor/store";
import { charList, cmpStr, isSpace, matchIndices, trimEndChars } from "./text.ts";

/** A project's files are listed again when the menu opens after this long. */
export const FILES_STALE_MS = 20_000;
/** Its issues and pull requests are asked again after this long. */
export const REFS_STALE_MS = 120_000;
/** More files than this aren't listed (a huge tree, or a home folder). */
export const MAX_FILES = 50_000;
/** Rows the menu (and the phone's list) shows at most. */
export const MAX_ROWS = 50;


export const { PUNCT, opens, word, tagged, tokens } = tagsyntax;
export type TagWord = tagsyntax.TagWord;

// Its letters in order in `hay`: how many were skipped between them (the ones before the first count half), or null.
function inOrder(hay: string, q: string): number | null {
  const rest = charList(hay);
  let at = 0;
  let gaps = 0;
  let lead = 0;
  let first = true;
  for (const c of q) {
    for (;;) {
      const x = rest[at++];
      if (x === undefined) return null;
      if (x === c) break;
      if (first) lead++;
      else gaps++;
    }
    first = false;
  }
  return gaps + Math.floor(lead / 2);
}

// Whether `q` starts a word of `hay` (after `-`, `_`, `.`, `/` or a space).
function atBoundary(hay: string, q: string): boolean {
  return matchIndices(hay, q).some((i) => i === 0 || "-_./ ".includes(hay.charAt(i - 1)));
}

/** How well `query` matches a name or title (lower is better): exactly, as a prefix, at a word boundary, anywhere, its letters in order. */
export function textScore(hay: string, query: string): number | null {
  const q = query.toLowerCase();
  if (q === "") return 0;
  const h = hay.toLowerCase();
  if (h === q) return 0;
  if (h.startsWith(q)) return 10;
  if (atBoundary(h, q)) return 20;
  if (h.includes(q)) return 30;
  const g = inOrder(h, q);
  return g === null ? null : 100 + g;
}

/** How well `query` matches a project file's path (lower is better): its name exactly, then as a prefix, at a word boundary, anywhere; then a folder's name, the path, and the letters in order (in the name before the path). */
export function fileScore(path: string, query: string): number | null {
  if (query === "") return path.split("/").length - 1;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  if (q.includes("/")) {
    if (p === q) return 0;
    if (p.endsWith(q) && p.slice(0, p.length - q.length).endsWith("/")) return 5;
    if (p.startsWith(q)) return 10;
    if (atBoundary(p, q)) return 15;
    if (p.includes(q)) return 20;
    const g = inOrder(p, q);
    return g === null ? null : 200 + g;
  }
  if (name === q) return 0;
  if (stem === q) return 1;
  if (name.startsWith(q)) return 10;
  if (atBoundary(name, q)) return 20;
  if (name.includes(q)) return 30;
  if (atBoundary(p, q)) return 40;
  if (p.includes(q)) return 50;
  const g = inOrder(name, q);
  if (g !== null) return 100 + g;
  const gp = inOrder(p, q);
  return gp === null ? null : 300 + gp;
}

const utf8 = new TextEncoder();

/** The files for `query`, best first (shorter paths first among equals), at most `limit`. */
export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
  const v: [number, number, string][] = [];
  for (const f of files) {
    const s = fileScore(f, query);
    if (s !== null) v.push([s, utf8.encode(f).length, f]);
  }
  v.sort((a, b) => a[0] - b[0] || a[1] - b[1] || cmpStr(a[2], b[2]));
  return v.slice(0, limit).map((x) => x[2]);
}

/** An issue or a pull request of the project's GitHub repo. */
export interface Ref {
  number: number;
  title: string;
  url: string;
  pr: boolean;
  state: "open" | "closed" | "merged" | "draft";
  updated: number;
}

function refOpen(r: Ref): boolean {
  return r.state === "open" || r.state === "draft";
}

/** How the agent is told about it. */
export function refLine(r: Ref): string {
  return `#${r.number}: GitHub ${r.pr ? "pull request" : "issue"} "${r.title}" (${r.state}), ${r.url}`;
}

/** How well `query` matches an issue or PR (lower is better): its number (exactly, then as a prefix), then its title (a word's start, anywhere, its letters in order). */
export function refScore(r: Ref, query: string): number | null {
  const closed = refOpen(r) ? 0 : 1;
  const q = query.replace(/^#+/, "").toLowerCase();
  if (q === "") return closed;
  const n = `${r.number}`;
  const t = r.title.toLowerCase();
  let s: number;
  if (n === q) s = 0;
  else if (n.startsWith(q)) s = 10 + n.length - q.length;
  else if (t.startsWith(q)) s = 20;
  else if (atBoundary(t, q)) s = 24;
  else if (t.includes(q)) s = 30;
  else {
    const g = inOrder(t, q);
    if (g === null) return null;
    s = 100 + g;
  }
  return s * 2 + closed;
}

/** The issues and PRs for `query`, best first (most recently updated among equals). */
export function rankRefs(refs: readonly Ref[], query: string, limit: number): Ref[] {
  const v: [number, Ref][] = [];
  for (const r of refs) {
    const s = refScore(r, query);
    if (s !== null) v.push([s, r]);
  }
  v.sort(([sa, a], [sb, b]) => sa - sb || b.updated - a.updated || b.number - a.number);
  return v.slice(0, limit).map((x) => x[1]);
}


export type FileKind = "ts" | "tsx" | "js" | "rs" | "json" | "md" | "image" | "shell" | "code" | "file";

/** A file's icon kind by its extension; the phone maps the same names. */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1);
  switch (ext) {
    case "ts": case "mts": case "cts":
      return "ts";
    case "tsx": case "jsx":
      return "tsx";
    case "js": case "mjs": case "cjs":
      return "js";
    case "rs":
      return "rs";
    case "json": case "jsonc": case "toml": case "yaml": case "yml": case "lock":
      return "json";
    case "md": case "mdx": case "txt": case "rst":
      return "md";
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "ico": case "bmp":
      return "image";
    case "sh": case "bash": case "zsh": case "fish":
      return "shell";
    case "py": case "go": case "java": case "kt": case "c": case "h": case "cc": case "cpp": case "hpp": case "cs": case "swift": case "rb":
    case "php": case "lua": case "luau": case "css": case "scss": case "html": case "vue": case "svelte": case "sql": case "zig": case "dart":
      return "code";
    default:
      return "file";
  }
}

/** An icon's colour: a hue at shade 700, or the subtle text colour. */
export type IconColor = "blue" | "amber" | "red" | "green" | "subtle";

export function fileIcon(kind: FileKind): { icon: IconName; color: IconColor } {
  switch (kind) {
    case "ts": case "tsx":
      return { icon: "FILE_CODE", color: "blue" };
    case "js":
      return { icon: "FILE_CODE", color: "amber" };
    case "rs":
      return { icon: "FILE_CODE", color: "red" };
    case "json":
      return { icon: "FILE_BRACES", color: "amber" };
    case "md":
      return { icon: "FILE_TEXT", color: "blue" };
    case "image":
      return { icon: "FILE_IMAGE", color: "green" };
    case "shell":
      return { icon: "TERMINAL", color: "green" };
    case "code":
      return { icon: "FILE_CODE", color: "subtle" };
    default:
      return { icon: "FILE", color: "subtle" };
  }
}

/** The glyph and colour of an issue or PR by its state (as the Issues and PR pages draw them). */
export function refIcon(r: Ref): { icon: IconName; color: IconColor } {
  if (r.pr) {
    if (r.state === "merged") return { icon: "GIT_MERGE", color: "blue" };
    if (r.state === "draft") return { icon: "PR_DRAFT", color: "subtle" };
    if (r.state === "closed") return { icon: "PR_CLOSED", color: "red" };
    return { icon: "PR_OPEN", color: "green" };
  }
  return r.state === "open" ? { icon: "CIRCLE_DOT", color: "green" } : { icon: "CIRCLE_CHECK", color: "blue" };
}

/** `path` split as the menu shows it: file name, then its folder ("" at the top). */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}


/** A project's files: git's tracked and untracked-not-ignored ones; in a folder without Git, what's on disk (`walk`). Null when it
 *  can't be read. Off the main thread's way: git runs as a child process waited for asynchronously (a big repository on a busy
 *  disk takes seconds), and the walk reads folders asynchronously. */
export async function listFiles(cwd: string): Promise<string[] | null> {
  let out: { ok: boolean; stdout: string } | null = null;
  try {
    const p = Bun.spawn(["git", "-C", cwd, "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    out = { ok: code === 0, stdout };
  } catch {
    out = null;
  }
  if (out === null || !out.ok) return walk(cwd);
  const v = [...new Set(out.stdout.split("\0").filter((s) => s !== ""))].sort(cmpStr);
  return v.slice(0, MAX_FILES);
}

/** Folders a plain project's listing skips, besides hidden ones: dependencies and builds. */
const SKIP_DIRS: readonly string[] = ["node_modules", "target", "dist", "build", "__pycache__", "venv"];

/** A folder's files without Git, breadth first (shallow ones first when it's huge): hidden entries, symlinks and `SKIP_DIRS` left out, paths relative to `cwd` with `/`. */
export async function walk(cwd: string): Promise<string[] | null> {
  try {
    await readdir(cwd);
  } catch {
    return null;
  }
  const v: string[] = [];
  const dirs: string[] = [""];
  for (let rel = dirs.shift(); rel !== undefined; rel = dirs.shift()) {
    let found;
    try {
      found = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of found) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.includes(e.name)) dirs.push(path);
      } else if (e.isFile()) {
        v.push(path);
        if (v.length >= MAX_FILES) {
          dirs.length = 0;
          break;
        }
      }
    }
  }
  return v.sort(cmpStr);
}

/** The GraphQL query for the repo's (owner/name) latest issues and pull requests, 100 of each; null for a bad name. */
export function refsQuery(repo: string): string | null {
  const slash = repo.indexOf("/");
  if (slash < 0) return null;
  const clean = (s: string) => charList(s).filter((c) => /^[A-Za-z0-9\-_.]$/.test(c)).join("");
  const owner = clean(repo.slice(0, slash));
  const name = clean(repo.slice(slash + 1));
  return (
    `query { repository(owner: "${owner}", name: "${name}") { ` +
    "issues(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url state updatedAt } } " +
    "pullRequests(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url state isDraft updatedAt } } } }"
  );
}

/** The repo's latest issues and pull requests, most recently updated first, through the GitHub CLI; null when gh can't answer. */
export async function fetchRefs(repo: string, timeoutMs = 30_000): Promise<Ref[] | null> {
  const q = refsQuery(repo);
  if (q === null) return null;
  const run = () => {
    try {
      return Bun.spawn(["gh", "api", "graphql", "-f", `query=${q}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    } catch {
      return null;
    }
  };
  const child = run();
  if (child === null) return null;
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const data = obj(v).data;
  if (code !== 0 && (data === undefined || data === null)) return null;
  return parseRefs(v);
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Seconds since 1970 of an ISO date ("2026-10-01T00:00:00Z"), read at fixed places as GitHub writes it.
function isoSecs(s: string): number | null {
  const n = (a: number, z: number): number | null => {
    const x = s.slice(a, z);
    return /^[+-]?\d+$/.test(x) ? Number(x) : null;
  };
  const y = n(0, 4);
  const m = n(5, 7);
  const d = n(8, 10);
  if (y === null || m === null || d === null) return null;
  return Date.UTC(y, m - 1, d, n(11, 13) ?? 0, n(14, 16) ?? 0, n(17, 19) ?? 0) / 1000;
}

/** GitHub's answer to `refsQuery`, most recently updated first. */
export function parseRefs(v: unknown): Ref[] {
  const r = obj(obj(obj(v).data).repository);
  const out: Ref[] = [];
  for (const [key, pr] of [["issues", false], ["pullRequests", true]] as const) {
    const nodes = obj(r[key]).nodes;
    for (const raw of Array.isArray(nodes) ? nodes : []) {
      const n = obj(raw);
      if (typeof n.number !== "number" || !Number.isSafeInteger(n.number) || n.number < 0) continue;
      const lower = (typeof n.state === "string" ? n.state : "").toLowerCase();
      const state = lower === "open" || lower === "merged" ? lower : "closed";
      out.push({
        number: n.number,
        title: typeof n.title === "string" ? n.title : "",
        url: typeof n.url === "string" ? n.url : "",
        pr,
        state: pr && state === "open" && n.isDraft === true ? "draft" : state,
        updated: isoSecs(typeof n.updatedAt === "string" ? n.updatedAt : "") ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}


/** One row of the menu. */
export type TagRow = { kind: "file"; path: string } | { kind: "ref"; ref: Ref };

/** What picking it writes. */
export function rowInsert(r: TagRow): string {
  return r.kind === "file" ? `@${r.path}` : `#${r.ref.number}`;
}

/** What the row shows: a file's name then its folder, dimmed; an issue's or PR's number then its title. */
export function rowText(r: TagRow): { icon: IconName; color: IconColor; name: string; rest: string } {
  if (r.kind === "file") {
    const { name, dir } = splitPath(r.path);
    return { ...fileIcon(fileKind(r.path)), name, rest: dir };
  }
  return { ...refIcon(r.ref), name: `#${r.ref.number}`, rest: r.ref.title };
}

export function rowTip(r: TagRow): string {
  return r.kind === "file" ? r.path : `#${r.ref.number} ${r.ref.title}\n${r.ref.url}`;
}

/** A row as the phone gets it. */
export function rowJson(r: TagRow): Record<string, string | number> {
  if (r.kind === "file") {
    const { name, dir } = splitPath(r.path);
    return { kind: "file", insert: rowInsert(r), path: r.path, name, dir, icon: fileKind(r.path) };
  }
  return { kind: r.ref.pr ? "pr" : "issue", insert: rowInsert(r), number: r.ref.number, title: r.ref.title, state: r.ref.state, url: r.ref.url };
}

/** The rows for a word: the files or the issues and PRs ranked (none while the list is unknown). */
export function rows(trigger: "@" | "#", query: string, files: readonly string[] | null, refs: readonly Ref[] | null): TagRow[] {
  if (trigger === "@") return files === null ? [] : rankFiles(files, query, MAX_ROWS).map((path): TagRow => ({ kind: "file", path }));
  return refs === null ? [] : rankRefs(refs, query, MAX_ROWS).map((ref): TagRow => ({ kind: "ref", ref }));
}

export function apiTrigger(trigger: string): "@" | "#" {
  return trigger.startsWith("#") ? "#" : "@";
}

/** Whether the menu shows: rows, or a loading row while the list comes and nothing is typed yet. */
export function menuShows(rowCount: number, pending: boolean, query: string): boolean {
  return rowCount > 0 || (pending && query === "");
}

export function loadingText(trigger: "@" | "#"): string {
  return trigger === "@" ? "Listing the project's files…" : "Loading issues and pull requests…";
}

/** A row picked for `w` in `draft`: the new text and cursor, and the token written. */
export function accept(draft: string, w: TagWord, r: TagRow): { text: string; cursor: number; token: string } {
  const token = rowInsert(r);
  return { ...replace(draft, w, token), token };
}

/** What the agent gets after the user's text: the files and the issues or PRs tagged in it, with their full path or title and URL (nothing when there are none). */
export function tagsPrompt(text: string, cwd: string | null, gh: string | null, refs: readonly Ref[] | null): string {
  if (!text.includes("@") && !text.includes("#")) return "";
  const { files, numbers } = tagged(text);
  const out: string[] = [];
  if (cwd !== null) {
    for (const f of files) {
      const p = cwd.endsWith("/") ? cwd + f : `${cwd}/${f}`;
      if (f !== "" && !f.startsWith("/") && !f.includes("..") && existsSync(p)) {
        let dir = false;
        try {
          dir = statSync(p).isDirectory();
        } catch {
          dir = false;
        }
        out.push(`@${f}: ${dir ? "a folder" : "a file"} in the project, ${p}`);
      }
    }
  }
  if (gh !== null) {
    for (const n of numbers) {
      const r = refs?.find((x) => x.number === n);
      if (r !== undefined) out.push(refLine(r));
      // Not in the latest 100: GitHub sends /issues/N on to a PR too.
      else if (refs !== null) out.push(`#${n}: GitHub issue or pull request of ${gh}, https://github.com/${gh}/issues/${n}`);
    }
  }
  return out.length === 0 ? "" : `\n\n[Tagged in this message:\n- ${out.join("\n- ")}]`;
}
