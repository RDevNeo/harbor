import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { blankChat, parseAccess, parseItem, parseRole, repoDir, type Chat, type Item, type Mention, type Repo, type Store } from "@harbor/store";
import type { Call } from "./api.ts";
import { err, type Reply } from "./http.ts";
import { now } from "./kv.ts";
import { autoKey } from "./ram.ts";
import { itemValue } from "./meshstore.ts";
import type { Mesh } from "./mesh.ts";
import {
  NO_MOVE_CODE,
  apiMoveTargets,
  askMoveTargets,
  codeState,
  deadlineMs,
  gitHead,
  gitHeadLabel,
  gitText,
  moveAdopt,
  moveCheck,
  moveCheckBody,
  moveOutcomeText,
  movePayload,
  movePcBlocker,
  movePcTargets,
  moveReconcile,
  moveSessions,
  moveStaysText,
  movedHereDetail,
  receivedChat,
  remoteUrl,
  sendHandoff,
  tildeOf,
  MovepcLocal,
  type HeldMessage,
  type MoveAccount,
  type MoveCandidate,
  type MoveChat,
  type MoveCode,
  type MoveHandoff,
  type MoveOutcome,
  type MoveSendDeps,
  type MoveTarget,
  type MoveTargetApp,
  type OwnedChat,
} from "./movepc.ts";
import type { Spawner } from "./proc.ts";
import { dest, type Peer, type Shared } from "./shared.ts";
import { arr, obj, str, type Json } from "./wire.ts";

/** Between a held message and the next, as Harbor joins what waited. */
const JOIN = "\n\n---\n\n";
const ASK_TTL_MS = 20_000;
const CODE_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 20_000;

export interface MoveEngine {
  readonly pending: Map<number, string[]>;
  /** Cached transcripts: a chat that became a copy drops its own, the store's is the truth then. */
  readonly transcripts: Map<number, unknown>;
  repo(id: number | null): Repo | undefined;
  running(id: number): boolean;
  worktreeOf(c: Chat): string | null;
  chatCwd(c: Chat): string;
  cwdOf(repo: number | null): string;
  transcript(id: number): { items: Item[] };
  reload(): void;
  changed(id: number | null): void;
  notice(id: number, icon: string, text: string, detail?: string): void;
  startTurn(id: number, prompt: string): void;
  send(id: number, text: string, opts: { files?: string[]; mentions?: Mention[] }): void;
}

export interface MovePcAccount extends MoveAccount {
  claude: boolean;
}

export interface MovePcDeps {
  store: Store;
  engine: MoveEngine;
  mesh: Shared;
  forward: Mesh["forward"];
  accounts(): MovePcAccount[];
  home: string;
  uploadsDir: string;
  worktreeRoot: string;
  overlays(): string[];
  removeWorktree(repo: string, dir: string): Promise<void>;
  /** The mesh's id maps again (mesh.rs `mesh_index`). */
  reindex(): void;
  forget?(chatId: number): void;
  run?: Spawner;
  send?: MoveSendDeps;
  now?: () => number;
}

/** What "Move to PC…" shows: the PCs, and why the chat can't move at all (then each carries it). */
export interface MoveTargets {
  why: string | null;
  targets: MoveTarget[];
}

const ASKING: MoveTargets = { why: "Asking its PC…", targets: [] };

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function withCode(blocker: string | null, targets: MoveTarget[], codeError: string | null): MoveTargets {
  if (blocker !== null || codeError === null) return { why: blocker, targets };
  return { why: codeError, targets: targets.map((t) => ({ ...t, why: codeError })) };
}

/** "Move to PC…": the sender's and the target's side of movepc.rs on this PC's chats. */
export class MovePc {
  readonly local = new MovepcLocal();
  /** Where the outcome of a handoff is said besides the chat's notice (the window's toast). */
  onToast: (text: string) => void = () => {};
  /** A chat on an SSH device: its sessions come here first, then on (relocate.rs, set by the hub). */
  relocate: ((chatId: number, pc: string, auto?: boolean) => Promise<string>) | null = null;
  readonly target: MoveTargetApp;
  private readonly asked = new Map<number, { at: number; result: MoveTargets | null }>();
  private readonly codes = new Map<number, { at: number; error: string | null }>();

  constructor(readonly d: MovePcDeps) {
    this.target = this.targetApp();
  }

  private clock(): number {
    return (this.d.now ?? Date.now)();
  }

  private chats(): Chat[] {
    return this.d.store.chats();
  }

  private chat(id: number): Chat | undefined {
    return this.chats().find((c) => c.id === id);
  }

  private subs(lead: number): Chat[] {
    return this.chats()
      .filter((c) => c.role === "sub" && c.parent === lead)
      .sort((a, b) => a.id - b.id);
  }

  private account(id: string): MovePcAccount | undefined {
    return this.d.accounts().find((a) => a.id === id);
  }

  private homeName(c: Chat): string {
    return c.home !== "" ? this.d.mesh.nameOf(c.home) : this.d.mesh.me.name;
  }

  /** At startup: the moves still waiting for their target's answer. */
  load(): void {
    this.local.load(this.d.store);
  }

  private save(): void {
    this.local.save(this.d.store);
  }

  /** The PC a chat is being handed to; `ownProject`: not counting its project's move (that move's own handoffs). */
  movingTo(chatId: number, ownProject = false): string | null {
    if (this.local.moving.size === 0 && this.local.relocating.size === 0 && this.local.projects.size === 0) return null;
    const c = this.chat(chatId);
    if (!c) return null;
    const lead = c.role === "sub" ? (c.parent === null ? undefined : this.chat(c.parent)) : c;
    if (!lead) return null;
    const to = this.local.movingTo(lead.gid, lead.id);
    if (to !== null || ownProject || lead.home !== "" || lead.repoId === null) return to;
    return this.local.projects.get(lead.repoId)?.[1] ?? null;
  }

  /** Why this PC's chat can't move to any PC now (null: it may, the PCs say the rest). Cheap: no git. */
  blocker(chatId: number, ownProject = false): string | null {
    const c = this.chat(chatId);
    if (!c) return null;
    const team = c.role === "sub" ? [c] : [c, ...this.subs(chatId)];
    return movePcBlocker({
      foreignHome: c.home !== "" ? this.d.mesh.nameOf(c.home) : null,
      isSub: c.role === "sub",
      meshOn: this.d.mesh.on,
      movingTo: this.movingTo(chatId, ownProject),
      chats: team.map((x) => ({ id: x.id, name: x.name, device: x.device, claude: this.account(x.account)?.claude ?? false, running: this.d.engine.running(x.id) })),
    });
  }

  private plainTargets(chatId: number): { blocker: string | null; targets: MoveTarget[] } {
    const mesh = this.d.mesh;
    const blocker = this.blocker(chatId);
    const hosts = [...mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const targets = movePcTargets({ blocker, meId: mesh.me.id, hosts, allowedFp: (fp) => mesh.usableFp(fp) !== null, downOf: (id) => mesh.down.get(id) ?? null });
    return { blocker, targets };
  }

  private async codeError(c: Chat): Promise<string | null> {
    if (c.repoId === null || c.device !== "") return null;
    try {
      await codeState({ home: this.d.home, ...(this.d.run ? { run: this.d.run } : {}) }, this.d.engine.chatCwd(c), this.d.engine.worktreeOf(c) !== null);
      return null;
    } catch (e) {
      return text(e);
    }
  }

  /** The state of the code the chat works in, as last read (read again in the background when it is old). */
  private cachedCodeError(c: Chat): string | null {
    if (c.repoId === null || c.device !== "") return null;
    const hit = this.codes.get(c.id);
    const t = this.clock();
    if (hit && t - hit.at <= CODE_TTL_MS) return hit.error;
    this.codes.set(c.id, { at: t, error: hit?.error ?? null });
    void this.codeError(c).then((error) => {
      this.codes.set(c.id, { at: this.clock(), error });
      if (error !== (hit?.error ?? null)) this.d.engine.changed(c.id);
    });
    return hit?.error ?? null;
  }

  /** The PCs for the desktop's menu, without waiting: the code's state and a copy's answer come from the last read, and a new one starts. */
  targetsNow(chatId: number): MoveTargets {
    const c = this.chat(chatId);
    if (c && c.home !== "") return this.askedFor(c);
    const { blocker, targets } = this.plainTargets(chatId);
    return withCode(blocker, targets, blocker === null && c ? this.cachedCodeError(c) : null);
  }

  /** `GET /v1/chats/{id}/move_targets`: with the code's state read now. A copy's are its home PC's. */
  async targets(chatId: number): Promise<MoveTargets> {
    const c = this.chat(chatId);
    if (c && c.home !== "") return this.askHome(c);
    const { blocker, targets } = this.plainTargets(chatId);
    return withCode(blocker, targets, blocker === null && c ? await this.codeError(c) : null);
  }

  async targetsJson(chatId: number): Promise<Json> {
    const t = await this.targets(chatId);
    return apiMoveTargets(t.why, t.targets, null);
  }

  private askedFor(c: Chat): MoveTargets {
    const hit = this.asked.get(c.id);
    if (hit && this.clock() - hit.at < ASK_TTL_MS) return hit.result ?? ASKING;
    this.asked.set(c.id, { at: this.clock(), result: null });
    void this.askHome(c).then((result) => {
      this.asked.set(c.id, { at: this.clock(), result });
      this.d.engine.changed(c.id);
    });
    return ASKING;
  }

  private async askHome(c: Chat): Promise<MoveTargets> {
    const peer = this.d.mesh.peer(c.home);
    if (!peer?.online) return { why: `${this.homeName(c)} is off: it moves the chat`, targets: [] };
    try {
      return await askMoveTargets(dest(peer), c.homeId, this.d.send?.http);
    } catch (e) {
      return { why: text(e), targets: [] };
    }
  }

  /** Starts handing `chatId` (and its sub-agents) over to PC `pc`. Resolves with the PC's name; the outcome comes later (a notice in the chat; the chat turns into a copy of that PC's).
   * `auto`: Runs on › Auto chose `pc`; the target remembers that too (move.json `auto_placed`). */
  async movePc(chatId: number, pc: string, auto = false): Promise<string> {
    const c = this.chat(chatId);
    if (c && c.home !== "") return this.moveFromHome(c, pc);
    const { blocker, targets } = this.plainTargets(chatId);
    if (blocker !== null) throw new Error(blocker);
    const t = targets.find((x) => x.id === pc);
    if (!t) throw new Error("that PC isn't one of this PC's");
    if (t.why !== null) throw new Error(`${t.name} can't take it: ${t.why}`);
    const peer = this.d.mesh.peer(pc);
    if (!peer) throw new Error("that PC isn't one of this PC's");
    if (!c) throw new Error("no such chat");
    if (c.device !== "") {
      if (this.relocate === null) throw new Error(`it runs on the device ${c.device}: bring it to this PC first, then move it`);
      return this.relocate(chatId, pc, auto);
    }
    const engine = this.d.engine;
    const worktree = engine.worktreeOf(c);
    const code = c.repoId !== null ? await codeState({ home: this.d.home, ...(this.d.run ? { run: this.d.run } : {}) }, engine.chatCwd(c), worktree !== null) : { ...NO_MOVE_CODE };
    // Nothing is awaited from here to the moment the move is recorded: a second call sees it.
    const again = this.blocker(chatId);
    if (again !== null) throw new Error(again);
    const handoff = this.handoffOf(c, peer, t.name, code, worktree !== null && code.worktree ? [worktree, code.branch, code.remote] : null, null, auto);
    // Auto's marker says where it put the chat: a hand-picked move to that PC isn't Auto's (an earlier Auto move there failed).
    if (auto) this.d.store.set(autoKey(c.gid), pc);
    else if (this.d.store.get(autoKey(c.gid)) === pc) this.d.store.del(autoKey(c.gid));
    this.local.moving.set(c.gid, [pc, t.name]);
    this.local.sending.add(c.gid);
    this.save();
    engine.changed(chatId);
    const [gid, name] = [c.gid, t.name];
    sendHandoff(handoff, this.d.send).then(
      (outcome) => this.done(chatId, gid, pc, name, outcome),
      (e: unknown) => this.done(chatId, gid, pc, name, { kind: "unknown", why: text(e) }),
    );
    return name;
  }

  /** What's sent for chat `c` (and its sub-agents); `project`: a project move's, whose folder is at `at` there already. */
  private handoffOf(c: Chat, peer: Peer, peerName: string, code: MoveCode, push: [string, string, string] | null, project: { at: string; branch: string | null } | null, auto = false): MoveHandoff {
    const engine = this.d.engine;
    const chats = [c, ...this.subs(c.id)];
    for (const x of chats) if (!this.account(x.account)) throw new Error("an account of the chat is gone");
    const sessions = moveSessions(
      { home: this.d.home, overlays: this.d.overlays },
      c.id,
      chats.map((x) => ({ id: x.id, name: x.name, started: x.started, session_id: x.sessionId, configDir: this.account(x.account)?.configDir ?? null })),
    );
    const list: MoveChat[] = chats.map((x) => ({
      gid: x.gid,
      ...(auto && x.id === c.id ? { auto_placed: true } : {}),
      title: x.title,
      session_id: x.sessionId,
      started: x.started,
      model: x.model,
      effort: x.effort,
      access: x.access,
      settled: x.settled,
      retired: x.retired,
      role: x.role,
      parent: x.parent === null ? null : (this.chat(x.parent)?.gid ?? null),
      name: x.name,
      items: engine.transcript(x.id).items.map(itemValue),
    }));
    const repo = engine.repo(c.repoId);
    const check = moveCheckBody({
      gid: c.gid,
      email: this.account(c.account)?.email ?? "",
      project: repo ? { name: repo.name, folder: basename(repo.path), remote: code.remote, ...(project ? { at: project.at } : {}) } : null,
      from: this.d.mesh.me.name,
      code,
    });
    // A project move's worktree branch came with the project's commits: it's there already.
    if (project && project.branch !== null && code.worktree) check.worktree = { branch: project.branch, remote: code.remote, here: true };
    return { dest: dest(peer), peer: peerName, check, payload: movePayload(list), sessions, push };
  }

  /**
   * One lead (and its sub-agents) of a project being moved to `pc`, whose folder is at `at` there
   * now; `branches` maps this PC's branches to their names there. Resolves when it's settled:
   * the chat is a copy of the target's then, or still this PC's (with why).
   */
  async handoffForProject(chatId: number, pc: string, at: string, branches: Record<string, string>): Promise<MoveOutcome> {
    const c = this.chat(chatId);
    if (!c || c.home !== "") return { kind: "refused", why: "it isn't this PC's chat" };
    const peer = this.d.mesh.peer(pc);
    if (!peer?.online) return { kind: "refused", why: `${peer?.name ?? "the PC"} is off or out of reach` };
    const name = peer.name;
    const blocked = this.blocker(chatId, true);
    if (blocked !== null) return { kind: "refused", why: blocked };
    const engine = this.d.engine;
    const worktree = engine.worktreeOf(c);
    const repo = engine.repo(c.repoId);
    let code: MoveCode = { ...NO_MOVE_CODE, remote: repo?.remote ?? "" };
    if (worktree !== null) {
      try {
        code = await codeState({ home: this.d.home, ...(this.d.run ? { run: this.d.run } : {}) }, worktree, true);
      } catch (e) {
        return { kind: "refused", why: text(e) };
      }
    }
    const again = this.blocker(chatId, true);
    if (again !== null) return { kind: "refused", why: again };
    let handoff: MoveHandoff;
    try {
      handoff = this.handoffOf(c, peer, name, code, null, { at, branch: worktree === null ? null : (branches[code.branch] ?? null) });
    } catch (e) {
      return { kind: "refused", why: text(e) };
    }
    if (worktree !== null && handoff.check.worktree === undefined) return { kind: "refused", why: `its worktree's branch ${code.branch} didn't come along` };
    this.local.moving.set(c.gid, [pc, name]);
    this.local.sending.add(c.gid);
    this.save();
    engine.changed(chatId);
    const outcome = await sendHandoff(handoff, this.d.send).catch((e: unknown): MoveOutcome => ({ kind: "unknown", why: text(e) }));
    this.done(chatId, c.gid, pc, name, outcome, true);
    return outcome;
  }

  /** A copy: its home PC hands it over. */
  private async moveFromHome(c: Chat, pc: string): Promise<string> {
    const peer = this.d.mesh.peer(c.home);
    const name = this.homeName(c);
    if (!peer?.online) throw new Error(`${name} is off: this chat is read-only until it's back`);
    if (!peer.moves) throw new Error(`${name} runs an older Harbor that can't move chats: update it first`);
    this.asked.delete(c.id);
    const r = await this.d.forward(dest(peer), peer.name, "POST", ["v1", "chats", String(c.homeId), "move_pc"], { pc }, [], [this.d.mesh.me.name, ""], null);
    if (r.status >= 300) throw new Error(str(obj(r.body).error) ?? "it didn't work");
    return str(obj(r.body).to) ?? pc;
  }

  private done(chatId: number, gid: string, pc: string, name: string, outcome: MoveOutcome, quiet = false): void {
    this.local.sending.delete(gid);
    // Settled meanwhile by the target's chat list.
    if (!this.local.moving.has(gid)) return;
    const said = moveOutcomeText(name, outcome);
    if (outcome.kind === "done") this.release(gid, pc, outcome.ids);
    else if (outcome.kind === "refused") {
      this.local.moving.delete(gid);
      this.save();
    }
    if (said.notice !== null) this.d.engine.notice(chatId, "alert", said.notice);
    if (said.toast !== null && !quiet) this.onToast(said.toast);
    if (outcome.kind === "refused") this.resume(chatId);
    else if (outcome.kind === "unknown") this.d.engine.changed(chatId);
  }

  /** What waited while the chat was being handed over runs here: its turn, then its messages. */
  resume(chatId: number): void {
    const engine = this.d.engine;
    for (const x of [chatId, ...this.subs(chatId).map((s) => s.id)]) {
      const q = engine.pending.get(x);
      engine.pending.delete(x);
      if (q && q.length > 0) engine.startTurn(x, q.join(JOIN));
      const held = this.local.held.get(x) ?? [];
      this.local.held.delete(x);
      for (const m of held) engine.send(x, m.text, { files: m.files, mentions: m.mentions });
    }
    engine.changed(chatId);
  }

  /** The target took the chat: this PC's chat and its sub-agents become copies of its. */
  private release(gid: string, pc: string, ids: Map<string, number>): void {
    const { store, engine } = this.d;
    this.local.moving.delete(gid);
    this.save();
    const lead = this.chats().find((c) => c.gid === gid && c.home === "");
    if (!lead) return;
    this.dropWorktree(lead);
    const team = [lead, ...this.subs(lead.id)];
    const left = new Map<number, { waiting: string[]; held: HeldMessage[] }>();
    for (const x of team) {
      left.set(x.id, { waiting: engine.pending.get(x.id) ?? [], held: this.local.held.get(x.id) ?? [] });
      engine.pending.delete(x.id);
      this.local.held.delete(x.id);
    }
    for (const x of team) {
      const hid = ids.get(x.gid);
      if (hid === undefined) continue;
      store.saveChat({ ...x, home: pc, homeId: hid, sessionId: "" });
      store.setHome(x.id, pc, hid);
      engine.transcripts.delete(x.id);
      this.d.forget?.(x.id);
    }
    engine.reload();
    this.d.reindex();
    for (const x of team) engine.changed(x.id);
    engine.changed(null);
    // What was sent meanwhile goes to its new home.
    void (async () => {
      for (const x of team) {
        const l = left.get(x.id);
        if (!l) continue;
        if (l.waiting.length > 0) await this.sendHome(x.id, l.waiting.join(JOIN), [], []);
        for (const m of l.held) await this.sendHome(x.id, m.text, m.files, m.mentions);
      }
    })();
  }

  /** Its worktree here is clean and pushed: it goes (kept, with a toast, if it changed since). */
  private dropWorktree(c: Chat): void {
    const { store, engine } = this.d;
    const dir = store.get(`worktree:${c.id}`);
    store.set(`worktree:${c.id}`, "");
    store.set(`worktree_named:${c.id}`, "");
    if (dir === null || dir === "") return;
    this.d.removeWorktree(engine.cwdOf(c.repoId), dir).catch((e: unknown) => {
      this.onToast(`Kept the chat's worktree: ${text(e)}. Commit or discard them, then remove it with \`git worktree remove ${dir}\`.`);
    });
  }

  private async sendHome(chatId: number, message: string, files: string[], mentions: Mention[]): Promise<void> {
    const c = this.chat(chatId);
    if (!c || c.home === "") return;
    const name = this.homeName(c);
    const peer = this.d.mesh.peer(c.home);
    let reply: Reply;
    if (!peer?.online) reply = err(409, `${name} is off`);
    else {
      try {
        const blobs = files.map((f) => ({ name: basename(f), data: readFileSync(f) }));
        reply = await this.d.forward(dest(peer), peer.name, "POST", ["v1", "chats", String(c.homeId), "send"], { text: message, mentions, mode: "queue" }, blobs, [this.d.mesh.me.name, ""], null);
      } catch (e) {
        reply = err(409, text(e));
      }
    }
    if (reply.status >= 300) this.d.engine.notice(chatId, "alert", `Couldn't send a message to ${name}: ${str(obj(reply.body).error) ?? "no answer"}`, message);
  }

  /** A target's chat list while a move to it waits for an answer (before the copies are applied). */
  reconcile(peer: string, body: unknown): void {
    if (this.local.moving.size === 0) return;
    const r = moveReconcile(this.local.moving, this.local.sending, peer, body);
    for (const [gid, listed] of r.release) this.release(gid, peer, listed);
    for (const [gid, name] of r.stays) {
      this.local.moving.delete(gid);
      this.save();
      const id = this.chats().find((c) => c.gid === gid)?.id;
      if (id === undefined) continue;
      this.d.engine.notice(id, "alert", moveStaysText(name));
      this.resume(id);
    }
  }

  hold(chatId: number, message: string, files: string[], mentions: Mention[]): boolean {
    if (this.movingTo(chatId) === null) return false;
    const list = this.local.held.get(chatId) ?? [];
    list.push({ text: message, files, mentions });
    this.local.held.set(chatId, list);
    return true;
  }

  /** `POST /mesh/v1/adopt/check` and `/mesh/v1/adopt` from a chat's home PC; null for any other call. */
  route(call: Call): Promise<Reply> | null {
    const [m, v, a, c] = call.path;
    if (call.method !== "POST" || m !== "mesh" || v !== "v1" || a !== "adopt") return null;
    if (call.path.length === 4 && c === "check") return moveCheck(this.target, call.device, call.body);
    if (call.path.length !== 3) return null;
    // The deadline is this PC's own clock at the call, whatever the caller wrote.
    const body = typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? { ...call.body, deadline_ms: deadlineMs(this.clock()) } : call.body;
    return moveAdopt(this.target, call.device, body);
  }

  private owned(gid: string): Map<string, number> | null {
    const all = this.chats();
    const lead = all.find((c) => c.gid === gid && c.home === "");
    if (!lead) return null;
    const m = new Map<string, number>([[lead.gid, lead.id]]);
    for (const s of all.filter((c) => c.role === "sub" && c.parent === lead.id)) m.set(s.gid, s.id);
    return m;
  }

  private targetApp(): MoveTargetApp {
    const d = this.d;
    return {
      meName: () => d.mesh.me.name,
      home: d.home,
      accounts: () => d.accounts(),
      defaultAccount: () => d.store.get("default_account") ?? "claude",
      candidates: async () => {
        const out: MoveCandidate[] = [];
        for (const r of d.store.repos()) {
          const dir = repoDir(r);
          if (isDir(dir)) out.push({ id: r.id, name: r.name, folder: basename(dir), remote: await remoteUrl(dir, d.run) });
        }
        return out;
      },
      repo: (id) => {
        const r = d.store.repos().find((x) => x.id === id);
        return r ? { name: r.name, dir: repoDir(r) } : null;
      },
      repoAt: (dir) => d.store.repos().find((x) => repoDir(x) === dir)?.id ?? null,
      isCheckout: async (dir) => (await gitHead(dir, d.run)) !== null,
      owned: (gid) => this.owned(gid),
      chatOf: (gid): OwnedChat | null => {
        const c = this.chats().find((x) => x.gid === gid);
        return c ? { id: c.id, gid: c.gid, home: c.home, homeName: this.homeName(c), foreign: c.home !== "" } : null;
      },
      adopting: this.local.adopting,
      uploadsDir: d.uploadsDir,
      worktree: { root: d.worktreeRoot, newId: () => randomUUID().replace(/[^0-9a-f]/g, "").slice(0, 6), ...(d.run ? { run: d.run } : {}) },
      removeWorktree: d.removeWorktree,
      take: (peer, chats, repo, account, worktree, body) => this.take(peer, chats, repo, account, worktree, body),
      ...(d.now ? { now: d.now } : {}),
    };
  }

  /** Makes the received chats this PC's own (the copies of them become the chats). */
  private take(peer: string, chats: unknown[], repo: number | null, account: string, wt: string | null, body: unknown): Map<string, number> {
    const { store, engine } = this.d;
    const ids = new Map<string, number>();
    const all = store.chats();
    for (const m of chats) {
      const r = receivedChat(m);
      if (r.gid === "") continue;
      const existing = all.find((c) => c.gid === r.gid);
      const parent = r.parent === null ? null : (ids.get(r.parent) ?? all.find((c) => c.gid === r.parent)?.id ?? null);
      const c = blankChat({
        id: existing?.id ?? 0,
        repoId: repo,
        title: r.title,
        sessionId: r.session_id,
        started: r.started,
        account,
        model: r.model,
        effort: r.effort,
        access: parseAccess(r.access),
        settled: r.settled,
        updated: now(),
        role: parseRole(r.role),
        parent,
        name: r.name,
        gid: r.gid,
        retired: r.retired,
      });
      let id: number;
      if (existing) {
        store.saveChat(c);
        store.setHome(existing.id, "", 0);
        id = existing.id;
      } else id = store.createChat(c).id;
      // The sender's target id becomes this PC ("") here. Clear an older marker on a copy
      // when a manual move, or an older peer without the flag, brings the chat back.
      if (r.auto_placed) store.set(autoKey(r.gid), "");
      else store.del(autoKey(r.gid));
      const items = arr(r.items)
        .map((x) => parseItem(JSON.stringify(x)))
        .filter((x): x is Item => x !== null);
      store.saveItems(id, items);
      engine.transcript(id).items = items;
      this.d.forget?.(id);
      ids.set(r.gid, id);
    }
    engine.reload();
    this.d.reindex();
    const leadGid = str(obj(chats[0]).gid);
    const lead = leadGid === null ? undefined : ids.get(leadGid);
    if (lead !== undefined) {
      if (wt !== null) store.set(`worktree:${lead}`, wt);
      void this.movedNotice(lead, peer, repo, account, wt, body);
    }
    for (const id of ids.values()) engine.changed(id);
    engine.changed(null);
    return ids;
  }

  private async movedNotice(lead: number, peer: string, repo: number | null, account: string, wt: string | null, body: unknown): Promise<void> {
    const b = obj(body);
    const said = str(b.from);
    const from = said !== null && said !== "" ? said : this.d.mesh.nameOf(peer);
    const r = repo === null ? undefined : this.d.store.repos().find((x) => x.id === repo);
    const code = obj(b.code);
    const branch = str(code.branch);
    const sha = str(code.sha);
    let checkout: { label: string; sha: string } | null = null;
    // In the checkout (not its own worktree): say where this PC's checkout is.
    if (r && wt === null && branch !== null && branch !== "" && sha !== null) {
      const dir = repoDir(r);
      const h = await gitHead(dir, this.d.run);
      if (h) checkout = { label: gitHeadLabel(h), sha: await gitText(dir, ["rev-parse", "--short", "HEAD"], GIT_TIMEOUT_MS, this.d.run).catch(() => "") };
    }
    const detail = movedHereDetail({
      accountShort: this.account(account)?.short ?? account,
      project: r ? tildeOf(this.d.home, repoDir(r)) : null,
      worktreeName: wt === null ? null : basename(wt),
      from,
      code: branch !== null && sha !== null ? { branch, sha } : null,
      checkout,
    });
    this.d.engine.notice(lead, "monitor", `Moved here from ${from}`, detail);
  }
}
