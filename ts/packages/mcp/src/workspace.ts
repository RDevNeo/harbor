import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { home } from "@harbor/store";
import { argBool, argStr, argUint } from "./args.ts";
import type { Json } from "./json.ts";
import { hostname, shQuote } from "@harbor/net";
import { capture, osError, shell, shellCommand, token } from "./shell.ts";
import { providers } from "@harbor/agents";

export const TOOLS: readonly string[] = ["bash", "read", "write", "edit", "glob", "grep"];
/** Claude Code's own tools these stand in for, and others that would act on the device's files or shell (LSP, Monitor, worktrees), disallowed there. */
export const REPLACED = "Bash,BashOutput,KillShell,Read,Edit,MultiEdit,Write,NotebookEdit,Glob,Grep,LS,LSP,Monitor,EnterWorktree,ExitWorktree";

const READ_LINES = 2000;
const LINE_MAX = 2000;
const GLOB_MAX = 100;
const GREP_MAX = 30_000;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface Called {
  ok: boolean;
  content: Content[];
}

/** The tools a turn gets for its access: plan reads and searches; auto-edit also writes and edits but runs no commands; a team lead reads and, with full access, runs commands, but doesn't edit. */
export function forAccess(access: string, lead: boolean): string[] {
  if (access === "plan" || (lead && access !== "full")) return ["read", "glob", "grep"];
  if (lead) return ["bash", "read", "glob", "grep"];
  if (access === "edits") return ["read", "write", "edit", "glob", "grep"];
  return [...TOOLS];
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** CLAUDE.md and CLAUDE.local.md in the project and the folders above it, up to (not including) home, outermost first. */
function memoryFiles(cwd: string): string[] {
  const h = home();
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    if (d === h || !(h === "/" || d === h || d.startsWith(`${h}/`))) break;
    dirs.push(d);
    if (dirname(d) === d) break;
  }
  return dirs
    .reverse()
    .flatMap((d) => ["CLAUDE.md", "CLAUDE.local.md"].map((n) => join(d, n)))
    .filter(isFile);
}

export function note(tools: readonly string[], cwd: string): string {
  const host = hostname();
  const list = tools.map((t) => `mcp__origin__${t}`).join(", ");
  let s = `Your workspace is on '${host}', not on the device: the project is ${cwd} there, and your shell, git and file tools (${list}) run on '${host}'. Use them like Claude Code's Bash, Read, Write, Edit, Glob and Grep (those are off); paths are '${host}' paths.`;
  for (const f of memoryFiles(cwd)) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.length > 20_000) text = Array.from(text).slice(0, 20_000).join("");
    s += `\n\nContents of ${f} (project instructions on '${host}'):\n\n${text.trim()}`;
  }
  return s;
}

/** A path the agent gave: ~ is home here, relative is from the project. */
export function resolve(cwd: string, p: string): string {
  p = p.trim();
  if (p === "") return cwd;
  if (p === "~") return home();
  if (p.startsWith("~/")) return joined(home(), p.slice(2));
  return p.startsWith("/") ? p : joined(cwd, p);
}

/** Path::join: no normalizing, so a `..` after a symlink means what the system says. */
function joined(base: string, rest: string): string {
  return base.endsWith("/") ? base + rest : `${base}/${rest}`;
}

/** `old` must occur once unless `all`; an empty `old` writes a new or empty file; a CRLF file matches an `old` written with LF. */
export function replace(text: string, old: string, next: string, all: boolean): { text: string; n: number } | { error: string } {
  if (old === next) return { error: "old_string and new_string are the same; nothing to change" };
  if (old === "") return text === "" ? { text: next, n: 1 } : { error: "old_string is empty but the file isn't; use write to replace a whole file" };
  const crlf = (s: string): string => s.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  if (!text.includes(old) && text.includes("\r\n") && text.includes(crlf(old))) {
    old = crlf(old);
    next = crlf(next);
  }
  const parts = text.split(old);
  const n = parts.length - 1;
  if (n === 0) return { error: "old_string isn't in the file (it must match exactly, whitespace included); read the file again" };
  if (n > 1 && !all) return { error: `old_string is in the file ${n} times; give more context to make it unique, or set replace_all` };
  return { text: all ? parts.join(next) : parts[0] + next + parts.slice(1).join(old), n };
}

/** Rust's `str::lines`: split at \n, a final empty piece dropped. */
function lines(text: string): string[] {
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

export function numbered(text: string, offset: number, limit: number): string {
  const start = Math.max(offset, 1);
  let out = "";
  const all = lines(text);
  for (let i = start - 1; i < all.length && i < start - 1 + limit; i++) {
    let line = (all[i] as string).replace(/\r$/, "");
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length > LINE_MAX) {
      let cut = LINE_MAX;
      while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
      line = `${bytes.subarray(0, cut).toString("utf8")}… [line cut]`;
    }
    out += `${String(i + 1).padStart(6, " ")}\t${line}\n`;
  }
  return out;
}

type Props = { [k: string]: Json };

function def(name: string, description: string, properties: Props, required: string[], readOnly: boolean): Json {
  const t: { [k: string]: Json } = { name, description, inputSchema: { type: "object", properties, required } };
  if (readOnly) t.annotations = { readOnlyHint: true };
  return t;
}

export function tools(names: readonly string[]): Json[] {
  const host = hostname();
  const path = { type: "string", description: "Absolute path (relative: from the project)" };
  const all: [string, Json][] = [
    [
      "bash",
      def(
        "bash",
        `Run a bash command on ${host} (where the project and its git repo are), not on the machine you run on. The working folder is kept between calls (starts in the project); stdout and stderr are returned together with the exit code. Use it for git, builds, tests and anything else Bash would do.`,
        {
          command: { type: "string", description: "The command" },
          timeout: { type: "integer", description: "Milliseconds before it is stopped (default 120000, at most 600000)" },
          description: { type: "string", description: "What it does, in a few words" },
          run_in_background: { type: "boolean", description: "Start it and return at once; its output goes to a log file there (read it with read)" },
        },
        ["command"],
        false,
      ),
    ],
    [
      "read",
      def(
        "read",
        `Read a file on ${host}: lines numbered like cat -n, 2000 from the start unless offset/limit say otherwise. Images come back as images.`,
        { file_path: path, offset: { type: "integer", description: "First line (1-based)" }, limit: { type: "integer", description: "How many lines" } },
        ["file_path"],
        true,
      ),
    ],
    [
      "write",
      def("write", `Write a file on ${host}, replacing it if it exists (folders are created). Prefer edit for changes to an existing file.`, { file_path: path, content: { type: "string" } }, ["file_path", "content"], false),
    ],
    [
      "edit",
      def(
        "edit",
        `Replace exact text in a file on ${host}. old_string must match the file exactly (whitespace and indentation included) and be unique, unless replace_all. An empty old_string creates a new file.`,
        { file_path: path, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean", description: "Replace every occurrence (default false)" } },
        ["file_path", "old_string", "new_string"],
        false,
      ),
    ],
    [
      "glob",
      def(
        "glob",
        `Find files on ${host} by glob pattern ("**/*.rs", "src/**/*.ts"), newest first; .gitignore'd files are skipped.`,
        { pattern: { type: "string" }, path: { type: "string", description: "Folder to search (default: the project)" } },
        ["pattern"],
        true,
      ),
    ],
    [
      "grep",
      def(
        "grep",
        `Search file contents on ${host} with ripgrep (regex).`,
        {
          pattern: { type: "string", description: "Regular expression (ripgrep syntax)" },
          path: { type: "string", description: "File or folder (default: the project)" },
          glob: { type: "string", description: 'Only files matching this glob ("*.js", "*.{ts,tsx}")' },
          type: { type: "string", description: "ripgrep file type (js, py, rust…)" },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Default files_with_matches" },
          "-i": { type: "boolean", description: "Ignore case" },
          "-n": { type: "boolean", description: "Line numbers (content mode; default true)" },
          "-A": { type: "integer" },
          "-B": { type: "integer" },
          "-C": { type: "integer" },
          multiline: { type: "boolean", description: "Patterns can span lines; . matches newlines" },
          head_limit: { type: "integer", description: "Only the first N lines of output" },
        },
        ["pattern"],
        true,
      ),
    ],
  ];
  return all.filter(([n]) => names.includes(n)).map(([, t]) => t);
}

const CWDS = new Map<number, string>();

export function forget(chatId: number): void {
  CWDS.delete(chatId);
}

const text = (ok: boolean, t: string): Called => ({ ok, content: [{ type: "text", text: t }] });

const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function call(cwd: string, chatId: number, name: string, a: unknown): Promise<Called> {
  const path = (k: string): string | undefined => {
    const p = argStr(a, k);
    return p === undefined ? undefined : resolve(cwd, p);
  };
  switch (name) {
    case "bash":
      return bash(cwd, chatId, a);
    case "read": {
      const p = path("file_path");
      if (p === undefined) return text(false, "file_path is required");
      if (isDir(p)) return text(false, `${p} is a folder; list it with bash (ls)`);
      let bytes: Buffer;
      try {
        bytes = await readFile(p);
      } catch (e) {
        return text(false, `cannot read ${p}: ${osError(e)}`);
      }
      const mime = IMAGES[extname(p).slice(1).toLowerCase()];
      if (mime) return { ok: true, content: [{ type: "image", data: bytes.toString("base64"), mimeType: mime }] };
      const t = bytes.toString("utf8");
      if (t === "") return text(true, `(${p} is empty)`);
      const offset = argUint(a, "offset") ?? 1;
      const limit = argUint(a, "limit") ?? READ_LINES;
      const out = numbered(t, offset, limit);
      const total = lines(t).length;
      const more = Math.max(offset, 1) - 1 + limit < total ? `\n[${total} lines in all; read on with offset]` : "";
      return text(true, out === "" ? `(the file has ${total} lines)` : out + more);
    }
    case "write": {
      const p = path("file_path");
      const content = argStr(a, "content");
      if (p === undefined || content === undefined) return text(false, "file_path and content are required");
      await mkdir(dirname(p), { recursive: true }).catch(() => {});
      try {
        await writeFile(p, content);
      } catch (e) {
        return text(false, `cannot write ${p}: ${osError(e)}`);
      }
      return text(true, `Wrote ${p} (${Buffer.byteLength(content)} bytes)`);
    }
    case "edit": {
      const p = path("file_path");
      const old = argStr(a, "old_string");
      const next = argStr(a, "new_string");
      if (p === undefined || old === undefined || next === undefined) return text(false, "file_path, old_string and new_string are required");
      let cur: string;
      try {
        cur = utf8.decode(await readFile(p));
      } catch (e) {
        if (e instanceof TypeError) return text(false, `cannot read ${p}: stream did not contain valid UTF-8`);
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT" && old === "")) return text(false, `cannot read ${p}: ${osError(e)}`);
        cur = "";
      }
      const r = replace(cur, old, next, argBool(a, "replace_all") ?? false);
      if ("error" in r) return text(false, r.error);
      await mkdir(dirname(p), { recursive: true }).catch(() => {});
      try {
        await writeFile(p, r.text);
      } catch (e) {
        return text(false, `cannot write ${p}: ${osError(e)}`);
      }
      return text(true, `Edited ${p} (${r.n} replacement${r.n === 1 ? "" : "s"})`);
    }
    case "glob": {
      const pattern = argStr(a, "pattern");
      if (pattern === undefined || pattern === "") return text(false, "pattern is required");
      const out = await rg(["--files", "--hidden", "-g", "!.git", "-g", pattern], path("path") ?? cwd);
      if (typeof out !== "string") return text(false, out.error);
      const files = out === "" ? [] : out.split("\n");
      const mtimes = new Map<string, number>();
      await Promise.all(files.map(async (f) => mtimes.set(f, await stat(f).then((s) => s.mtimeMs, () => 0))));
      files.sort((x, y) => (mtimes.get(y) ?? 0) - (mtimes.get(x) ?? 0));
      let s = files.slice(0, GLOB_MAX).join("\n");
      if (files.length > GLOB_MAX) s += `\n[${files.length} files in all; the newest ${GLOB_MAX} shown, narrow the pattern]`;
      return text(true, s === "" ? "No files found" : s);
    }
    case "grep":
      return grep(a, path("path") ?? cwd);
    default:
      return text(false, `No tool ${name} here`);
  }
}

async function grep(a: unknown, dir: string): Promise<Called> {
  const pattern = argStr(a, "pattern");
  if (pattern === undefined) return text(false, "pattern is required");
  const args = ["--hidden", "-g", "!.git", "--no-heading", "--color", "never"];
  switch (argStr(a, "output_mode") ?? "files_with_matches") {
    case "content":
      if (argBool(a, "-n") ?? true) args.push("-n");
      for (const k of ["-A", "-B", "-C"]) {
        const n = argUint(a, k);
        if (n !== undefined) args.push(k, String(n));
      }
      break;
    case "count":
      args.push("-c");
      break;
    default:
      args.push("-l");
  }
  if (argBool(a, "-i") === true) args.push("-i");
  if (argBool(a, "multiline") === true) args.push("-U", "--multiline-dotall");
  const glob = argStr(a, "glob");
  if (glob) args.push("-g", glob);
  const type = argStr(a, "type");
  if (type) args.push("-t", type);
  args.push("-e", pattern);
  const out = await rg(args, dir);
  if (typeof out !== "string") return text(false, out.error);
  if (out === "") return text(true, "No matches");
  const head = argUint(a, "head_limit");
  let o = head === undefined ? out : out.split("\n").slice(0, head).join("\n");
  if (Buffer.byteLength(o) > GREP_MAX) {
    const b = Buffer.from(o, "utf8");
    let cut = GREP_MAX;
    while (cut > 0 && ((b[cut] ?? 0) & 0xc0) === 0x80) cut--;
    o = `${b.subarray(0, cut).toString("utf8")}\n[… output cut; narrow the search or use head_limit]`;
  }
  return text(true, o);
}

async function rg(args: string[], target: string): Promise<string | { error: string }> {
  let r: Awaited<ReturnType<typeof capture>>;
  try {
    r = await capture("rg", [...args, target], agentPathEnv());
  } catch (e) {
    return { error: `ripgrep (rg) can't run on ${hostname()}: ${osError(e)}` };
  }
  if (r.code === 0 || r.code === 1) return r.stdout.toString("utf8").trimEnd();
  return { error: `rg: ${r.stderr.toString("utf8").trim()}` };
}

function agentPathEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.PATH = providers.childPath();
  return env;
}

async function bash(cwd: string, chatId: number, a: unknown): Promise<Called> {
  const command = argStr(a, "command");
  if (command === undefined || command.trim() === "") return text(false, "command is required");
  const kept = CWDS.get(chatId);
  const here = kept !== undefined && isDir(kept) ? kept : cwd;
  const tag = token();
  if (argBool(a, "run_in_background") === true) {
    const log = join(tmpdir(), `harbor-bash-${tag.slice(0, 12)}.log`);
    let fd: number;
    try {
      fd = openSync(log, "wx", 0o600);
    } catch {
      return text(false, `cannot create ${log}`);
    }
    const child = await shellCommand(`exec 2>&1\n${command}`, here, ["ignore", fd, fd]);
    const failed = await new Promise<Error | null>((res) => {
      child.once("spawn", () => res(null));
      child.once("error", res);
    });
    closeSync(fd);
    if (failed) return text(false, `cannot run it in ${here}: ${osError(failed)}`);
    child.unref();
    return text(true, `Started in the background (process group ${child.pid}); its output goes to ${log}. Read that file to follow it; stop it with \`kill -- -${child.pid}\`.`);
  }
  const pwd = join(tmpdir(), `harbor-pwd-${tag.slice(0, 12)}`);
  const script = `trap 'pwd >| ${shQuote(pwd)} 2>/dev/null' EXIT\nexec 2>&1\n${command}`;
  const ms = Math.min(600_000, Math.max(1000, argUint(a, "timeout") ?? 120_000));
  const r = await shell(script, here, ms);
  try {
    const d = readFileSync(pwd, "utf8").replace(/\n+$/, "");
    if (isDir(d)) CWDS.set(chatId, d);
  } catch {
    // the shell never got as far as its trap
  }
  try {
    unlinkSync(pwd);
  } catch {
    // none was written
  }
  const out = r.text.trimEnd();
  switch (r.kind) {
    case "exit":
      return r.code === 0 ? text(true, out === "" ? "(no output)" : out) : text(false, `${out}\n[exit ${r.code}]`);
    case "stopped":
      return text(false, `${out}\n[stopped after ${Math.floor(ms / 1000)} s]`);
    case "failed":
      return text(false, r.why);
  }
}
