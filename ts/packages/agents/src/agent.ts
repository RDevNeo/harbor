// The conversation lives in the provider CLI's own session store, continued by id: Harbor keeps
// nothing resident between turns.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import * as compaction from "./compaction.ts";
import * as detach from "./detach.ts";
import { arr, at, bool, compact, f64, firstLine, i64, isNull, obj, optStr, parse, pretty, str, takeChars, u64 } from "./json.ts";
import { dataDir, home, now, privateDir, randomHex, selfArgv, socketPath, writePrivate } from "./paths.ts";
import { alive, killTree } from "./procfs.ts";
import { sessionDir } from "./movechat.ts";
import * as turnscope from "./turnscope.ts";
import { BRIDGE_PORT, BRIDGE_TOKEN, PORT_REF, RELAY } from "./relay.ts";
import { type Account, accountEnv, binStr, childPath, defaultEffort, kindOf, type Kind } from "./providers.ts";

export type Event =
  /** The provider's session id, needed to continue the conversation. */
  | { type: "session"; id: string }
  | { type: "mcp"; servers: [string, string][] }
  | { type: "textDelta"; text: string }
  /** A finished text block: replaces the streaming one, or is appended. */
  | { type: "textFinal"; text: string }
  | { type: "thinkingDelta"; text: string }
  | { type: "thinkingFinal"; text: string | null }
  /** Insert or update a tool call by id. */
  | { type: "tool"; id: string; name: string; summary: string; input: string; result: string | null; isError: boolean }
  /** `cached`: of the input tokens, those read from or written to the prompt cache. */
  | { type: "result"; costUsd: number | null; durationMs: number; turns: number; inputTokens: number; outputTokens: number; cached: number }
  | { type: "error"; text: string }
  | { type: "stderr"; text: string }
  /** The turn in `dir` ended (a chat's stopped turn can end after its next one started). */
  | { type: "exited"; ok: boolean; dir: string }
  /** Claude took in a user message written to a running turn (`--replay-user-messages`). */
  | { type: "userEcho"; text: string }
  /** The session was compacted: by Harbor before the turn (`start`, then `done`, sizes in bytes), or by Claude Code itself (`claude`, sizes in tokens). */
  | { type: "compact"; state: "start" | "done" | "claude"; before: number; after: number; ok: boolean; error: string }
  /** Claude's request is out (its reply started streaming): a steer written now cuts into it. */
  | { type: "querying" }
  /** The account hit a usage limit: its window, when it resets (Unix time) if known, and the CLI's sentence. */
  | { type: "limit"; kind: string; resetsAt: number | null; text: string }
  /** Live quota seen in a Claude turn: per window, utilization (0–1) and reset time. */
  | { type: "quota"; windows: [string, number, number][] };

/** The exit of another turn than `current` (the chat's running one): a stopped turn's end that came after the chat's next turn started. */
export function isStaleExit(ev: Event, current: string | null): boolean {
  return ev.type === "exited" && current !== null && current !== ev.dir;
}

/** How the running turn takes a steer: into the live turn (Claude), by a restart (Codex), or not at all. */
export type Steering = "active" | "restart" | "no";

/** bridge.rs's grant: what a remote turn (or the machines server) may reach through the bridge. */
export interface Grant {
  token: string;
  chat_id: number;
  cwd: string;
  servers: Record<string, unknown>;
  commands: boolean;
  workspace: string[];
  machines: unknown;
}

/** The bridge (mcp package): serves grants on a local port. */
export interface Bridge {
  grant(g: Grant): number | null | Promise<number | null>;
  revoke(token: string): void;
  /** A turn followed again: its saved grant is served again. */
  resume(dir: string): void | Promise<void>;
  remoteConfig(g: Grant, remotePort: number): unknown;
  origin: string;
  /** Where the bridge writes its port: a turn's runner relays to it (relay.ts), so the turn reaches a restarted Harbor. */
  portFile?(): string;
}

/** What runs before the agent on a device: net's `RemoteSetup`, kind for kind. */
export type Setup =
  | { kind: "token" }
  | { kind: "mcp" }
  | { kind: "profile"; rel: string }
  | { kind: "guest"; rel: string }
  | { kind: "session"; id: string }
  | { kind: "sh"; line: string };

/** remote.rs (net package): how a device's shell starts the agent. */
export interface Remote {
  launch(family: string, dir: string, setup: Setup[], argv: string[]): { command: string; input: string };
}

/** workspace.rs (mcp package): this PC's files for an agent on another device. */
export interface Workspace {
  forAccess(access: string, lead: boolean): string[];
  replaced: string;
  note(tools: string[], cwd: string): string;
}

/** mcp.rs: the servers a turn gets. */
export interface Servers {
  /** Claude Code's `--mcp-config` file for a turn; returns its path. With `lazy`, stdio servers go on the turn's bridge grant (`servers`) and the file names their URLs (`base` + name): they start only when a tool is called. */
  claudeConfig(chatId: number, extra: [string, unknown][], apps: boolean, lazy?: { servers: Record<string, unknown>; base: string } | null): string | Promise<string>;
  claudeServers(extra: [string, unknown] | null): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Codex's `-c` overrides for a turn: the local servers that are on, the signed-in apps and `extra` (Harbor's team server). With `lazy`, stdio servers go on the turn's bridge grant and Codex gets their URLs (`base` + name, the token from the environment variable `tokenVar`). */
  codexArgs(chatId: number, extra: [string, unknown][], lazy?: { servers: Record<string, unknown>; base: string; tokenVar: string } | null): string[] | Promise<string[]>;
  machinesName: string;
}

export interface Integrations {
  servers: Servers;
  bridge: Bridge | null;
  remote: Remote | null;
  workspace: Workspace | null;
}

/** Until the mcp package registers its own, a turn gets only Harbor's servers, none of the user's or the apps'. */
const harborOnly: Servers = {
  claudeConfig(chatId, extra, _apps) {
    const p = join(privateDir(join(privateDir(join(privateDir(dataDir()), "apps")), "run")), `claude-${chatId}.json`);
    const m: Record<string, unknown> = {};
    for (const [k, v] of extra) m[k] = v;
    writePrivate(p, compact({ mcpServers: m }));
    return p;
  },
  claudeServers(extra) {
    const m: Record<string, unknown> = {};
    if (extra) m[extra[0]] = extra[1];
    return m;
  },
  codexArgs: (_chat, extra) => extra.flatMap(([k, v]) => codexStdio(k, v)),
  machinesName: "machines",
};

export const integrations: Integrations = { servers: harborOnly, bridge: null, remote: null, workspace: null };

export function integrate(i: Partial<Integrations>): void {
  Object.assign(integrations, i);
}

export class Turn {
  private stopFollowing = false;
  /** Resolves once the turn's end came through (or following was released). */
  readonly done: Promise<void>;

  constructor(
    readonly dir: string,
    readonly meta: detach.Meta,
    done: (t: Turn) => Promise<void>,
  ) {
    this.done = done(this);
  }

  get released(): boolean {
    return this.stopFollowing;
  }

  /** Stops following without touching the turn: its folder stays for the next Harbor. */
  release(): void {
    this.stopFollowing = true;
  }

  write(prompt: string, files: readonly string[] = []): boolean {
    return detach.inputOpen(this.dir) && detach.writeInput(this.dir, claudeMessage(prompt, files));
  }

  /** Writes a steer: Claude ends what the turn is doing and takes it in now. */
  writeNow(prompt: string, files: readonly string[] = []): boolean {
    return detach.inputOpen(this.dir) && detach.writeInput(this.dir, claudeMessage(prompt, files, "now"));
  }

  steering(): Steering {
    if (this.meta.kind === "Claude") return detach.inputOpen(this.dir) ? "active" : "no";
    return this.meta.kind === "Codex" ? "restart" : "no";
  }

  /** Ends the input: Claude exits once it is done with what it was given. */
  closeInput(): void {
    detach.closeInput(this.dir);
  }

  /** Stops the turn and every command it started. */
  stop(): void {
    // Marks it stopped on purpose, so a later Harbor doesn't take it for cut off.
    try {
      writeFileSync(join(this.dir, "stopped"), "");
    } catch {
      // the kill below still happens; a later Harbor then reads it as cut off
    }
    // Read while the runner lives: the scope also holds what the agent's commands detached.
    const scope = aliveMeta(this.meta) ? turnscope.scopeOf(this.meta.pid, this.dir) : undefined;
    if (aliveMeta(this.meta)) killTree(this.meta.pid);
    turnscope.end(this.dir, scope);
    detach.takeBack(this.dir, this.meta.pid);
  }

  /** Stops the turn and waits until its process is gone, so its session file is final. */
  async stopWait(): Promise<void> {
    this.stop();
    const t = Date.now();
    while (aliveMeta(this.meta) && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 10));
  }
}

const aliveMeta = (m: detach.Meta): boolean => alive(m.pid, m.pid_start);

export interface Team {
  role: "lead" | "sub";
  system: string;
}

/** Harbor's own MCP server for a team turn: `harbor mcp --chat N --role R`. */
export function teamServer(t: Team, chatId: number): [string, string[]] {
  const [exe, ...pre] = selfArgv();
  return [exe ?? "harbor", [...pre, "mcp", "--chat", String(chatId), "--role", t.role]];
}

function teamMcpEntry(t: Team, chatId: number): unknown {
  const [command, args] = teamServer(t, chatId);
  return { type: "stdio", command, args, env: { HARBOR_SOCK: socketPath() } };
}

/** A turn's user context (meshctx.rs); the default: this PC's own. */
export interface Context {
  /** A chat commanded from another PC: the overlay profile (`CLAUDE_CONFIG_DIR`). Local Claude turns only. */
  overlay: string | null;
  /** With an overlay: this PC's GitHub and app sign-ins stay on. */
  signedIn: boolean;
  /** Told to the agent (who is who, whose chat it is). */
  note: string;
  /** Every PC's files (machines.rs), while the mesh has other PCs. Claude turns only. */
  machines: unknown;
}

export const ownContext = (): Context => ({ overlay: null, signedIn: false, note: "", machines: null });

/** Where a remote turn runs (remote.rs); Claude Code only. */
export interface RemoteSpec {
  ssh: string[];
  host: string;
  /** Its name in Settings › Workspace, for errors. */
  name: string;
  family: string;
  dir: string;
  setup: Setup[];
  bridge: boolean;
  commands: boolean;
  workspace: boolean;
  /** The account's Claude login on this PC: the first line of the turn's stdin. */
  token: string | null;
  note: string;
}

export interface TurnSpec {
  chatId: number;
  cwd: string;
  prompt: string;
  files: string[];
  sessionId: string;
  resume: boolean;
  account: Account;
  model: string;
  effort: string;
  access: string;
  team: Team | null;
  /** Fast mode: Claude's fastMode setting, Codex's priority tier. */
  fast: boolean;
  /** Transcript length when the turn starts, for replaying it after a restart. */
  base: number;
  remote: RemoteSpec | null;
  /** The user trusts the project's own agent config: off for a cloned project until they say so. */
  trusted: boolean;
  context: Context;
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function isImage(p: string): boolean {
  return IMAGE.has(extname(p).toLowerCase());
}

function mime(p: string): string {
  const e = extname(p).toLowerCase();
  return e === ".png" ? "image/png" : e === ".gif" ? "image/gif" : e === ".webp" ? "image/webp" : "image/jpeg";
}

/** Prompt text plus a list of attached paths the CLI can't take natively. */
export function promptWithPaths(prompt: string, paths: readonly string[]): string {
  if (paths.length === 0) return prompt;
  return `${prompt}\n\nAttached files:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/** One stream-json user message for Claude: images inline, other files as paths; `priority` "now" is a steer. */
export function claudeMessage(prompt: string, files: readonly string[], priority?: string): string {
  const content: unknown[] = [];
  for (const img of files.filter(isImage)) {
    let data: Buffer;
    try {
      data = readFileSync(img);
    } catch {
      continue;
    }
    content.push({ type: "image", source: { type: "base64", media_type: mime(img), data: data.toString("base64") } });
  }
  content.push({ type: "text", text: promptWithPaths(prompt, files.filter((f) => !isImage(f))) });
  const msg: Record<string, unknown> = { type: "user", message: { role: "user", content } };
  if (priority !== undefined) msg.priority = priority;
  return `${compact(msg)}\n`;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Builds the command line and the bytes to write to stdin, per provider, and the bridge grant of a remote turn. */
export async function build(given: TurnSpec): Promise<{ cmd: detach.Cmd; stdin: string | null; grant: Grant | null }> {
  if (given.remote && given.account.kind !== "Claude") throw new Error(`only Claude Code runs on other devices so far, not ${given.account.kind}`);
  // CLIs without a system-prompt flag get the team instructions in the first message; OpenCode, which has no team
  // tools, leads a chat as a plain agent (its subagents still get theirs: who they are and what they work on).
  const plain = given.account.kind === "OpenCode" && given.team?.role === "lead";
  const spec: TurnSpec =
    given.team && given.account.kind !== "Claude" && !given.resume && !plain ? { ...given, prompt: `${given.team.system}\n\n---\n\n${given.prompt}`, remote: null } : given;
  const a = spec.account;
  const cmd = detach.command(binStr(a));
  cmd.cwd = spec.cwd;
  const args = cmd.args;
  // Credentials only from Harbor's own sign-ins: the turn's runner adds them, so they stay out of its files.
  for (const [k, v] of accountEnv(a)) cmd.env.set(k, v);
  const overlay = a.kind === "Claude" && !spec.remote ? spec.context.overlay : null;
  if (overlay !== null) {
    cmd.env.set("CLAUDE_CONFIG_DIR", overlay);
    cmd.env.set(detach.GUEST_LOGIN, a.configDir ?? "");
    if (!spec.context.signedIn) cmd.env.set(detach.GUEST_APPS, "0");
  }
  const images = spec.files.filter(isImage);
  const others = spec.files.filter((f) => !isImage(f));
  const all = spec.files;
  const model = spec.model !== "" ? spec.model : null;
  // Claude Code keywords: "ultracode" is xhigh plus the word, "ultrathink" only the word.
  let effort: string | null = spec.effort === "" ? null : spec.effort;
  let keyword: string | null = null;
  if (spec.effort === "ultracode") [effort, keyword] = ["xhigh", "ultracode"];
  if (spec.effort === "ultrathink") [effort, keyword] = [null, "ultrathink"];
  const userPrompt = keyword !== null ? `${spec.prompt}\n\n${keyword}` : spec.prompt;
  let stdin: string | null = null;
  let grant: Grant | null = null;
  let remoteMcp: string | null = null;
  const remotePort = 20000 + (parseInt(randomHex(18).slice(0, 4), 16) % 40000);
  const sv = integrations.servers;

  switch (a.kind) {
    case "Claude": {
      {
        args.push("-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages");
        args.push("--permission-mode", spec.access === "edits" ? "acceptEdits" : spec.access === "plan" ? "plan" : "bypassPermissions");
        const lead = spec.team?.role === "lead";
        // The lead answers simple things itself and delegates real work; it has no edit tools,
        // and its shell only with full access.
        if (lead) args.push("--tools", spec.access === "full" ? "Read,Glob,Grep,Bash,WebFetch,WebSearch" : "Read,Glob,Grep,WebFetch,WebSearch");
        const ws = spec.remote?.workspace ? workspaceOrThrow().forAccess(spec.access, lead) : [];
        let note = spec.remote?.note ?? "";
        // Below full access, headless Claude Code refuses tools that would ask; the team's tools stay usable.
        const allowed = ws.map((t) => `mcp__${bridgeOrThrow().origin}__${t}`);
        if (spec.team && spec.access !== "full") allowed.push("mcp__harbor");
        if (allowed.length > 0) args.push(`--allowedTools=${allowed.join(",")}`);
        if (ws.length > 0) {
          const w = workspaceOrThrow();
          args.push(`--disallowedTools=${w.replaced}`);
          note = `${note}\n\n${w.note(ws, spec.cwd)}`.trim();
        }
        if (spec.context.note !== "") note = `${note}\n\n${spec.context.note}`.trim();
        if (spec.team) args.push("--append-system-prompt", note === "" ? spec.team.system : `${spec.team.system}\n\n${note}`);
        else if (note !== "") args.push("--append-system-prompt", note);
        // Only Harbor's servers: not the user's global, project or claude.ai ones.
        const harbor: [string, unknown] | null = spec.team ? ["harbor", teamMcpEntry(spec.team, spec.chatId)] : null;
        if (!spec.remote) {
          const apps = overlay === null || spec.context.signedIn;
          const extra: [string, unknown][] = harbor ? [harbor] : [];
          // A grant of its own on the bridge: every PC's files (machines.rs), and the stdio servers, which then start only when a tool is called.
          const br = integrations.bridge;
          const g: Grant = { token: randomHex(18), chat_id: spec.chatId, cwd: spec.cwd, servers: {}, commands: false, workspace: [], machines: isNull(spec.context.machines) ? null : spec.context.machines };
          const port = br ? await br.grant(g) : null;
          // Claude expands the variable in its config's URLs; the runner sets it (to its relay's port, relay.ts).
          const via = port === null ? "" : relayed(cmd, br, port);
          if (port !== null && g.machines !== null) extra.push([sv.machinesName, { type: "http", url: `http://127.0.0.1:${via}/${g.token}/${sv.machinesName}` }]);
          const lazy = port === null ? null : { servers: g.servers, base: `http://127.0.0.1:${via}/${g.token}/` };
          args.push("--strict-mcp-config", "--mcp-config", await sv.claudeConfig(spec.chatId, extra, apps, lazy));
          if (port !== null) {
            if (g.machines !== null || Object.keys(g.servers).length > 0) grant = g;
            else {
              br?.revoke(g.token);
              unrelay(cmd);
            }
          }
        } else {
          const r = spec.remote;
          const servers: Record<string, unknown> = r.bridge ? await sv.claudeServers(harbor) : harbor ? { [harbor[0]]: harbor[1] } : {};
          const g: Grant = { token: randomHex(18), chat_id: spec.chatId, cwd: spec.cwd, servers, commands: r.commands && spec.access !== "plan", workspace: ws, machines: spec.context.machines };
          // The config holds the grant's token: it goes on stdin, not on a command line.
          args.push("--strict-mcp-config", "--mcp-config", MCP_CONFIG_ARG);
          remoteMcp = compact(bridgeOrThrow().remoteConfig(g, remotePort));
          grant = g;
        }
        if (!spec.trusted) args.push("--setting-sources", "user");
        // No effort set: Harbor's default (Medium), not Claude Code's own effortLevel.
        const e = effort ?? (spec.effort === "" ? defaultEffort("Claude") : null);
        if (e !== null) args.push("--effort", e);
        if (spec.fast) args.push("--settings", '{"fastMode":true}');
        stdin = claudeMessage(userPrompt, spec.files);
      }
      if (model !== null) args.push("--model", model);
      if (spec.resume) args.push("--resume", spec.sessionId);
      else args.push("--session-id", spec.sessionId);
      // A long session is compacted by the runner before this turn reloads it (compaction.ts).
      if (spec.resume && !spec.remote) {
        const session = join(sessionDir(overlay ?? a.configDir ?? null, spec.cwd), `${spec.sessionId}.jsonl`);
        if (compaction.mayNeed(session)) cmd.compact = session;
      }
      break;
    }
    case "Codex": {
      args.push("exec");
      if (spec.resume) args.push("resume", "--json", "--skip-git-repo-check");
      else args.push("--json", "--skip-git-repo-check");
      if (spec.access === "edits") args.push("-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"');
      else if (spec.access === "plan") args.push("-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"');
      else args.push("--dangerously-bypass-approvals-and-sandbox");
      if (model !== null) args.push("-m", model);
      if (effort !== null) args.push("-c", `model_reasoning_effort="${effort}"`);
      if (spec.fast) args.push("-c", 'service_tier="priority"');
      // Like a local Claude turn: the stdio servers go on a grant of the turn's own and start only when a tool is called. Codex's config is on its command line, so the URLs carry no token: it comes from the environment.
      const extra: [string, unknown][] = spec.team ? [["harbor", teamMcpEntry(spec.team, spec.chatId)]] : [];
      const br = integrations.bridge;
      const g: Grant = { token: randomHex(18), chat_id: spec.chatId, cwd: spec.cwd, servers: {}, commands: false, workspace: [], machines: null };
      const port = br ? await br.grant(g) : null;
      const lazy = port === null ? null : { servers: g.servers, base: `http://127.0.0.1:${relayed(cmd, br, port)}/`, tokenVar: BRIDGE_TOKEN };
      args.push(...(await sv.codexArgs(spec.chatId, extra, lazy)));
      if (port !== null) {
        if (Object.keys(g.servers).length > 0) {
          grant = g;
          cmd.env.set(BRIDGE_TOKEN, g.token);
        } else {
          br?.revoke(g.token);
          unrelay(cmd);
        }
      }
      for (const img of images) args.push("-i", img);
      if (spec.resume) args.push(spec.sessionId);
      args.push(promptWithPaths(spec.prompt, others));
      break;
    }
    case "OpenCode": {
      // Headless, with full access (its only level): permissions its config doesn't deny are granted.
      args.push("run", "--format", "json", "--thinking", "--auto");
      if (model !== null) args.push("--model", model);
      if (spec.resume) args.push("--session", spec.sessionId);
      args.push(promptWithPaths(spec.prompt, all));
      break;
    }
  }
  if (spec.remote && grant) {
    const r = spec.remote;
    const br = bridgeOrThrow();
    const port = await br.grant(grant);
    if (port === null) throw new Error("Harbor's MCP bridge couldn't open a port on 127.0.0.1");
    const remote = integrations.remote;
    if (!remote) throw new Error("turns on other devices need the net package's remote module, which this Harbor doesn't have yet");
    // The device's own `claude` (from its login shell's PATH), with the same arguments.
    const argv = ["claude", ...args];
    // The login first (it's the first stdin line), the MCP config next, then the profile and the session.
    const setup: Setup[] = [];
    let lines = "";
    if (r.token !== null) {
      setup.push({ kind: "token" });
      lines += `${r.token}\n`;
    }
    if (remoteMcp !== null) {
      setup.push({ kind: "mcp" });
      lines += `${remoteMcp}\n`;
    }
    setup.push(...r.setup);
    if (spec.resume) setup.push({ kind: "session", id: spec.sessionId });
    const launch = remote.launch(r.family, r.dir, setup, argv);
    lines = `${launch.input}${lines}`;
    if (lines !== "") stdin = `${lines}${stdin ?? ""}`;
    const ssh = detach.command("ssh");
    ssh.args.push(...r.ssh, "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${relayed(ssh, br, port)}`, r.host, launch.command);
    ssh.cwd = isDir(spec.cwd) ? spec.cwd : home();
    ssh.env.set("PATH", childPath());
    // For the runner's error if the device can't be reached (it isn't passed on to ssh).
    ssh.env.set(detach.DEVICE, r.name);
    return { cmd: ssh, stdin, grant };
  }
  return { cmd, stdin, grant };
}

/** The port a turn's MCP URLs name: with the bridge's port file known, `${HARBOR_BRIDGE_PORT}`, which the runner fills in with its relay's port (relay.ts); else the bridge's port itself. */
function relayed(cmd: detach.Cmd, br: Bridge | null, port: number): string {
  const file = br?.portFile?.();
  if (file === undefined) return String(port);
  cmd.env.set(BRIDGE_PORT, String(port));
  cmd.env.set(RELAY, file);
  return PORT_REF;
}

function unrelay(cmd: detach.Cmd): void {
  cmd.env.delete(BRIDGE_PORT);
  cmd.env.delete(RELAY);
}

/** A stdio server as Codex's `-c` overrides (Rust's `{:?}` strings, which Codex reads as TOML). */
function codexStdio(name: string, def: unknown): string[] {
  const command = optStr(at(def, "command"));
  if (command === undefined) return [];
  const out = ["-c", `mcp_servers.${name}.command=${rustDebug(command)}`, "-c", `mcp_servers.${name}.args=[${arr(at(def, "args")).filter((a): a is string => typeof a === "string").map(rustDebug).join(",")}]`];
  const env = obj(at(def, "env"));
  if (env) out.push("-c", `mcp_servers.${name}.env={${Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => `${k}=${rustDebug(v)}`).join(",")}}`);
  return out;
}

/** remote.rs's placeholder for the MCP config the device's script reads from stdin. */
export const MCP_CONFIG_ARG = "@harbor-mcp-config";

function bridgeOrThrow(): Bridge {
  if (!integrations.bridge) throw new Error("this needs Harbor's MCP bridge (mcp package), which this Harbor doesn't have yet");
  return integrations.bridge;
}

function workspaceOrThrow(): Workspace {
  if (!integrations.workspace) throw new Error("working on this PC's files from a device needs the mcp package's workspace tools, which this Harbor doesn't have yet");
  return integrations.workspace;
}

/** Rust's `{:?}` of a string, which Codex reads as a TOML string. */
function rustDebug(s: string): string {
  let out = '"';
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += c;
  }
  return `${out}"`;
}

/** bridge.json: the grant as serde writes the struct (fields in order, server names sorted). */
export function grantJson(g: Grant): string {
  return JSON.stringify({ token: g.token, chat_id: g.chat_id, cwd: g.cwd, servers: JSON.parse(compact(g.servers)) as unknown, commands: g.commands, workspace: g.workspace, machines: g.machines ?? null });
}

export function savedGrant(dir: string): Grant | undefined {
  let v: unknown;
  try {
    v = parse(readFileSync(join(dir, "bridge.json"), "utf8"));
  } catch {
    return undefined;
  }
  const token = optStr(at(v, "token"));
  const chat = i64(at(v, "chat_id"));
  const cwd = optStr(at(v, "cwd"));
  const servers = obj(at(v, "servers"));
  const commands = bool(at(v, "commands"));
  if (token === undefined || chat === undefined || cwd === undefined || !servers || commands === undefined) return undefined;
  return { token, chat_id: chat, cwd, servers, commands, workspace: arr(at(v, "workspace")).filter((x): x is string => typeof x === "string"), machines: at(v, "machines") };
}

/** Gets each event with the turn it came from: the first ones can come before `start` or `reattach` returns it
 *  (a fast agent's whole reply is read in the follow's first look), and the result's handling needs the turn. */
export type Sink = (chatId: number, ev: Event, turn: Turn) => void;

/** Spawns the turn; events go to `sink` tagged with the chat id, `wake` repaints the UI (`true` once the turn has ended). */
export async function start(spec: TurnSpec, sink: Sink, wake: (ended: boolean) => void = () => {}, rootDir?: string): Promise<Turn> {
  const { cmd, stdin, grant } = await build(spec);
  const meta: detach.Meta = { chat_id: spec.chatId, kind: spec.account.kind, started: now(), base: spec.base, pid: 0, pid_start: 0 };
  // Claude's input stays open for messages sent mid-turn (closed after its result).
  let dir: string;
  let m: detach.Meta;
  try {
    [dir, m] = await detach.spawn(cmd, stdin, spec.account.kind === "Claude", spec.remote === null, meta, rootDir);
  } catch (e) {
    if (grant) integrations.bridge?.revoke(grant.token);
    throw e;
  }
  if (grant) writePrivate(join(dir, "bridge.json"), grantJson(grant));
  return followTurn(dir, m, sink, wake);
}

/** Picks up a turn an earlier Harbor (Rust or TypeScript) started: its output is replayed from the start. */
export function reattach(dir: string, meta: detach.Meta, sink: Sink, wake: (ended: boolean) => void = () => {}): Turn {
  return followTurn(dir, meta, sink, wake);
}

/** The events of one line of a provider's output. */
export function parser(kind: Kind): (v: unknown) => Event[] {
  switch (kind) {
    case "Claude":
      return parseClaude;
    case "Codex":
      return parseCodex;
    case "OpenCode": {
      const st = opencodeState();
      return (v) => parseOpencode(v, st);
    }
  }
}

function followTurn(dir: string, meta: detach.Meta, sink: Sink, wake: (ended: boolean) => void): Turn {
  const id = meta.chat_id;
  const kind = kindOf(meta.kind) ?? "Claude";
  // A remote turn picked up after a reload: its MCP servers are served again.
  if (existsSync(join(dir, "bridge.json"))) void integrations.bridge?.resume(dir);
  return new Turn(dir, meta, async (turn) => {
    const parse_ = parser(kind);
    // Claude reports the process's total cost; one process can run several turns.
    let spent = 0;
    // The first message Claude echoes is the turn's own prompt.
    let firstEcho = true;
    const ok = await detach.follow(
      dir,
      meta,
      (line) => {
        const v = parse(line);
        if (v === undefined) return;
        const evs = parse_(v);
        if (evs.length === 0) return;
        for (const ev of evs) {
          if (ev.type === "result" && ev.costUsd !== null) {
            const total = ev.costUsd;
            ev.costUsd -= spent;
            spent = total;
          } else if (ev.type === "userEcho" && firstEcho) {
            firstEcho = false;
            continue;
          }
          sink(id, ev, turn);
        }
        wake(false);
      },
      (line) => {
        if (line.trim() !== "") {
          sink(id, { type: "stderr", text: line }, turn);
          wake(false);
        }
      },
      () => turn.released,
    );
    if (turn.released) return;
    // A runner that died without writing how the turn ended didn't clear its scope either.
    if (!existsSync(join(dir, "exit"))) turnscope.end(dir, undefined);
    const g = savedGrant(dir);
    if (g) integrations.bridge?.revoke(g.token);
    sink(id, { type: "exited", ok, dir }, turn);
    wake(true);
    // Its events are out: the folder is done.
    rmSync(dir, { recursive: true, force: true });
  });
}

export function toolSummary(input: unknown): string {
  for (const k of ["command", "file_path", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
    const t = optStr(at(input, k));
    if (t !== undefined) return takeChars(firstLine(t), 120);
  }
  const t = compact(input ?? null);
  return t === "{}" || t === "null" ? "" : takeChars(t, 120);
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b) => {
        const ty = optStr(at(b, "type"));
        if (ty === "text") return str(at(b, "text"));
        if (ty !== undefined) return `[${ty}]`;
        return typeof b === "string" ? b : "";
      })
      .join("\n");
  if (isNull(c)) return "";
  return compact(c);
}

function toolResult(id: string, result: string, isError: boolean): Event {
  return { type: "tool", id, name: "", summary: "", input: "", result, isError };
}

const n0 = (v: unknown): number => u64(v) ?? 0;
const positive = (v: unknown): number | null => {
  const c = f64(v);
  return c !== undefined && c > 0 ? c : null;
};

/** Claude Code stream-json. */
export function parseClaude(v: unknown): Event[] {
  if (!isNull(at(v, "parent_tool_use_id"))) return [];
  const ty = str(at(v, "type"));
  if (ty === "system" && at(v, "subtype") === "init") {
    const mcp = arr(at(v, "mcp_servers")).map((m): [string, string] => [str(at(m, "name")), str(at(m, "status"))]);
    const e: Event[] = [{ type: "mcp", servers: mcp }];
    const id = optStr(at(v, "session_id"));
    if (id !== undefined && id !== "") e.push({ type: "session", id });
    return e;
  }
  if (ty === "stream_event") {
    const e = at(v, "event");
    if (at(e, "type") === "message_start") return [{ type: "querying" }];
    if (at(e, "type") !== "content_block_delta") return [];
    const dt = at(e, "delta", "type");
    if (dt === "text_delta") return [{ type: "textDelta", text: str(at(e, "delta", "text")) }];
    if (dt === "thinking_delta") return [{ type: "thinkingDelta", text: str(at(e, "delta", "thinking")) }];
    return [];
  }
  if (ty === "assistant" && at(v, "error") === "rate_limit") {
    const q = at(v, "quotaLimits");
    const text = arr(at(v, "message", "content"))
      .filter((b) => at(b, "type") === "text")
      .map((b) => str(at(b, "text")))
      .join(" ");
    return [{ type: "limit", kind: str(at(q, "rateLimitType")), resetsAt: i64(at(q, "resetsAt")) ?? null, text }];
  }
  if (ty === "rate_limit_event") {
    const info = at(v, "rate_limit_info");
    const windows: [string, number, number][] = Object.entries(obj(at(info, "unifiedWindows")) ?? {})
      .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
      .map(([k, w]) => [k, f64(at(w, "utilization")) ?? 0, i64(at(w, "resetsAt")) ?? 0]);
    const e: Event[] = [];
    if (windows.length > 0) e.push({ type: "quota", windows });
    if (at(info, "status") === "rejected") e.push({ type: "limit", kind: str(at(info, "rateLimitType")), resetsAt: i64(at(info, "resetsAt")) ?? null, text: "" });
    return e;
  }
  if (ty === "assistant") {
    const out: Event[] = [];
    for (const b of arr(at(v, "message", "content"))) {
      const bt = optStr(at(b, "type"));
      if (bt === "text") out.push({ type: "textFinal", text: str(at(b, "text")) });
      else if (bt === "thinking") out.push({ type: "thinkingFinal", text: str(at(b, "thinking")) });
      else if (bt === "tool_use")
        out.push({ type: "tool", id: str(at(b, "id")), name: str(at(b, "name")), summary: toolSummary(at(b, "input")), input: pretty(at(b, "input")), result: null, isError: false });
    }
    return out;
  }
  if (ty === compaction.COMPACT_LINE) {
    const state = at(v, "state") === "done" ? "done" : "start";
    return [{ type: "compact", state, before: n0(at(v, "before")), after: n0(at(v, "after")), ok: at(v, "ok") === true, error: str(at(v, "error")) }];
  }
  if (ty === "system" && at(v, "subtype") === "compact_boundary") {
    const m = at(v, "compact_metadata");
    return [{ type: "compact", state: "claude", before: n0(at(m, "pre_tokens")), after: n0(at(m, "post_tokens")), ok: true, error: "" }];
  }
  if (ty === "user" && at(v, "isReplay") === true) {
    const text = arr(at(v, "message", "content"))
      .filter((b) => at(b, "type") === "text")
      .map((b) => str(at(b, "text")));
    return [{ type: "userEcho", text: text.join("\n") }];
  }
  if (ty === "user") {
    return arr(at(v, "message", "content"))
      .filter((b) => at(b, "type") === "tool_result")
      .map((b) => toolResult(str(at(b, "tool_use_id")), textOf(at(b, "content")), bool(at(b, "is_error")) ?? false));
  }
  if (ty === "result") {
    const u = at(v, "usage");
    const e: Event[] = [];
    if (at(v, "is_error") === true || at(v, "subtype") !== "success") e.push({ type: "error", text: optStr(at(v, "result")) ?? str(at(v, "subtype")) });
    const cache = n0(at(u, "cache_read_input_tokens")) + n0(at(u, "cache_creation_input_tokens"));
    e.push({
      type: "result",
      costUsd: positive(at(v, "total_cost_usd")),
      durationMs: n0(at(v, "duration_ms")),
      turns: n0(at(v, "num_turns")),
      inputTokens: n0(at(u, "input_tokens")) + cache,
      outputTokens: n0(at(u, "output_tokens")),
      cached: cache,
    });
    return e;
  }
  return [];
}

/** `codex exec --json`: thread/turn/item events. */
export function parseCodex(v: unknown): Event[] {
  const item = at(v, "item");
  const ty = str(at(v, "type"));
  if (ty === "thread.started") return [{ type: "session", id: str(at(v, "thread_id")) }];
  if (ty === "item.started" || ty === "item.updated" || ty === "item.completed") {
    const done = ty === "item.completed";
    const id = str(at(item, "id"));
    const it = str(at(item, "type"));
    if (it === "agent_message" && done) return [{ type: "textFinal", text: str(at(item, "text")) }];
    if (it === "reasoning" && done) return [{ type: "thinkingFinal", text: str(at(item, "text")) }];
    if (it === "command_execution") {
      const full = str(at(item, "command"));
      let c = full;
      for (const pre of ["/usr/bin/bash -lc ", "bash -lc "]) {
        if (full.startsWith(pre)) {
          c = full.slice(pre.length).replace(/^'+|'+$/g, "");
          break;
        }
      }
      const code = i64(at(item, "exit_code"));
      return [{ type: "tool", id, name: "Shell", summary: firstLine(c), input: c, result: done ? str(at(item, "aggregated_output")) : null, isError: code !== undefined && code !== 0 }];
    }
    if (it === "file_change") {
      const paths = arr(at(item, "changes")).map((c) => `${str(at(c, "kind"))} ${str(at(c, "path"))}`);
      return [{ type: "tool", id, name: "Edit", summary: paths[0] ?? "", input: paths.join("\n"), result: done ? str(at(item, "status")) : null, isError: at(item, "status") === "failed" }];
    }
    if (it === "mcp_tool_call") {
      return [
        {
          type: "tool",
          id,
          name: `${str(at(item, "server"))}.${str(at(item, "tool"))}`,
          summary: toolSummary(at(item, "arguments")),
          input: pretty(at(item, "arguments")),
          result: done ? textOf(at(item, "result", "content")) : null,
          isError: at(item, "status") === "failed",
        },
      ];
    }
    if (it === "web_search") return [{ type: "tool", id, name: "WebSearch", summary: str(at(item, "query")), input: str(at(item, "query")), result: done ? "" : null, isError: false }];
    if (it === "error" && done) return [{ type: "error", text: str(at(item, "message")) }];
    return [];
  }
  if (ty === "turn.completed") {
    const u = at(v, "usage");
    // Codex counts its cached input inside input_tokens.
    return [{ type: "result", costUsd: null, durationMs: 0, turns: 1, inputTokens: n0(at(u, "input_tokens")), outputTokens: n0(at(u, "output_tokens")), cached: n0(at(u, "cached_input_tokens")) }];
  }
  if (ty === "turn.failed") return [{ type: "error", text: str(at(v, "error", "message")) }];
  if (ty === "error") return [{ type: "error", text: str(at(v, "message")) }];
  return [];
}

const has = (v: unknown, k: string): boolean => {
  const o = obj(v);
  return o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
};


/** What `opencode run`'s events carry over from one line to the next. */
export interface OpencodeState {
  sessionSent: boolean;
  /** Tokens and cost of the turn's steps so far: one result goes out when the last step ends. */
  cost: number;
  input: number;
  output: number;
  cached: number;
  steps: number;
}

export function opencodeState(): OpencodeState {
  return { sessionSent: false, cost: 0, input: 0, output: 0, cached: 0, steps: 0 };
}

/** `opencode run --format json`: events with a `part` and a `sessionID`. A step that ends in tool calls is followed by
 *  another; the turn's result (its steps added up) comes with the step that ends it. */
export function parseOpencode(v: unknown, st: OpencodeState): Event[] {
  const e: Event[] = [];
  const sid = optStr(at(v, "sessionID")) ?? optStr(at(v, "part", "sessionID"));
  if (!st.sessionSent && sid !== undefined && sid !== "") {
    st.sessionSent = true;
    e.push({ type: "session", id: sid });
  }
  const part = at(v, "part");
  const ty = str(at(v, "type"));
  if (ty === "text") e.push({ type: "textFinal", text: str(at(part, "text")) });
  else if (ty === "reasoning") e.push({ type: "thinkingFinal", text: str(at(part, "text")) });
  else if (ty === "tool_use" || ty === "tool") {
    const state = at(part, "state");
    const status = at(state, "status");
    const done = status === "completed" || status === "error";
    const out = status === "error" ? (optStr(at(state, "error")) ?? textOf(at(state, "output"))) : textOf(at(state, "output"));
    e.push({ type: "tool", id: str(at(part, "callID")), name: str(at(part, "tool")), summary: toolSummary(at(state, "input")), input: pretty(at(state, "input")), result: done ? out : null, isError: status === "error" });
  } else if (ty === "step_finish") {
    const t = at(part, "tokens");
    st.cost += positive(at(part, "cost")) ?? 0;
    st.input += n0(at(t, "input")) + n0(at(t, "cache", "read"));
    st.output += n0(at(t, "output")) + n0(at(t, "reasoning"));
    st.cached += n0(at(t, "cache", "read"));
    st.steps++;
    if (at(part, "reason") !== "tool-calls")
      e.push({ type: "result", costUsd: st.cost > 0 ? st.cost : null, durationMs: 0, turns: st.steps, inputTokens: st.input, outputTokens: st.output, cached: st.cached });
  } else if (ty === "error") {
    const msg = optStr(at(v, "error", "data", "message")) ?? optStr(at(v, "error", "message")) ?? optStr(at(v, "error", "name")) ?? "error";
    e.push({ type: "error", text: msg });
  }
  return e;
}
