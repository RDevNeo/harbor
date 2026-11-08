// Nothing else may hold running turns or queues: ui renders this, and mcp's control socket and
// net's phone and mesh routes call into it.
import { existsSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Chat, type CopyTurn, hot, type Item, limits, liveSince, type Mention, type Repo, secrets, type Store, type Timer, type SentVia, usageCtl, type Webhook } from "@harbor/store";
import * as agent from "./agent.ts";
import * as compaction from "./compaction.ts";
import { parse as parseJson } from "./json.ts";
import type { Event, RemoteSpec, Turn } from "./agent.ts";
import * as detach from "./detach.ts";
import { ensureSession, ensureSessionIn, sessionCopies } from "./movechat.ts";
import { forkable, forkJsonl, forksKey, preambleKey } from "./fork.ts";

/** kv: the provider kind a chat's session runs on. */
export const sessionKindKey = (chat: number): string => `session_kind_${chat}`;
import { home, newUuid, now } from "./paths.ts";
import { alive as aliveNow } from "./procfs.ts";
import * as procs from "./procs.ts";
import { access as accessLevels, type Account, accountEnv, applyUsage, binStr, installed, type Kind, kindOf, knownAccount, short, staticModels } from "./providers.ts";
import * as team from "./team.ts";
import * as toolsModule from "./tools.ts";
import { fromJson as waitFromJson, type Waiting, waitingOf } from "./waiting.ts";
import { type FromAgent, type Intent, NOT_LANDED, PROMOTED, QueueState, type Queued, queuedItem, queuedPrompt, sentFrom, STEER, steering, type Mode, withWho } from "./queue.ts";
export { type FromAgent, NOT_LANDED, PROMOTED, QueueState, type Queued, queuedItem, queuedPrompt, sentFrom, STEER, type Mode } from "./queue.ts";
import { Recaps } from "./recap.ts";

/** Harbor's team tools (send_message, spawn_agent…), swapped by dev hot reload (ui/src/hotdev.ts). */
const tools = hot.unit("tools", "packages/agents/src/tools.ts", toolsModule);
/** The lead's and subagents' instructions (team.ts), swapped the same way. */
const prompts = hot.unit("prompts", "packages/agents/src/team.ts", team);

/** What the engine needs from the app around it; the optional parts belong to other packages. */
/** The PC that forwarded a message, and the context it sent with it. */
export interface SentBy {
  peer: string;
  name: string;
  ctx: unknown;
}

export interface EngineHost {
  store: Store;
  accounts(): readonly Account[];
  /** Reads this PC's accounts again now (providers.discover), so a removed profile folder is gone at once. */
  rediscover?(): void;
  /** Something about `chatId` changed (null: about several): repaint, tell phones. */
  changed(chatId: number | null): void;
  /** A chat whose home is another PC: its turns run there (net). */
  isForeign?(chatId: number): boolean;
  /** Without it, every copy reads as idle. */
  copyTurn?(chatId: number): CopyTurn | null;
  /** The chat is being handed to another PC (net's movepcrun.ts): its turns and queue wait. */
  moving?(chatId: number): boolean;
  /** A message sent to a moving chat is kept by the host, which sends it where the chat ends up; true when kept. */
  hold?(chatId: number, text: string, files: string[], mentions: Mention[]): boolean;
  /** Where a chat pinned to a device runs (net's remote.rs); throws the chat's error. */
  remoteSpec?(chat: Chat, account: Account): RemoteSpec | null;
  /** Whose context a turn runs with (net's meshctx.rs). */
  turnContext?(chat: Chat, remote: boolean): agent.Context;
  /** A message reached the chat: from another PC (`from`) its turns run with that PCs context, typed here they run with this PCs again (meshctx.rs `ctx_adopt`). */
  adopt?(chatId: number, from: SentBy | null): void;
  /** Slash commands expanded for agents that don't expand them, tags and images (ui's slash.rs). */
  slashPrompt?(chatId: number, text: string, files: readonly string[]): string;
  /** Mentioned messages quoted before the user's text (ui's mentions.rs). */
  mentionsPrompt?(mentions: readonly Mention[]): string;
  /** This PC's name, for "[The user sent this from …]". */
  hostname?(): string;
  /** A reply's shown files are copied aside, so they outlive a cleaned-up /tmp (media.rs `keep`); `cwd`: where its relative paths start. */
  keepMedia?(text: string, cwd: string): void;
  /** A reply as its chat keeps it: the images and videos it draws from files here copied into the chat's uploads by their contents, and named there (media.ts `adopt`). */
  adoptMedia?(text: string, cwd: string, chatId: number): string;
  /** A finished turn worth a notification (net's notify.rs). */
  noteTurn?(chatId: number, sub: boolean, failed: boolean, said: string): void;
  /** The chat is on screen with the window focused. */
  visible?(chatId: number): boolean;
  /** `harbor://chat/<gid>?pc=<PC>` (net's chatlink.ts `chatLink`). */
  chatLink?(chat: Chat): string;
  /** Where /hooks is reachable from outside (Harbor's own HTTPS, else Tailscale Funnel), ending in /hooks; null: only this PC. */
  hookBase?(): string | null;
  /** A chat waits for its account's usage limit, or continues after it (net's notify.rs). */
  noteLimit?(chatId: number, account: string, waits: boolean, note: string): void;
  noteResumed?(chatId: number, account: string, text: string): void;
  /** A desktop notification about a usage cap or its warning. */
  /** `chat`: the chat it's about (its gid), which the notification opens. */
  notify?(kind: string, key: string, title: string, body: string, chat?: string): void;
  /** After a turn's end, for limits, recaps, pull requests and git status. */
  turnEnded?(chatId: number, stopped: boolean): void;
  /** The overlay profiles of chats commanded from other PCs, where a session may have been written (net's meshctx.rs). */
  overlays?(): string[];
  /** A chat changed project: its remembered workspace grants go (mcp's workspace.rs). */
  forgetWorkspace?(chatId: number): void;
  /** The PC whose person runs a chat ("" for this PC's own), for who may see and message whom (net's meshctx.rs). */
  commander?(chat: Chat): string;
  homeName?(chat: Chat): string;
  /** `open_chat` on another PC (`machine`), through the mesh. */
  openElsewhere?(me: Chat, machine: string, args: unknown): Promise<string>;
  /** Why a chat's project folder isn't on this PC (null: it is, or the chat has none); say it in the transcript. */
  missingFolder?(chat: Chat): string | null;
  /** A turn is about to start without its project's folder: true when the turn waits for a clone of it (clone.rs `clone_for_turn`). */
  holdForClone?(chat: Chat, prompt: string, files: readonly string[]): boolean;
  /** Text in the chat's composer (recaps wait while there is some). */
  draft?(chatId: number): string;
  /** An undone message goes back to the chat's composer (ui), with its attachments and mentions. */
  restoreDraft?(chatId: number, text: string, files: string[], mentions: Mention[]): void;
  /** Tools other packages answer (secrets, chats across PCs, open_chat); undefined: not theirs. */
  tool?(chat: Chat, name: string, args: unknown): Promise<string> | undefined;
  /** Running on a copy of someone's data (ts/run.sh): only a message the person sends starts a turn. No timer,
   *  usage-limit wait, recap or turn left running by the copy's Harbor acts on its own. */
  offline?: boolean;
}

/** A chat's transcript while it's loaded, with the parts of a turn still streaming. */
export interface Transcript {
  items: Item[];
  pendingText: number | null;
  pendingThinking: number | null;
  mcp: [string, string][];
  stderr: string[];
  gotResult: boolean;
}

/** What undoing a sent message restores (undo.rs). */
interface Started {
  item: number;
  at: number;
  text: string;
  files: string[];
  mentions: Mention[];
  /** The turn it started, to tell it from later turns. */
  turn: Running | null;
  /** Queued prompts that went into this turn ahead of the message. */
  consumed: string[];
  sessionId: string;
  wasStarted: boolean;
  /** The Claude session file and its length before the turn (null inside: not there yet); null: not a Claude turn. */
  jsonl: [string | null, number | null] | null;
}

/** Thinking alone still counts as "nothing yet" for this long. */
const UNDO_GRACE_MS = 5000;

/** Tool inputs and outputs beyond this keep their start and end. */
export const TOOL_TEXT_MAX = 64 * 1024;

/** What Claude sends once its request is out (a steer written before that can reach the agent twice). */
const QUERYING = new Set<Event["type"]>(["querying", "textDelta", "thinkingDelta", "textFinal", "thinkingFinal", "tool", "userEcho"]);

interface Running {
  /** Null while its runner starts. */
  turn: Turn | null;
  /** Unix ms the turn started (a picked-up one: when it really started). */
  at: number;
  /** Claude's request is out, so a steer written now cuts into it. Off while Claude still takes in a
   *  prompt (its start, a follow-up after a result): a steer written then reaches the agent twice,
   *  into the turn and again as the next one (Claude Code 2.1.316). */
  querying?: boolean;
  /** Steers and follow-ups this process took in, by text: Claude can echo one twice. */
  took?: string[];
}

/** What became of another agent's message (`Engine.deliver`). "later": a usage limit or a move to another PC; `restart`: Codex
 *  takes a steer by restarting its turn; `at` counts from 1 (next); `steer`: why a steer asked for didn't happen. */
export type Delivery =
  | { how: "started" }
  | { how: "waiting"; why: "slots" | "paused" | "later" }
  | { how: "steered"; restart: boolean }
  | { how: "queued"; id: number; at: number; steer: "unsupported" | "missed" | null };

export class Engine {
  chats: Chat[] = [];
  repos: Repo[] = [];
  readonly transcripts = new Map<number, Transcript>();
  readonly turns = new Map<number, Running>();
  /** Prompts waiting for a chat's turn to end (Rust's `pending`). */
  readonly pending = new Map<number, string[]>();
  readonly queue = new QueueState();
  /** Chats whose turn a restart cut off: they continue once the replay ends. */
  readonly cutOff = new Set<number>();
  readonly unread = new Set<number>();
  readonly failed = new Set<number>();
  /** Per project (0: none), when its last automatic turns started. */
  readonly autoTurns = new Map<number, number[]>();
  /** Projects whose automatic turns are paused until the user writes. */
  readonly paused = new Set<number>();
  procs: procs.Proc[] = [];
  /** Ended processes' last output, for process_logs: lead, name, how it ended, output. */
  readonly endedProcs: [number, string, string, string][] = [];
  timers: Timer[] = [];
  webhooks: Webhook[] = [];
  /** Turns stopped to restart them (a Codex steer): their exit is dropped. */
  private readonly swallow = new Set<Running>();
  /** Fast mode for every turn (Claude's fastMode, Codex's priority tier): kv `fast_mode`, as the composer sets it. */
  get fast(): boolean {
    return this.store.get("fast_mode") === "1";
  }

  set fast(on: boolean) {
    this.store.set("fast_mode", on ? "1" : "0");
  }
  /** Per chat, the message that started its running turn. */
  private readonly undoStarted = new Map<number, Started>();
  /** Chats whose undone turn hasn't reported its exit yet: their events are dropped. */
  private readonly undoSwallow = new Set<number>();
  /** The port control.rs's webhook listener got (47920 or one of the next nine). */
  hookPort = 47920;

  readonly recaps: Recaps;
  /** Usage limits and caps: blocked accounts, chats waiting for a reset (kv `limits`). */
  readonly limits: limits.Limits;

  constructor(readonly host: EngineHost) {
    this.reload();
    const info = (a: Account): limits.AccountInfo => ({ id: a.id, kind: a.kind.toLowerCase(), name: a.name, short: short(a), loggedIn: a.loggedIn, configDir: a.configDir, usage: a.usage, usageAt: a.usageAt ?? null, plan: a.plan, off: a.off === true });
    this.limits = new limits.Limits({
      store: host.store,
      chat: (id) => this.chat(id),
      chats: () => this.chats,
      account: (id) => {
        const a = this.account(id);
        return a ? info(a) : undefined;
      },
      accounts: () => host.accounts().map(info),
      pending: this.pending,
      turnRunning: (id) => this.turns.has(id),
      runningSubs: (lead) => this.runningSubs(lead).length,
      startTurn: (id, prompt) => this.startTurn(id, prompt),
      notice: (id, icon, text, detail) => this.notice(id, icon, text, detail),
      noteLimit: (id, account, waits, note) => host.noteLimit?.(id, account, waits, note),
      noteResumed: (id, account, text) => host.noteResumed?.(id, account, text),
      notify: (kind, key, title, body) => host.notify?.(kind, key, title, body),
      persist: (id) => this.persist(id),
      setAccount: (id, account) => {
        const c = this.chat(id);
        if (c) {
          c.account = account;
          this.store.saveChat(c);
        }
      },
      sessionFile: (configDir, sid) => sessionCopies(configDir, sid)[0] ?? null,
    });
    this.recaps = new Recaps({
      store: host.store,
      chat: (id) => this.chat(id),
      items: (id) => this.transcript(id).items,
      running: (id) => this.turns.has(id),
      subsRunning: (id) => this.runningSubs(id).length > 0,
      asker: (id) => {
        const c = this.chat(id);
        const a = c ? this.account(c.account) : undefined;
        // Not at (or near) a usage limit.
        if (!a || a.kind !== "Claude" || this.limits.blocked(a.id) || this.limits.paused.has(id)) return null;
        if ((this.limits.quota.get(a.id) ?? []).some(([, used]) => used >= 0.9)) return null;
        return { bin: binStr(a), env: accountEnv(a) };
      },
      watched: (id) => this.host.visible?.(id) ?? false,
      draft: (id) => this.host.draft?.(id) ?? "",
      changed: (id) => this.changed(id),
    });
  }

  /** An account as limit notices name it: a Claude account by its own name, others by provider. */
  accountLabel(id: string): string {
    const a = this.account(id);
    return a ? limits.accountName({ id: a.id, kind: a.kind.toLowerCase(), name: a.name, short: short(a), loggedIn: a.loggedIn, configDir: a.configDir, usage: a.usage }) : id;
  }

  /** The app's tick: queued messages to idle chats, due wake-ups, recaps. Returns ms until something is due (null: nothing). */
  tick(): number | null {
    this.queueDrain();
    if (this.host.offline) return null;
    const timers = this.fireTimers();
    const recap = this.recaps.tick();
    const waits = this.limits.fireLimitTimers();
    const due = [timers, recap, waits === null ? null : waits * 1000].filter((x): x is number => x !== null);
    return due.length === 0 ? null : Math.min(...due);
  }

  get store(): Store {
    return this.host.store;
  }

  reload(): void {
    this.chats = this.store.chats();
    this.repos = this.store.repos();
    this.timers = this.store.timers();
    this.webhooks = this.store.webhooks();
  }

  chat(id: number): Chat | undefined {
    return this.chats.find((c) => c.id === id);
  }

  /** The store changed under the engine (copies from other PCs): a chat's items (its id) or the chats (null). */
  storeChanged(id: number | null): void {
    if (id === null) this.reload();
    else if (!this.turns.has(id)) this.transcripts.delete(id);
    this.changed(id);
  }

  repo(id: number | null): Repo | undefined {
    return id === null ? undefined : this.repos.find((r) => r.id === id);
  }

  account(id: string): Account | undefined {
    return this.host.accounts().find((a) => a.id === id);
  }

  /** The Claude accounts' usage windows for the read-out, the usage monitor's file read now: until then an
   *  account's `usage` is as old as the last read. */
  usageReadings(): usageCtl.Reading[] {
    this.host.rediscover?.();
    const accounts = this.host.accounts();
    applyUsage(accounts);
    return this.limits.ctl.readings(accounts.map((a) => ({ id: a.id, kind: a.kind, short: short(a), email: a.email, plan: a.plan, installed: installed(a), loggedIn: a.loggedIn })));
  }

  private foreign(id: number): boolean {
    return this.host.isForeign?.(id) ?? (this.chat(id)?.home ?? "") !== "";
  }

  changed(id: number | null): void {
    this.host.changed(id);
  }

  transcript(id: number): Transcript {
    let t = this.transcripts.get(id);
    if (!t) {
      t = { items: this.store.items(id), pendingText: null, pendingThinking: null, mcp: [], stderr: [], gotResult: false };
      this.transcripts.set(id, t);
    }
    return t;
  }

  itemsOf(id: number): Item[] {
    return this.transcripts.get(id)?.items ?? this.store.items(id);
  }

  /** The transcript held in memory (open or streaming), which can be ahead of the saved one; null: none. */
  liveItems(id: number): Item[] | null {
    return this.transcripts.get(id)?.items ?? null;
  }

  release(id: number): void {
    if (!this.turns.has(id) && !this.pending.has(id)) this.transcripts.delete(id);
  }

  persist(id: number): void {
    const c = this.chat(id);
    if (c) this.store.saveChat(c);
    const t = this.transcripts.get(id);
    if (t) this.store.saveItems(id, t.items);
    this.changed(id);
  }

  notice(id: number, icon: string, text: string, detail = ""): void {
    this.transcript(id).items.push({ kind: "notice", icon, text, detail });
    this.persist(id);
  }

  /** Something the lead's agents are told at the start of their next turn: its worktree's branch or folder changed under them. */
  noteWorktree(lead: number, text: string): void {
    for (const id of [lead, ...this.subsOf(lead).map((s) => s.id)]) {
      const k = `worktree_note:${id}`;
      const old = this.store.get(k) ?? "";
      this.store.set(k, old === "" ? text : `${old}\n${text}`);
    }
  }

  /** What goes before a turn's prompt about its worktree having changed ("" if nothing); a slash command's turn leaves it for the next one. */
  takeNote(id: number, prompt: string): string {
    if (prompt.startsWith("/")) return "";
    const k = `worktree_note:${id}`;
    const n = this.store.get(k) ?? "";
    if (n === "") return n;
    this.store.set(k, "");
    return `[Harbor: ${n}]\n\n`;
  }

  /** The worktree a chat runs in (sub-agents: their lead's), if any. */
  worktreeOf(c: Chat): string | null {
    const id = c.role === "sub" ? c.parent : c.id;
    if (id === null) return null;
    const p = this.store.get(`worktree:${id}`);
    return p === null || p === "" ? null : p;
  }

  cwdOf(repo: number | null): string {
    const r = this.repo(repo);
    return r ? (r.local ?? r.path) : home();
  }

  /** Where a chat's agent works: its worktree, else its project (or home). */
  chatCwd(c: Chat): string {
    return this.worktreeOf(c) ?? this.cwdOf(c.repoId);
  }

  /** The user trusts the project's own agent config (off for a cloned project until they say so). */
  trusted(repo: number | null): boolean {
    const r = this.repo(repo);
    return !r || this.store.get(`untrusted:${r.local ?? r.path}`) !== "1";
  }

  /** A turn on this PC: one this Harbor can stop, steer or wait for. A copy's turn is `live`. */
  running(id: number): boolean {
    return this.turns.has(id);
  }

  runningSince(id: number): number | null {
    return this.turns.get(id)?.at ?? null;
  }

  /** The chat's turn wherever it runs: this PC's, or a copy's at its home PC. For what's shown. */
  liveSince(id: number): number | null {
    return liveSince(this.runningSince(id), this.foreign(id) ? this.host.copyTurn?.(id) : null);
  }

  live(id: number): boolean {
    return this.liveSince(id) !== null;
  }

  /** Turns running on this PC and copies' turns running at their home PCs. */
  liveCount(): number {
    return this.turns.size + this.chats.filter((c) => !this.turns.has(c.id) && this.foreign(c.id) && this.live(c.id)).length;
  }

  /** When the chat's or one of its subagents' turns started (wherever they run), the earliest; null while none runs. */
  teamStarted(id: number): number | null {
    const at = this.chats.filter((c) => c.id === id || (c.role === "sub" && c.parent === id)).flatMap((c) => this.liveSince(c.id) ?? []);
    return at.length === 0 ? null : Math.min(...at);
  }

  /** What the chat waits on once its own turn is done (waiting.ts): its processes, subagents, wake-ups, keys asked;
   *  null for nothing. `asks`: the secret cards (kv `secret_asks`), when the caller read them already for a list. */
  waiting(id: number, asks: readonly { chat: number }[] = secrets.loadAsks(this.store)): Waiting | null {
    // Another PC's chat: its processes and wake-ups are there; its home PC says what it waits on.
    if (this.foreign(id)) {
      const st = this.host.copyTurn?.(id)?.status;
      return st !== null && typeof st === "object" ? waitFromJson((st as { wait?: unknown }).wait) : null;
    }
    return waitingOf(this, id, asks);
  }

  subsOf(lead: number): Chat[] {
    return this.allSubsOf(lead).filter((c) => !c.retired);
  }

  allSubsOf(lead: number): Chat[] {
    return this.chats.filter((c) => c.role === "sub" && c.parent === lead).sort((a, b) => a.id - b.id);
  }

  leadFor(c: Chat): number | null {
    return c.role === "lead" ? c.id : c.role === "sub" ? c.parent : null;
  }

  /** "lead" or a teammate's name within the chat's team. */
  resolve(from: Chat, name: string): Chat | undefined {
    const lead = this.leadFor(from);
    if (lead === null) return undefined;
    if (["lead", "main"].includes(name.toLowerCase())) return this.chat(lead);
    return this.subsOf(lead).find((c) => c.name.toLowerCase() === name.toLowerCase());
  }

  teamFor(c: Chat): agent.Team | null {
    const r = this.repo(c.repoId);
    const name = r ? r.name : "No project";
    const path = r ? (r.local ?? r.path) : home();
    if (c.role === "lead") return { role: "lead", system: prompts.now.leadPrompt(name, path) };
    if (c.role === "sub") {
      const mates = c.parent === null ? [] : this.subsOf(c.parent).filter((x) => x.id !== c.id).map((x) => x.name);
      return { role: "sub", system: prompts.now.subPrompt(c.name, name, path, mates) };
    }
    return null;
  }

    /** Starts one agent turn for a chat (user message, report, wake-up, webhook…). */
  startTurn(id: number, prompt: string, files: string[] = []): void {
    if (this.foreign(id) || this.chat(id)?.retired) return;
    // One turn per chat. A runner still going for it, even one this Harbor lost track of, holds
    // the session: the prompt waits for that turn instead.
    if (this.turns.has(id) || (this.host.moving?.(id) ?? false) || this.adoptRunner(id)) {
      let p = prompt;
      for (const f of files) p += `\n(attached: ${f})`;
      this.pushPending(id, p);
      this.persist(id);
      return;
    }
    if (this.limits.limitGuard(id, prompt, files)) return;
    prompt = this.takeNote(id, prompt) + prompt;
    const chat = this.chat(id);
    if (!chat) return;
    const account = this.account(chat.account);
    if (!account) {
      if (knownAccount(chat.account)) return;
      // A chat on a provider Harbor dropped (Cursor, Gemini, …) says so instead of doing nothing.
      const tr = this.transcript(id);
      tr.items.push({ kind: "error", text: `Harbor no longer runs ${chat.account}: switch this chat to a Claude, Codex or OpenCode account.` });
      this.persist(id);
      return;
    }
    // Another provider than the session's: a fresh session, the conversation so far before the prompt.
    if (this.handOver(id)) prompt = this.takeForkPreamble(id) + prompt;
    this.store.set(sessionKindKey(id), account.kind);
    const tr = this.transcript(id);
    let remote: RemoteSpec | null = null;
    try {
      remote = this.host.remoteSpec?.(chat, account) ?? null;
    } catch (e) {
      tr.items.push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      this.persist(id);
      return;
    }
    const missing = (): string | null => this.host.missingFolder?.(chat) ?? (!existsSync(this.chatCwd(chat)) ? `The project folder ${this.chatCwd(chat)} isn't on this PC.` : null);
    if ((!remote || remote.workspace) && missing() !== null) {
      if (this.host.holdForClone?.(chat, prompt, files)) {
        this.persist(id);
        return;
      }
      const why = missing();
      if (why !== null) {
        tr.items.push({ kind: "error", text: why });
        this.persist(id);
        return;
      }
    }
    const cwd = this.chatCwd(chat);
    const context = this.host.turnContext?.(chat, remote !== null) ?? agent.ownContext();
    // Claude resumes sessions of its folder only: a moved chat's is brought over.
    if (!remote && account.kind === "Claude" && chat.started && chat.sessionId !== "") {
      const also = [...(this.host.overlays?.() ?? []), account.configDir ?? `${home()}/.claude`];
      try {
        ensureSessionIn(context.overlay ?? account.configDir, also, chat.sessionId, cwd);
      } catch {
        // without the copy Claude starts the session fresh, as the Rust app does
      }
    }
    const spec: agent.TurnSpec = {
      chatId: id,
      cwd,
      prompt,
      files,
      sessionId: chat.sessionId,
      resume: chat.started && chat.sessionId !== "",
      account,
      model: chat.model,
      effort: chat.effort,
      access: chat.access,
      team: this.teamFor(chat),
      fast: this.fast,
      base: tr.items.length,
      remote,
      trusted: this.trusted(chat.repoId),
      context,
    };
    tr.gotResult = false;
    tr.stderr = [];
    tr.pendingText = null;
    tr.pendingThinking = null;
    chat.updated = now();
    // Held from now, so a second prompt meanwhile waits for this turn.
    const run: Running = { turn: null, at: Date.now() };
    this.turns.set(id, run);
    this.persist(id);
    agent.start(spec, (cid, ev) => this.onEvent(cid, ev, run), () => {}).then(
      (turn) => {
        run.turn = turn;
        // Stopped while it started.
        if (this.turns.get(id) !== run) turn.stop();
        this.changed(id);
      },
      (e: unknown) => {
        if (this.turns.get(id) === run) this.turns.delete(id);
        tr.items.push({ kind: "error", text: `Could not start the agent: ${e instanceof Error ? e.message : String(e)}` });
        this.persist(id);
        this.afterTurn(id, false);
      },
    );
  }

  pushPending(id: number, p: string): void {
    const q = this.pending.get(id);
    if (q) q.push(p);
    else this.pending.set(id, [p]);
  }

  /** The turn of `id` once its runner is up (a just-started one is still coming). */
  turnOf(id: number): Turn | null {
    return this.turns.get(id)?.turn ?? null;
  }

  stop(id: number): void {
    const r = this.turns.get(id);
    if (!r) return;
    this.turns.delete(id);
    // Its queue waits for Resume (or the next message), in order.
    this.queueStopped(id);
    r.turn?.stop();
    this.transcript(id).items.push({ kind: "error", text: "Stopped." });
    this.persist(id);
  }

  onEvent(id: number, ev: Event, from: Running): void {
    if (this.undoSwallow.has(id)) {
      if (ev.type === "exited") this.undoSwallow.delete(id);
      return;
    }
    if (ev.type === "exited" && this.swallow.delete(from)) return;
    // A stopped turn's end that came after the chat's next turn started: that one goes on.
    const current = this.turns.get(id);
    if (ev.type === "exited" && current !== undefined && current !== from) return;
    if (this.queueEvent(id, ev, from) || this.limits.limitEvent(id, limitEvent(ev))) return;
    const exited = ev.type === "exited" ? !this.turns.has(id) : null;
    this.applyEvent(id, ev);
    if (exited !== null) {
      this.queueExited(id, exited);
      this.limits.limitExited(id);
      this.host.turnEnded?.(id, exited);
      this.restartExited(id);
      this.recaps.exited(id, exited);
    }
  }

  /** A chat on another device keeps its files there. */
  private keepMedia(chat: Chat | undefined, text: string): string {
    if (!chat || chat.device !== "") return text;
    const cwd = this.chatCwd(chat);
    let kept = text;
    try {
      kept = this.host.adoptMedia?.(text, cwd, chat.id) ?? text;
    } catch {
      // As written: the kept copy below still serves it.
    }
    this.host.keepMedia?.(kept, cwd);
    return kept;
  }

  private applyEvent(id: number, ev: Event): void {
    const chat = this.chat(id);
    const tr = this.transcript(id);
    const startedAt = this.runningSince(id);
    const resumes = ev.type === "exited" && this.resumes(id);
    switch (ev.type) {
      case "session":
        if (chat && ev.id !== "" && (!chat.started || chat.sessionId !== ev.id)) {
          chat.sessionId = ev.id;
          chat.started = true;
          this.store.saveChat(chat);
        }
        break;
      case "mcp": {
        tr.mcp = ev.servers;
        const text = mcpFailNotice(ev.servers);
        // Once a turn: a turn picked up again replays its output.
        if (text !== null && !noticedThisTurn(tr.items, text)) tr.items.push({ kind: "notice", icon: "alert", text, detail: MCP_FAIL_DETAIL });
        break;
      }
      case "textDelta": {
        const it = tr.pendingText === null ? undefined : tr.items[tr.pendingText];
        if (it?.kind === "text") it.text += ev.text;
        else {
          tr.items.push({ kind: "text", text: ev.text, at: now() });
          tr.pendingText = tr.items.length - 1;
        }
        break;
      }
      case "textFinal": {
        const text = this.keepMedia(chat, ev.text);
        const i = tr.pendingText;
        tr.pendingText = null;
        const it = i === null ? undefined : tr.items[i];
        if (it?.kind === "text") it.text = text;
        else if (text.trim() !== "") tr.items.push({ kind: "text", text, at: now() });
        break;
      }
      case "thinkingDelta": {
        const it = tr.pendingThinking === null ? undefined : tr.items[tr.pendingThinking];
        if (it?.kind === "thinking") it.text += ev.text;
        else {
          tr.items.push({ kind: "thinking", text: ev.text });
          tr.pendingThinking = tr.items.length - 1;
        }
        break;
      }
      case "thinkingFinal": {
        const i = tr.pendingThinking;
        tr.pendingThinking = null;
        const it = i === null ? undefined : tr.items[i];
        if (it?.kind === "thinking" && ev.text !== null) it.text = ev.text;
        else if (it === undefined && ev.text !== null && ev.text.trim() !== "") tr.items.push({ kind: "thinking", text: ev.text });
        break;
      }
      case "tool": {
        const input = team.clipMiddle(ev.input, TOOL_TEXT_MAX);
        const result = ev.result === null ? null : team.clipMiddle(ev.result, TOOL_TEXT_MAX);
        let existing: Extract<Item, { kind: "tool" }> | undefined;
        for (let i = tr.items.length - 1; i >= 0; i--) {
          const it = tr.items[i];
          if (it?.kind === "tool" && it.id === ev.id) {
            existing = it;
            break;
          }
        }
        if (existing) {
          if (ev.name !== "") existing.name = ev.name;
          if (ev.summary !== "") existing.summary = ev.summary;
          if (input !== "") existing.input = input;
          if (result !== null) {
            existing.result = result;
            existing.is_error = ev.isError;
          }
        } else tr.items.push({ kind: "tool", id: ev.id, name: ev.name, summary: ev.summary, input, result, is_error: ev.isError });
        tr.pendingText = null;
        break;
      }
      case "result":
        tr.gotResult = true;
        tr.items.push({
          kind: "result",
          cost_usd: ev.costUsd ?? 0,
          duration_ms: ev.durationMs === 0 && startedAt !== null ? Date.now() - startedAt : ev.durationMs,
          turns: ev.turns,
          input_tokens: ev.inputTokens,
          output_tokens: ev.outputTokens,
          cached: ev.cached,
          at: now(),
          account: chat?.account ?? "",
          model: chat?.model ?? "",
        });
        break;
      case "error":
        if (ev.text.trim() !== "") tr.items.push({ kind: "error", text: ev.text });
        break;
      case "stderr":
        tr.stderr.push(ev.text);
        if (tr.stderr.length > 40) tr.stderr.shift();
        break;
      case "compact": {
        // One notice per turn and side: start's becomes done's, and a turn replayed after a restart finds its own.
        const side = ev.state === "claude" ? "claude" : "harbor";
        let it: Extract<Item, { kind: "notice" }> | undefined;
        for (let i = tr.items.length - 1; i >= 0; i--) {
          const x = tr.items[i];
          if (x?.kind === "user") break;
          if (x?.kind === "notice" && compaction.compactNotice(x.text) === side) {
            it = x;
            break;
          }
        }
        const text = ev.state === "start" ? compaction.compactingText(ev.before) : ev.state === "done" ? compaction.compactedText(ev) : compaction.claudeCompactedText(ev.before, ev.after);
        const icon = ev.state === "start" ? "clock" : ev.ok ? "compact" : "alert";
        const detail = ev.state === "start" ? "" : ev.state === "done" && !ev.ok ? "The turn goes on with the whole session." : compaction.COMPACT_DETAIL;
        if (it) Object.assign(it, { icon, text, detail });
        else tr.items.push({ kind: "notice", icon, text, detail });
        tr.pendingText = null;
        this.persist(id);
        break;
      }
      case "userEcho":
      case "limit":
      case "quota":
        break;
      case "exited": {
        // The turn's replies, for an agent that only streams them (unchanged files are skipped).
        let from = 0;
        for (let i = tr.items.length - 1; i >= 0; i--) {
          if (tr.items[i]?.kind === "user") {
            from = i + 1;
            break;
          }
        }
        for (const it of tr.items.slice(from)) if (it.kind === "text") it.text = this.keepMedia(chat, it.text);
        const stopped = !this.turns.delete(id);
        const last = tr.items[tr.items.length - 1];
        const failed = !stopped && !resumes && (!tr.gotResult || last?.kind === "error");
        if (!tr.gotResult && !stopped && !resumes) {
          const tail = tr.stderr.join("\n");
          tr.items.push({ kind: "error", text: tail !== "" ? tail : ev.ok ? "The agent exited without a result." : "The agent exited with an error." });
        }
        tr.pendingText = null;
        tr.pendingThinking = null;
        let said = "";
        for (let i = tr.items.length - 1; i >= 0; i--) {
          const it = tr.items[i];
          if (it?.kind === "text") {
            said = it.text;
            break;
          }
        }
        const visible = this.host.visible?.(id) ?? false;
        // Subagents work behind the lead: only the lead notifies, once its subagents are done too.
        const sub = chat?.role === "sub";
        const teamBusy = !failed && this.teamStarted(id) !== null;
        if (!visible && !sub && !resumes && !teamBusy) {
          this.unread.add(id);
          if (failed) this.failed.add(id);
          else this.failed.delete(id);
        }
        if (!resumes && !stopped && (sub || !teamBusy)) this.host.noteTurn?.(id, sub, failed, said);
        if (chat) chat.updated = now();
        this.persist(id);
        this.afterTurn(id, stopped);
        return;
      }
    }
    this.changed(id);
  }

    /** Runs `prompt` as the chat's next turn now, or after the current one. `auto`: Harbor starts it on its own (rate limited). */
  trigger(id: number, prompt: string, auto: boolean): void {
    if (this.chat(id)?.retired) return;
    if (auto && !this.countAuto(id, prompt)) return;
    if (this.turns.has(id) || this.subsBusy(id)) this.pushPending(id, prompt);
    else this.startTurn(id, prompt);
  }

  /** Counts an automatic turn of the chat's project. Past the hourly limit they pause and `prompt` is held as pending instead: false. */
  private countAuto(id: number, prompt: string): boolean {
    const project = this.chat(id)?.repoId ?? 0;
    const t = Date.now();
    const q = (this.autoTurns.get(project) ?? []).filter((x) => t - x < 3600_000);
    this.autoTurns.set(project, q);
    if (q.length >= team.AUTO_TURNS_PER_HOUR) {
      if (!this.paused.has(project)) {
        this.paused.add(project);
        const lead = this.mainChat(project) ?? this.leadOf(project);
        if (lead !== null) this.notice(lead, "alert", "Automatic turns paused: more than 60 in the last hour. Send a message to resume.");
      }
      // Held for when the user resumes, up to a point: a flood mustn't grow it without end.
      if ((this.pending.get(id)?.length ?? 0) < team.MAX_PAUSED_PENDING) this.pushPending(id, prompt);
      return false;
    }
    q.push(t);
    return true;
  }

  /** A subagent whose teammates already run as many turns as a team may. */
  private subsBusy(id: number): boolean {
    const chat = this.chat(id);
    return chat?.role === "sub" && chat.parent !== null && this.subsOf(chat.parent).filter((s) => this.turns.has(s.id)).length >= team.MAX_RUNNING_SUBS;
  }

  /** From message_agent and message_chat: a steer is the user's steer; a queued message is also what the agent's
   *  read_messages takes. */
  deliver(id: number, text: string, by: FromAgent, mode: Mode = "queue"): Delivery {
    const prompt = `${by.tag}${text}`;
    if (!this.turns.has(id) || this.host.moving?.(id)) {
      this.transcript(id).items.push({ kind: "message", from: by.from, to: by.to, text });
      this.persist(id);
      this.trigger(id, prompt, true);
      if (this.turns.has(id)) return { how: "started" };
      return { how: "waiting", why: this.subsBusy(id) ? "slots" : this.paused.has(this.chat(id)?.repoId ?? 0) ? "paused" : "later" };
    }
    if (!this.countAuto(id, prompt)) {
      this.transcript(id).items.push({ kind: "message", from: by.from, to: by.to, text });
      this.persist(id);
      return { how: "waiting", why: "paused" };
    }
    const q: Queued = { id: this.queue.id(), text, files: [], mentions: [], written: false, sender: "", device: "", intent: "", note: "", editing: "", agent: by };
    const how = this.steering(id);
    if (mode === "steer" && how !== "no") {
      this.steer(id, q, STEER);
      if (steering(q)) return { how: "steered", restart: how === "restart" };
    } else {
      this.queue.list(id).push(q);
      this.changed(id);
    }
    const at = this.queued(id).filter((x) => !x.written && !steering(x)).indexOf(q) + 1;
    return { how: "queued", id: q.id, at, steer: mode === "steer" ? (how === "no" ? "unsupported" : "missed") : null };
  }

  /** read_messages: the other agents' messages waiting in the chat's queue, taken out as the agent reads them now. */
  takeMessages(id: number): string[] {
    const list = this.queue.chats.get(id) ?? [];
    const taken = list.filter((q) => q.agent && !q.written && !steering(q));
    if (taken.length === 0) return [];
    this.queue.chats.set(
      id,
      list.filter((q) => !taken.includes(q)),
    );
    this.queue.tidy(id);
    const tr = this.transcript(id);
    for (const q of taken) tr.items.push(queuedItem(q));
    tr.pendingText = null;
    tr.pendingThinking = null;
    this.persist(id);
    this.changed(id);
    return taken.map((q) => queuedPrompt(q, q.text, ""));
  }

  /** Takes back what chat `by`'s agent queued for `id`: one message by its queue id, or all. Steers and what is on its way
   *  in stay, unless `inFlight` (its turn is being stopped). Returns what was taken. */
  unqueue(id: number, by: number, qid: number | "all", inFlight = false): Queued[] {
    const list = this.queue.chats.get(id) ?? [];
    const gone = list.filter((q) => q.agent?.chat === by && (qid === "all" || q.id === qid) && (inFlight || (!q.written && !steering(q))));
    if (gone.length === 0) return [];
    this.queue.chats.set(
      id,
      list.filter((q) => !gone.includes(q)),
    );
    this.queue.tidy(id);
    this.changed(id);
    return gone;
  }

  /** The user wrote: automatic turns of the chat's project run again. */
  resumeAuto(id: number): void {
    this.paused.delete(this.chat(id)?.repoId ?? 0);
  }

  mainChat(repo: number): number | null {
    const id = this.store.mainChats().get(repo);
    const c = id === undefined ? undefined : this.chat(id);
    return c && c.repoId === repo && c.role === "lead" && !c.settled ? c.id : null;
  }

  leadOf(repo: number): number | null {
    let best: Chat | undefined;
    for (const c of this.chats) if (c.role === "lead" && c.repoId === repo && (!best || c.updated > best.updated)) best = c;
    return best?.id ?? null;
  }

  /** Called when a chat's turn ends (after the transcript is saved). */
  afterTurn(id: number, stopped: boolean): void {
    const chat = this.chat(id);
    if (!chat) return;
    // A sub-agent stopped by a usage limit hasn't finished: it continues after the reset.
    if (chat.role === "sub" && !stopped && !this.limits.hitLimit(id) && !this.resumes(id) && chat.parent !== null) {
      const report = this.lastReply(id);
      this.notice(chat.parent, "report", reportLine(chat.name, report), report);
      this.trigger(chat.parent, `[agent ${chat.name}] finished its turn. Its report:\n\n${report}`, true);
    }
    const q = this.pending.get(id);
    this.pending.delete(id);
    if (q && q.length > 0) this.startTurn(id, q.join("\n\n---\n\n"));
    // A finished subagent frees a slot for queued teammates.
    if (chat.role === "sub" && chat.parent !== null) {
      for (const s of this.subsOf(chat.parent)) {
        if (this.turns.has(s.id) || !(this.pending.get(s.id)?.length ?? 0)) continue;
        if (this.subsOf(chat.parent).filter((x) => this.turns.has(x.id)).length >= team.MAX_RUNNING_SUBS) break;
        const p = this.pending.get(s.id) ?? [];
        this.pending.delete(s.id);
        this.startTurn(s.id, p.join("\n\n---\n\n"));
      }
    }
  }

  lastReply(id: number): string {
    const items = this.transcripts.get(id)?.items ?? [];
    const out: string[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i] as Item;
      if (it.kind === "text") out.push(it.text);
      else if (it.kind === "error") out.push(`Error: ${it.text}`);
      else if (it.kind === "user" || it.kind === "notice" || it.kind === "message") break;
    }
    const s = out.reverse().join("\n\n");
    return s.trim() === "" ? "(no text reply)" : team.clip(s, 6000);
  }

    /** At startup: picks up the turns an earlier Harbor (Rust or TypeScript) left running or that ended while it was away. */
  reattachTurns(rootDir: string = detach.root()): void {
    if (this.host.offline) return;
    const left = detach.leftovers(rootDir);
    detach.followOrder(left);
    for (const [dir, meta] of left) {
      const id = meta.chat_id;
      const live = alive(meta);
      if (!this.chat(id) || this.turns.has(id)) {
        // Never pull a folder from under a runner that is still going.
        if (!live) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      // The runner died without an exit code (a reboot, a logout) and wasn't stopped.
      if (!existsSync(join(dir, "exit")) && !existsSync(join(dir, "stopped")) && !live) this.cutOff.add(id);
      this.pickUp(dir, meta);
    }
    // Runners still going whose folder vanished: recovered, not forgotten (a forgotten one would get a second turn on its session).
    for (const [id, dir, pid] of detach.runners(rootDir)) {
      if (this.turns.has(id) || !this.chat(id)) continue;
      const meta = detach.recover(dir, pid, id, userTimes(this.store.items(id)));
      this.notice(id, "alert", "Picked up a turn Harbor had lost track of");
      this.pickUp(dir, meta);
    }
  }

  /** The transcript goes back to where the turn began, keeping notices, messages and anything sent since, and the turn is replayed. */
  private pickUp(dir: string, meta: detach.Meta): void {
    const id = meta.chat_id;
    const items = this.store.items(id);
    const since = items.splice(Math.min(meta.base, items.length)).filter((it) => it.kind === "notice" || it.kind === "message" || (it.kind === "user" && it.at > meta.started));
    items.push(...since);
    this.transcripts.set(id, { items, pendingText: null, pendingThinking: null, mcp: [], stderr: [], gotResult: false });
    const run: Running = { turn: null, at: Math.min(Date.now(), meta.started * 1000) };
    this.turns.set(id, run);
    run.turn = agent.reattach(dir, meta, (cid, ev) => this.onEvent(cid, ev, run));
  }

  /** A runner of this chat the engine isn't following is taken back by its pid; true if one was found. */
  adoptRunner(id: number, rootDir: string = detach.root()): boolean {
    const r = detach.runners(rootDir).find((x) => x[0] === id);
    if (!r) return false;
    const [, dir, pid] = r;
    this.persist(id);
    let meta: detach.Meta | undefined;
    try {
      meta = detach.readMeta(readFileSync(join(dir, "meta.json"), "utf8"));
    } catch {
      // no meta.json: recovered from the process below
    }
    meta ??= detach.recover(dir, pid, id, userTimes(this.store.items(id)));
    this.notice(id, "alert", "A turn of this chat was still running: new messages wait for it");
    this.pickUp(dir, meta);
    return true;
  }

  /** A thread that was working when the computer restarted picks up where it stopped (always). */
  resumeOnRestart(): boolean {
    return true;
  }

  resumes(id: number): boolean {
    const c = this.chat(id);
    return this.cutOff.has(id) && this.resumeOnRestart() && c !== undefined && c.started && c.sessionId !== "";
  }

  /** After a cut-off turn's replay: continues the chat in its session (unless something else already did). */
  private restartExited(id: number): void {
    const go = this.resumes(id);
    if (!this.cutOff.delete(id) || !go || this.turns.has(id) || this.limits.paused.has(id)) return;
    this.notice(id, "restart", "The turn was cut off while Harbor was away · continuing");
    this.startTurn(id, detach.RESTARTED);
  }

    private said(id: number, text: string, files: readonly string[]): string {
    return this.host.slashPrompt?.(id, text, files) ?? text;
  }

  private mentions(ms: readonly Mention[]): string {
    return this.host.mentionsPrompt?.(ms) ?? "";
  }

  /** A new turn when the chat is idle (with what waited for it), else a follow-up that steers or queues per `mode` (Queue unless said). */
  send(id: number, text: string, opts: { files?: string[]; mentions?: Mention[]; mode?: Mode; sender?: string; device?: string; who?: string; via?: SentVia | undefined; dev?: string; from?: SentBy | null } = {}): void {
    const files = opts.files ?? [];
    const mentions = opts.mentions ?? [];
    const sender = opts.sender ?? "";
    const device = opts.device ?? "";
    if (this.host.hold?.(id, text, files, mentions)) {
      this.changed(id);
      return;
    }
    this.host.adopt?.(id, opts.from ?? null);
    this.resumeAuto(id);
    if (this.turns.has(id)) {
      const q: Queued = { id: this.queue.id(), text, files, mentions, written: false, sender, device, intent: "", note: "", editing: "" };
      if (sender !== "" && opts.who) q.who = opts.who;
      if (sender !== "" && opts.via) q.via = opts.via;
      if (sender !== "" && opts.dev) q.dev = opts.dev;
      if ((opts.mode ?? "queue") === "steer" && this.steering(id) !== "no") this.steer(id, q, STEER);
      else {
        this.queue.list(id).push(q);
        this.changed(id);
      }
      return;
    }
    // A message to an idle chat resumes a queue its Stop held: the queue follows it.
    this.queue.held.delete(id);
    // Switched to another provider since its last turn: the conversation goes with this message (taken below).
    this.handOver(id);
    const tr = this.transcript(id);
    const item = tr.items.length;
    // The previous message came from elsewhere: this one's place is said too.
    let back = false;
    for (let i = tr.items.length - 1; i >= 0; i--) {
      const it = tr.items[i] as Item;
      if (it.kind === "user") {
        back = it.sender !== "";
        break;
      }
    }
    const from = sentFrom(sender, device, back, this.host.hostname?.(), sender !== "" ? opts.via : undefined);
    const at = now();
    tr.items.push(withWho({ kind: "user", text, files: [...files], at, mentions, sender, intent: "" }, opts.who, opts.via, opts.dev));
    const quoted = `${from}${this.mentions(mentions)}`;
    // Anything queued for an idle chat goes first; a fork's context before all.
    const fork = this.takeForkPreamble(id);
    const queued = this.pending.get(id);
    this.pending.delete(id);
    const snap = this.undoSnapshot(id, item, at, text, files, mentions, queued ?? []);
    const said = this.said(id, text, files);
    let prompt: string;
    if (queued && queued.length > 0) prompt = `${fork}${queued.join("\n\n---\n\n")}\n\n---\n\n${quoted}${said}`;
    // A slash command only runs at the start: what goes with it follows.
    else if (said.startsWith("/") && !(fork === "" && quoted === "")) prompt = `${said}\n\n${fork}${quoted}`.trimEnd();
    else prompt = `${fork}${quoted}${said}`;
    this.startTurn(id, prompt, files);
    const run = this.turns.get(id);
    if (snap && run) this.undoStarted.set(id, { ...snap, turn: run });
    else this.undoStarted.delete(id);
  }

  /** What undoing the message must restore, taken before its turn starts. */
  private undoSnapshot(id: number, item: number, at: number, text: string, files: string[], mentions: Mention[], consumed: string[]): Started | null {
    const chat = this.chat(id);
    const acc = chat ? this.account(chat.account) : undefined;
    if (!chat || !acc) return null;
    let jsonl: [string | null, number | null] | null = null;
    if (acc.kind === "Claude") {
      // The copy the turn will write: a moved chat's is brought to its folder first.
      const resumes = chat.started && chat.sessionId !== "";
      if (resumes && chat.device === "") {
        try {
          ensureSession(acc.configDir, chat.sessionId, this.chatCwd(chat));
        } catch {
          // the turn then writes a new copy, which undo removes
        }
      }
      const path = resumes ? (sessionCopies(acc.configDir, chat.sessionId)[0] ?? null) : null;
      let len: number | null = null;
      if (path !== null) {
        try {
          len = statSync(path).size;
        } catch {
          // gone meanwhile: the turn makes it, and undo removes it
        }
      }
      jsonl = [path, len];
    }
    return { item, at, text, files, mentions, turn: null, consumed: [...consumed], sessionId: chat.sessionId, wasStarted: chat.started, jsonl };
  }

  /** Esc in a chat: undo the last send if nothing came of it yet, else stop (the queue is held then). */
  esc(id: number): void {
    if (!this.tryUndo(id)) this.stop(id);
  }

  stopAll(lead: number): void {
    for (const c of this.subsOf(lead)) {
      this.pending.delete(c.id);
      this.stop(c.id);
    }
    this.pending.delete(lead);
    this.stop(lead);
  }

  /** Undoes the last send if nothing came of it yet; false when there is none. Only Claude turns can be rewound. */
  tryUndo(id: number): boolean {
    // A steer on its way in would be left without its turn: it stops instead.
    if (this.queued(id).some((q) => q.written || steering(q))) return false;
    const s = this.undoStarted.get(id);
    const run = this.turns.get(id);
    const undoable = s !== undefined && run !== undefined && s.turn === run && s.jsonl !== null && this.nothingYet(id, s);
    this.undoStarted.delete(id);
    if (!undoable || !s) return false;
    void this.rewind(id, s);
    return true;
  }

  /** No reply text, no tool call, no result since the message; thinking only briefly. */
  private nothingYet(id: number, s: Started): boolean {
    const items = this.transcripts.get(id)?.items;
    const i = this.findUser(id, s);
    if (!items || i === null) return false;
    let thinking = false;
    for (const it of items.slice(i + 1)) {
      if (it.kind === "thinking") thinking = true;
      else if (it.kind === "text" || it.kind === "tool" || it.kind === "result" || it.kind === "error") return false;
    }
    return !thinking || Date.now() - (s.turn?.at ?? 0) < UNDO_GRACE_MS;
  }

  /** Where the message's item is now (indices shift when earlier items go). */
  private findUser(id: number, s: Started): number | null {
    const items = this.transcripts.get(id)?.items ?? [];
    const is = (it: Item | undefined): boolean => it?.kind === "user" && it.text === s.text && it.at === s.at;
    if (is(items[s.item])) return s.item;
    for (let i = items.length - 1; i >= 0; i--) if (is(items[i])) return i;
    return null;
  }

  private async rewind(id: number, s: Started): Promise<void> {
    const run = this.turns.get(id);
    if (!run) return;
    this.turns.delete(id);
    this.undoSwallow.add(id);
    await run.turn?.stopWait();
    const chat = this.chat(id);
    const config = chat ? (this.account(chat.account)?.configDir ?? null) : null;
    const [path, len] = s.jsonl ?? [null, null];
    if (path !== null && len !== null) {
      try {
        truncateSync(path, len);
      } catch {
        // the session keeps the message; the chat's started flag goes back anyway
      }
    } else if (s.jsonl !== null) {
      // The turn created the file (a new session, or a resumed one with no file yet).
      const p = sessionCopies(config, s.sessionId)[0];
      if (p !== undefined) {
        try {
          unlinkSync(p);
        } catch {
          // already gone
        }
      }
    }
    if (chat) {
      chat.sessionId = s.sessionId;
      chat.started = s.wasStarted;
    }
    const i = this.findUser(id, s);
    const tr = this.transcript(id);
    if (i !== null) {
      tr.items.splice(i, 1);
      for (let k = i; k < tr.items.length; ) {
        const it = tr.items[k];
        // The session went back to before the turn: a compaction it began with is undone too.
        if (it?.kind === "thinking" || (it?.kind === "notice" && compaction.compactNotice(it.text) === "harbor")) tr.items.splice(k, 1);
        else k++;
      }
      tr.pendingText = null;
      tr.pendingThinking = null;
      this.persist(id);
    }
    // The turn ended as a stop (frees a subagent slot); queued prompts it took wait again.
    const later = this.pending.get(id) ?? [];
    this.pending.delete(id);
    this.afterTurn(id, true);
    const q = [...s.consumed, ...later, ...(this.pending.get(id) ?? [])];
    this.pending.delete(id);
    if (q.length > 0) this.pending.set(id, q);
    this.host.restoreDraft?.(id, s.text, s.files, s.mentions);
    this.changed(id);
  }

  /** The forks made from `id`: the item they branch after, and the fork. */
  forksOf(id: number): [number, number][] {
    const v = (parseJson(this.store.get(forksKey(id)) ?? "") ?? []) as unknown;
    const list = Array.isArray(v) ? v.filter((x): x is [number, number] => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number") : [];
    return list.filter(([, f]) => this.chat(f) !== undefined);
  }

  /** "Fork from this response": a new thread with the conversation up to the end of reply `reply`'s turn; returns it. */
  forkFrom(id: number, reply: number): Chat | null {
    const src = this.chat(id);
    const all = this.transcript(id).items;
    const upto = forkable(all)[reply] ?? null;
    if (!src || upto === null) return null;
    const items = all.slice(0, upto + 1);
    const acc = this.account(src.account);
    const claude = acc?.kind === "Claude";
    const sessionId = claude ? newUuid() : "";
    let forked = false;
    if (claude && src.started) {
      const f = sessionCopies(acc?.configDir ?? null, src.sessionId)[0];
      if (f !== undefined) {
        try {
          forkJsonl(f, sessionId, items);
          forked = true;
        } catch {
          // the message isn't in the session: the fork gets the conversation as its first message's preamble
        }
      }
    }
    const title = src.role === "sub" && src.name !== "" ? `${src.name} · ${src.title}` : src.title;
    const chat = this.store.createChat({
      id: 0,
      repoId: src.repoId,
      title: `${[...title].slice(0, 60).join("")} fork`,
      sessionId,
      started: forked,
      account: src.account,
      model: src.model,
      effort: src.effort,
      access: src.access,
      settled: false,
      updated: now(),
      role: "lead",
      parent: null,
      name: "lead",
      device: src.device,
      gid: "",
      home: "",
      homeId: 0,
      retired: false,
    });
    this.chats.push(chat);
    if (!forked) {
      const context = team.clip(items.filter((i) => i.kind !== "thinking" && i.kind !== "result").map(team.renderItem).join("\n"), 40_000);
      this.store.set(preambleKey(chat.id), `This conversation is a fork of an earlier one. Here it is so far; continue from it with the user's next message.\n\n${context}\n\n---\n\n`);
    }
    // The divider links back to the reply; the copied items move down by one.
    const copy: Item[] = [
      { kind: "notice", icon: "fork", text: "Forked from conversation", detail: `harbor:chat/${id}/${reply}` },
      ...items.map((it): Item => (it.kind === "user" ? { ...it, mentions: it.mentions.map((m) => ({ ...m, item: m.item + 1 })) } : { ...it })),
    ];
    this.store.saveItems(chat.id, copy);
    const list = [...this.forksOf(id), [upto, chat.id] as [number, number]];
    this.store.set(forksKey(id), JSON.stringify(list));
    this.transcripts.set(chat.id, { items: copy, pendingText: null, pendingThinking: null, mcp: [], stderr: [], gotResult: false });
    this.changed(null);
    return chat;
  }

  /** The provider of a chat's session: the one its last turn ran on (chats from before this was kept: a lead's was
   *  Claude, the only provider a lead ran on; anything else's its account's). */
  sessionKind(c: Chat): Kind | undefined {
    const k = kindOf(this.store.get(sessionKindKey(c.id)) ?? "");
    if (k !== undefined) return k;
    return c.role === "lead" ? "Claude" : this.account(c.account)?.kind;
  }

  /** A started chat switched to another provider can't resume its session there: it starts a fresh one, with the
   *  conversation so far as its first message's preamble (as a fork's). True when it did. `moved`: the chat came from
   *  another PC on one of this PC's accounts without a session it can go on with ("Codex on desk"): always. */
  handOver(id: number, moved?: string): boolean {
    const c = this.chat(id);
    const to = c ? this.account(c.account)?.kind : undefined;
    if (!c || to === undefined || !c.started || c.sessionId === "") return false;
    const from = moved ?? this.sessionKind(c);
    if (from === undefined || (moved === undefined && from === to)) return false;
    const items = this.transcript(id).items.filter((i) => i.kind !== "thinking" && i.kind !== "result" && i.kind !== "notice");
    const context = team.clip(items.map(team.renderItem).join("\n"), 40_000);
    if (context.trim() !== "") this.store.set(preambleKey(id), `This conversation started on ${from} and continues with you (${to}). Here it is so far; continue from it with the user's next message.\n\n${context}\n\n---\n\n`);
    c.started = false;
    c.sessionId = to === "Claude" ? newUuid() : "";
    this.store.set(sessionKindKey(id), to);
    this.store.saveChat(c);
    this.transcript(id).items.push({ kind: "notice", icon: "restart", text: `Continues on ${to}: a new session, with the conversation so far`, detail: "" });
    this.persist(id);
    return true;
  }

  /** A fork's preamble for its first message (once), or "". */
  takeForkPreamble(id: number): string {
    const k = preambleKey(id);
    const p = this.store.get(k) ?? "";
    if (p !== "") this.store.set(k, "");
    return p;
  }

  /** What Enter does while the agent works: always Steer (Ctrl+Enter queues one message). */
  followDefault(): Mode {
    return "steer";
  }

  steering(id: number): agent.Steering {
    return this.turnOf(id)?.steering() ?? "no";
  }

  queued(id: number): readonly Queued[] {
    return this.queue.queued(id);
  }

  /** Steers the running turn with `q`, with the fallbacks that never lose a message. */
  private steer(id: number, q: Queued, intent: Intent): void {
    q.intent = intent;
    q.note = "";
    q.editing = "";
    const how = this.steering(id);
    if (how === "no" && !this.turns.has(id)) {
      // Not running any more: a plain new turn (that resumes a held queue, too).
      q.intent = "";
      this.queue.held.delete(id);
      this.sendQueued(id, [q]);
    } else if (how === "no") {
      // Can't be steered, or its input just closed: it goes next.
      q.intent = "";
      this.insertNext(id, q);
    } else if (how === "active" && !this.turns.get(id)?.querying) {
      // Claude is still taking in the prompt: the steer waits for its request (steerHeld), or goes next.
      this.insertNext(id, q);
    } else if (how === "active") {
      if (this.writeSteer(id, q)) this.queue.list(id).push(q);
      else this.insertNext(id, q);
    } else {
      // Codex: stopped and waited for, so the resumed session is settled; its exit is dropped.
      const r = this.turns.get(id);
      this.turns.delete(id);
      if (r) this.swallow.add(r);
      if (r?.turn) {
        void r.turn.stopWait().then(() => {
          const tr = this.transcript(id);
          tr.items.push({ kind: "error", text: "Interrupted by a steer." });
          tr.pendingText = null;
          tr.pendingThinking = null;
          this.sendQueued(id, [q]);
        });
        return;
      }
      this.sendQueued(id, [q]);
    }
    this.changed(id);
  }

  /** Writes steer `q` into the running Claude turn; one that can't be written goes next, said so. */
  private writeSteer(id: number, q: Queued): boolean {
    const wrote = this.turnOf(id)?.writeNow(queuedPrompt(q, this.said(id, q.text, q.files), this.mentions(q.mentions)), q.files) ?? false;
    if (wrote) q.written = true;
    else {
      q.intent = "";
      q.note = NOT_LANDED;
    }
    return wrote;
  }

  /** Claude's request is out: the steers that waited for it go in now, in order. */
  private steerHeld(id: number): void {
    for (const q of this.queued(id)) if (!q.written && steering(q)) this.writeSteer(id, q);
    this.changed(id);
  }

  /** After what is on its way in and the steers waiting for the request, before the rest. */
  private insertNext(id: number, q: Queued): void {
    const list = this.queue.list(id);
    let at = 0;
    while (at < list.length && (list[at]?.written || steering(list[at] as Queued))) at++;
    list.splice(at, 0, q);
  }

  /** Agent events that move the queue; true when consumed here. */
  private queueEvent(id: number, ev: Event, from: Running | null = null): boolean {
    const run = this.turns.get(id);
    const mine = run !== undefined && (from === null || run === from) ? run : undefined;
    if (ev.type === "result") {
      // Claude takes in what comes next before its next request: steers wait for that.
      if (mine) mine.querying = false;
      // A steer written but not taken in yet: this result ends the segment it cut short.
      if (!this.queued(id).some((q) => q.written) && !this.queue.held.has(id)) this.deliverNext(id);
      // Nothing left to deliver: the input closes and Claude exits.
      if (!this.queued(id).some((q) => q.written)) this.turnOf(id)?.closeInput();
      return false;
    }
    if (mine && !mine.querying && QUERYING.has(ev.type)) {
      mine.querying = true;
      if (this.queued(id).some((q) => !q.written && steering(q))) this.steerHeld(id);
    }
    if (ev.type === "querying") return true;
    if (ev.type !== "userEcho") return false;
    const list = this.queue.list(id);
    const found = list.findIndex((q) => q.written && ev.text.includes(q.text.trim()));
    const tr = this.transcript(id);
    // Claude can echo a steer twice (taken into the turn, then run again as the next one): it shows once.
    const again = found < 0 ? (mine?.took ?? []).findIndex((t) => t !== "" && ev.text.includes(t)) : -1;
    if (again >= 0) mine?.took?.splice(again, 1);
    else if (found < 0 && ev.text.trim() !== "") {
      // Replayed after a restart: a message Claude took in earlier left the queue already.
      tr.items.push({ kind: "user", text: ev.text, files: [], at: now(), mentions: [], sender: "", intent: "" });
      tr.pendingText = null;
      tr.pendingThinking = null;
    }
    if (found >= 0) {
      const [m] = list.splice(found, 1) as [Queued];
      if (mine) (mine.took ??= []).push(m.text.trim());
      tr.items.push(queuedItem(m));
      tr.pendingText = null;
      tr.pendingThinking = null;
      this.queue.tidy(id);
      this.persist(id);
    }
    this.queue.tidy(id);
    return true;
  }

  /** Writes the first waiting message into a Claude turn that just gave its result: Claude runs it next, in the same process. */
  private deliverNext(id: number): void {
    const q = this.queued(id).find((x) => !x.written);
    const turn = this.turnOf(id);
    if (!q || !turn) return;
    // A steer that waited for a request that never came: it is simply the next message.
    q.intent = "";
    if (turn.write(queuedPrompt(q, this.said(id, q.text, q.files), this.mentions(q.mentions)), q.files)) {
      q.written = true;
      q.editing = "";
      this.changed(id);
    }
  }

  queueStopped(id: number): void {
    if (this.queued(id).length > 0) this.queue.held.add(id);
  }

  /** After a turn's exit: what the agent never took in waits again; a steer that didn't land goes out as a new turn. */
  private queueExited(id: number, stopped: boolean): void {
    const list = this.queue.chats.get(id);
    if (!list) return;
    const steers: Queued[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i] as Queued;
      // Written ones, and steers still waiting for the request.
      if (!q.written && !steering(q)) continue;
      q.written = false;
      if (steering(q)) {
        steers.unshift(q);
        list.splice(i, 1);
      }
    }
    if (stopped) {
      for (const s of [...steers].reverse()) {
        s.intent = "";
        s.note = NOT_LANDED;
        this.queue.list(id).unshift(s);
      }
      this.queueStopped(id);
      return;
    }
    if (steers.length > 0 && !this.turns.has(id) && !this.foreign(id)) {
      for (const s of steers) s.intent = "";
      this.sendQueued(id, steers);
      return;
    }
    for (const s of [...steers].reverse()) {
      s.intent = "";
      this.queue.list(id).unshift(s);
    }
    this.queue.tidy(id);
  }

  /** Now and then: an idle chat's next queued message goes out, unless a Stop holds the queue. */
  queueDrain(): void {
    for (const [id, q] of [...this.queue.chats]) {
      if (q.length === 0 || this.turns.has(id) || this.foreign(id) || this.queue.held.has(id) || this.host.moving?.(id)) continue;
      const first = q.shift() as Queued;
      this.queue.tidy(id);
      this.sendQueued(id, [first]);
    }
  }

  private sendQueued(id: number, qs: Queued[]): void {
    if (qs.length === 0) return;
    const prompts = qs.map((m) => queuedPrompt(m, this.said(id, m.text, m.files), this.mentions(m.mentions)));
    const tr = this.transcript(id);
    const files: string[] = [];
    for (const m of qs) {
      files.push(...m.files);
      tr.items.push(queuedItem(m));
    }
    this.startTurn(id, prompts.join("\n\n"), files);
  }

  queueResume(id: number): void {
    this.queue.held.delete(id);
    this.changed(id);
  }

  queueRemove(id: number, qid: number): boolean {
    const list = this.queue.chats.get(id);
    if (!list) return false;
    const n = list.length;
    this.queue.chats.set(
      id,
      list.filter((q) => q.id !== qid || q.written || steering(q)),
    );
    const gone = (this.queue.chats.get(id)?.length ?? 0) !== n;
    this.queue.tidy(id);
    this.changed(id);
    return gone;
  }

  queueMove(id: number, qid: number, to: number): boolean {
    const moved = this.queue.moveTo(id, qid, to);
    this.changed(id);
    return moved;
  }

  queueUpdate(id: number, qid: number, text: string | null, mentions: Mention[] | null, editing: string | null): boolean {
    const q = this.queue.find(id, qid);
    if (!q || q.written) return false;
    if (text !== null) q.text = text;
    if (mentions !== null) q.mentions = mentions;
    if (editing !== null) q.editing = editing;
    q.note = "";
    this.changed(id);
    return true;
  }

  /** "Steer" on a queued message: it steers the running turn now ("Send now" when idle). */
  queuePromote(id: number, qid: number): boolean {
    const list = this.queue.chats.get(id);
    const i = list?.findIndex((q) => q.id === qid && !q.written && !steering(q)) ?? -1;
    if (!list || i < 0) return false;
    const [q] = list.splice(i, 1) as [Queued];
    this.queue.tidy(id);
    this.steer(id, q, this.turns.has(id) ? PROMOTED : STEER);
    return true;
  }

  /** Takes a chat's waiting messages out of the queue (/clear-queue). */
  takeQueue(id: number): Queued[] {
    const all = this.queue.chats.get(id) ?? [];
    this.queue.chats.delete(id);
    this.queue.held.delete(id);
    const going = (q: Queued): boolean => (q.written || steering(q)) && this.turns.has(id);
    const keep = all.filter(going);
    if (keep.length > 0) this.queue.chats.set(id, keep);
    this.changed(id);
    return all.filter((q) => !going(q));
  }

  /** The `queue` of the chat status (PROTOCOL.md): waiting messages and steers in flight. */
  queueJson(id: number): unknown[] {
    const held = this.queue.held.has(id) && this.queued(id).length > 0;
    return this.queued(id).map((q) => {
      const v: Record<string, unknown> = { id: q.id, text: q.text, files: q.files.map((f) => f.split("/").pop() ?? f), sending: q.written };
      if (steering(q)) v.intent = q.intent;
      else if (held) v.held = true;
      if (q.note !== "") v.note = q.note;
      if (q.editing !== "") v.editing = true;
      return v;
    });
  }

    /** The chats that move with `id` (it first, then its sub-agents), or why it can't move. */
  movable(id: number): number[] {
    const c = this.chat(id);
    if (!c) throw new Error("no such chat");
    if (c.home !== "") throw new Error(`this chat is ${c.home}'s: move it there`);
    if (c.role === "sub") throw new Error("a sub-agent moves with its lead: move the lead");
    const ids = [id, ...this.allSubsOf(id).map((s) => s.id)];
    const d = ids.map((i) => this.chat(i)).find((x) => x !== undefined && x.device !== "");
    if (d) throw new Error(`${d.id === id ? "it" : "one of its sub-agents"} runs on device ${d.device}, which keeps its session there`);
    if (this.turns.has(id)) throw new Error("its turn is running: move it once it ends");
    const w = this.worktreeOf(c);
    if (w !== null) throw new Error(`it works in its own worktree, ${w}`);
    return ids;
  }

  /** Moves `id` and its sub-agents to project `repo` (null: "No project"); sessions first, so nothing changes unless all of them made it. */
  moveChat(id: number, repo: number | null): void {
    const ids = this.movable(id);
    const from = this.chat(id)?.repoId ?? null;
    if (from === repo) return;
    if (repo !== null) {
      const r = this.repo(repo);
      if (!r) throw new Error("no such project");
      if (!existsSync(r.local ?? r.path)) throw new Error(`${r.path} isn't on this PC`);
    }
    const cwd = this.cwdOf(repo);
    for (const i of ids) {
      const c = this.chat(i);
      const acc = c ? this.account(c.account) : undefined;
      if (!c || !acc || acc.kind !== "Claude" || !c.started || c.sessionId === "") continue;
      try {
        ensureSession(acc.configDir, c.sessionId, cwd);
      } catch (e) {
        throw new Error(`couldn't copy ${c.name}'s session: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const name = (r: number | null): string => this.repo(r)?.name ?? "No project";
    const text = `Moved from ${name(from)} to ${name(repo)}`;
    for (const i of ids) {
      const c = this.chat(i);
      if (c) c.repoId = repo;
      this.host.forgetWorkspace?.(i);
      this.persist(i);
    }
    this.notice(id, "folder", text);
  }

  /** A team tool (`harbor mcp`): its text, or a rejection with the tool's error. */
  async tool(chatId: number, name: string, args: unknown): Promise<string> {
    const me = this.chat(chatId);
    if (!me) throw new Error("unknown agent");
    if (me.retired) throw new Error("this agent was retired");
    const other = this.host.tool?.(me, name, args);
    if (other !== undefined) return other;
    if (name === "retire_agent") return tools.now.retireCall(this, me, args);
    return tools.now.teamTool(this, me, name, args);
  }

  /** Takes one of this PC's subagents off its team for good, its transcript kept to read. */
  retireAgent(id: number): string {
    const c = this.chat(id);
    if (!c || c.role !== "sub" || c.home !== "") throw new Error("only a subagent of this PC can be retired");
    if (c.retired) return `${c.name} was already retired.`;
    const running = this.turns.has(id) || this.adoptRunner(id);
    c.retired = true;
    let waiting = this.pending.get(id)?.length ?? 0;
    this.pending.delete(id);
    this.stop(id);
    waiting += this.takeQueue(id).length;
    this.limits.cancelLimit(id);
    this.notice(id, "report", "Retired: this agent's job is done");
    const ps = this.procs.filter((p) => p.owner === id).map((p) => p.name);
    let out = `Retired ${c.name}${running ? " (its running turn was stopped)" : ""}. It's off the team for good; its chat stays readable: ${this.chatLink(c)}`;
    if (waiting > 0) out += `\nDropped ${waiting} message(s) waiting for it.`;
    if (ps.length > 0) out += `\nIts processes keep running and report to you now: ${ps.join(", ")}.`;
    return out;
  }

  chatLink(c: Chat): string {
    return this.host.chatLink?.(c) ?? `harbor://chat/${c.gid}`;
  }

  /** A webhook's local address, and its public one when /hooks is reachable from outside (team.rs `hook_url`). */
  hookUrl(token: string): [string, string | null] {
    const base = this.host.hookBase?.() ?? null;
    return [`http://127.0.0.1:${this.hookPort}/hooks/${token}`, base === null ? null : `${base}/${token}`];
  }

  modelLabel(kind: Kind, model: string): string {
    if (model === "") return "Default";
    return staticModels(kind).find((m) => m.id === model)?.label ?? model;
  }

  /** Messages waiting for a lead's idle sub-agents (the agent strip's "· 2 queued"). */
  subsQueued(lead: number): number {
    return this.subsOf(lead)
      .filter((c) => !this.turns.has(c.id))
      .reduce((n, c) => n + (this.pending.get(c.id)?.length ?? 0), 0);
  }

  /** Messages held for the chat: the queue's and those waiting for its turn to end (api.rs `queued_count`). */
  queuedCount(id: number): number {
    return this.queued(id).length + (this.pending.get(id)?.length ?? 0);
  }

  /** A phone or window opened the chat: its blue dot and failed mark go. True when it had either. */
  opened(id: number): boolean {
    const a = this.unread.delete(id);
    const b = this.failed.delete(id);
    return a || b;
  }

  /** The lead's subagents with a turn running on this PC, longest running first, with seconds running. */
  runningSubs(lead: number): [Chat, number][] {
    return this.subsSince(lead, (id) => this.runningSince(id));
  }

  /** `runningSubs` wherever they run, for what's shown. */
  liveSubs(lead: number): [Chat, number][] {
    return this.subsSince(lead, (id) => this.liveSince(id));
  }

  private subsSince(lead: number, since: (id: number) => number | null): [Chat, number][] {
    return this.subsOf(lead)
      .flatMap((c): [Chat, number][] => {
        const at = since(c.id);
        return at === null ? [] : [[c, Math.floor((Date.now() - at) / 1000)]];
      })
      .sort((a, b) => b[1] - a[1]);
  }

  /** A new lead chat (a project's thread, or a project-less one) on the account picked: Claude, Codex or OpenCode. An
   *  account this PC doesn't have falls back to Claude's; only Claude runs on another device. */
  newThread(repo: number | null, first: string, sel: { account: string; model: string; effort: string; access: string; device: string }): Chat {
    let { account, model, access, device } = sel;
    const acc = this.account(account);
    if (!acc) [account, model] = ["claude", "claude-opus-5-5"];
    const kind = acc?.kind ?? "Claude";
    if (kind !== "Claude") device = "";
    if (!accessLevels(kind).some((a) => a[0] === access)) access = accessLevels(kind)[0]?.[0] ?? "full";
    const title = [...(first.trim().split("\n")[0] ?? "").trim()].slice(0, 60).join("");
    const chat = this.store.createChat({
      id: 0,
      repoId: repo,
      title: title === "" ? "New thread" : title,
      sessionId: newUuid(),
      started: false,
      account,
      model,
      effort: sel.effort,
      access: access as Chat["access"],
      settled: false,
      updated: now(),
      role: "lead",
      parent: null,
      name: "lead",
      device: device,
      gid: "",
      home: "",
      homeId: 0,
      retired: false,
    });
    this.chats.push(chat);
    return chat;
  }

  dropEnded(lead: number, name: string): void {
    for (let i = this.endedProcs.length - 1; i >= 0; i--) {
      const e = this.endedProcs[i] as [number, string, string, string];
      if (e[0] === lead && e[1] === name) this.endedProcs.splice(i, 1);
    }
  }

  adoptProcs(): void {
    this.procs = procs.adopt(this.store, (e) => this.onProcEvent(e));
  }

  /** A process printed its URL or exited: tell the team, and wake whoever started it. */
  onProcEvent(e: procs.ProcEvent): void {
    const i = this.procs.findIndex((p) => p.id === e.id);
    if (i < 0) return;
    const p = this.procs[i] as procs.Proc;
    // A retired agent's processes report to its lead.
    const o = this.chat(p.owner);
    const owner = o?.retired && o.parent !== null ? o.parent : p.owner;
    if (e.type === "url") {
      // Shown, not announced: waking the agent again would only repeat its report.
      p.url = e.url;
      this.store.setProcUrl(p.id, e.url);
      this.notice(p.lead, "process", `${p.name} is running at ${e.url}`, e.url);
      return;
    }
    const tail = p.tail(25);
    const kept = p.tail(400);
    this.procs.splice(i, 1);
    this.store.deleteProc(p.id);
    rmSync(p.log, { force: true });
    const how = e.code === 0 ? "finished" : e.code !== null ? `exited with code ${e.code}` : "was stopped";
    this.notice(p.lead, "process", `${p.name} ${how}`, tail);
    this.dropEnded(p.lead, p.name);
    this.endedProcs.push([p.lead, p.name, how, kept]);
    if (this.endedProcs.length > 20) this.endedProcs.shift();
    this.trigger(owner, `[process ${p.name}] ${how}. Last output:\n${tail}`, true);
  }

  /** Fires due wake-ups; returns ms until the next one (null: none). */
  fireTimers(): number | null {
    const t = now();
    for (const timer of this.timers.filter((x) => x.at <= t)) {
      this.store.deleteTimer(timer.id);
      this.timers = this.timers.filter((x) => x.id !== timer.id);
      this.notice(timer.chatId, "wake", "Woke up", timer.reason);
      this.trigger(timer.chatId, `[wake] You asked to be woken up now. Reason: ${timer.reason}`, true);
    }
    if (this.timers.length === 0) return null;
    return Math.max(1, Math.min(...this.timers.map((x) => x.at)) - t) * 1000;
  }
}

/** The lead's line for a subagent's report (agentstrip.rs): its first sentence. */
/** The notice for MCP servers Claude Code reports as failed when its process starts (null: none failed). Claude doesn't try them again; the next turn is a new process, which connects anew. */
export function mcpFailNotice(servers: readonly (readonly [string, string])[]): string | null {
  const failed = servers.filter(([, status]) => status === "failed").map(([name]) => name);
  if (failed.length === 0) return null;
  const names = failed.length <= 4 ? failed.join(", ") : `${failed.slice(0, 3).join(", ")} and ${failed.length - 3} more`;
  return `MCP servers didn't connect: ${names} · they reconnect on the next turn`;
}

export const MCP_FAIL_DETAIL =
  "Claude Code couldn't reach these servers when this turn started, so their tools are missing until it ends. When every server that goes through Harbor failed at once, Harbor's MCP bridge was out of reach.";

function noticedThisTurn(items: readonly Item[], text: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === "user") return false;
    if (it?.kind === "notice" && it.text === text) return true;
  }
  return false;
}

export function reportLine(name: string, report: string): string {
  const sentence = headline(report);
  if (sentence === "") return `${name} finished`;
  return sentence.startsWith("Error: ") ? `${name} failed: ${sentence.slice(7)}` : `${name} finished: ${sentence}`;
}

/** A report's first line that isn't a heading or a code fence, without list marks, bold or code ticks, up to ". ". */
function headline(text: string): string {
  const first =
    text
      .split("\n")
      .map((l) => l.replace(/\r$/, "").trim())
      .filter((l) => !l.startsWith("#") && !l.startsWith("```"))
      .map((l) => l.replace(/^[>\-* ]+/, "").trim())
      .find((l) => l !== "" && l !== "(no text reply)") ?? "";
  const plain = first.replaceAll("**", "").replaceAll("`", "");
  const i = plain.indexOf(". ");
  const sentence = (i < 0 ? plain : plain.slice(0, i + 2)).trim().replace(/\.+$/, "").trim();
  const cs = [...sentence];
  return cs.length <= 110 ? sentence : `${cs.slice(0, 109).join("").trimEnd()}…`;
}

function arg(a: unknown, k: string): string {
  const v = (a as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v.trim() : "";
}

function alive(m: detach.Meta): boolean {
  return aliveNow(m.pid, m.pid_start);
}

/** What follows "Working… 12s" while sub-agents run too ("" with none); the phone shows it too. */
export function subsRunning(n: number): string {
  if (n === 0) return "";
  return n === 1 ? "  ·  1 sub-agent running" : `  ·  ${n} sub-agents running`;
}


function limitEvent(ev: Event): limits.LimitEvent {
  if (ev.type === "quota") return { type: "quota", windows: ev.windows };
  if (ev.type === "limit") return { type: "limit", kind: ev.kind, resetsAt: ev.resetsAt, text: ev.text };
  if (ev.type === "error") return { type: "error", text: ev.text };
  return { type: "other" };
}

/** Per item: its time if it is a user message, for `detach.recover`. */
export function userTimes(items: readonly Item[]): (number | null)[] {
  return items.map((it) => (it.kind === "user" ? it.at : null));
}

