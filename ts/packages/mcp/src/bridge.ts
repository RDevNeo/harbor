import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HEAD_WAIT, HttpError, header, Reader, readBody, readChunked, readHead, urlEncode, type Request } from "@harbor/net";
import { home, writePrivate } from "@harbor/store";
import { argStr, argUint } from "./args.ts";
import { isObject, type Json } from "./json.ts";
import { grantFrom, type Grant as MachinesGrant, mcp as machinesMcp, NAME as MACHINES } from "./machines.ts";
import { agentProcessEnv, hostname, OUTPUT_MAX, shell, token } from "./shell.ts";
import { harborVersion } from "./version.ts";
import { call as workspaceCall, resolve, tools as workspaceTools } from "./workspace.ts";

export { OUTPUT_MAX, shell, token };

/** First port tried; a stable one lets turns that outlive a reload find it again. Not the phone API's (47930): that one has no other port to go to. */
export const PORT = 47940;
export const ORIGIN = "origin";
/** The `_meta` key a server stamps its `subscriptions/listen` notifications with: the id of the listen request. */
export const SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

/** How long a stdio server has to answer a request (`tool` for a tool call); each notification it sends about the request (progress) starts the wait again. Tests shorten them. */
export const waits = { wait: 60_000, tool: 3_600_000 };

const MAX_CONNS = 128;
const MAX_BODY = 32 << 20;
const IDLE = 30_000;

type Obj = { [k: string]: Json };

/** What one remote turn may reach. Saved in the turn's folder (owner-only: it holds the servers' tokens) so a Harbor that picks the turn up after a reload serves it again. Field names are the Rust app's, so either reads the other's file. */
export interface Grant {
  token: string;
  chat_id: number;
  /** The project here: stdio servers and commands run in it. */
  cwd: string;
  servers: Obj;
  commands: boolean;
  /** workspace.ts tools offered (empty: the agent works on the device's files). */
  workspace: string[];
  /** The `machines` server (every PC's files), while the mesh has other PCs. Local turns get a grant just for it. */
  machines: MachinesGrant | null;
}

function parseGrant(v: unknown): Grant | null {
  if (!isObject(v) || typeof v.token !== "string" || typeof v.chat_id !== "number" || typeof v.cwd !== "string" || !isObject(v.servers) || typeof v.commands !== "boolean") return null;
  return {
    token: v.token,
    chat_id: v.chat_id,
    cwd: v.cwd,
    servers: v.servers,
    commands: v.commands,
    workspace: Array.isArray(v.workspace) ? v.workspace.filter((t): t is string => typeof t === "string") : [],
    machines: grantFrom(v.machines),
  };
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | "late"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => {
    t = setTimeout(() => r("late"), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(t);
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function get(v: unknown, ...keys: string[]): unknown {
  let x = v;
  for (const k of keys) x = isObject(x) ? x[k] : undefined;
  return x;
}

const uint = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);


class Inbox {
  private queue: (Obj | null)[] = [];
  private waiting: ((v: Obj | null) => void) | null = null;

  push(v: Obj | null): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(v);
    } else this.queue.push(v);
  }

  next(): Promise<Obj | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

}

interface Wait {
  inbox: Inbox;
  id: Json;
  progress: Json;
  tool: boolean;
}

let procs = 0;

/** A running stdio server. Requests reach it with ids of the bridge's own (agents reuse theirs after a reconnect); each answer, and the notifications about a request, go to the connection waiting for it. So a request that is never answered holds up nothing but its own connection. */
class Proc {
  readonly id = ++procs;
  readonly byId = new Map<number, Wait>();
  heard: number | null = null;
  private dead = false;

  constructor(
    readonly child: ChildProcess,
    private cwd: string,
  ) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout?.on("data", (b: Buffer) => {
      pending += decoder.write(b);
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        this.line(line);
      }
    });
    child.stdout?.on("close", () => this.closeWaits());
    child.stdout?.on("error", () => this.closeWaits());
    child.stdin?.on("error", () => {
      this.dead = true;
    });
    child.once("exit", () => {
      this.dead = true;
    });
  }

  alive(): boolean {
    return !this.dead && this.child.exitCode === null && this.child.signalCode === null;
  }

  write(line: string): boolean {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(line);
    return true;
  }

  closeWaits(): void {
    for (const w of this.byId.values()) w.inbox.push(null);
    this.byId.clear();
  }

  kill(): void {
    this.dead = true;
    this.child.kill("SIGKILL");
    this.closeWaits();
  }

  /** A line of the server's output: answers go to the requests waiting for them, notifications about a request (its progress, its subscription) to that request, and the server's own requests (roots, ping) are answered here. */
  private line(text: string): void {
    this.heard = Date.now();
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(v)) return;
    const method = typeof v.method === "string" ? v.method : undefined;
    const rid = v.id;
    if (method !== undefined && rid !== undefined) {
      let answer: Obj;
      if (method === "roots/list") answer = { jsonrpc: "2.0", id: rid, result: { roots: [{ uri: `file://${this.cwd}`, name: "project" }] } };
      else if (method === "ping") answer = { jsonrpc: "2.0", id: rid, result: {} };
      else answer = { jsonrpc: "2.0", id: rid, error: { code: -32601, message: "not supported over Harbor's bridge" } };
      this.write(`${JSON.stringify(answer)}\n`);
    } else if (method !== undefined) {
      let to = uint(get(v, "params", "_meta", SUBSCRIPTION));
      if (to === undefined) {
        const token = get(v, "params", "progressToken");
        if (token !== null && token !== undefined) to = [...this.byId].find(([, x]) => sameJson(x.progress, token))?.[0];
      }
      if (to !== undefined) this.byId.get(to)?.inbox.push(v);
    } else if (rid !== undefined) {
      const k = uint(rid);
      const w = k === undefined ? undefined : this.byId.get(k);
      if (k !== undefined && w) {
        this.byId.delete(k);
        w.inbox.push(v);
      }
    }
  }
}

/** A stdio server's process, the `initialize` it got (replayed if it restarts), and the last id the bridge gave a request on its way there. */
class Slot {
  proc: Proc | null = null;
  init: Obj | null = null;
  next = 0;
  /** The turn ended: nothing starts here anymore. */
  closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  /** Held only to start the server and send to it. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => {});
    return r;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }
}

interface Live {
  grant: Grant;
  slots: Map<string, Slot>;
}

const GRANTS = new Map<string, Live>();

async function spawnServer(g: Grant, def: Obj): Promise<Proc | null> {
  const command = def.command;
  if (typeof command !== "string") return null;
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : [];
  const env = await agentProcessEnv();
  if (isObject(def.env)) for (const [k, v] of Object.entries(def.env)) if (typeof v === "string") env[k] = v;
  const child = spawn(command, args, { cwd: isDir(g.cwd) ? g.cwd : undefined, env, stdio: ["pipe", "pipe", "ignore"] });
  const failed = await new Promise<Error | null>((res) => {
    child.once("spawn", () => res(null));
    child.once("error", res);
  });
  if (failed) return null;
  return new Proc(child, g.cwd);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Writes `msg` to the server; a request goes under the bridge's id `mine`, and its answer comes on the inbox. Null when the server isn't there to take it. */
function send(p: Proc, msg: Obj, mine: number | null): { inbox: Inbox | null } | null {
  const out: Obj = { ...msg };
  let inbox: Inbox | null = null;
  if (mine !== null) {
    inbox = new Inbox();
    p.byId.set(mine, { inbox, id: msg.id ?? null, progress: (get(msg, "params", "_meta", "progressToken") ?? null) as Json, tool: msg.method === "tools/call" });
    out.id = mine;
  }
  if (!p.alive() || !p.write(`${JSON.stringify(out)}\n`)) {
    if (mine !== null) p.byId.delete(mine);
    return null;
  }
  return { inbox };
}

/** A new process in the slot. One that replaces a server that died mid-turn comes back initialized, as the agent left it (its answer bounded like any request's). */
async function restart(g: Grant, def: Obj, s: Slot, reinit: boolean): Promise<void> {
  s.stop();
  const p = await spawnServer(g, def);
  if (p && s.closed) {
    p.kill();
    return;
  }
  s.proc = p;
  const init = reinit ? s.init : null;
  if (!init || !p) return;
  s.next += 1;
  const sent = send(p, init, s.next);
  const first = sent?.inbox ? await within(sent.inbox.next(), waits.wait) : null;
  const answered = first !== null && first !== "late" && "result" in first;
  if (!answered || !send(p, { jsonrpc: "2.0", method: "notifications/initialized" }, null)) s.stop();
}

/** The connection a request came on, while the request waits for its answer. */
class Agent {
  sse = false;
  streaming = false;
  /** The agent hung up. */
  left = false;
  readonly goneP: Promise<"gone">;

  constructor(readonly s: Socket) {
    this.goneP = new Promise((resolve) => {
      const f = (): void => {
        this.left = true;
        resolve("gone");
      };
      s.once("end", f);
      s.once("close", f);
      s.on("error", f);
    });
  }

  event(v: Json): void {
    if (!this.sse) return;
    if (!this.streaming) {
      this.streaming = true;
      this.s.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
    }
    this.s.write(`event: message\ndata: ${JSON.stringify(v)}\n\n`);
  }
}

const rpcError = (id: Json, why: string): Obj => ({ jsonrpc: "2.0", id, error: { code: -32000, message: why } });

/** One message for a stdio server, and its answer (null for a notification, or when the agent hung up meanwhile). The slot is held only to start the server and send; then the request waits on its own, for at most `waits.wait` (`waits.tool`; a `subscriptions/listen` without a limit) and only while its agent is connected. A request given up on is cancelled at the server, and a server that said nothing at all meanwhile (and runs no tool call) is taken for stuck and stopped: the next request starts it again. */
async function stdio(g: Grant, def: Obj, slot: Slot, message: Obj, agent: Agent): Promise<Json | null> {
  const hasId = "id" in message;
  const id = (message.id ?? null) as Json;
  const msg = structuredClone(message);
  const sent = await slot.lock(async () => {
    if (slot.closed) return null;
    if (msg.method === "initialize") slot.init = structuredClone(msg);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!slot.proc?.alive()) await restart(g, def, slot, msg.method !== "initialize");
      slot.next += 1;
      const mine = slot.next;
      const p = slot.proc;
      if (!p) break;
      if (msg.method === "notifications/cancelled") {
        // The agent names its own id; the server knows the bridge's. Whoever waits for that answer stops.
        const theirs = get(msg, "params", "requestId");
        const found = [...p.byId].find(([, x]) => sameJson(x.id, theirs));
        if (found && isObject(msg.params)) {
          msg.params.requestId = found[0];
          p.byId.delete(found[0]);
          found[1].inbox.push(rpcError(found[0], "cancelled"));
        }
      }
      const r = send(p, msg, hasId ? mine : null);
      if (r) return { inbox: r.inbox, mine, proc: p };
      // It was gone already: once more with a new one.
      slot.stop();
    }
    return null;
  });
  if (!sent) return hasId ? rpcError(id, "the MCP server on the Harbor PC didn't start or exited") : null;
  const { inbox, mine, proc } = sent;
  if (!hasId || !inbox) return null;
  const at = Date.now();
  // A listen is answered only by its events, for as long as the agent wants them.
  const listen = msg.method === "subscriptions/listen";
  const limit = msg.method === "tools/call" ? waits.tool : waits.wait;
  let until = at + limit;
  // Not to wait for anymore: the server drops it too.
  const forget = (): void => {
    proc.byId.delete(mine);
    proc.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: mine, reason: "the client is gone or it took too long" } })}\n`);
  };
  for (;;) {
    const next = Promise.race([inbox.next(), agent.goneP]);
    const got = listen ? await next : await within(next, Math.max(0, until - Date.now()));
    if (got === "gone") {
      forget();
      return null;
    }
    if (got === "late") {
      forget();
      const stuck = (proc.heard === null || proc.heard < at) && ![...proc.byId.values()].some((x) => x.tool);
      if (stuck) await slot.lock(async () => (slot.proc?.id === proc.id ? slot.stop() : undefined));
      return rpcError(id, `the MCP server on the Harbor PC didn't answer in ${Math.floor(limit / 1000)} s`);
    }
    if (got === null) return rpcError(id, "the MCP server on the Harbor PC exited");
    if ("method" in got) {
      // About this request (progress, a subscription's events): on to the agent, and the wait starts again.
      const meta = get(got, "params", "_meta");
      if (isObject(meta) && SUBSCRIPTION in meta) meta[SUBSCRIPTION] = id;
      agent.event(got);
      if (agent.left) {
        forget();
        return null;
      }
      until = Date.now() + limit;
      continue;
    }
    got.id = id;
    return got;
  }
}


/** Forwards the request to the server's URL with its headers (tokens) added here, and streams the answer back (JSON or an event stream). */
async function forward(s: Socket, agent: Agent, req: Req, def: Obj): Promise<void> {
  const url = def.url;
  if (typeof url !== "string") return respond(s, 404, "text/plain", "no url");
  const headers = new Headers();
  if (isObject(def.headers)) for (const [k, v] of Object.entries(def.headers)) if (typeof v === "string") headers.set(k, v);
  for (const k of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const v = req.header(k);
    if (v !== null) headers.set(k, v);
  }
  const abort = new AbortController();
  void agent.goneP.then(() => abort.abort());
  const init: RequestInit = { method: req.method, headers, redirect: "manual", signal: abort.signal };
  if (req.body.length > 0) init.body = req.body;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    if (agent.left) return void s.destroy();
    return respond(s, 502, "text/plain", "bridge: the server didn't answer");
  }
  const keep: string[] = [];
  for (const k of ["content-type", "mcp-session-id", "www-authenticate"]) {
    const v = res.headers.get(k);
    if (v !== null) keep.push(`${k}: ${v}`);
  }
  s.write(`HTTP/1.1 ${res.status} X\r\n${keep.map((h) => `${h}\r\n`).join("")}Cache-Control: no-cache\r\nConnection: close\r\n\r\n`);
  // Copied as it comes, so an event stream reaches the agent as it is written.
  try {
    const reader = res.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done || agent.left) break;
      if (!s.write(chunk.value)) await Promise.race([new Promise((r) => s.once("drain", r)), agent.goneP]);
    }
  } catch {
    // the server or the agent went away mid-stream
  }
  abort.abort();
  s.end(() => s.destroy());
}


interface Prompt {
  name: string;
  description: string;
  body: string;
}

/** A command or skill read from `~/.claude`, as the slash module scans them. */
export interface LocalCommand {
  name: string;
  description: string;
  body: string;
  skill: string | null;
}

/** Where the user's commands and skills come from (the ui package's slash logic); the app sets it at startup. */
export interface Slash {
  scan(base: string): LocalCommand[];
  withArgs(body: string, args: string): string;
}

let slash: Slash | null = null;

export function setSlash(s: Slash | null): void {
  slash = s;
}

/** ~/.claude/commands (as `name`, folders joined with `_`) and ~/.claude/skills (as `skill_<folder>`). Skills' other files stay here; the prompt says where. */
function prompts(): Prompt[] {
  const ident = (s: string): string => s.replace(/[^A-Za-z0-9_-]/gu, "_");
  return (slash?.scan(join(home(), ".claude")) ?? []).map((l) =>
    l.skill === null
      ? { name: ident(l.name), description: l.description, body: l.body }
      : {
          name: `skill_${basename(l.skill)}`,
          description: l.description,
          body: `Follow this skill. Its other files are on the Harbor PC in ${l.skill} (the origin read tool, or run_command, reads them when this device has it).\n\n${l.body}`,
        },
  );
}

function runCommandOn(g: Grant): boolean {
  return g.commands && !g.workspace.includes("bash");
}

function runCommandTool(): Json {
  return {
    name: "run_command",
    description: `Run a shell command on ${hostname()}, the PC running Harbor (not the machine you run on): its files, tools and sign-ins. Returns the output and exit code.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (bash)" },
        cwd: { type: "string", description: "Folder there; relative paths are from the project (default: the project)" },
        timeout: { type: "integer", description: "Seconds before it is stopped (default 120, at most 600)" },
      },
      required: ["command"],
    },
  };
}

async function runCommand(g: Grant, a: unknown): Promise<{ ok: boolean; text: string }> {
  const command = argStr(a, "command");
  if (command === undefined || command.trim() === "") return { ok: false, text: "command is required" };
  const cwd = resolve(g.cwd, argStr(a, "cwd") ?? "");
  const secs = Math.min(600, Math.max(1, argUint(a, "timeout") ?? 120));
  const r = await shell(`exec 2>&1\n${command}`, cwd, secs * 1000);
  switch (r.kind) {
    case "exit":
      return { ok: r.code === 0, text: `${r.text}\n[exit ${r.code}]` };
    case "stopped":
      return { ok: false, text: `${r.text}\n[stopped after ${secs} s]` };
    case "failed":
      return { ok: false, text: r.why };
  }
}

async function origin(g: Grant, msg: Obj): Promise<Json | null> {
  if (!("id" in msg)) return null;
  const id = msg.id as Json;
  const p = msg.params;
  let result: Json;
  switch (typeof msg.method === "string" ? msg.method : "") {
    case "initialize": {
      const where = g.workspace.length > 0 ? "; your workspace is there: its tools (bash, read, write, edit, glob, grep) work on the project there" : g.commands ? "; run_command runs a shell command there (not on the machine you run on)" : "";
      result = {
        protocolVersion: argStr(p, "protocolVersion") ?? "2025-06-18",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: ORIGIN, version: harborVersion() },
        instructions: `You run on a remote device. '${hostname()}' is the PC running Harbor (the user is usually there; a message from a phone or another PC says so). Its prompts are the user's own slash commands and skills${where}.`,
      };
      break;
    }
    case "tools/list": {
      const tools = workspaceTools(g.workspace);
      if (runCommandOn(g)) tools.push(runCommandTool());
      result = { tools };
      break;
    }
    case "tools/call": {
      const name = argStr(p, "name") ?? "";
      const args = get(p, "arguments") ?? null;
      if (runCommandOn(g) && name === "run_command") {
        const r = await runCommand(g, args);
        result = { content: [{ type: "text", text: r.text }], isError: !r.ok };
      } else if (g.workspace.includes(name)) {
        const r = await workspaceCall(g.cwd, g.chat_id, name, args);
        result = { content: r.content, isError: !r.ok };
      } else {
        result = { content: [{ type: "text", text: "No such tool here (this device isn't allowed it on the Harbor PC)." }], isError: true };
      }
      break;
    }
    case "prompts/list":
      result = {
        prompts: prompts().map((c) => ({
          name: c.name,
          description: c.description,
          arguments: [{ name: "arguments", description: "What to pass to it ($ARGUMENTS)", required: false }],
        })),
      };
      break;
    case "prompts/get": {
      const name = argStr(p, "name") ?? "";
      const c = prompts().find((x) => x.name === name);
      if (!c) return { jsonrpc: "2.0", id, error: { code: -32602, message: `no prompt ${name}` } };
      const text = slash ? slash.withArgs(c.body, argStr(get(p, "arguments"), "arguments") ?? "") : c.body;
      result = { description: c.description, messages: [{ role: "user", content: { type: "text", text } }] };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  return { jsonrpc: "2.0", id, result };
}


interface Req {
  method: string;
  body: Buffer;
  header(k: string): string | null;
}

const REASONS: Record<number, string> = { 200: "OK", 202: "Accepted", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large", 431: "Request Header Fields Too Large" };

function respond(s: Socket, code: number, ctype: string, body: string | Uint8Array): void {
  const data = typeof body === "string" ? Buffer.from(body) : body;
  const head = `HTTP/1.1 ${code} ${REASONS[code] ?? "Error"}\r\nContent-Type: ${ctype}\r\nContent-Length: ${data.length}\r\nAllow: POST, DELETE\r\nConnection: close\r\n\r\n`;
  s.end(Buffer.concat([Buffer.from(head), data]), () => s.destroy());
}

async function handle(s: Socket): Promise<void> {
  s.on("error", () => {});
  const agent = new Agent(s);
  const r = new Reader(s);
  const headTimer = setTimeout(() => s.destroy(), HEAD_WAIT);
  s.setTimeout(IDLE, () => s.destroy());
  let head: Request;
  try {
    head = await readHead(r, true);
  } catch (e) {
    clearTimeout(headTimer);
    return e instanceof HttpError ? respond(s, e.status, "text/plain", "bad request") : void s.destroy();
  }
  clearTimeout(headTimer);
  // The path comes decoded: "<token>/<server name>".
  const path = head.path.replace(/^\/+|\/+$/g, "");
  const slashAt = path.indexOf("/");
  const tokenPart = slashAt < 0 ? path : path.slice(0, slashAt);
  const server = slashAt < 0 ? "" : path.slice(slashAt + 1);
  const live = GRANTS.get(tokenPart);
  const def = live && Object.hasOwn(live.grant.servers, server) ? (live.grant.servers[server] as Json) : undefined;
  const mine = live !== undefined && (server === ORIGIN || (server === MACHINES && live.grant.machines !== null));
  if (!live || !(mine || def !== undefined)) return respond(s, 404, "text/plain", "not found");
  const grant = live.grant;
  const slot = live.slots.get(server) ?? new Slot();
  live.slots.set(server, slot);
  let body: Buffer;
  try {
    body = head.chunked ? await readChunked(r, MAX_BODY) : await readBody(r, head.len, MAX_BODY);
  } catch (e) {
    return e instanceof HttpError ? respond(s, e.status, "text/plain", "bad body") : void s.destroy();
  }
  s.setTimeout(0);
  const req: Req = { method: head.method, body, header: (k) => header(head, k) };
  const defObj = isObject(def) ? def : undefined;
  const kind = defObj ? (typeof defObj.type === "string" ? defObj.type : "url" in defObj ? "http" : "stdio") : undefined;
  if (defObj && kind === "http") return forward(s, agent, req, defObj);
  if (req.method === "DELETE") return respond(s, 200, "text/plain", "");
  if (req.method !== "POST") return respond(s, 405, "text/plain", "");
  let msg: unknown;
  try {
    msg = JSON.parse(body.toString("utf8"));
  } catch {
    return respond(s, 400, "application/json", JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
  }
  const one = async (m: unknown): Promise<Json | null> => {
    if (!isObject(m)) return null;
    if (!defObj) return server === MACHINES && grant.machines ? machinesMcp(grant.machines, grant.cwd, grant.chat_id, m) : origin(grant, m);
    if (kind === "stdio") return stdio(grant, defObj, slot, m, agent);
    return "id" in m ? rpcError(m.id as Json, "Harbor's bridge only carries stdio and http servers") : null;
  };
  // Events only for a single request (a batch's answers come together).
  agent.sse = !Array.isArray(msg) && (req.header("accept") ?? "").includes("text/event-stream");
  let out: Json | null;
  if (Array.isArray(msg)) {
    const all: Json[] = [];
    for (const m of msg) {
      const a = await one(m);
      if (a !== null) all.push(a);
    }
    out = all.length > 0 ? all : null;
  } else out = await one(msg);
  if (agent.left) return void s.destroy();
  if (out !== null && agent.streaming) {
    agent.event(out);
    s.end(() => s.destroy());
  } else if (out !== null) respond(s, 200, "application/json", JSON.stringify(out));
  else respond(s, 202, "application/json", "");
}


const servers = new Set<Server>();
const sockets = new Set<Socket>();
let conns = 0;

export function listen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer({ allowHalfOpen: true }, (s) => {
      if (conns >= MAX_CONNS) return void s.destroy();
      conns++;
      sockets.add(s);
      s.once("close", () => {
        conns--;
        sockets.delete(s);
      });
      void handle(s);
    });
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      servers.add(server);
      resolve((server.address() as { port: number }).port);
    });
  });
}

let found: Promise<number | null> | null = null;

export function port(): Promise<number | null> {
  found ??= (async () => {
    for (let p = PORT; p < PORT + 10; p++) {
      const bound = await listen(p);
      if (bound !== null) return bound;
    }
    return null;
  })();
  return found;
}

/** The bridge port a turn's ssh forwards to (its `-R …:127.0.0.1:<port>` in cmd.json). */
export function forwardedPort(dir: string): number | null {
  try {
    const args = get(JSON.parse(readFileSync(join(dir, "cmd.json"), "utf8")), "args");
    if (!Array.isArray(args)) return null;
    const strings = args.filter((a): a is string => typeof a === "string");
    const i = strings.indexOf("-R");
    const spec = i < 0 ? undefined : strings[i + 1];
    const last = spec?.split(":").pop();
    return last !== undefined && /^\d+$/.test(last) && Number(last) <= 65535 ? Number(last) : null;
  } catch {
    return null;
  }
}

export async function grant(g: Grant): Promise<number | null> {
  const p = await port();
  if (p === null) return null;
  if (!GRANTS.has(g.token)) GRANTS.set(g.token, { grant: g, slots: new Map() });
  return p;
}

export function revoke(tokenToEnd: string): void {
  const live = GRANTS.get(tokenToEnd);
  if (!live) return;
  GRANTS.delete(tokenToEnd);
  // Nothing waits on a request still pending (it hears that its server is gone).
  for (const slot of live.slots.values()) {
    slot.closed = true;
    slot.stop();
  }
}

export function save(dir: string, g: Grant): void {
  try {
    writePrivate(join(dir, "bridge.json"), JSON.stringify(g));
  } catch {
    // the turn runs without a saved grant; a reload then can't serve it again
  }
}

function saved(dir: string): Grant | null {
  try {
    return parseGrant(JSON.parse(readFileSync(join(dir, "bridge.json"), "utf8")));
  } catch {
    return null;
  }
}

const extra: number[] = [];

/** A turn followed again (after a reload): its grant is served again, also on the port its ssh forwards to when that isn't this run's (a turn started by an older build). When that port is someone else's now (another local user took it while Harbor was away), the grant is not served at all: whoever holds the port has seen its token. */
export async function resume(dir: string): Promise<void> {
  const g = saved(dir);
  if (!g) return;
  const here = await grant(g);
  const p = forwardedPort(dir);
  if (p === null || p === here || extra.includes(p)) return;
  if ((await listen(p)) !== null) extra.push(p);
  else {
    console.error(`harbor: a remote turn's bridge port 127.0.0.1:${p} is taken by another process; its MCP servers are cut off`);
    revoke(g.token);
  }
}

export function end(dir: string): void {
  const g = saved(dir);
  if (g) revoke(g.token);
}

export async function close(): Promise<void> {
  for (const t of [...GRANTS.keys()]) revoke(t);
  for (const s of sockets) s.destroy();
  await Promise.all([...servers].map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.clear();
  extra.length = 0;
  found = null;
}

export function remoteConfig(g: Grant, remotePort: number): Json {
  const m: Obj = {};
  const names = [...Object.keys(g.servers), ORIGIN, ...(g.machines ? [MACHINES] : [])];
  for (const name of names) m[name] = { type: "http", url: `http://127.0.0.1:${remotePort}/${g.token}/${urlEncode(name)}` };
  return { mcpServers: m };
}

export const enc = urlEncode;

export function serving(t: string): boolean {
  return GRANTS.has(t);
}
