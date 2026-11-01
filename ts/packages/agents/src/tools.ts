import { join } from "node:path";
import type { Chat } from "@harbor/store";
import type { Engine } from "./engine.ts";
import * as oc from "./openchat.ts";
import { newUuid, now, randomHex } from "./paths.ts";
import * as procs from "./procs.ts";
import { accessLabel, short, staticModels } from "./providers.ts";
import * as team from "./team.ts";
import { elapsed } from "./team.ts";

function arg(a: unknown, k: string): string {
  const v = (a as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v.trim() : "";
}

export function retireCall(e: Engine, me: Chat, a: unknown): string {
  if (me.role !== "lead") throw new Error("'retire_agent' is only available to the lead");
  const c = team.retiree(e.chats, me.id, arg(a, "agent"));
  if (typeof c === "string") throw new Error(c);
  if (c.retired) return `${c.name} was already retired.`;
  if ((c.home ?? "") !== "") throw new Error("retiring another PC's agent needs the mesh, which this Harbor doesn't have yet");
  return e.retireAgent(c.id);
}

export async function teamTool(e: Engine, me: Chat, tool: string, a: unknown): Promise<string> {
  const leadId = e.leadFor(me);
  if (leadId === null) throw new Error("not part of a team");
  const repoId = me.repoId;
  const isLead = me.role === "lead";
  const project = (): number => {
    if (repoId === null) throw new Error("webhooks need a project; this thread has none");
    return repoId;
  };
  switch (tool) {
    case "list_agents": {
      const subs = e.subsOf(leadId);
      if (subs.length === 0) return "No subagents yet.";
      return subs
        .map((c) => {
          const status = e.turns.has(c.id) ? "running" : (e.pending.get(c.id)?.length ?? 0) > 0 ? "queued" : `idle (${team.ago(c.updated)} ago)`;
          const acc = e.account(c.account);
          const who = acc ? short(acc) : c.account;
          const model = acc ? e.modelLabel(acc.kind, c.model) : c.model;
          return `- ${c.name} [${status}] ${who} / ${model}\n  link: ${e.chatLink(c)}\n  task: ${c.title}\n  last: ${team.clip(e.lastReply(c.id), 400)}`;
        })
        .join("\n");
    }
    case "send_message":
    case "message_agent": {
      const to = arg(a, tool === "message_agent" ? "agent" : "to");
      const text = arg(a, "text");
      if (text === "") throw new Error("text is empty");
      const target = e.resolve(me, to);
      if (!target) throw new Error(team.noAgent(e.chats, leadId, to));
      if (target.id === me.id) throw new Error("that is you");
      const from = isLead ? "lead" : me.name;
      e.transcript(target.id).items.push({ kind: "message", from, to: target.name, text });
      e.persist(target.id);
      const busy = e.turns.has(target.id);
      e.trigger(target.id, `[message from ${from}] ${text}`, true);
      return busy
        ? `Delivered to ${target.name}. It is busy; it will see it with read_messages or right after its turn.`
        : `Delivered to ${target.name}; it is working on it now.`;
    }
    case "start_process": {
      if (me.access !== "full") throw new Error(`start_process needs full access; this chat is ${accessLabel("Claude", me.access)}`);
      const name = [...arg(a, "name")].filter((c) => /^[\p{L}\p{N}_-]$/u.test(c)).slice(0, 32).join("");
      const cmd = arg(a, "command");
      if (name === "" || cmd === "") throw new Error("name and command are required");
      const running = e.procs.find((p) => p.lead === leadId && p.name === name);
      if (running) throw new Error(`'${name}' is already running (pid ${running.pid}). Use process_logs or stop_process.`);
      const lead = e.chat(leadId);
      const base = lead ? e.chatCwd(lead) : e.cwdOf(repoId);
      const c = arg(a, "cwd");
      const cwd = c === "" ? base : c.startsWith("/") ? c : join(base, c);
      const p = await procs.spawn(e.store, { name, cmd, cwd, repoId, lead: leadId, owner: me.id }, (ev) => e.onProcEvent(ev));
      e.procs = e.procs.filter((x) => !(x.lead === leadId && x.name === name));
      e.dropEnded(leadId, name);
      e.procs.push(p);
      return `Started '${name}' (pid ${p.pid}). It keeps running after your turn ends. You'll get a [process ${name}] message when it prints a local URL or exits; use process_logs to check on it.`;
    }
    case "process_logs": {
      const name = arg(a, "name");
      const raw = (a as Record<string, unknown> | null)?.lines;
      const n = Math.min(typeof raw === "number" && raw >= 0 ? Math.floor(raw) : 60, 400);
      const p = e.procs.find((x) => x.lead === leadId && x.name === name);
      if (!p) {
        const ended = e.endedProcs.find(([l, x]) => l === leadId && x === name);
        if (!ended) throw new Error(`no process named '${name}'`);
        const lines = ended[3].split("\n");
        return `${name}: ${ended[2]}\n${lines.slice(Math.max(0, lines.length - n)).join("\n")}`;
      }
      return `${name}: running ${elapsed(Math.floor((Date.now() - p.started) / 1000))}${p.url !== null ? `, serving ${p.url}` : ""}\n${p.tail(n)}`;
    }
    case "stop_process": {
      const name = arg(a, "name");
      const p = e.procs.find((x) => x.lead === leadId && x.name === name);
      if (!p) throw new Error(`no process named '${name}'`);
      p.stop();
      return `Stopping '${name}'.`;
    }
    case "list_processes": {
      const list = [
        ...e.procs.filter((p) => p.lead === leadId).map((p) => `- ${p.name} [running] ${p.cmd}${p.url !== null ? ` → ${p.url}` : ""}`),
        ...e.endedProcs.filter(([l]) => l === leadId).map(([, n, how]) => `- ${n} [${how}]`),
      ];
      return list.length === 0 ? "No processes." : list.join("\n");
    }
    case "read_messages": {
      const q = e.pending.get(me.id) ?? [];
      e.pending.delete(me.id);
      return q.length === 0 ? "No new messages." : q.join("\n\n");
    }
  }
  if (!isLead) throw new Error(`'${tool}' is only available to the lead`);
  switch (tool) {
    case "spawn_agent":
      return spawnAgent(e, me, leadId, a);
    case "open_chat":
      return openChat(e, me, a);
    case "list_chats": {
      const chats = chatsFor(e, me, toolProject(e, me, a));
      if (chats.length === 0) return "No chats.";
      return chats.map((c) => `- id ${c.id} ${oc.quoted(c.title)}${c.id === me.id ? " (this chat)" : ""} [${statusWords(e, c)}] ${e.chatLink(c)}`).join("\n");
    }
    case "find_chats": {
      const who = commander(e, me);
      const hits = oc.matching(e.chats, arg(a, "query"), (c) => {
        const l = c.role === "sub" ? (c.parent === null ? undefined : e.chat(c.parent)) : c;
        return l !== undefined && commander(e, l) === who;
      });
      if (hits.length === 0) return "No chat matches. Try fewer or other words.";
      return hits
        .map((c) => {
          const l = c.role === "sub" && c.parent !== null ? e.chat(c.parent) : undefined;
          const what = l ? `sub-agent ${oc.quoted(c.name)} of ${oc.quoted(l.title)}` : oc.quoted(c.title);
          const project = e.repo(c.repoId)?.name ?? "No project";
          return `- ${what}${c.id === me.id ? " (this chat)" : ""} · ${project} · ${homeName(e, c)} [${statusWords(e, c)}] ${e.chatLink(c)}`;
        })
        .join("\n");
    }
    case "message_chat":
      return messageChat(e, me, a);
    case "read_agent": {
      const name = arg(a, "agent");
      const target = e.resolve(me, name) ?? team.namedSub(e.chats, leadId, name);
      if (!target) throw new Error("no such agent");
      const raw = (a as Record<string, unknown> | null)?.items;
      const n = typeof raw === "number" && raw >= 0 ? Math.floor(raw) : 20;
      const items = e.transcripts.get(target.id)?.items ?? e.store.items(target.id);
      const lines = items.slice(Math.max(0, items.length - n)).map(team.renderItem);
      return `Transcript of ${target.name} (last ${lines.length}):\n${lines.join("\n")}`;
    }
    case "stop_agent": {
      const name = arg(a, "agent");
      const target = e.resolve(me, name);
      if (!target) throw new Error(team.noAgent(e.chats, leadId, name));
      e.pending.delete(target.id);
      if (!e.turns.has(target.id)) return `${target.name} was not running.`;
      e.stop(target.id);
      return `Stopped ${target.name}.`;
    }
    case "list_models": {
      const out: string[] = [];
      for (const acc of e.host.accounts().filter((x) => x.bin !== null && x.loggedIn !== false)) {
        const usage = acc.usage.map((w) => `${w.label} ${Math.round(w.percent * 100)}% used`);
        const tools = acc.kind === "Claude" || acc.kind === "Codex" ? "" : " (no team tools: cannot message others)";
        out.push(`account '${acc.id}' — ${short(acc)}${acc.email === "" ? "" : ` <${acc.email}>`}${usage.length === 0 ? "" : ` — ${usage.join(", ")}`}${tools}`);
        for (const m of staticModels(acc.kind)) if (m.id !== "") out.push(`    model '${m.id}' (${m.label})${m.more ? " legacy" : ""}`);
      }
      return out.join("\n");
    }
    case "snooze": {
      const raw = (a as Record<string, unknown> | null)?.minutes;
      const minutes = typeof raw === "number" ? raw : 0;
      if (!(minutes >= 0.5 && minutes <= 60 * 24 * 7)) throw new Error("minutes must be between 0.5 and 10080");
      const reason = arg(a, "reason");
      const at = now() + Math.trunc(minutes * 60);
      const id = e.store.addTimer(leadId, at, reason);
      e.timers.push({ id, chatId: leadId, at, reason });
      e.changed(leadId);
      return `Snoozed until ${team.localHm(at)} (in ${team.until(at)}). End your turn now; you will get a [wake] message.`;
    }
    case "cancel_snooze": {
      const ids = e.timers.filter((t) => t.chatId === leadId).map((t) => t.id);
      for (const id of ids) e.store.deleteTimer(id);
      e.timers = e.timers.filter((t) => t.chatId !== leadId);
      return `Cancelled ${ids.length} wake-up(s).`;
    }
    case "create_webhook": {
      const name = [...arg(a, "name")].filter((c) => /^[\p{L}\p{N}_-]$/u.test(c)).slice(0, 32).join("");
      if (name === "") throw new Error("name is empty");
      const repo = project();
      if (e.webhooks.some((w) => w.repoId === repo && w.name === name)) throw new Error(`webhook '${name}' already exists; use list_webhooks`);
      const token = randomHex(20);
      e.store.addWebhook(repo, name, token, arg(a, "description"));
      e.webhooks = e.store.webhooks();
      const local = e.hookUrl(token);
      return `Webhook '${name}' created, but the public URL is not enabled yet. Only this machine can reach it: ${local}\nTell the user to turn on public webhooks in Harbor › Settings › Webhooks; the URL will then be https://<this PC's public name>/hooks/${token}.`;
    }
    case "list_webhooks": {
      const list = e.webhooks.filter((w) => w.repoId === repoId).map((w) => `- ${w.name} (${w.hits} calls): ${e.hookUrl(w.token)}`);
      return list.length === 0 ? "No webhooks." : list.join("\n");
    }
    case "delete_webhook": {
      const name = arg(a, "name");
      const repo = project();
      const w = e.webhooks.find((x) => x.repoId === repo && x.name === name);
      if (!w) throw new Error("no such webhook");
      e.store.deleteWebhook(w.id);
      e.webhooks = e.store.webhooks();
      return `Deleted webhook '${name}'.`;
    }
  }
  throw new Error(`unknown tool '${tool}'`);
}

export function commander(e: Engine, c: Chat): string {
  return e.host.commander?.(c) ?? "";
}

export function homeName(e: Engine, c: Chat): string {
  return e.host.homeName?.(c) ?? (c.home !== "" ? c.home : (e.host.hostname?.() ?? "this PC"));
}

/** This PC's chats of `repo` that `me` may see and message: leads run here, for the same person. */
export function chatsFor(e: Engine, me: Chat, repo: number | null): Chat[] {
  const who = commander(e, me);
  return e.chats.filter((c) => c.role === "lead" && c.repoId === repo && c.home === "" && commander(e, c) === who).sort((x, y) => y.updated - x.updated);
}

/** The project a tool call names (`project`), or the calling chat's. */
export function toolProject(e: Engine, me: Chat, a: unknown): number | null {
  const p = arg(a, "project");
  if (p === "") return me.repoId;
  const id = oc.findProject(e.repos, p);
  if (id === null) throw new Error(`no project '${p}'. Projects: ${e.repos.map((r) => r.name).join(", ")}`);
  return id;
}

export function statusWords(e: Engine, c: Chat): string {
  if (c.retired) return "retired";
  if (e.turns.has(c.id) || e.subsOf(c.id).some((s) => e.turns.has(s.id))) {
    const since = e.runningSince(c.id);
    return `working${since === null ? "" : ` ${elapsed(Math.floor((Date.now() - since) / 1000))}`}`;
  }
  if ((e.pending.get(c.id)?.length ?? 0) > 0) return "queued";
  if (c.settled) return "settled";
  const a = team.ago(c.updated);
  return a === "now" ? "idle, active just now" : `idle, last active ${a} ago`;
}

export async function openChat(e: Engine, me: Chat, a: unknown): Promise<string> {
  const prompt = arg(a, "prompt");
  if (prompt === "") throw new Error("prompt is empty");
  const repo = toolProject(e, me, a);
  const title = [...arg(a, "title")].slice(0, 80).join("");
  const machine = arg(a, "machine");
  const here = homeName(e, me).toLowerCase();
  const elsewhere = machine !== "" && machine.toLowerCase() !== here && machine.toLowerCase() !== (e.host.hostname?.() ?? "").toLowerCase();
  const t = Date.now();
  const q = (e.autoTurns.get(repo ?? 0) ?? []).filter((x) => t - x < 3600_000);
  e.autoTurns.set(repo ?? 0, q);
  if (q.length >= team.AUTO_TURNS_PER_HOUR) throw new Error("too many automatic turns in this project in the last hour: ask the user instead");
  q.push(t);
  if (elsewhere) {
    if (!e.host.openElsewhere) throw new Error(`no PC named '${machine}'. PCs: ${homeName(e, me)}`);
    return e.host.openElsewhere(me, machine, a);
  }
  const mine = e.account(me.account)?.kind === "Claude";
  const account = arg(a, "account") || (mine ? me.account : "claude");
  const acc = e.account(account);
  if (!acc) throw new Error(`unknown account '${account}'. Use list_models.`);
  if (acc.kind !== "Claude") throw new Error(`chats run on a Claude account; give ${acc.kind} work with spawn_agent instead`);
  const same = account === me.account;
  const model = arg(a, "model") || (same ? me.model : "");
  const effort = arg(a, "effort") || (same ? me.effort : "");
  const fresh = e.newThread(repo, prompt, { account, model, effort, access: me.access, device: me.device });
  if (title !== "") fresh.title = title;
  e.notice(fresh.id, "chat", oc.openedBy(me.title), `${oc.LINK}${me.gid}`);
  e.notice(me.id, "chat", `Opened ${oc.quoted(fresh.title)}`, `${oc.LINK}${fresh.gid}`);
  e.transcript(fresh.id).items.push({ kind: "user", text: prompt, files: [], at: now(), mentions: [], sender: "", intent: "" });
  e.persist(fresh.id);
  e.startTurn(fresh.id, `${oc.preamble(me)}${prompt}`);
  const project = e.repo(repo)?.name ?? "No project";
  return `Opened the chat ${oc.quoted(fresh.title)} (id ${fresh.id}) in ${project}. Its agent is working on it now; the user sees it in the sidebar. Follow up with message_chat(chat: ${fresh.id}, text) and check it with list_chats.`;
}

/** `message_chat`: a message from this chat's agent to another chat's, which starts a turn with it (or reads it after the current one). */
export function messageChat(e: Engine, me: Chat, a: unknown): string {
  const text = arg(a, "text");
  if (text === "") throw new Error("text is empty");
  const which = arg(a, "chat");
  const target = oc.findChat(
    e.chats.filter((c) => c.role === "lead" && c.home === ""),
    which,
  );
  if (!target || commander(e, target) !== commander(e, me)) throw new Error(`no chat '${which}'. Use list_chats.`);
  if (target.id === me.id) throw new Error("that is this chat");
  e.transcript(target.id).items.push({ kind: "message", from: `chat ${oc.quoted(me.title)}`, to: oc.THIS_CHAT, text });
  e.persist(target.id);
  const busy = e.turns.has(target.id);
  e.trigger(target.id, `[message from the agent of the chat ${oc.quoted(me.title)} (id ${me.id})] ${text}`, true);
  return busy ? `Delivered to ${oc.quoted(target.title)}. It is busy; it reads it right after its turn.` : `Delivered to ${oc.quoted(target.title)}; its agent is working on it now.`;
}

export function spawnAgent(e: Engine, me: Chat, leadId: number, a: unknown): string {
  let name = [...arg(a, "name")].filter((c) => /^[\p{L}\p{N}_-]$/u.test(c)).slice(0, 24).join("");
  const task = arg(a, "task");
  if (task === "") throw new Error("task is empty");
  if (name === "" || name.toLowerCase() === "lead") name = `agent${e.subsOf(leadId).length + 1}`;
  const taken = e.subsOf(leadId).map((c) => c.name.toLowerCase());
  if (taken.includes(name.toLowerCase())) {
    const base = name;
    for (let n = 2; ; n++) {
      if (!taken.includes(`${base}-${n}`.toLowerCase())) {
        name = `${base}-${n}`;
        break;
      }
    }
  }
  const accountId = arg(a, "account") || me.account;
  const acc = e.account(accountId);
  if (!acc) throw new Error(`unknown account '${accountId}'. Use list_models.`);
  if (acc.bin === null) throw new Error(`${acc.kind} is not installed`);
  const model = arg(a, "model") || (acc.kind === "Claude" ? me.model : "");
  const access = team.subAccess(me.access, acc.kind);
  if (access === null) throw new Error(`${acc.kind} has no ${accessLabel("Claude", me.access)} access; pick another account`);
  const pre = acc.kind === "Claude" || acc.kind === "Grok" || acc.kind === "Meta";
  const title = [...(arg(a, "title") || (task.split("\n")[0] ?? ""))].slice(0, 80).join("");
  const chat = e.store.createChat({
    id: 0,
    repoId: me.repoId,
    title,
    sessionId: pre ? newUuid() : "",
    started: false,
    account: accountId,
    model,
    effort: arg(a, "effort"),
    access: access as Chat["access"],
    settled: false,
    updated: now(),
    role: "sub",
    parent: leadId,
    name,
    // Claude subagents run where their lead does; other CLIs only run here.
    device: acc.kind === "Claude" ? me.device : "",
    gid: "",
    home: "",
    homeId: 0,
    retired: false,
  });
  e.chats.push(chat);
  e.transcript(chat.id).items.push({ kind: "message", from: "lead", to: name, text: task });
  e.persist(chat.id);
  e.trigger(chat.id, task, false);
  const queued = !e.turns.has(chat.id);
  return `Spawned '${name}' on ${short(acc)} / ${e.modelLabel(acc.kind, model)}${queued ? " (queued: too many agents running)" : ""}. It reports back to you when its turn ends.`;
}
