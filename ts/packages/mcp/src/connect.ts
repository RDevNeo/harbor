import { type Engine, team } from "@harbor/agents";
import { type Hook, type Incoming, type Listener, type SocketOptions, startHooks, startSocket, type ToolCall } from "./control.ts";
import { isObject, type Json } from "./json.ts";


export interface ConnectOptions<A, M, O> {
  engine: Engine;
  other?: (i: Exclude<Incoming<A, M, O>, { kind: "tool" | "hook" }>) => void;
  ensureLead?: (repo: number) => number | undefined;
  previewReceived?: SocketOptions<A, M, O>["previewReceived"];
  socket?: string;
  hooks?: number | false;
}

export interface Connected {
  stop(): void;
}

export function deliverHook(engine: Engine, h: Hook, ensureLead?: (repo: number) => number | undefined): boolean {
  const wh = engine.webhooks.find((w) => w.token === h.token);
  if (!wh) return false;
  if (!engine.repos.some((r) => r.id === wh.repoId)) {
    engine.webhooks = engine.store.webhooks();
    return false;
  }
  engine.store.hitWebhook(wh.id);
  engine.webhooks = engine.store.webhooks();
  const lead = engine.mainChat(wh.repoId) ?? engine.leadOf(wh.repoId) ?? ensureLead?.(wh.repoId);
  if (lead === undefined || lead === null) return false;
  const headers = h.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = team.clip(h.body, 8000);
  const event = h.headers.find(([k]) => k.endsWith("-event"))?.[1];
  engine.notice(lead, "webhook", `Webhook ${wh.name}${event === undefined ? "" : ` · ${event}`}`, `${h.method} ${wh.name}\n${headers}\n\n${body}`);
  const request = team.untrusted("webhook request", `${headers}\n\nBody:\n${body}`);
  engine.trigger(lead, `[webhook ${wh.name}] ${h.method} request received.\n${request}`, true);
  return true;
}

/** Answers a team tool call from the control socket (`harbor mcp`); `computer` answers with MCP content (screenshots). */
export function answerTool(engine: Engine, call: ToolCall): void {
  const { chatId, tool, args, reply } = call;
  const failed = (e: unknown): void => reply(false, e instanceof Error ? e.message : String(e));
  if (tool === "computer") {
    engine.computer(chatId, args).then((r) => {
      const content = r.content as Json[];
      const text = content.map((c) => (isObject(c) && typeof c.text === "string" ? c.text : "")).join("\n");
      reply(r.ok, text, content);
    }, failed);
    return;
  }
  engine.tool(chatId, tool, args).then((text) => reply(true, text), failed);
}

export function connect<A = never, M = never, O = never>(o: ConnectOptions<A, M, O>): Connected {
  const send = (i: Incoming<A, M, O>): void => {
    if (i.kind === "tool") {
      answerTool(o.engine, i.call);
    } else if (i.kind === "hook") {
      deliverHook(o.engine, i.hook, o.ensureLead);
    } else o.other?.(i);
  };
  const socketOpts: SocketOptions<A, M, O> = { send };
  if (o.previewReceived) socketOpts.previewReceived = o.previewReceived;
  if (o.socket) socketOpts.path = o.socket;
  const socket: Listener | undefined = startSocket(socketOpts);
  const tokens = { has: (t: string) => o.engine.webhooks.some((w) => w.token === t) };
  const hooks = o.hooks === false ? undefined : startHooks(tokens, (h) => send({ kind: "hook", hook: h }), o.hooks);
  if (hooks) o.engine.hookPort = hooks.port;
  return {
    stop() {
      socket?.stop();
      hooks?.stop();
    },
  };
}
