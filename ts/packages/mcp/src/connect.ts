import { type Engine, type Integrations, integrate as integrateAgents, setAgentEnv, team } from "@harbor/agents";
import * as bridge from "./bridge.ts";
import { type Hook, type Incoming, type Listener, type SocketOptions, startHooks, startSocket } from "./control.ts";
import type { Json } from "./json.ts";
import { grantFrom, NAME as MACHINES } from "./machines.ts";
import { agentEnvAs, claudeConfig, claudeServers, codexArgs } from "./mcp.ts";
import * as workspace from "./workspace.ts";

type AgentGrant = Parameters<NonNullable<Integrations["bridge"]>["grant"]>[0];
type BridgeGrant = Parameters<typeof bridge.grant>[0];

const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;

function asGrant(g: AgentGrant): BridgeGrant {
  const servers = asJson(g.servers);
  return { ...g, servers: typeof servers === "object" && servers !== null && !Array.isArray(servers) ? servers : {}, machines: grantFrom(g.machines) };
}

export function wireAgents(): void {
  integrateAgents({
    servers: { claudeConfig: (chat, extra, apps) => claudeConfig(chat, extra.map(([k, v]) => [k, asJson(v)]), apps), claudeServers: (extra) => claudeServers(extra ? [extra[0], asJson(extra[1])] : undefined), codexArgs, machinesName: MACHINES },
    bridge: {
      grant: (g) => bridge.grant(asGrant(g)),
      revoke: bridge.revoke,
      resume: bridge.resume,
      remoteConfig: (g, port) => bridge.remoteConfig(asGrant(g), port),
      origin: bridge.ORIGIN,
    },
    workspace: { forAccess: workspace.forAccess, replaced: workspace.REPLACED, note: workspace.note },
  });
  setAgentEnv((signedIn) => agentEnvAs(signedIn));
}

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

export function connect<A = never, M = never, O = never>(o: ConnectOptions<A, M, O>): Connected {
  wireAgents();
  const send = (i: Incoming<A, M, O>): void => {
    if (i.kind === "tool") {
      const { chatId, tool, args, reply } = i.call;
      o.engine.tool(chatId, tool, args).then(
        (text) => reply(true, text),
        (e: unknown) => reply(false, e instanceof Error ? e.message : String(e)),
      );
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
