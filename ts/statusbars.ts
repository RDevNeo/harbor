import { statSync } from "node:fs";
import { homedir } from "node:os";
import { type Chat, cost, repoDir } from "./packages/store/src/index.ts";
import { type Engine, providers, waiting as wait } from "./packages/agents/src/index.ts";
import { subsRunning } from "./packages/agents/src/engine.ts";
import { type CloneState, cloneFolderJson, cloneProjectOwner } from "./packages/net/src/clone.ts";
import type { Json } from "./packages/net/src/wire.ts";
import { doing, stripJson, type Row } from "./packages/ui/src/logic/agentstrip.ts";

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export interface BarsHost {
  engine: Engine;
  clones: CloneState;
  homeName(c: Chat): string;
}

export function stripRows(h: BarsHost, lead: number): Row[] {
  const c = h.engine.chat(lead);
  if (!c || c.role !== "lead") return [];
  const repo = h.engine.repo(c.repoId);
  const root = repo ? repoDir(repo) : "";
  return h.engine.liveSubs(lead).map(([s, secs]) => {
    const acc = h.engine.account(s.account);
    const items = h.engine.transcripts.get(s.id)?.items ?? [];
    const usage = cost.ofItems(items);
    return {
      id: s.id,
      kind: acc ? (acc.kind.toLowerCase() as Row["kind"]) : null,
      badge: acc?.badge ?? "",
      model: acc ? h.engine.modelLabel(acc.kind, s.model) : s.model,
      doing: doing(items, root),
      task: s.title,
      name: s.name,
      secs,
      usage: cost.isEmpty(usage) ? "" : cost.compact(usage),
    };
  });
}

function folder(h: BarsHost, c: Chat): Json {
  const repo = h.engine.repo(c.repoId);
  const r = repo ? { id: repo.id, name: repo.name, path: repo.path, dir: repoDir(repo), remote: repo.remote } : null;
  const wt = h.engine.worktreeOf(c);
  const chats = h.engine.chats.map((x) => ({ repoId: x.repoId, foreign: x.home !== "", home: x.home, homeName: h.homeName(x) }));
  const line = h.clones.folderLine({
    chat: { foreign: c.home !== "", device: c.device },
    repo: r,
    worktreeLost: wt !== null && !isDir(wt),
    owner: r ? cloneProjectOwner(r.id, chats) : null,
    home: homedir(),
  });
  return cloneFolderJson(line);
}

/** PROTOCOL.md `wait`: what wakes a chat whose own turn is done (agents waiting.ts), null while it works or waits on nothing.
 *  `asks`: the secret cards, read once for a list. */
export function waitJson(engine: Engine, id: number, nowMs: number, asks?: readonly { chat: number }[]): Json {
  if (engine.live(id)) return null;
  const w = engine.waiting(id, asks);
  if (w === null) return null;
  const t = Math.floor(nowMs / 1000);
  return { label: "Waiting", text: wait.waitText(w, t, wait.utcOffset(t)), procs: w.procs, subs: w.subs, wake_ms: w.wake === null ? null : w.wake * 1000, keys: w.keys };
}

/** api.rs `api_status`. */
export function statusBars(h: BarsHost, id: number, nowMs: number): Record<string, Json> {
  const c = h.engine.chat(id);
  const lead = c?.role === "lead";
  const subs = lead ? h.engine.liveSubs(id) : [];
  const since = h.engine.liveSince(id);
  const working = since === null ? null : { since_ms: since, subagents: subs.length, text: `Working…${subsRunning(subs.length)}` };
  const waiting =
    working === null && subs.length > 0
      ? { agents: subs.map(([s, secs]) => ({ id: s.id, name: s.name, title: s.title, since_ms: nowMs - secs * 1000 })), queued: h.engine.subsQueued(id) }
      : null;
  const text = h.engine.limits.limitText(id);
  const limit =
    text === null
      ? null
      : {
          text: text[0],
          can_cancel: text[1],
          targets: h.engine.limits.switchTargets(id, false).map((t) => {
            const a = h.engine.account(t);
            return { id: t, name: a ? `${providers.short(a)} · ${a.email}` : t };
          }),
        };
  const rows = stripRows(h, id);
  return {
    working,
    waiting,
    limit,
    agents: stripJson(rows, h.engine.subsQueued(id), nowMs) as Json,
    folder: c ? folder(h, c) : null,
    wait: waitJson(h.engine, id, nowMs),
  };
}
