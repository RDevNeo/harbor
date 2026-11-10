import { writeSync } from "node:fs";
import { type Json, type JsonObject, isObject, parseJson, sleep } from "./json.ts";
import { socketPath } from "./control.ts";
import { harborVersion } from "./version.ts";

const prop = (type: string, description: string): Json => ({ type, description });

function tool(name: string, description: string, properties: JsonObject, required: string[]): JsonObject {
  return { name, description, inputSchema: { type: "object", properties, required } };
}

const names = (description: string): Json => ({ type: "array", items: { type: "string" }, description });

/** message_agent's and message_chat's `mode`. */
const mode: Json = {
  type: "string",
  enum: ["queue", "steer"],
  description: "For a busy agent: 'steer' cuts into the turn it is running now, for a correction or a cancel of what it is doing; 'queue' (default) waits until that turn ends, for follow-up work. An idle agent starts a turn with it either way",
};

export function tools(role: string): JsonObject[] {
  const v: JsonObject[] = [
    tool("list_processes", "Long-running processes Harbor runs for this project (dev servers, watchers…): status, command and URL.", {}, []),
    tool("process_logs", "Recent output of a process started with start_process.", { name: prop("string", "Process name"), lines: prop("integer", "How many lines (default 60)") }, ["name"]),
    tool("stop_process", "Stop a process (and everything it started).", { name: prop("string", "Process name") }, ["name"]),
    tool(
      "start_process",
      "Run a long-running or slow command (dev server, watcher, data pull, long build) owned by Harbor, so it survives your turn. Returns at once; you get a [process name] message when it prints a local URL or exits.",
      {
        name: prop("string", "Short name, e.g. 'dev', 'convex', 'db-pull'"),
        command: prop("string", "Shell command, e.g. 'npm run dev'"),
        cwd: prop("string", "Folder, relative to the project (default: project root)"),
      },
      ["name", "command"],
    ),
    tool("list_agents", "List the project's agents: name, account id and provider/model, status (running, queued, paused at a usage limit, idle), current task and last report; for the lead, also the messages it queued for each (with their ids, for unqueue_message).", {}, []),
    tool(
      "find_chats",
      "Find Harbor chats by title or sub-agent name (every word must match), across all projects and PCs: title, project, PC, status and its link (harbor://chat/…) to put in a reply so the user can open it.",
      { query: prop("string", "Words of the title or agent name (empty: the most recent chats)") },
      [],
    ),
    tool("list_secrets", "Keys the user saved in Harbor for agents (API keys, tokens): their names, what they're for and whether you may use them now; never the values.", {}, []),
    tool(
      "request_secret",
      "Ask the user for a key you need (an API key, a token) instead of asking in the chat, also one they still have to create: say where to get it in how_to_get. Harbor shows them a card with a field for it, outside the chat; they may keep it in Harbor (and let you use it for `minutes`), write it to the project's .env file you name, or both. Returns at once; you get a '[secret NAME]' message when they answer. You never see the value.",
      {
        name: prop("string", "Environment variable name, e.g. 'STRIPE_SECRET_KEY'"),
        reason: prop("string", "What it's for, shown to the user, e.g. 'To test the payments integration'"),
        how_to_get: prop("string", "Where and how to get it (shown with clickable links), e.g. 'https://dashboard.stripe.com/test/apikeys: copy the Secret key (test mode)'"),
        minutes: prop("number", "How long you need to use it once saved (default 15, at most 1440)"),
        env_file: prop("string", "A .env file in the project to write it to, when the project reads it from one, e.g. '.env.local'"),
        env_var: prop("string", "The variable's name in that file (default: name)"),
      },
      ["name", "reason"],
    ),
    tool(
      "request_secret_access",
      "Ask the user to let you use saved keys for a while: every use of a key needs it. Harbor shows them a card with your reason and the time; they may shorten it or say no. Returns at once; you get a '[secret …]' message when they answer, and another when the time is up.",
      {
        names: names("Names from list_secrets"),
        reason: prop("string", "Why, shown to the user, e.g. 'To test the Boat API'"),
        minutes: prop("number", "How long you need them (default 15, at most 1440)"),
      },
      ["names", "reason"],
    ),
    tool(
      "write_secret_to_env",
      "Ask the user to let Harbor write a saved key to a .env file of the project (.env, .env.local, .env.production…), for code that reads it from there. Harbor writes the VAR=value line itself; you never see the value. Returns at once; you get a '[secret NAME]' message when it's written or refused.",
      {
        name: prop("string", "The secret's name, from list_secrets"),
        file: prop("string", "The .env file, relative to the project, e.g. '.env.local'"),
        var: prop("string", "The variable's name in that file (default: name)"),
        reason: prop("string", "Why, shown to the user"),
      },
      ["name", "file"],
    ),
    tool(
      "run_with_secrets",
      "Run a shell command on this PC with saved keys as environment variables (refer to them as $NAME), once the user allowed you to use them (request_secret_access). Its output comes back with their values hidden, as is and in common encodings (base64, URL, hex, JSON). That stops accidental leaks only: never try to get a value out (printing it changed, writing it to a file). Waits for the command, up to `timeout` seconds; use it for short commands, not servers.",
      {
        command: prop("string", "Shell command (bash), e.g. 'boat deploy --prod'"),
        secrets: names("Names of the secrets to set, from list_secrets"),
        cwd: prop("string", "Folder, relative to the project (default: project root)"),
        timeout: prop("number", "Seconds before it's stopped (default 50, at most 110)"),
      },
      ["command", "secrets"],
    ),
  ];
  if (role === "lead") {
    v.push(
      tool(
        "spawn_agent",
        "Start a subagent that works in the project folder with full tools. Give it a short unique name and a complete, self-contained task. It reports back to you when its turn ends.",
        {
          name: prop("string", "Short handle, e.g. 'tests', 'api', 'reviewer'"),
          title: prop("string", "What the work is in a few words, for the user: the chat shows \"<name> started: <title>\", e.g. 'PR status in the composer footer' (default: the task's first sentence)"),
          task: prop("string", "What to do, with all context it needs"),
          account: prop("string", "Provider account id from list_models (default: your own account)"),
          model: prop("string", "Model id from list_models (default: your model)"),
          effort: prop("string", "Reasoning effort, e.g. low/medium/high (default: medium on Claude)"),
        },
        ["name", "task"],
      ),
      tool(
        "open_chat",
        "Open a new chat (a thread in the sidebar, on the user's PC and phone, like one the user starts) whose agent starts on `prompt` at once. Use it for an independent topic the user wants as its own thread; use spawn_agent for work that serves this chat. Returns the new chat's id.",
        {
          prompt: prop("string", "Its first message: a complete, self-contained request"),
          project: prop("string", "Project name or folder (default: this chat's project)"),
          title: prop("string", "Sidebar title (default: the prompt's first line)"),
          account: prop("string", "Account id from list_models: Claude, Codex or OpenCode (default: yours)"),
          model: prop("string", "Model id from list_models (default: yours)"),
          effort: prop("string", "Reasoning effort (optional)"),
          machine: prop("string", "Another PC of the user's Harbor mesh to run it on (default: this PC)"),
        },
        ["prompt"],
      ),
      tool(
        "list_chats",
        "The project's chats (sidebar threads): id, title, status (working, queued, idle, settled), link (harbor://chat/…, to put in a reply) and the messages you queued there (with their ids, for unqueue_message).",
        { project: prop("string", "Project name or folder (default: this chat's project)") },
        [],
      ),
      tool(
        "message_chat",
        "Send a message to another chat's agent (by id from list_chats or open_chat, or its title). Idle, it starts a turn with it. Busy, mode 'queue' (default) waits for its turn to end and 'steer' cuts into it now. The result says which happened; a queued message's id lets unqueue_message take it back.",
        { chat: prop("string", "Chat id or title"), text: prop("string", "Message"), mode },
        ["chat", "text"],
      ),
      tool(
        "message_agent",
        "Send a message to a subagent. Idle, it starts a new turn with it. Busy: mode 'steer' delivers it into the running turn now, like the user's steer, for a correction or a cancel of what it is doing (where steering isn't possible it is queued, said so); 'queue' (default) is for follow-up work: it waits until the turn ends (or the agent calls read_messages). The result says what happened: steered, queued at position N with an id, or started a turn. Withdraw a queued message with unqueue_message.",
        { agent: prop("string", "Agent name"), text: prop("string", "Message"), mode },
        ["agent", "text"],
      ),
      tool(
        "unqueue_message",
        "Take back messages you queued with message_agent or message_chat that the agent hasn't received yet: one by its id (from the send's result, list_agents or list_chats), or all of yours. A steer, or a message already delivered, can't be taken back: send a correction instead.",
        { agent: prop("string", "Agent name"), chat: prop("string", "Chat id or title, instead of agent"), id: prop("string", "The message's id, or 'all'") },
        ["id"],
      ),
      tool("read_agent", "Read the recent transcript of a subagent (its messages, tool calls and results).", { agent: prop("string", "Agent name"), items: prop("integer", "How many recent entries (default 20)") }, ["agent"]),
      tool("stop_agent", "Stop a subagent's running turn and drop the messages waiting for it. It stays on the team: to take it off, use retire_agent.", { agent: prop("string", "Agent name") }, ["agent"]),
      tool(
        "retire_agent",
        "Retire a subagent whose job is done: stops its turn if one is running, drops the messages waiting for it, and takes it off the team and the user's Agents panel for good, so it can't be messaged or woken again. Its chat stays readable (its link, find_chats, read_agent). Processes it started keep running and report to you.",
        { agent: prop("string", "Agent name") },
        ["agent"],
      ),
      tool(
        "switch_agent_account",
        "Move a subagent to another account (e.g. one stuck at a usage limit), keeping its conversation: on the same provider it resumes its session there; on another provider (Claude <-> Codex) it starts a new session that begins with its conversation so far. If it waits at a limit or has messages waiting, it continues on the new account at once; if a turn is running, it moves when that turn ends. Only use accounts the user allows.",
        {
          agent: prop("string", "Agent name"),
          account: prop("string", "Account id from list_models, e.g. 'claude3' or 'codex'"),
          model: prop("string", "Model id from list_models (default: its model on the same provider, the provider's default on another)"),
          effort: prop("string", "Reasoning effort (default: kept on the same provider)"),
        },
        ["agent", "account"],
      ),
      tool("list_models", "Providers, accounts and models you can give to subagents, with each account's current usage.", {}, []),
      tool(
        "snooze",
        "Wake yourself up later. After the given minutes you get a '[wake]' message with the reason. End your turn after calling it.",
        { minutes: prop("number", "Minutes from now"), reason: prop("string", "What to do when you wake up") },
        ["minutes", "reason"],
      ),
      tool("cancel_snooze", "Cancel all pending wake-ups of this project.", {}, []),
      tool(
        "create_webhook",
        "Create a URL other services (GitHub, Vercel, Stripe, CI…) can POST to. Each request arrives to you as a '[webhook name]' message with its body.",
        { name: prop("string", "Short name, e.g. 'github-push'"), description: prop("string", "What it is for") },
        ["name"],
      ),
      tool("list_webhooks", "List this project's webhooks and their URLs.", {}, []),
      tool("delete_webhook", "Delete a webhook by name.", { name: prop("string", "Webhook name") }, ["name"]),
    );
  } else {
    v.push(
      tool("send_message", "Send a message to a teammate (by name) or to the lead ('lead'). Use it to coordinate, hand off or ask.", { to: prop("string", "Agent name or 'lead'"), text: prop("string", "Message") }, ["to", "text"]),
      tool("read_messages", "Read messages other agents sent you since your turn started.", {}, []),
    );
  }
  return v;
}

export function askSocket(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (f: () => void): void => {
      if (settled) return;
      settled = true;
      f();
    };
    Bun.connect<undefined>({
      unix: path,
      socket: {
        open(s) {
          s.write(`${line}\n`);
        },
        data(s, d) {
          buf += d.toString("utf8");
          const i = buf.indexOf("\n");
          if (i >= 0) {
            finish(() => resolve(buf.slice(0, i)));
            s.end();
          }
        },
        close() {
          finish(() => resolve(buf));
        },
        error(_s, e) {
          finish(() => reject(e));
        },
        connectError(_s, e) {
          finish(() => reject(e));
        },
      },
    }).catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

export interface CallOptions {
  path?: string;
  waitMs?: number;
}

export async function callApp(chat: number, name: string, args: Json, opts: CallOptions = {}): Promise<[boolean, string]> {
  const path = opts.path ?? process.env.HARBOR_SOCK ?? socketPath();
  const waitMs = opts.waitMs ?? 30_000;
  const started = Date.now();
  const message = JSON.stringify({ chat, tool: name, args });
  let answer: string;
  for (;;) {
    try {
      answer = await askSocket(path, message);
      break;
    } catch {
      if (Date.now() - started >= waitMs) return [false, "Harbor is not running"];
      await sleep(250);
    }
  }
  if (answer.trim() === "") return [false, "Harbor restarted before answering. Check whether it took effect (list_agents, list_processes…) before trying again."];
  const v = parseJson(answer);
  const o = isObject(v) ? v : {};
  return [o.ok === true, typeof o.text === "string" ? o.text : "no reply"];
}

export interface Io {
  lines: AsyncIterable<string>;
  write(line: string): boolean;
}

async function* stdinLines(): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
  if (buf !== "") yield buf;
}

function stdoutWrite(line: string): boolean {
  const data = Buffer.from(`${line}\n`);
  let off = 0;
  while (off < data.length) {
    try {
      off += writeSync(1, data, off);
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "EAGAIN") continue;
      return false;
    }
  }
  return true;
}

export interface RunOptions {
  io?: Io;
  version?: string;
  call?: (chat: number, name: string, args: Json) => Promise<[boolean, string]>;
}

export async function run(args: string[], opts: RunOptions = {}): Promise<void> {
  let chat = 0;
  let role = "sub";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chat") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      chat = Number.isNaN(n) ? 0 : n;
    } else if (args[i] === "--role") role = args[++i] ?? "";
  }
  const io = opts.io ?? { lines: stdinLines(), write: stdoutWrite };
  const call = opts.call ?? ((c, n, a) => callApp(c, n, a));
  const version = opts.version ?? harborVersion();
  for await (const line of io.lines) {
    const req = parseJson(line);
    if (!isObject(req)) continue;
    const out = await answer(req, chat, role, call, version);
    if (out !== null && !io.write(JSON.stringify(out))) return;
  }
}

/** The team server's answer to one message (null for a notification): `harbor mcp` over stdio, and the bridge without a process. */
export async function answer(req: JsonObject, chat: number, role: string, call: (chat: number, name: string, args: Json) => Promise<[boolean, string]>, version: string): Promise<Json | null> {
  if (!("id" in req)) return null;
  const id = req.id as Json;
  const params = isObject(req.params) ? req.params : {};
  let result: Json;
  switch (typeof req.method === "string" ? req.method : "") {
    case "initialize":
      result = {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "harbor", version },
      };
      break;
    case "tools/list":
      result = { tools: tools(role) };
      break;
    case "tools/call": {
      const [ok, text] = await call(chat, typeof params.name === "string" ? params.name : "", params.arguments ?? null);
      result = { content: [{ type: "text", text }], isError: !ok };
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
