import { statSync } from "node:fs";
import { homedir } from "node:os";
import { type Chat, cost, repoDir } from "./packages/store/src/index.ts";
import { type Engine, providers } from "./packages/agents/src/index.ts";
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
  return h.engine.runningSubs(lead).map(([s, secs]) => {
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

/** api.rs `api_status`. */
export function statusBars(h: BarsHost, id: number, nowMs: number): Record<string, Json> {
  const c = h.engine.chat(id);
  const lead = c?.role === "lead";
  const subs = lead ? h.engine.runningSubs(id) : [];
  const since = h.engine.runningSince(id);
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
  };
}
