import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { dataDir, privateDir, writePrivate } from "@harbor/store";
import { providers } from "@harbor/agents";
import { isObject, type Json } from "./json.ts";
import { selfExe } from "./sys.ts";
import { harborVersion } from "./version.ts";

/**
 * What lets the bridge keep a stdio MCP server asleep until a tool is actually called: the answers to the
 * handshake (`initialize`, `tools/list`…) kept per server, a gate on how many servers start at once, and
 * how long an unused one stays up. Claude Code connects every server at every turn start, so without the
 * cache each turn would start every server it is given.
 */

type Obj = { [k: string]: Json };

/** Requests whose answer depends only on the server (and the protocol version asked for). */
export const CACHED = new Set(["initialize", "server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list"]);

/** Tests shorten them. `idle`: an unused server is stopped after it (`stateful`: one that holds a session, such as a browser). `live`: servers kept running at most, the least recently used idle one goes first. `starts`: servers starting at once. */
export const limits = { idle: 60_000, stateful: 300_000, ttl: 24 * 3600_000, live: 8, starts: 2 };

interface Entry {
  /** When the server last answered for real. */
  at: number;
  /** Request key → the request (to ask again when the server starts) and its answer (`result`, or a method-not-found `error`). */
  answers: { [rk: string]: { ask: Obj; answer: Obj } };
}

let mem: { [sk: string]: Entry } | null = null;
let file: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function path(): string {
  file ??= join(privateDir(join(dataDir(), "apps")), "mcp-cache.json");
  return file;
}

function cache(): { [sk: string]: Entry } {
  if (mem) return mem;
  mem = {};
  try {
    const v = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    if (isObject(v)) for (const [k, e] of Object.entries(v)) if (isObject(e) && typeof e.at === "number" && isObject(e.answers)) mem[k] = e as unknown as Entry;
  } catch {
    // none yet: the first turn of each server fills it
  }
  return mem;
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
  saveTimer.unref?.();
}

/** Writes what is pending now (Harbor is closing). */
export function flush(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const c = cache();
  // Servers not seen for a long time go.
  const old = Date.now() - 30 * 24 * 3600_000;
  for (const [k, e] of Object.entries(c)) if (e.at < old) delete c[k];
  try {
    writePrivate(path(), JSON.stringify(c));
  } catch {
    // kept in memory; the next Harbor asks the servers again
  }
}

/** Forgets everything (tests). */
export function resetCache(at?: string): void {
  mem = null;
  file = at ?? null;
}

function stamp(command: string, env: Obj): string {
  let p: string | null = command;
  if (!isAbsolute(command) && !command.includes("/")) {
    const dirs = (typeof env.PATH === "string" ? env.PATH : providers.childPath()).split(delimiter);
    p = null;
    for (const d of dirs) {
      try {
        if (statSync(join(d, command)).isFile()) {
          p = join(d, command);
          break;
        }
      } catch {
        // not there
      }
    }
  }
  if (p === null) return "missing";
  try {
    const s = statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** Names a server: its command line, environment and folder, the program's size and time (a new build lists anew) and, for Harbor's own servers, Harbor's version (they come from its bundle, which updates without the program). */
export function serverKey(def: Obj, cwd: string): string {
  const command = typeof def.command === "string" ? def.command : "";
  const env = isObject(def.env) ? def.env : {};
  const parts = [command, def.args ?? [], env, cwd, stamp(command, env), command === selfExe() ? harborVersion() : ""];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** A cacheable request's key: its method and parameters (not its `_meta`; for `initialize` only the protocol version, which the answer echoes). Null for anything else. */
export function requestKey(msg: Obj): string | null {
  const method = typeof msg.method === "string" ? msg.method : "";
  if (!CACHED.has(method) || !("id" in msg)) return null;
  const params = isObject(msg.params) ? { ...msg.params } : {};
  delete params._meta;
  if (method === "initialize") return `${method}\0${typeof params.protocolVersion === "string" ? params.protocolVersion : ""}`;
  return `${method}\0${JSON.stringify(params)}`;
}

/** The answer kept for the request (without its id), if there is a fresh one. */
export function cached(sk: string, rk: string): Obj | null {
  const e = cache()[sk];
  if (!e || Date.now() - e.at > limits.ttl) return null;
  const a = e.answers[rk]?.answer;
  return a ? structuredClone(a) : null;
}

/** Keeps a server's answer to `ask` (results only, and "method not found": both say what the server is). */
export function remember(sk: string, ask: Obj, answer: Obj): void {
  const rk = requestKey(ask);
  if (rk === null) return;
  let keep: Obj;
  if ("result" in answer) keep = { result: answer.result ?? null };
  // A server of an older protocol refuses the newer one's probe (with whatever code it picked): that says what it is too.
  else if (isObject(answer.error) && (answer.error.code === -32601 || ask.method === "server/discover")) keep = { error: answer.error };
  else return;
  const c = cache();
  const e = c[sk] ?? { at: 0, answers: {} };
  const q = structuredClone(ask);
  delete q.id;
  e.answers[rk] = { ask: q, answer: keep };
  e.at = Date.now();
  c[sk] = e;
  save();
}

const LISTEN = "subscriptions/listen";

function listenKey(msg: Obj): string {
  const params = isObject(msg.params) ? { ...msg.params } : {};
  delete params._meta;
  return `${LISTEN}\0${JSON.stringify(params)}`;
}

/** The acknowledgement a server sent to a `subscriptions/listen` like `msg`, for an agent that listens while the server sleeps. */
export function ackFor(sk: string, msg: Obj): Obj | null {
  const e = cache()[sk];
  if (!e || Date.now() - e.at > limits.ttl) return null;
  const a = e.answers[listenKey(msg)]?.answer;
  return a ? structuredClone(a) : null;
}

export function rememberAck(sk: string, msg: Obj, ack: Obj): void {
  const c = cache();
  const e = c[sk] ?? { at: 0, answers: {} };
  const q = structuredClone(msg);
  delete q.id;
  e.answers[listenKey(msg)] = { ask: q, answer: structuredClone(ack) };
  e.at = Date.now();
  c[sk] = e;
  save();
}

/** The requests to ask a server that just started, so its answers are fresh (not `initialize`: the start sends that one). */
export function asked(sk: string): Obj[] {
  const e = cache()[sk];
  if (!e) return [];
  return Object.values(e.answers)
    .map((a) => a.ask)
    .filter((a) => a.method !== "initialize" && a.method !== LISTEN);
}

/** At most `limits.starts` servers starting at once, so a burst of turns doesn't start them all together. */
class Gate {
  private running = 0;
  private queue: (() => void)[] = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= limits.starts) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export const starts = new Gate();

/** Servers that hold a session worth keeping between calls (a browser and its pages) stay up longer when unused. */
export function idleFor(name: string, def: Obj): number {
  const text = `${name} ${JSON.stringify(def.args ?? [])} ${typeof def.command === "string" ? def.command : ""}`.toLowerCase();
  return /playwright|puppeteer|browser|chrome/.test(text) ? limits.stateful : limits.idle;
}
