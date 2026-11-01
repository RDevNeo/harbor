import { statSync } from "node:fs";
import { outputWithin } from "./git.ts";

/** A link target the desktop's markdown viewer hands back instead of opening. */
export const SCHEME = "harbor-commit:";
/** How long "not a commit here" is believed: a copy's PC may fetch the commit later. */
const FORGET_MISS_MS = 300_000;
const GIT_LIMIT_MS = 10_000;
/** A card lists at most this many files. */
const MAX_FILES = 300;
/** git's commit-icon glyph in Harbor's icon font (icons.rs GIT_COMMIT). */
export const GIT_COMMIT_ICON = "\u{e0e3}";

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** Author date, Unix seconds. */
  at: number;
}

export function commitJson(c: Commit): Record<string, unknown> {
  return { sha: c.sha, short: c.short, subject: c.subject, author: c.author, at: c.at };
}

export interface FileStat {
  path: string;
  /** Null: a binary file. */
  adds: number | null;
  dels: number | null;
}

export interface Detail {
  commit: Commit;
  body: string;
  email: string;
  files: FileStat[];
  /** More files than `files` lists. */
  moreFiles: number;
  /** The commit on GitHub, when the repository has a GitHub remote. */
  url: string | null;
}

export function detailJson(d: Detail): Record<string, unknown> {
  return { ...commitJson(d.commit), body: d.body, email: d.email, url: d.url, files: d.files.map((f) => ({ path: f.path, adds: f.adds, dels: f.dels })), more_files: d.moreFiles };
}

/** A digit and a letter both: a number or a word alone is no hash. */
export function shaLike(tok: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(tok) && /\d/.test(tok) && /[a-f]/.test(tok);
}

const alnum = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9]$/.test(c);

/** The hash-like tokens of plain text, as [start, end) ranges. Not part of a word, a path, a URL, a UUID, a colour, `0x…`, an e-mail or `key=value`. */
export function tokens(text: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (!alnum(text[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && (alnum(text[i]) || text[i] === "_")) i++;
    const tok = text.slice(start, i);
    const prev = start > 0 ? text[start - 1] : undefined;
    const next = text[i];
    const after = text[i + 1];
    const gluedBefore = prev !== undefined && "-#/.@:$&=%\\~+".includes(prev);
    // Sentence punctuation may follow ("in 7dfbd05."), a file extension or a port may not.
    const gluedAfter = (next !== undefined && "-/@\\+~".includes(next)) || ((next === "." || next === ":") && alnum(after));
    if (shaLike(tok) && !gluedBefore && !gluedAfter) out.push([start, i]);
  }
  return out;
}

/** Where a pill can go: a token in text (`code: false`), or a whole inline code span holding just a token (`code: true`, the range includes the backticks). */
export interface Site {
  range: [number, number];
  token: string;
  code: boolean;
}

export function maybe(text: string): boolean {
  return /[0-9a-f]{7}/.test(text);
}

/** The pill sites of markdown: fenced and indented code blocks, link texts and destinations are left alone. */
export function sites(md: string): Site[] {
  if (!maybe(md)) return [];
  const out: Site[] = [];
  let fence: string | null = null;
  let blank = true;
  let pos = 0;
  for (const line of md.split("\n")) {
    const at = pos;
    pos += line.length + 1;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (f && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length && line.trim().replace(/^[`~]+/, "") === "") fence = null;
      continue;
    }
    if (f) {
      fence = f[1] ?? "```";
      continue;
    }
    // An indented code block can't interrupt a paragraph.
    if (blank && /^( {4}|\t)/.test(line)) continue;
    blank = line.trim() === "";
    inline(line, at, out);
  }
  return out;
}

function inline(line: string, at: number, out: Site[]): void {
  let i = 0;
  let text = 0;
  const flush = (end: number): void => {
    const seg = line.slice(text, end);
    for (const [a, z] of tokens(seg)) out.push({ range: [at + text + a, at + text + z], token: seg.slice(a, z), code: false });
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "`") {
      let n = 0;
      while (line[i + n] === "`") n++;
      const ticks = "`".repeat(n);
      let close = line.indexOf(ticks, i + n);
      while (close >= 0 && line[close + n] === "`") close = line.indexOf(ticks, close + n + 1);
      if (close < 0) {
        i += n;
        continue;
      }
      flush(i);
      const content = line.slice(i + n, close).trim();
      if (shaLike(content)) out.push({ range: [at + i, at + close + n], token: content, code: true });
      i = close + n;
      text = i;
      continue;
    }
    if (c === "[" || (c === "!" && line[i + 1] === "[")) {
      const open = c === "!" ? i + 1 : i;
      const end = linkEnd(line, open);
      if (end > 0) {
        flush(i);
        i = end;
        text = i;
        continue;
      }
    }
    if (c === "<") {
      const close = line.indexOf(">", i);
      if (close > i && /^<[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*>$/.test(line.slice(i, close + 1))) {
        flush(i);
        i = close + 1;
        text = i;
        continue;
      }
    }
    i++;
  }
  flush(line.length);
}

/** Where `[text](dest)` starting at `open` ends (0: it isn't a link). */
function linkEnd(line: string, open: number): number {
  let depth = 0;
  let j = open;
  for (; j < line.length; j++) {
    if (line[j] === "\\") j++;
    else if (line[j] === "[") depth++;
    else if (line[j] === "]" && --depth === 0) break;
  }
  if (j >= line.length || line[j + 1] !== "(") return 0;
  let paren = 0;
  for (let k = j + 1; k < line.length; k++) {
    if (line[k] === "(") paren++;
    else if (line[k] === ")" && --paren === 0) return k + 1;
  }
  return 0;
}

export function candidates(md: string): string[] {
  return [...new Set(sites(md).map((s) => s.token))];
}

async function git(dir: string, args: string[], stdin?: string): Promise<string | null> {
  const argv = ["git", "-c", "core.fsmonitor=false", "-C", dir, ...args];
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  if (stdin === undefined) {
    try {
      const out = await outputWithin(argv, GIT_LIMIT_MS, { env });
      return out.code === 0 ? out.stdout : null;
    } catch {
      return null;
    }
  }
  try {
    const p = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(stdin);
    await p.stdin.end();
    const text = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode === 0 ? text : null;
  } catch {
    return null;
  }
}

const FORMAT = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e";

function parseLog(out: string): Commit[] {
  return out.split("\x1e").flatMap((rec) => {
    const f = rec.replace(/^\n+/, "").split("\x1f");
    if (f.length < 5 || (f[0] ?? "").length < 7) return [];
    const at = Number((f[4] ?? "").trim());
    return [{ sha: f[0] as string, short: f[1] ?? "", subject: f[2] ?? "", author: f[3] ?? "", at: Number.isInteger(at) ? at : 0 }];
  });
}

/** Which tokens name commits in `dir`'s repository (two git runs for any number of tokens); ambiguous prefixes and other objects are left out. */
export async function resolve(dir: string, toks: readonly string[]): Promise<Map<string, Commit>> {
  const found = new Map<string, Commit>();
  if (toks.length === 0) return found;
  // `^{commit}` peels an annotated tag; a short id that's also a branch name stays a commit id.
  const out = await git(dir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], toks.map((t) => `${t}^{commit}\n`).join(""));
  if (out === null) return found;
  const lines = out.split("\n");
  const shas: [string, string][] = [];
  toks.forEach((t, i) => {
    const [sha, type] = (lines[i] ?? "").trim().split(/\s+/);
    if (sha !== undefined && type === "commit" && sha.startsWith(t)) shas.push([t, sha]);
  });
  if (shas.length === 0) return found;
  const log = await git(dir, ["show", "-s", "--no-walk=unsorted", FORMAT, ...shas.map((s) => s[1])]);
  const commits = log === null ? [] : parseLog(log);
  for (const [t, sha] of shas) {
    const c = commits.find((x) => x.sha === sha);
    if (c) found.set(t, c);
  }
  return found;
}

export async function detail(dir: string, sha: string): Promise<Detail> {
  if (!shaLike(sha)) throw new Error("not a commit id");
  const commit = (await resolve(dir, [sha])).get(sha);
  if (!commit) throw new Error(`${sha} isn't a commit in this project`);
  const raw = (await git(dir, ["show", "-s", "--format=%b%x1f%ae", commit.sha])) ?? "";
  const cut = raw.indexOf("\x1f");
  const [body, email] = cut < 0 ? [raw, ""] : [raw.slice(0, cut), raw.slice(cut + 1)];
  // First parent only: a merge lists what it brought in.
  const stat = (await git(dir, ["show", "--numstat", "--format=", "--first-parent", "-m", "--no-renames", commit.sha])) ?? "";
  const files = numstat(stat);
  const moreFiles = Math.max(0, files.length - MAX_FILES);
  let url: string | null = null;
  for (const u of await remotes(dir)) {
    const b = githubBase(u);
    if (b !== null) {
      url = `${b}/commit/${commit.sha}`;
      break;
    }
  }
  return { commit, body: body.trim(), email: email.trim(), files: files.slice(0, MAX_FILES), moreFiles, url };
}

/** First parent only: a merge shows what it brought in. */
export async function diff(dir: string, sha: string): Promise<string> {
  if (!shaLike(sha)) throw new Error("not a commit id");
  const d = await git(dir, ["show", "--format=", "--first-parent", "-m", "--no-color", "--no-ext-diff", sha]);
  if (d === null) throw new Error("git show failed");
  return d;
}

function numstat(out: string): FileStat[] {
  return out.split("\n").flatMap((l) => {
    const p = l.split("\t");
    if (p.length < 3) return [];
    const n = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    return [{ path: p.slice(2).join("\t"), adds: n(p[0]), dels: n(p[1]) }];
  });
}

/** origin first, then the other remotes. */
async function remotes(dir: string): Promise<string[]> {
  const v: string[] = [];
  const o = await git(dir, ["remote", "get-url", "origin"]);
  if (o !== null) v.push(o.trim());
  for (const name of ((await git(dir, ["remote"])) ?? "").split("\n").filter((n) => n !== "" && n !== "origin")) {
    const u = await git(dir, ["remote", "get-url", name]);
    if (u !== null) v.push(u.trim());
  }
  return v;
}

/** A remote's GitHub web address; credentials never in it. Other hosts: null. */
export function githubBase(remote: string): string | null {
  const u = remote.trim().replace(/\/+$/, "");
  let rest: string;
  if (u.startsWith("git@")) rest = u.slice(4).replace(":", "/");
  else {
    const pre = ["https://", "http://", "ssh://", "git://", "git+ssh://"].find((p) => u.startsWith(p));
    if (pre === undefined) return null;
    const r = u.slice(pre.length);
    const at = r.indexOf("@");
    rest = at >= 0 && !r.slice(0, at).includes("/") ? r.slice(at + 1) : r;
  }
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = (rest.slice(0, slash).split(":")[0] ?? "").toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  let path = rest.slice(slash + 1);
  while (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/").filter((s) => s !== "");
  const [owner, repo] = parts;
  const ok = (s: string | undefined): s is string => s !== undefined && /^[A-Za-z0-9._-]+$/.test(s);
  return parts.length === 2 && ok(owner) && ok(repo) ? `https://github.com/${owner}/${repo}` : null;
}

type Entry = { kind: "pending" } | { kind: "commit"; commit: Commit } | { kind: "miss"; at: number };
const cache = new Map<string, Entry>();

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The commits among `toks` known in `dir` now; the rest are looked up, and `done` runs when one turned out to be a commit. */
export function known(dir: string, toks: readonly string[], done: () => void): Map<string, Commit> {
  const out = new Map<string, Commit>();
  const ask: string[] = [];
  for (const t of toks) {
    const key = `${dir}\0${t}`;
    const e = cache.get(key);
    if (e?.kind === "commit") out.set(t, e.commit);
    else if (e?.kind === "pending" || (e?.kind === "miss" && Date.now() - e.at < FORGET_MISS_MS)) continue;
    else {
      cache.set(key, { kind: "pending" });
      ask.push(t);
    }
  }
  if (ask.length > 0) {
    void (isDir(dir) ? resolve(dir, ask) : Promise.resolve(new Map<string, Commit>())).then((found) => {
      for (const t of ask) {
        const c = found.get(t);
        cache.set(`${dir}\0${t}`, c ? { kind: "commit", commit: c } : { kind: "miss", at: Date.now() });
      }
      if (found.size > 0) done();
    });
  }
  return out;
}

export function ofText(dir: string | null, md: string, done: () => void): Map<string, Commit> {
  if (dir === null) return new Map();
  const c = candidates(md);
  return c.length === 0 ? new Map() : known(dir, c, done);
}

/** The pill's text: the git-commit glyph and the short id between no-break spaces, so it never wraps. */
export function pillText(c: Commit): string {
  return ` ${GIT_COMMIT_ICON} ${short7(c)} `;
}

export function short7(c: Commit): string {
  return c.sha.slice(0, Math.min(Math.max(c.short.length, 7), c.sha.length));
}

/** The reply with each known commit as a link the viewer hands back (`SCHEME`), its text in code style. */
export function pillsMd(md: string, commits: ReadonlyMap<string, Commit>): string {
  if (commits.size === 0) return md;
  let out = "";
  let at = 0;
  for (const s of sites(md)) {
    const c = commits.get(s.token);
    if (!c || s.range[0] < at) continue;
    out += `${md.slice(at, s.range[0])}[\`${pillText(c)}\`](${SCHEME}${c.sha})`;
    at = s.range[1];
  }
  return out + md.slice(at);
}

/** The `commits` map of an item on the wire: full sha → what its pill shows. */
export function wire(commits: ReadonlyMap<string, Commit>): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const c of commits.values()) m[c.sha] = commitJson(c);
  return m;
}
