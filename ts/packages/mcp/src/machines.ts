import { realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Body, type Dest, dest, hostname, http as meshHttp, jsonBody, type Kv, type Me, type Peer, shQuote } from "@harbor/net";
import { home, privateDir, randomHex } from "@harbor/store";
import { argStr, argStrings, argUint } from "./args.ts";
import { isObject, type Json } from "./json.ts";
import { signedIn } from "./mcp.ts";
import { shell } from "./shell.ts";
import { harborVersion } from "./version.ts";
import { call as workspaceCall, resolve, TOOLS, tools as workspaceTools } from "./workspace.ts";

export const NAME = "machines";
/** kv: what this PC shares with each other PC, `{peer id: level}`. */
export const SHARE_KEY = "share_files";
/** kv: "0" = chats this PC drives on other PCs don't get its GitHub login. */
export const GITHUB_KEY = "share_github";

export type Level = "off" | "read" | "edit" | "full";

export const LEVELS: readonly Level[] = ["off", "read", "edit", "full"];

export const DEFAULT: Level = "full";

export function parseLevel(s: string): Level | null {
  return LEVELS.find((l) => l === s) ?? null;
}

export function label(l: Level): string {
  return { off: "Nothing", read: "Read my projects", edit: "Edit my projects", full: "Everything (shell, any file, GitHub)" }[l];
}

export function aboutLevel(l: Level): string {
  return {
    off: "Its chats can't see this PC's files",
    read: "Read and search inside your Harbor projects",
    edit: "Also write and edit files inside your projects",
    full: "Run any command and open any file as you, use your GitHub login (the default)",
  }[l];
}

export function short(l: Level): string {
  return { off: "Shares nothing", read: "Reads projects", edit: "Edits projects", full: "Everything" }[l];
}

export function allows(l: Level, tool: string): boolean {
  switch (l) {
    case "off":
      return false;
    case "read":
      return ["read", "glob", "grep"].includes(tool);
    case "edit":
      return ["read", "glob", "grep", "write", "edit"].includes(tool);
    case "full":
      return true;
  }
}

export type Project = [name: string, path: string];

interface Share {
  levels: Map<string, Level>;
  github: boolean;
  projects: Project[];
  /** Memory ids this PC sent with its chats' context: proof a call is for one. */
  ids: Set<string>;
}

const SHARE: Share = { levels: new Map(), github: false, projects: [], ids: new Set() };

export function levels(kv: Kv): Map<string, Level> {
  const out = new Map<string, Level>();
  const raw = kv.get(SHARE_KEY);
  if (raw === null) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObject(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const l = typeof x === "string" ? parseLevel(x) : null;
    if (l) out.set(k, l);
  }
  return out;
}

export function levelFor(kv: Kv, peer: string): Level {
  return levels(kv).get(peer) ?? DEFAULT;
}

export function fullAccess(peer: string): boolean {
  return (SHARE.levels.get(peer) ?? DEFAULT) === "full";
}

export function setLevel(kv: Kv, peer: string, l: Level): void {
  let m: { [k: string]: Json } = {};
  try {
    const v: unknown = JSON.parse(kv.get(SHARE_KEY) ?? "{}");
    if (isObject(v)) m = v;
  } catch {
    // an unreadable value starts over
  }
  m[peer] = l;
  kv.set(SHARE_KEY, JSON.stringify(m));
}

export function githubOn(kv: Kv): boolean {
  return kv.get(GITHUB_KEY) !== "0";
}

/** Hands the listener what it answers with: levels, projects, and the memory ids this PC issued (net's `issuedIds`). */
export function publish(kv: Kv, projects: Project[], ids: Set<string>): void {
  SHARE.levels = levels(kv);
  SHARE.github = githubOn(kv);
  SHARE.projects = projects;
  SHARE.ids = ids;
}


export interface Reply {
  status: number;
  body: Json;
}

const ok = (body: Json): Reply => ({ status: 200, body });
const err = (status: number, msg: string): Reply => ({ status, body: { error: msg } });

export function serveShare(peer: string): Reply {
  const level = SHARE.levels.get(peer) ?? DEFAULT;
  const projects: Json[] = level === "off" ? [] : SHARE.projects.map(([name, path]) => ({ name, path }));
  return ok({ level, github: SHARE.github, projects, home: level === "full" ? home() : null });
}

/** `POST /mesh/v1/tool` `{tool, args, project, chat, memory_id}` from `peer`: one tool call, if this PC's owner lets that PC's chats do it there. Answers `{ok, content}`. */
export async function serveTool(peer: string, body: unknown): Promise<Reply> {
  const tool = argStr(body, "tool") ?? "";
  const args = isObject(body) ? (body.args ?? null) : null;
  const level = SHARE.levels.get(peer) ?? DEFAULT;
  const id = argStr(body, "memory_id") ?? "";
  const proven = id !== "" && SHARE.ids.has(id);
  const projects = SHARE.projects;
  const me = hostname();
  const no = (why: string): Reply => ok({ ok: false, content: [{ type: "text", text: why }] });
  if (tool === "github") {
    if (!(level === "full" || (SHARE.github && proven))) return no(`${me} doesn't let this PC's chats use its GitHub login (its owner can allow it in Settings › Devices)`);
    const r = await gh(args, level === "full");
    return ok({ ok: r.ok, content: [{ type: "text", text: r.text }] });
  }
  if (!TOOLS.includes(tool)) return err(400, "no such tool");
  if (!allows(level, tool)) {
    return no(`${me} doesn't allow \`${tool}\` for this PC's chats: it shares ${label(level).toLowerCase()}. Its owner can change that in Settings › Devices there.`);
  }
  const roots = projects.map(([, p]) => p);
  const name = argStr(body, "project") ?? "";
  // Relative paths and the shell start in the chat's project here (same name), else home
  // (everything shared) or the first project.
  const named = projects.find(([n]) => name !== "" && n === name);
  let cwd: string;
  if (named) cwd = named[1];
  else if (level === "full") cwd = home();
  else if (roots[0] !== undefined) cwd = roots[0];
  else return no(`${me} has no projects in Harbor to share`);
  if (level !== "full") {
    const key = ["read", "write", "edit"].includes(tool) ? "file_path" : "path";
    const target = resolve(cwd, argStr(args, key) ?? "");
    if (!inside(target, roots)) return no(`${target} is outside the projects ${me} shares (${roots.join(", ")})`);
  }
  const r = await workspaceCall(cwd, chatKey(peer, argStr(body, "chat") ?? ""), tool, args);
  return ok({ ok: r.ok, content: r.content });
}

/** A (peer, chat) pair as the bash tool's per-chat folder key: negative, apart from this PC's chats (an FNV-1a hash, 52 bits so the number stays exact). */
export function chatKey(peer: string, chat: string): number {
  const mask = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.concat([Buffer.from(peer), Buffer.from([0]), Buffer.from(chat)])) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & mask;
  }
  return -Number(h >> 12n) - 1;
}

/** Whether `p` (absolute) is inside one of `roots`, symlinks resolved: its nearest existing folder is resolved and the rest may not climb out. */
export function inside(p: string, roots: readonly string[]): boolean {
  if (!p.startsWith("/") || p.split("/").includes("..")) return false;
  let base = p;
  const rest: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync(base);
      break;
    } catch {
      const up = dirname(base);
      if (base === "/" || up === base) return false;
      rest.push(basename(base));
      base = up;
    }
  }
  for (const c of rest.reverse()) real = real === "/" ? `/${c}` : `${real}/${c}`;
  return roots.some((r) => {
    try {
      const root = realpathSync(r);
      return real === root || real.startsWith(root === "/" ? "/" : `${root}/`);
    } catch {
      return false;
    }
  });
}

/** gh's commands a chat may run through `github` without full access: GitHub's own objects. Not `alias`, `extension`, `config` (they run commands here), `auth` (the token), `codespace`. */
const GH_COMMANDS = ["api", "issue", "pr", "repo", "release", "run", "workflow", "gist", "search", "label", "status", "project", "cache", "variable", "secret", "ruleset"];

/** Without full access `github` may not touch this PC's files: a known command, and no argument that names a path here (absolute, home, climbing up, `@file`); it runs in an empty folder of its own, so relative paths name nothing. Null when allowed, else why not. */
export function ghAllowed(argv: readonly string[]): string | null {
  const cmd = argv[0] ?? "";
  if (!GH_COMMANDS.includes(cmd)) return `\`gh ${cmd}\` isn't allowed here (only ${GH_COMMANDS.join(", ")})`;
  const path = (x: string): boolean => x.startsWith("/") || x.startsWith("~") || x.startsWith("@") || x === ".." || x.startsWith("../") || x.includes("/../");
  for (const [i, a] of argv.entries()) {
    // `gh api /repos/…`: an endpoint, not a file.
    if (cmd === "api" && i === 1 && a.startsWith("/") && !a.includes("..")) continue;
    const eq = a.indexOf("=");
    const v = eq < 0 ? a : a.slice(eq + 1);
    if (path(a) || path(v)) return `\`${a}\` names a file on this PC; GitHub through another PC can't read or write its files`;
  }
  return null;
}

export async function gh(args: unknown, full: boolean): Promise<{ ok: boolean; text: string }> {
  const argv = argStrings(args, "args");
  if (argv.length === 0) return { ok: false, text: 'args is required (gh\'s arguments, e.g. ["pr", "list"])' };
  if (!full) {
    const why = ghAllowed(argv);
    if (why !== null) return { ok: false, text: why };
  }
  if (!signedIn("github")) return { ok: false, text: `GitHub isn't signed in in Harbor on ${hostname()}` };
  const script = `exec 2>&1\nGH_PAGER=cat GH_PROMPT_DISABLED=1 GH_BROWSER=false BROWSER=false exec gh ${argv.map(shQuote).join(" ")}`;
  const scratch = join(tmpdir(), `harbor-gh-${randomHex(8)}`);
  const wanted = argStr(args, "cwd");
  let dir: string;
  if (full && wanted !== undefined && isDir(wanted)) dir = wanted;
  else if (isDir(privateDir(scratch))) dir = scratch;
  else return { ok: false, text: "no scratch folder" };
  const r = await shell(script, dir, 300_000);
  rmSync(scratch, { recursive: true, force: true });
  switch (r.kind) {
    case "exit":
      if (r.code === 0) return { ok: true, text: r.text.trim() === "" ? "(no output)" : r.text };
      return { ok: false, text: `${r.text}\n[exit ${r.code}]` };
    case "stopped":
      return { ok: false, text: `${r.text}\n[stopped after 300 s]` };
    case "failed":
      return { ok: false, text: r.why };
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}


export interface Grant {
  /** The chat's gid and its project's name (the same project on another PC goes by it). */
  chat: string;
  project: string;
  /** workspace.ts tools its mode allows. */
  tools: string[];
  /** A chat commanded from another PC: that PC's id and the memory id it sent. */
  commander: string;
  memory_id: string;
}

export function grantFrom(v: unknown): Grant | null {
  if (!isObject(v)) return null;
  return {
    chat: typeof v.chat === "string" ? v.chat : "",
    project: typeof v.project === "string" ? v.project : "",
    tools: Array.isArray(v.tools) ? v.tools.filter((t): t is string => typeof t === "string") : [],
    commander: typeof v.commander === "string" ? v.commander : "",
    memory_id: typeof v.memory_id === "string" ? v.memory_id : "",
  };
}

type Obj = { [k: string]: Json };

function toolDefs(g: Grant): Json[] {
  const machine = { type: "string", description: "The PC's name (as `list` shows it)" };
  const out: Json[] = [
    {
      name: "list",
      description:
        "The PCs of the user's Harbor mesh: who owns each, whether it's on, what it lets this chat do there and its projects' folders; then the Harbor version and update status of every PC and the app version of every paired phone. Call it before working on another PC.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
  for (const t of workspaceTools(g.tools) as Obj[]) {
    const name = String(t.name ?? "");
    t.description = `${generic(name)} On the PC named by \`machine\`: this one or another PC of the mesh (its owner decides what it allows).`;
    const schema = t.inputSchema as Obj;
    (schema.properties as Obj).machine = machine;
    (schema.required as Json[]).unshift("machine");
    out.push(t);
  }
  if (g.tools.includes("bash")) {
    out.push({
      name: "github",
      description:
        "Run gh (GitHub's CLI) on a PC, signed in as that PC's owner in Harbor: issues, pull requests, releases, `gh api`. A chat driven from another PC uses it on that PC, so GitHub actions are its person's. Unless that PC allows everything it runs in an empty folder and takes no file paths: pass --repo owner/name and texts inline (--body, -f).",
      inputSchema: {
        type: "object",
        properties: {
          machine,
          args: { type: "array", items: { type: "string" }, description: 'gh\'s arguments, e.g. ["pr", "create", "--repo", "owner/name", "--title", "…", "--body", "…"]' },
          cwd: { type: "string", description: "Folder there (a clone, for gh's repo detection)" },
        },
        required: ["machine", "args"],
      },
    });
  }
  return out;
}

/** workspace.ts's description of a tool, without its "on <this PC>" wording. */
function generic(name: string): string {
  return (
    {
      bash: "Run a bash command (the folder is kept between calls; output and exit code come back).",
      read: "Read a file: lines numbered like cat -n (offset/limit for more); images come back as images.",
      write: "Write a file, replacing it (folders are created).",
      edit: "Replace exact text in a file (old_string must be unique unless replace_all).",
      glob: "Find files by glob pattern, newest first.",
      grep: "Search file contents with ripgrep.",
    } as Record<string, string>
  )[name] ?? "";
}

const text = (ok: boolean, t: string): Json => ({ content: [{ type: "text", text: t }], isError: !ok });

export interface Hub {
  me(): Me;
  peers(): Peer[];
  /** The Harbor version and update status of every PC, and the paired phones' apps (net's `versionsText`). */
  versions(): string;
  /** One request to a peer; the mesh's own client unless a test brings another. */
  http?: (to: Dest, method: string, path: string, body: Body | null, wait: number) => Promise<[number, unknown]>;
}

let hub: Hub | null = null;

export function setHub(h: Hub | null): void {
  hub = h;
}

export async function mcp(g: Grant, cwd: string, chatId: number, msg: unknown): Promise<Json | null> {
  if (!isObject(msg) || !("id" in msg)) return null;
  const id = msg.id as Json;
  const p = msg.params;
  let result: Json;
  switch (typeof msg.method === "string" ? msg.method : "") {
    case "initialize":
      result = {
        protocolVersion: argStr(p, "protocolVersion") ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: harborVersion() },
        instructions: "Files, shell and GitHub on every PC of the user's Harbor mesh: pass `machine` (see `list`). Each PC's owner decides what other PCs' chats may do there.",
      };
      break;
    case "tools/list":
      result = { tools: toolDefs(g) };
      break;
    case "tools/call":
      result = await callTool(g, cwd, chatId, argStr(p, "name") ?? "", isObject(p) ? (p.arguments ?? null) : null);
      break;
    case "ping":
      result = {};
      break;
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  return { jsonrpc: "2.0", id, result };
}

async function callTool(g: Grant, cwd: string, chatId: number, name: string, a: unknown): Promise<Json> {
  if (!hub) return text(false, "Harbor's mesh isn't running");
  if (name === "list") return text(true, await list(hub, g));
  const allowed = (name === "github" && g.tools.includes("bash")) || g.tools.includes(name);
  if (!allowed) return text(false, `\`${name}\` isn't available in this chat's mode`);
  const want = (argStr(a, "machine") ?? "").trim();
  const me = hub.me();
  const mine = want === "" || want.toLowerCase() === me.name.toLowerCase() || want === me.id || want.toLowerCase() === hostname().toLowerCase();
  if (mine) {
    if (name === "github") {
      const r = await gh(a, true);
      return text(r.ok, r.text);
    }
    const r = await workspaceCall(cwd, chatId, name, a);
    return { content: r.content, isError: !r.ok };
  }
  const peer = hub.peers().find((x) => x.name.toLowerCase() === want.toLowerCase() || x.id === want);
  if (!peer) return text(false, `No PC named '${want}' in the mesh; \`list\` shows them`);
  if (!peer.online) return text(false, `${peer.name} is off or unreachable right now`);
  const args: Obj = isObject(a) ? { ...a } : {};
  delete args.machine;
  const memoryId = peer.id === g.commander ? g.memory_id : "";
  const body = { tool: name, args, project: g.project, chat: g.chat, memory_id: memoryId };
  const wait = Math.min(600_000, Math.max(1000, argUint(a, "timeout") ?? 120_000)) + 30_000;
  try {
    const [status, v] = await (hub.http ?? meshHttp)(dest(peer), "POST", "/mesh/v1/tool", jsonBody(body), wait);
    if (status === 200) return { content: isObject(v) ? (v.content as Json) : null, isError: !(isObject(v) && v.ok === true) };
    if (status === 404) return text(false, `${peer.name} runs an older Harbor without shared files (0.45+)`);
    return text(false, `${peer.name} answered ${status}: ${argStr(v, "error") ?? ""}`);
  } catch (e) {
    return text(false, `${peer.name} didn't answer: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function list(h: Hub, g: Grant): Promise<string> {
  const me = h.me();
  const lines = [`- ${me.name === "" ? hostname() : me.name} (this PC, where you run): everything (your own tools work here too)${g.commander === "" ? "" : "; its owner's GitHub and app sign-ins are off for this chat"}`];
  const request = h.http ?? meshHttp;
  const answers = await Promise.all(
    h.peers().map(async (p): Promise<[Peer, unknown]> => {
      if (!p.online) return [p, null];
      try {
        const [status, v] = await request(dest(p), "GET", "/mesh/v1/share", null, 6000);
        return [p, status === 200 ? v : null];
      } catch {
        return [p, null];
      }
    }),
  );
  for (const [p, v] of answers) {
    const owner = p.owner === "" ? "" : `, owner ${p.owner}`;
    const driven = p.id === g.commander ? " — this chat is driven from here" : "";
    let what: string;
    if (!p.online) what = "offline";
    else if (v === null) what = "on, but its Harbor shares no files (older than 0.45)";
    else {
      const level = parseLevel(argStr(v, "level") ?? "") ?? "off";
      what = `allows: ${label(level).toLowerCase()}`;
      const github = level === "full" || (isObject(v) && v.github === true && p.id === g.commander);
      if (github && level !== "full") what += "; github: yes (its owner's login, for this chat)";
      const projects = isObject(v) && Array.isArray(v.projects) ? v.projects.map((x) => `${argStr(x, "path") ?? ""} (${argStr(x, "name") ?? ""})`) : [];
      if (projects.length > 0) what += `; projects: ${projects.join(", ")}`;
      const homeDir = argStr(v, "home");
      if (homeDir !== undefined) what += `; home ${homeDir}`;
    }
    lines.push(`- ${p.name}${owner}${driven}: ${what}`);
  }
  lines.push("");
  lines.push(h.versions());
  return lines.join("\n");
}
