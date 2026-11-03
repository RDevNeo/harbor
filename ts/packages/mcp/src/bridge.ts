import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HEAD_WAIT, HttpError, header, Reader, readBody, readChunked, readHead, urlEncode, type Request } from "@harbor/net";
import { dataDir, home, privateDir, writePrivate } from "@harbor/store";
import { argStr, argUint } from "./args.ts";
import { isObject, type Json } from "./json.ts";
import { grantFrom, type Grant as MachinesGrant, mcp as machinesMcp, NAME as MACHINES } from "./machines.ts";
import { hostname } from "@harbor/net";
import { agentProcessEnv, OUTPUT_MAX, shell, token } from "./shell.ts";
import { harborVersion } from "./version.ts";
import { ackFor, asked, cached, flush, idleFor, limits, remember, rememberAck, requestKey, serverKey, starts } from "./lazy.ts";
import { answer as teamAnswer, callApp } from "./mcpshim.ts";
import { selfExe } from "./sys.ts";
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
  /** A `subscriptions/listen`: open for as long as the agent wants, so it doesn't keep the server from stopping. */
  listen: boolean;
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

/** A stdio server's process, the `initialize` it got (replayed if it restarts), and the last id the bridge gave a request on its way there. The process starts only for a request the cache can't answer, and stops once unused for `idle`. Harbor's own app servers are one slot for every turn that has the same entry; any other server is a turn's own. */
class Slot {
  proc: Proc | null = null;
  init: Obj | null = null;
  next = 0;
  /** The turn ended: nothing starts here anymore. */
  closed = false;
  /** The grants that use it. */
  readonly users = new Set<string>();
  /** When a request last came or ended. */
  used = Date.now();
  /** Who waits for the server's next start (the agents' open listens). */
  private starting: (() => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly key: string,
    readonly def: Obj,
    readonly cwd: string,
    /** Its answers in the cache. */
    readonly ckey: string,
    readonly idle: number,
  ) {}

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

  /** Resolves when a new process is up (or the slot closed). */
  nextStart(): Promise<void> {
    return new Promise((r) => this.starting.push(r));
  }

  started(): void {
    for (const r of this.starting.splice(0)) r();
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.started();
  }
}

interface Live {
  grant: Grant;
  slots: Map<string, Slot>;
}

const GRANTS = new Map<string, Live>();
/** Every slot, by key: a grant's own (`<token>\0<name>`) or a shared one. */
const SLOTS = new Map<string, Slot>();

/**
 * Servers safe to share between turns and chats, beside Harbor's own apps: what one instance of them does doesn't
 * depend on who asks. The Roblox Studio MCP server already makes every instance but the first a proxy to the one
 * that holds its port (where the Studio plugin connects), so one shared instance is what the turns had anyway.
 * Browsers (Playwright and the like) hold a session per chat and stay a turn's own.
 */
export const SHARE_SAFE: readonly RegExp[] = [/robloxstudio-mcp|rbx-studio-mcp/i];

/** Whose server it is: one slot for every turn with the same command line and environment (Harbor's apps: Discord's chat is in its env), or null for a turn's own. */
export function sharedKey(def: Obj): string | null {
  const command = typeof def.command === "string" ? def.command : null;
  const args = Array.isArray(def.args) ? def.args : [];
  if (command === null) return null;
  const env = isObject(def.env) && Object.keys(def.env).length > 0 ? def.env : null;
  const id = JSON.stringify([command, args, env]);
  if (command === selfExe() && args.length === 2 && args[0] === "app") return `app\0${id}`;
  const line = [command, ...args.filter((a): a is string => typeof a === "string")].join(" ");
  return SHARE_SAFE.some((r) => r.test(line)) ? `shared\0${id}` : null;
}

function slotFor(live: Live, name: string, def: Obj): Slot {
  const had = live.slots.get(name);
  if (had && !had.closed) return had;
  const shared = sharedKey(def);
  const key = shared ?? `${live.grant.token}\0${name}`;
  let s = SLOTS.get(key);
  if (!s || s.closed) {
    const cwd = shared !== null ? home() : live.grant.cwd;
    s = new Slot(key, def, cwd, serverKey(def, cwd), idleFor(name, def));
    SLOTS.set(key, s);
  }
  s.users.add(live.grant.token);
  live.slots.set(name, s);
  return s;
}

/** Harbor's team server (`harbor mcp --chat N --role R`, `HARBOR_SOCK` set): served here, without a process. */
function teamOf(def: Obj): { chat: number; role: string; sock: string } | null {
  const sock = isObject(def.env) ? def.env.HARBOR_SOCK : undefined;
  const args = Array.isArray(def.args) ? def.args : [];
  if (typeof sock !== "string" || args.length < 5) return null;
  const [m, c, n, r, role] = args.slice(-5);
  if (m !== "mcp" || c !== "--chat" || r !== "--role" || typeof n !== "string" || !/^\d+$/.test(n) || typeof role !== "string") return null;
  return { chat: Number(n), role, sock };
}

function team(t: { chat: number; role: string; sock: string }, msg: Obj): Promise<Json | null> {
  return teamAnswer(msg, t.chat, t.role, (c, n, a) => callApp(c, n, a, { path: t.sock }), harborVersion());
}

async function spawnServer(cwd: string, def: Obj): Promise<Proc | null> {
  const command = def.command;
  if (typeof command !== "string") return null;
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : [];
  const env = await agentProcessEnv();
  if (isObject(def.env)) for (const [k, v] of Object.entries(def.env)) if (typeof v === "string") env[k] = v;
  const child = spawn(command, args, { cwd: isDir(cwd) ? cwd : undefined, env, stdio: ["pipe", "pipe", "ignore"] });
  const failed = await new Promise<Error | null>((res) => {
    child.once("spawn", () => res(null));
    child.once("error", res);
  });
  if (failed) return null;
  return new Proc(child, cwd);
}

const busy = (p: Proc): boolean => [...p.byId.values()].some((w) => !w.listen);

/** Room for one more running server: past `limits.live`, the least recently used idle one stops. */
function makeRoom(except: Slot): void {
  const running = [...SLOTS.values()].filter((s) => s.proc?.alive());
  if (running.length < limits.live) return;
  const idle = running.filter((s) => s !== except && s.proc !== null && !busy(s.proc)).sort((a, b) => a.used - b.used)[0];
  if (idle) void idle.lock(async () => (idle.proc && !busy(idle.proc) ? idle.stop() : undefined));
}

let reaper: ReturnType<typeof setInterval> | null = null;

/** Every few seconds: servers unused for their `idle` stop, and slots no turn uses anymore go. */
function reap(): void {
  const t = Date.now();
  for (const s of SLOTS.values()) {
    const p = s.proc;
    if (p && p.alive() && !busy(p) && t - s.used > s.idle) void s.lock(async () => (s.proc === p && !busy(p) && Date.now() - s.used > s.idle ? s.stop() : undefined));
    if (s.users.size === 0 && !s.proc?.alive() && SLOTS.get(s.key) === s) {
      s.closed = true;
      SLOTS.delete(s.key);
    }
  }
  if (SLOTS.size === 0 && reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

function watch(): void {
  reaper ??= setInterval(reap, Math.min(5000, Math.max(100, limits.idle / 4)));
  reaper.unref?.();
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
    p.byId.set(mine, { inbox, id: msg.id ?? null, progress: (get(msg, "params", "_meta", "progressToken") ?? null) as Json, tool: msg.method === "tools/call", listen: msg.method === "subscriptions/listen" });
    out.id = mine;
  }
  if (!p.alive() || !p.write(`${JSON.stringify(out)}\n`)) {
    if (mine !== null) p.byId.delete(mine);
    return null;
  }
  return { inbox };
}

/** A new process in the slot. One started for a request comes up initialized, as the agent left it (its answer bounded like any request's): its answer, and those to the handshake's other requests, refresh the cache. At most `limits.starts` start at once. */
async function restart(s: Slot, reinit: boolean): Promise<Obj | null> {
  s.stop();
  return starts.run(async () => {
    if (s.closed) return null;
    makeRoom(s);
    const p = await spawnServer(s.cwd, s.def);
    if (p && s.closed) {
      p.kill();
      return null;
    }
    s.proc = p;
    if (p) watch();
    const init = reinit ? s.init : null;
    if (!init || !p) return null;
    s.next += 1;
    const sent = send(p, init, s.next);
    const first = sent?.inbox ? await within(sent.inbox.next(), waits.wait) : null;
    const answered = first !== null && first !== "late" && "result" in first;
    if (!answered || !send(p, { jsonrpc: "2.0", method: "notifications/initialized" }, null)) {
      s.stop();
      return null;
    }
    remember(s.ckey, init, first);
    for (const ask of asked(s.ckey)) {
      s.next += 1;
      const r = send(p, { ...ask, id: s.next }, s.next);
      if (r?.inbox) void within(r.inbox.next(), waits.wait).then((a) => (a !== null && a !== "late" && !("method" in a) ? remember(s.ckey, { ...ask, id: 0 }, a) : undefined));
    }
    s.started();
    return first;
  });
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
async function stdio(slot: Slot, message: Obj, agent: Agent): Promise<Json | null> {
  slot.used = Date.now();
  try {
    return await stdioNow(slot, message, agent);
  } finally {
    slot.used = Date.now();
  }
}

async function stdioNow(slot: Slot, message: Obj, agent: Agent): Promise<Json | null> {
  const hasId = "id" in message;
  const id = (message.id ?? null) as Json;
  const msg = structuredClone(message);
  // The handshake comes from the cache: the server sleeps until something else is asked.
  const rk = requestKey(msg);
  const hit = rk === null || slot.closed ? null : cached(slot.ckey, rk);
  if (hit) {
    if (msg.method === "initialize") slot.init = structuredClone(msg);
    return { jsonrpc: "2.0", id, ...hit };
  }
  if (msg.method === "subscriptions/listen" && hasId) return listenLazily(slot, msg, agent, id);
  // A notification for a server that isn't running has no one to tell.
  if (!hasId && !slot.proc?.alive()) return null;
  const sent = await slot.lock(async () => {
    if (slot.closed) return null;
    if (msg.method === "initialize") slot.init = structuredClone(msg);
    for (let attempt = 0; attempt < 2; attempt++) {
      // A start sends the agent's `initialize` (or the last one it sent) itself, inside the gate on starts.
      if (!slot.proc?.alive()) {
        const init = await restart(slot, true);
        if (msg.method === "initialize") return init ? { answer: init } : null;
      }
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
  if ("answer" in sent) return { ...structuredClone(sent.answer), id };
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
    remember(slot.ckey, msg, got);
    got.id = id;
    return got;
  }
}


const ACK = "notifications/subscriptions/acknowledged";

/** A `subscriptions/listen`, which every turn opens and keeps open: it doesn't start the server. With the server asleep the agent gets the acknowledgement it sent last time (from the cache) and the stream stays open; whenever the server runs (started for a tool call), the listen is sent to it and its events go on to the agent. When it stops (unused), the agent's stream stays open for its next start. */
async function listenLazily(slot: Slot, msg: Obj, agent: Agent, id: Json): Promise<Json | null> {
  const toAgent = (n: Obj): void => {
    const out = structuredClone(n);
    const meta = get(out, "params", "_meta");
    if (isObject(meta) && SUBSCRIPTION in meta) meta[SUBSCRIPTION] = id;
    agent.event(out);
  };
  const ack = ackFor(slot.ckey, msg);
  let acked = false;
  if (ack && !slot.proc?.alive()) {
    toAgent(ack);
    acked = true;
  }
  for (;;) {
    if (agent.left) return null;
    if (slot.closed) return rpcError(id, "the turn ended");
    let p = slot.proc?.alive() ? slot.proc : null;
    if (!p && !acked) {
      // Never heard from: start it once to learn its acknowledgement.
      await slot.lock(async () => (slot.proc?.alive() ? undefined : restart(slot, true)));
      p = slot.proc?.alive() ? slot.proc : null;
      if (!p) return rpcError(id, "the MCP server on the Harbor PC didn't start or exited");
    }
    if (!p) {
      if ((await Promise.race([slot.nextStart(), agent.goneP])) === "gone") return null;
      continue;
    }
    slot.next += 1;
    const mine = slot.next;
    const sent = send(p, msg, mine);
    if (!sent?.inbox) {
      await Promise.race([slot.nextStart(), agent.goneP]);
      continue;
    }
    for (;;) {
      const got = await Promise.race([sent.inbox.next(), agent.goneP]);
      if (got === "gone") {
        p.byId.delete(mine);
        p.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: mine, reason: "the client is gone" } })}\n`);
        return null;
      }
      // The server stopped: the agent keeps listening for its next start.
      if (got === null) break;
      if ("method" in got) {
        if (got.method === ACK) {
          rememberAck(slot.ckey, msg, got);
          if (acked) continue;
          acked = true;
        }
        toAgent(got);
        if (agent.left) return null;
        continue;
      }
      got.id = id;
      return got;
    }
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

/** When this Harbor began serving: turns it picks up after a restart get their grants back a moment later. */
let servingSince = 0;

/** Shortly after a restart, a request for a grant not served (yet) waits a little: its turn may still be being picked up. */
async function resuming(t: string): Promise<Live | undefined> {
  const until = Math.min(Date.now() + resumeWait.ms, servingSince + resumeWait.window);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    const live = GRANTS.get(t);
    if (live) return live;
  }
  return undefined;
}

/** Tests shorten them: how long such a request waits, and for how long after the start it may. */
export const resumeWait = { ms: 10_000, window: 60_000 };

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
  // The path comes decoded: "<token>/<server name>", or just the name with the token as a bearer (Codex: its config is on a command line, the token in its environment).
  const path = head.path.replace(/^\/+|\/+$/g, "");
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(head, "authorization") ?? "")?.[1];
  const slashAt = path.indexOf("/");
  const [tokenPart, server] = bearer !== undefined ? [bearer, path] : [slashAt < 0 ? path : path.slice(0, slashAt), slashAt < 0 ? "" : path.slice(slashAt + 1)];
  const live = GRANTS.get(tokenPart) ?? (await resuming(tokenPart));
  const def = live && Object.hasOwn(live.grant.servers, server) ? (live.grant.servers[server] as Json) : undefined;
  const mine = live !== undefined && (server === ORIGIN || (server === MACHINES && live.grant.machines !== null));
  if (!live || !(mine || def !== undefined)) return respond(s, 404, "text/plain", "not found");
  const grant = live.grant;
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
    if (kind === "stdio") {
      const t = teamOf(defObj);
      return t ? team(t, m) : stdio(slotFor(live, server, defObj), m, agent);
    }
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

/** How long a start waits for `PORT` to come free (the Harbor it replaces may still be exiting) before taking the next one. Tests shorten it. */
export const portWait = { ms: 1500 };

export function port(): Promise<number | null> {
  found ??= (async () => {
    let bound: number | null = null;
    for (const until = Date.now() + portWait.ms; bound === null; ) {
      bound = await listen(PORT);
      if (bound !== null || Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (let p = PORT + 1; bound === null && p < PORT + 10; p++) bound = await listen(p);
    if (bound !== null) {
      servingSince = Date.now();
      try {
        writePrivate(portFile(), String(bound));
      } catch {
        // turns then reach the bridge only on the port they were started with
      }
    }
    return bound;
  })();
  return found;
}

/** Where the bridge's port is written once it serves: a turn's runner reads it for each connection it passes on (relay.ts), so turns reach a Harbor that came back on another port. */
export function portFile(): string {
  return join(privateDir(join(dataDir(), "apps")), "bridge-port");
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
  // Nothing waits on a request still pending (it hears that its server is gone). A shared server other turns still use stays; one nobody uses stops once idle.
  for (const slot of live.slots.values()) {
    slot.users.delete(tokenToEnd);
    if (slot.users.size > 0 || sharedKey(slot.def) !== null) continue;
    slot.close();
    if (SLOTS.get(slot.key) === slot) SLOTS.delete(slot.key);
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
  for (const s of SLOTS.values()) s.close();
  SLOTS.clear();
  flush();
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
