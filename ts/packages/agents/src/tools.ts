import { isAbsolute, join } from "node:path";
import { type Chat, secrets, usageCtl } from "@harbor/store";
import type { Delivery, Engine } from "./engine.ts";
import * as oc from "./openchat.ts";
import { newUuid, now, randomHex } from "./paths.ts";
import * as procs from "./procs.ts";
import { type Mode, parseMode, steering } from "./queue.ts";
import { type Account, accessLabel, applyUsage, type Kind, short, staticModels, usable } from "./providers.ts";
import * as team from "./team.ts";
import { elapsed } from "./team.ts";
import { utcOffset, waitWords } from "./waiting.ts";

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
      const asks = secrets.loadAsks(e.store);
      return subs
        .map((c) => {
          const w = e.turns.has(c.id) ? null : e.waiting(c.id, asks);
          const limit = e.turns.has(c.id) ? null : e.limits.limitText(c.id);
          const sync = e.host.syncing?.(c.id) ?? null;
          const status = sync !== null ? `syncing: ${sync}` : e.turns.has(c.id) ? "running" : limit !== null ? `paused: ${limit[0]}` : (e.pending.get(c.id)?.length ?? 0) > 0 ? "queued" : w !== null ? waitWords(w, now(), utcOffset()) : `idle (${team.ago(c.updated)} ago)`;
          const acc = e.account(c.account);
          const who = acc ? short(acc) : c.account;
          const model = acc ? e.modelLabel(acc.kind, c.model) : c.model;
          const moving = e.wantAccount.get(c.id);
          const next = moving ? ` (moves to account '${moving.to}' when this turn ends)` : "";
          return `- ${c.name} [${status}] account '${c.account}' (${who}) / ${model}${next}\n  link: ${e.chatLink(c)}\n  task: ${c.title}\n  last: ${team.clip(e.lastReply(c.id), 400)}${isLead ? queuedLine(e, me, c) : ""}`;
        })
        .join("\n");
    }
    case "send_message": {
      const to = arg(a, "to");
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
      const cwd = c === "" ? base : isAbsolute(c) ? c : join(base, c);
      const p = await procs.spawn(e.store, { name, cmd, cwd, repoId, lead: leadId, owner: me.id }, (ev) => e.onProcEvent(ev));
      e.procs = e.procs.filter((x) => !(x.lead === leadId && x.name === name));
      e.dropEnded(leadId, name);
      e.procs.push(p);
      return `Started '${name}' (pid ${p.pid}). It keeps running after your turn ends and across Harbor restarts. You'll get a [process ${name}] message when it prints a local URL or exits; use process_logs to check on it.`;
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
      const q = [...(e.pending.get(me.id) ?? []), ...e.takeMessages(me.id)];
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
      return chats.map((c) => `- id ${c.id} ${oc.quoted(c.title)}${c.id === me.id ? " (this chat)" : ""} [${statusWords(e, c)}] ${e.chatLink(c)}${queuedLine(e, me, c)}`).join("\n");
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
    case "message_agent": {
      const name = arg(a, "agent");
      const text = arg(a, "text");
      if (text === "") throw new Error("text is empty");
      const target = e.resolve(me, name);
      if (!target) throw new Error(team.noAgent(e.chats, leadId, name));
      if (target.id === me.id) throw new Error("that is you");
      const d = e.deliver(target.id, text, { chat: me.id, from: "lead", to: target.name, tag: "[message from lead] " }, toolMode(a));
      return delivered(e, target, d, target.name, `agent: ${JSON.stringify(target.name)}`);
    }
    case "message_chat":
      return messageChat(e, me, a);
    case "unqueue_message": {
      const agent = arg(a, "agent");
      const chat = arg(a, "chat");
      if ((agent === "") === (chat === "")) throw new Error("give agent or chat");
      const target = agent !== "" ? e.resolve(me, agent) : chatTarget(e, me, chat);
      if (!target) throw new Error(team.noAgent(e.chats, leadId, agent));
      const name = agent !== "" ? target.name : oc.quoted(target.title);
      const raw = (a as Record<string, unknown> | null)?.id;
      const which = raw === "all" ? "all" : typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : null;
      if (which === null) throw new Error("id must be a queued message's id or 'all'");
      const gone = e.unqueue(target.id, me.id, which);
      if (gone.length > 0) return `Took back ${gone.length === 1 ? `message ${gone[0]?.id}` : `${gone.length} messages (ids ${gone.map((q) => q.id).join(", ")})`} from ${name}'s queue: it never gets ${gone.length === 1 ? "it" : "them"}.`;
      if (which === "all") return `Nothing of yours waits in ${name}'s queue.`;
      const q = e.queued(target.id).find((x) => x.id === which);
      if (q && q.agent?.chat !== me.id) throw new Error(`message ${which} isn't yours: only the user takes it back`);
      if (q) throw new Error(`message ${which} is already on its way into ${name}'s turn: send a correction instead`);
      throw new Error(`no message ${which} waits in ${name}'s queue: it was delivered already, or the id is wrong (list_agents and list_chats show what waits)`);
    }
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
      // What the lead queued would wait for a Resume the lead can't give: it goes with the turn.
      const gone = e.unqueue(target.id, me.id, "all", true).length;
      const dropped = gone > 0 ? ` Dropped ${gone} message(s) you had queued for it.` : "";
      if (!e.turns.has(target.id)) return `${target.name} was not running.${dropped}`;
      e.stop(target.id);
      return `Stopped ${target.name}.${dropped}`;
    }
    case "switch_agent_account": {
      const name = arg(a, "agent");
      const target = e.resolve(me, name);
      if (!target || target.role !== "sub") throw new Error(target ? "only subagents switch accounts here; the user switches this chat's account in its composer" : team.noAgent(e.chats, leadId, name));
      const account = arg(a, "account");
      if (account === "") throw new Error("account is required: an account id from list_models");
      const r = e.switchAccount(target.id, account, { model: arg(a, "model"), effort: arg(a, "effort"), why: "switched by the lead" });
      e.changed(leadId);
      return r;
    }
    case "list_models": {
      const out: string[] = [];
      e.host.rediscover?.();
      applyUsage(e.host.accounts());
      for (const acc of e.host.accounts().filter(usable)) {
        const usage = usageCtl.quotaText(acc.plan, e.limits.ctl.windows(acc.id), now());
        const tools = acc.kind === "Claude" || acc.kind === "Codex" ? "" : " (no team tools: cannot message others)";
        out.push(`account '${acc.id}' — ${short(acc)}${acc.email === "" ? "" : ` <${acc.email}>`}${usage === "" ? "" : ` — ${usage}`}${tools}`);
        const models = staticModels(acc.kind);
        // OpenCode lists every provider's models: the config's are enough here, the rest is counted.
        const shown = acc.kind === "OpenCode" ? models.filter((m) => !m.more) : models;
        for (const m of shown) if (m.id !== "") out.push(`    model '${m.id}' (${m.label})${m.more ? " legacy" : ""}`);
        if (shown.length < models.length) out.push(`    … and ${models.length - shown.length} more 'provider/model' ids from \`opencode models\``);
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
      e.changed(leadId);
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
      const [local, pub] = e.hookUrl(token);
      if (pub !== null) return `Webhook '${name}' created.\nPublic URL: ${pub}\n(Local: ${local})`;
      return `Webhook '${name}' created, but the public URL is not enabled yet. Only this machine can reach it: ${local}\nTell the user to turn on public webhooks in Harbor › Settings › Webhooks; the URL will then be https://<this PC's public name>/hooks/${token}.`;
    }
    case "list_webhooks": {
      const list = e.webhooks.filter((w) => w.repoId === repoId).map((w) => {
        const [local, pub] = e.hookUrl(w.token);
        return `- ${w.name} (${w.hits} calls): ${pub ?? local}`;
      });
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
  const sync = e.host.syncing?.(c.id) ?? null;
  if (sync !== null) return `syncing (${sync}): messages wait for it`;
  if (e.live(c.id) || e.subsOf(c.id).some((s) => e.live(s.id))) {
    const since = e.liveSince(c.id);
    return `working${since === null ? "" : ` ${elapsed(Math.floor((Date.now() - since) / 1000))}`}`;
  }
  if ((e.pending.get(c.id)?.length ?? 0) > 0) return "queued";
  const w = e.waiting(c.id);
  if (w !== null) return waitWords(w, now(), utcOffset());
  if (c.settled) return "settled";
  const a = team.ago(c.updated);
  return a === "now" ? "idle, active just now" : `idle, last active ${a} ago`;
}

/** The account a new chat or agent runs on: the one named, else `dflt`. An account turned off in Settings ›
 *  Providers is never used: named, it's refused; as the default, the first usable one (of `kind`, else of the
 *  default's provider) takes its place. */
function pickAccount(e: Engine, named: string, dflt: string, kind?: Kind): Account {
  const id = named || dflt;
  const acc = e.account(id);
  if (!acc) throw new Error(`unknown account '${id}'. Use list_models.`);
  if (acc.off !== true) return acc;
  if (named !== "") throw new Error(`account '${id}' is turned off on this PC. Use list_models.`);
  const k = kind ?? acc.kind;
  const alt = e.host.accounts().find((x) => x.kind === k && usable(x));
  if (!alt) throw new Error(`account '${id}' is turned off on this PC and no other ${k} account is on`);
  return alt;
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
  // A chat runs on any provider: the one named, else this chat's own.
  const acc = pickAccount(e, arg(a, "account"), me.account);
  const account = acc.id;
  if (acc.bin === null) throw new Error(`${acc.kind} is not installed`);
  const same = account === me.account;
  const model = arg(a, "model") || (same ? me.model : "");
  const effort = arg(a, "effort") || (same ? me.effort : "");
  const fresh = e.newThread(repo, prompt, { account, model, effort, access: me.access, device: acc.kind === "Claude" ? me.device : "" });
  if (title !== "") fresh.title = title;
  e.notice(fresh.id, "chat", oc.openedBy(me.title), `${oc.LINK}${me.gid}`);
  e.notice(me.id, "chat", `Opened ${oc.quoted(fresh.title)}`, `${oc.LINK}${fresh.gid}`);
  e.transcript(fresh.id).items.push({ kind: "user", text: prompt, files: [], at: now(), mentions: [], sender: "", intent: "" });
  e.persist(fresh.id);
  e.startTurn(fresh.id, `${oc.preamble(me)}${prompt}`);
  const project = e.repo(repo)?.name ?? "No project";
  return `Opened the chat ${oc.quoted(fresh.title)} (id ${fresh.id}) in ${project}. Its agent is working on it now; the user sees it in the sidebar. Follow up with message_chat(chat: ${fresh.id}, text) and check it with list_chats.`;
}

/** A lead chat of this PC `me` may message (by id or title), for message_chat and unqueue_message. */
function chatTarget(e: Engine, me: Chat, which: string): Chat {
  const target = oc.findChat(
    e.chats.filter((c) => c.role === "lead" && c.home === ""),
    which,
  );
  if (!target || commander(e, target) !== commander(e, me)) throw new Error(`no chat '${which}'. Use list_chats.`);
  return target;
}

/** `message_chat`: a message from this chat's agent to another chat's, which starts a turn with it, steers its running one or waits for it to end. */
export function messageChat(e: Engine, me: Chat, a: unknown): string {
  const text = arg(a, "text");
  if (text === "") throw new Error("text is empty");
  const target = chatTarget(e, me, arg(a, "chat"));
  if (target.id === me.id) throw new Error("that is this chat");
  const d = e.deliver(target.id, text, { chat: me.id, from: `chat ${oc.quoted(me.title)}`, to: oc.THIS_CHAT, tag: `[message from the agent of the chat ${oc.quoted(me.title)} (id ${me.id})] ` }, toolMode(a));
  return delivered(e, target, d, oc.quoted(target.title), `chat: ${target.id}`);
}

function toolMode(a: unknown): Mode {
  const s = arg(a, "mode");
  if (s === "") return "queue";
  const m = parseMode(s);
  if (m === null) throw new Error("mode is 'steer' or 'queue'");
  return m;
}

/** What a message_agent or message_chat did, for the lead: `ref` names the target in an unqueue_message call. */
function delivered(e: Engine, target: Chat, d: Delivery, name: string, ref: string): string {
  switch (d.how) {
    case "started":
      return `Delivered to ${name}; ${target.role === "sub" ? "it is" : "its agent is"} working on it now.`;
    case "waiting":
      if (d.why === "slots") return `Delivered to ${name}; it starts on it once a teammate's turn ends (${team.MAX_RUNNING_SUBS} run at a time).`;
      if (d.why === "paused") return `Held for ${name}: automatic turns are paused in this project until the user writes.`;
      return `Delivered to ${name}; it starts on it as soon as it can.`;
    case "steered":
      return d.restart
        ? `Steered ${name}: ${e.account(target.account)?.kind ?? "its provider"} can't take a message mid-turn, so its turn was stopped and resumed with yours.`
        : `Steered ${name}: your message goes into its running turn now.`;
    case "queued": {
      const why =
        d.steer === "unsupported"
          ? `Couldn't steer ${name} (${steerless(e, target)}), so it was queued instead: `
          : d.steer === "missed"
            ? `Couldn't steer ${name} (its turn was closing its input), so it goes next: `
            : "";
      const sooner = target.role === "sub" ? ", or sooner if it calls read_messages" : "";
      return `${why}Queued for ${name} at position ${d.at} (id ${d.id}); it gets it when its current turn ends${sooner}. unqueue_message(${ref}, id: ${d.id}) takes it back.`;
    }
  }
}

/** Why a running turn can't take a steer: Claude's and Codex's can, once their runner is up and while Claude's input is open. */
function steerless(e: Engine, c: Chat): string {
  return e.turnOf(c.id) === null ? "its turn is still starting" : "its turn is closing its input";
}

/** For list_agents and list_chats: the messages `me` queued for `c` (with the ids unqueue_message takes), and how many others wait there. */
function queuedLine(e: Engine, me: Chat, c: Chat): string {
  const waiting = e.queued(c.id).filter((q) => !q.written && !steering(q));
  if (waiting.length === 0) return "";
  const mine = waiting.filter((q) => q.agent?.chat === me.id);
  const parts = mine.map((q) => `id ${q.id} ${oc.quoted(gist(q.text))}`);
  const others = waiting.length - mine.length;
  if (others > 0) parts.push(`${others} not from you`);
  return `\n  queued: ${parts.join("; ")}`;
}

/** A queued message's first line, short. */
function gist(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const chars = [...line];
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : line;
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
  const acc = pickAccount(e, arg(a, "account"), me.account);
  const accountId = acc.id;
  if (acc.bin === null) throw new Error(`${acc.kind} is not installed`);
  const model = arg(a, "model") || (acc.kind === "Claude" ? me.model : "");
  const access = team.subAccess(me.access, acc.kind);
  if (access === null) throw new Error(`${acc.kind} has no ${accessLabel("Claude", me.access)} access; pick another account`);
  const pre = acc.kind === "Claude";
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
