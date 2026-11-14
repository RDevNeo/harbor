import { existsSync } from "node:fs";
import type { Account, Engine } from "./packages/agents/src/index.ts";
import {
  dest,
  err,
  failoverDraftLine,
  type FailoverPc,
  type FailoverPick,
  failoverLine,
  heldKey,
  heldNotice,
  type Hub,
  type Mesh,
  ok,
  parseHeld,
  pickFailover,
  type Reply,
  splitNotice,
  switchedNotice,
  takenKey,
  type WaitingMessage,
} from "./packages/net/src/index.ts";
import { type Chat, newUuid, repoDir, type Store } from "./packages/store/src/index.ts";
import { freshSession } from "./continuehere.ts";

/**
 * The hub's side of packages/net/src/failover.ts: which PC takes a chat or a new chat whose PC is
 * off, taking a chat over here, and the messages that wait while no PC can. The window and the
 * phone routes ask the same object, so both say and do the same.
 */
export interface FailoverHost {
  store: Store;
  engine: () => Engine | null;
  hub: Hub;
  mesh: () => Mesh | null;
  accounts: () => readonly Account[];
  ram: () => number | null;
  /** A copy's turn state (StoreReplica.remote): forgotten when the chat becomes this PC's. */
  forgetCopy: (id: number) => void;
  /** Where a project's folder is when it isn't here (projectclones.ts `place`). */
  place: (repo: number) => { pc: string; name: string; online: boolean } | null;
  touch: (chat: number | null) => void;
  /** The PCs this account uses (account.ts `pcScope`): only those take a chat over. */
  scope?: (pc: string) => boolean;
  /** Continue anywhere (continuehere.ts): what the cloud carries of a chat of PC `pc`, and taking it with them. */
  carry?: {
    of(pc: string, hid: number): { kind: "Claude" | "Codex"; files: boolean } | null;
    /** The chat (now this PC's) resumes its session with its work on its next turn; false: nothing carried. */
    begin(chat: number, from: string, hid: number, off: string, quiet?: boolean): boolean;
  };
  /** A chat's notice (split: it went its own way). */
  notice?: (chat: number, icon: string, text: string, detail: string) => void;
  /** Run anywhere: the PC is in one of this account's workspaces (its chats come to the PC they're typed on). */
  mine?: (pc: string) => boolean;
  /** A copy's turn runs or waits at its PC now (its messages go there, to that run). */
  busy?: (chat: number) => boolean;
  /** Reads the workspace cloud now (a PC has just sent a chat's session and work up). */
  refresh?: () => Promise<void>;
  /** Sends this PC's chat `hid` up with its session and work now (chatcloud.ts `carryNow`): true once they're up. */
  carryNow?: (hid: number, limitMs: number) => Promise<boolean>;
  /** The per-chat syncing state (syncing.ts): a chat handed on or taken over syncs meanwhile. */
  syncing?: {
    hold(chat: number, why: string, ms?: number): () => void;
    drop(chat: number): void;
    why(chat: number): string | null;
  };
}

/** The short notice of a chat that came here without its agent session (it stayed on `off`). */
export function lostNotice(off: string): { text: string; detail: string } {
  return { text: "New session here, with the conversation so far", detail: `Its agent session stayed on ${off}: the agent here gets the conversation so far, not its tool history.` };
}

/** kv: where the user picked a chat to run ("runs_on:<gid>" → a PC's mesh id); none: the PC it's typed on. */
export const runsOnKey = (gid: string): string => `runs_on:${gid}`;

/** How long a chat's PC takes at most to send its session and work up for another PC that takes the chat (`/handoff`). */
export const HANDOFF_MS = 30_000;

/** The provider an account id belongs to ("claude2" → Claude). */
export function kindOfAccount(id: string): "Claude" | "Codex" | undefined {
  return /^claude/i.test(id) ? "Claude" : /^codex/i.test(id) ? "Codex" : undefined;
}

const RETRY_MS = 15_000;

export class Failover {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly h: FailoverHost) {}

  private get mesh() {
    return this.h.hub.mesh;
  }

  /** This PC's name in the mesh. */
  here(): string {
    return this.mesh.me.name;
  }

  /** A chat of another PC whose PC is off (and so the one failover is about). */
  away(c: Chat | undefined | null): c is Chat {
    return c !== undefined && c !== null && c.home !== "" && !c.retired && !this.mesh.online(c.home);
  }

  /** The PCs that are on, this one first, as candidates for project `repo` (null: a chat without one). */
  candidates(repo: number | null, skip: string, carried = false): FailoverPc[] {
    // The engine's own lists (in memory): this runs on every redraw of such a chat's composer.
    const e = this.h.engine();
    const r = repo === null ? undefined : (e?.repo(repo) ?? this.h.store.repos().find((x) => x.id === repo));
    const remote = (r?.remote ?? "") !== "";
    const claude = this.h.accounts().some((a) => a.kind === "Claude" && a.off !== true);
    const codex = this.h.accounts().some((a) => a.kind === "Codex" && a.off !== true && a.loggedIn !== false);
    const hereHas = r === undefined || existsSync(repoDir(r));
    // A folder without Git the cloud carries is unpacked here as a clone would be.
    const out: FailoverPc[] = [{ id: "", name: this.here(), ram: this.h.ram(), hasProject: hereHas, canClone: remote || carried, claude, codex }];
    if (!this.mesh.on) return out;
    const chats = e?.chats ?? this.h.store.chats();
    for (const p of this.mesh.peers.values()) {
      if (!p.online || p.id === skip || this.h.scope?.(p.id) === false) continue;
      // It runs chats of the project: it has its folder.
      const has = r === undefined || chats.some((c) => c.home === p.id && c.repoId === r.id);
      out.push({ id: p.id, name: p.name === "" ? p.id : p.name, ram: p.ram, hasProject: has, canClone: remote || carried, claude: p.accounts.some((a) => a[2] === "claude"), codex: p.accounts.some((a) => a[2] === "codex") });
    }
    return out;
  }

  pick(c: Chat): FailoverPick {
    const carried = c.home === "" || this.h.scope?.(c.home) === false ? null : (this.h.carry?.of(c.home, c.homeId) ?? null);
    return pickFailover(this.candidates(c.repoId, c.home, carried?.files === true), carried?.kind ?? kindOfAccount(c.account), this.h.mine?.(c.home) === true);
  }

  held(c: Chat): WaitingMessage[] {
    return parseHeld(this.h.store.get(heldKey(c.gid)));
  }

  /** The line over the composer of a chat whose PC is off; null when it isn't. */
  line(c: Chat | undefined | null): { text: string; warn: boolean } | null {
    if (!this.away(c)) return null;
    const pick = this.pick(c);
    // It runs here, as any chat typed here does (run anywhere): nothing to say.
    if (pick.to !== null && pick.to.id === "" && this.held(c).length === 0) return null;
    return { text: failoverLine(this.mesh.nameOf(c.home), pick, this.held(c).length), warn: pick.to === null };
  }

  /** A new chat in project `repo` whose folder is on a PC that is off: where it starts (`to` null: nowhere now) and the line saying so. */
  draft(repo: number): { to: string | null; line: string; off: string } | null {
    const p = this.h.place(repo);
    if (p === null || p.pc === "" || p.online) return null;
    const pick = pickFailover(this.candidates(repo, p.pc));
    return { to: pick.to === null ? null : pick.to.id, line: failoverDraftLine(p.name, pick), off: p.name };
  }

  /** The notice a new chat that started away from its project's PC gets. */
  startedNotice(chat: number, offName: string): void {
    const e = this.h.engine();
    if (!e) return;
    const n = switchedNotice(offName, this.here(), false);
    e.notice(chat, "monitor", n.text, n.detail);
  }

  /**
   * A message for a chat whose PC is off: the usable PC takes the chat over and it runs there;
   * none: it waits here. `to` set: another PC picked this one already (it takes the chat or says why not).
   */
  async send(c: Chat, msg: { text: string; files: string[]; mentions: unknown[] }, to: string | null = null, sendHere: ((own: Chat) => Promise<Reply> | Reply) | null = null): Promise<Reply> {
    const e = this.h.engine();
    if (!e) return err(503, "the engine isn't started");
    const off = this.mesh.nameOf(c.home);
    const pick = this.pick(c);
    if (to !== null) {
      if (pick.to === null || pick.to.id !== "") return err(409, `this PC can't take the chat over (${pick.to === null ? pick.why : `${pick.to.name} fits it better`})`);
    }
    if (pick.to === null) return this.hold(c, msg, off, pick.why);
    if (pick.to.id === "") {
      // A chat of the account's workspaces goes on here quietly (run anywhere); one from outside says where it came from.
      const why = this.takeHere(c, off, this.h.mine?.(c.home) === true);
      if (why !== null) return err(409, why);
      const own = this.h.store.chat(c.id) ?? c;
      if (sendHere !== null) return sendHere(own);
      e.send(c.id, msg.text, { files: msg.files, mentions: msg.mentions as never });
      return ok({ ok: true, failover: this.here() });
    }
    const peer = this.mesh.peer(pick.to.id);
    const m = this.h.mesh();
    if (!peer || !m) return this.hold(c, msg, off, "no other PC answers");
    const r = await m.forward(dest(peer), peer.name, "POST", ["v1", "chats", c.gid, "send"], { text: msg.text, mentions: msg.mentions as never, failover_to: peer.id }, [], [this.here(), ""], null);
    if (r.status >= 300) return this.hold(c, msg, off, `${peer.name}: ${String((r.body as { error?: unknown } | null)?.error ?? "no answer")}`);
    return ok({ ok: true, failover: peer.name });
  }

  /** Picks where copy `c` runs: a PC's mesh id, or "" (the PC it's typed on). Kept on this PC only. */
  pickRunsOn(c: Chat, pc: string): void {
    this.h.store.set(runsOnKey(c.gid), pc === this.mesh.me.id ? "" : pc);
    this.h.touch(c.id);
  }

  /** The PCs of this account's workspaces that are on, besides this one: where a chat may be picked to run. */
  pcs(): { id: string; name: string }[] {
    if (!this.mesh.on) return [];
    const out: { id: string; name: string }[] = [];
    for (const p of this.mesh.peers.values()) {
      if (!p.online || this.h.scope?.(p.id) === false || this.h.mine?.(p.id) !== true) continue;
      out.push({ id: p.id, name: p.name === "" ? p.id : p.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The PC the user picked for copy `c` in Runs on (a mesh id), or null: the PC it's typed on runs it. */
  picked(c: Chat): string | null {
    const v = this.h.store.get(runsOnKey(c.gid)) ?? "";
    return v === "" ? null : v;
  }

  /**
   * Run anywhere: why a message typed here for copy `c` doesn't bring the chat here (null: it does). It stays where it
   * is while it runs there, when the user picked a PC for it, for a sub-agent (it runs where its lead does), a chat on
   * an SSH device, or a PC outside this account's workspaces.
   */
  whyNotHere(c: Chat): string | null {
    if (c.home === "" || c.retired) return "not a copy";
    if (c.role === "sub") return "a sub-agent runs where its lead does";
    if (c.device !== "") return "it runs on a device of its PC";
    if (this.h.mine?.(c.home) !== true) return "its PC isn't in this account's workspaces";
    if (this.h.busy?.(c.id) === true) return "it runs there now";
    const pick = this.picked(c);
    if (pick !== null && pick !== this.mesh.me.id) return "picked to run there";
    if (!this.h.accounts().some((a) => a.off !== true && (a.kind === "Claude" || (a.kind === "Codex" && a.loggedIn !== false)))) return "this PC has no Claude or Codex account";
    return null;
  }

  /**
   * Run anywhere: the copy `c` of a PC that is on comes here and the message runs here. Its PC sends the chat's
   * session and work up first and stops running it (`/handoff`), then this PC takes it over as failover does (the
   * session and work come before the turn; the old PC becomes a copy once it sees this one's). Null: it stays where it
   * is (running there, picked, an older Harbor there, or that PC said no): the caller sends the message there.
   */
  async claim(c: Chat, msg: { text: string; files: string[]; mentions: unknown[] }, sendHere: ((own: Chat) => Promise<Reply> | Reply) | null = null): Promise<Reply | null> {
    const e = this.h.engine();
    const m = this.h.mesh();
    const peer = this.mesh.peer(c.home);
    if (!e || !m || !peer?.online || this.whyNotHere(c) !== null) return null;
    const name = peer.name === "" ? peer.id : peer.name;
    // The chat syncs while it comes here: nothing else changes it meanwhile (this message is the one that brings it).
    const release = this.h.syncing?.hold(c.id, `bringing it here from ${name}`, HANDOFF_MS + 15_000) ?? (() => {});
    let now: Chat | undefined;
    try {
      const r = await m
        .forward(dest(peer), name, "POST", ["v1", "chats", String(c.homeId), "handoff"], { to: this.mesh.me.id }, [], [this.here(), ""], null)
        .catch((): null => null);
      if (r === null || r.status >= 300) return null;
      // Its session and work are up now: read them before the chat is taken.
      await this.h.refresh?.().catch(() => undefined);
      now = this.h.store.chat(c.id);
      if (!now || now.home !== c.home) return null;
      const why = this.takeHere(now, name, true);
      if (why !== null) return null;
    } finally {
      release();
    }
    this.h.store.set(runsOnKey(c.gid), "");
    const own = this.h.store.chat(c.id) ?? now ?? c;
    if (sendHere !== null) return sendHere(own);
    e.send(c.id, msg.text, { files: msg.files, mentions: msg.mentions as never });
    return ok({ ok: true, here: true });
  }

  /**
   * Run anywhere, this PC's side: PC `to` (one of this account's own) takes this PC's chat `c`. Not while it runs,
   * waits or has messages queued here, or one of its sub-agents runs (409 `running`: the other PC sends its message
   * here); else its session and work go up first and the answer says so. This PC becomes a copy once it sees the chat
   * listed by `to` (meshstore.ts `upsert` → `release`).
   */
  async handoff(c: Chat, to: string): Promise<Reply> {
    const e = this.h.engine();
    if (!e) return err(503, "the engine isn't started");
    if (c.home !== "") return err(409, "this chat runs on another PC now");
    if (this.h.mine?.(to) !== true) return err(403, "only a PC of this account's workspaces takes its chats");
    const busy = () => e.running(c.id) || e.queuedCount(c.id) > 0 || e.waiting(c.id) !== null || e.chats.some((k) => k.parent === c.id && k.home === "" && e.running(k.id));
    if (busy()) return { status: 409, body: { error: "it runs here now", running: true } };
    // Syncing already (another PC is taking it, its own newest version isn't here): that one goes first.
    const syncing = this.h.syncing?.why(c.id) ?? null;
    if (syncing !== null) return { status: 409, body: { error: `it is syncing (${syncing})`, running: false, syncing: true } };
    const name = this.mesh.nameOf(to);
    // It syncs here from now until the other PC's version of it is seen (`release`), or for SYNC_MS at most.
    const release = this.h.syncing?.hold(c.id, `handing it to ${name}`) ?? (() => {});
    let handed = false;
    try {
      const carried = (await this.h.carryNow?.(c.id, HANDOFF_MS).catch(() => false)) ?? false;
      if (busy()) return { status: 409, body: { error: "it started here meanwhile", running: true } };
      // Its agent session couldn't go up (no workspace cloud here, its room is full): it goes on here, where it is.
      if (!carried && c.started && c.sessionId !== "") return { status: 409, body: { error: "its session couldn't be sent up", running: false } };
      handed = true;
      return ok({ ok: true, count: this.h.store.items(c.id).length, carried });
    } finally {
      // Handed on: it stays syncing until the other PC's version of it is seen here (`release`), SYNC_MS at most.
      if (handed) this.h.syncing?.hold(c.id, `${name} is taking it over`);
      release();
    }
  }

  private hold(c: Chat, msg: WaitingMessage, off: string, why: string): Reply {
    const list = this.held(c);
    list.push({ text: msg.text, files: msg.files, mentions: msg.mentions });
    this.h.store.set(heldKey(c.gid), JSON.stringify(list));
    this.h.touch(c.id);
    this.watch();
    return { status: 202, body: { ok: true, held: true, why: heldNotice(off, why) } };
  }

  /**
   * The copy becomes this PC's own chat, on an account here of its own provider when there is one (else Claude, else
   * Codex). The session and work the cloud carries come before its next turn (continuehere.ts); without them, a new
   * session with the conversation so far. A notice says where it went. Null, or why it can't.
   */
  takeHere(c: Chat, off: string, quiet = false, agent = true): string | null {
    const e = this.h.engine();
    if (!e) return "the engine isn't started";
    const from = c.home;
    const hid = c.homeId;
    // Sessions and work come only from this account's own PCs (a workspace mate's chat goes on with the conversation).
    const own = this.h.scope?.(from) !== false;
    const carried = own ? (this.h.carry?.of(from, hid) ?? null) : null;
    const kind = carried?.kind ?? kindOfAccount(c.account) ?? "Claude";
    const on = this.h.accounts().filter((a) => a.off !== true && (a.kind === "Claude" || (a.kind === "Codex" && a.loggedIn !== false)));
    const want = this.h.store.get("default_account") ?? "claude";
    const same = on.filter((a) => a.kind === kind);
    const claude = on.filter((a) => a.kind === "Claude");
    const pool = same.length > 0 ? same : claude.length > 0 ? claude : on;
    const account = pool.find((a) => a.id === c.account) ?? pool.find((a) => a.id === want) ?? pool[0];
    // A change that runs nothing (settle, rename…) takes it without an agent here: it keeps its account.
    if (!account && agent) return "this PC has no Claude or Codex account";
    const count = this.h.store.items(c.id).length;
    // Newer than its old PC's listing of it: the workspace cloud's other readers take this PC's.
    this.h.store.saveChat({ ...c, account: account?.id ?? c.account, device: "", updated: Math.max(c.updated, Math.floor(Date.now() / 1000)) });
    this.h.store.setHome(c.id, "", 0);
    this.mesh.foreign.delete(c.id);
    this.mesh.homes.delete(c.id);
    this.mesh.ids.delete(`${from}\0${hid}`);
    this.h.forgetCopy(c.id);
    this.h.store.set(takenKey(c.gid), JSON.stringify({ from, name: off, count }));
    e.reload();
    // Its session and work from the cloud, on the same provider: the next turn waits for them and resumes.
    if (account !== undefined && carried !== null && account.kind === kind && this.h.carry?.begin(c.id, from, hid, off, quiet)) {
      this.h.touch(c.id);
      this.h.touch(null);
      return null;
    }
    // A copy with messages is a conversation that goes on (its PC may not have said it started). Run anywhere says
    // nothing of PCs, unless the agent's own context stayed behind: then a short notice says the session is new.
    const lost = c.started || count > 0;
    const n = quiet ? lostNotice(off) : switchedNotice(off, this.here(), lost);
    if (!e.handOver(c.id, `${kind} on ${off}`, quiet && !lost ? null : { icon: "monitor", ...n }) && !quiet) e.notice(c.id, "monitor", n.text, n.detail);
    freshSession(this.h.store, e, c.id);
    this.h.touch(c.id);
    this.h.touch(null);
    return null;
  }

  /**
   * Any change to copy `c` but a message (settle, rename, delete, a model or access pick, a move…) while its PC is off:
   * the chat becomes this PC's, as a message would make it, and the change is made here. Nothing is carried or cloned
   * for it (a later turn brings the session and work). One PC writes a chat: its old PC, back, becomes a copy of this
   * one's (`release`), or deletes its own when this PC deleted it (dropped.ts). The chat, now this PC's; or why not.
   */
  adopt(c: Chat): Chat | string {
    if (c.home === "") return c;
    const off = this.mesh.nameOf(c.home);
    if (c.retired) return "this agent was retired";
    if (this.mesh.on && this.mesh.online(c.home)) return `${off} is on: the change goes there`;
    const why = this.takeHere(c, off, this.h.mine?.(c.home) !== false, false);
    if (why !== null) return why;
    return this.h.engine()?.chat(c.id) ?? this.h.store.chat(c.id) ?? c;
  }

  /**
   * PC `by` had taken this PC's chat `own` over while this PC was off and deleted it there, at `count` items: it goes
   * here too (true). When someone wrote in it here since, it stays, as a chat of its own (a new gid, so the delete
   * doesn't match it again); while it runs, later.
   */
  dropOwn(own: Chat, by: string, count: number): boolean {
    const e = this.h.engine();
    if (e?.running(own.id)) return false;
    if (this.h.store.items(own.id).slice(count).some((i) => i.kind === "user")) {
      this.h.store.set(takenKey(own.gid), "");
      this.h.store.setGid(own.id, newUuid());
      e?.reload();
      this.h.touch(own.id);
      return false;
    }
    e?.stop(own.id);
    this.h.store.deleteChat(own.id);
    e?.transcripts.delete(own.id);
    this.mesh.gone.push([this.h.hub.touch(null, true), own.id]);
    e?.reload();
    console.error(`harbor: chat ${own.id} was deleted on ${this.mesh.nameOf(by)}, which had taken it over while this PC was off`);
    return true;
  }

  /** What waits goes out once the chat's PC, or another usable one, is back (checked every 15 s while anything waits). */
  private watch(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), RETRY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    let left = 0;
    for (const c of this.h.store.chats()) {
      const list = this.held(c);
      if (list.length === 0) continue;
      const e = this.h.engine();
      const peer = c.home === "" ? null : this.mesh.peer(c.home);
      const home = c.home === "" || peer?.online === true;
      if (!home && this.pick(c).to === null) {
        left += 1;
        continue;
      }
      this.h.store.set(heldKey(c.gid), "");
      for (const m of list) {
        if (c.home === "") e?.send(c.id, m.text, { files: m.files, mentions: m.mentions as never });
        else if (home && peer) await this.h.mesh()?.forward(dest(peer), peer.name, "POST", ["v1", "chats", String(c.homeId), "send"], { text: m.text, mentions: m.mentions as never, mode: "queue" }, [], [this.here(), ""], null);
        else await this.send(this.h.store.chat(c.id) ?? c, m);
      }
      this.h.touch(c.id);
    }
    if (left === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** At start: messages left waiting from before go out when they can. */
  start(): void {
    if (this.h.store.chats().some((c) => this.held(c).length > 0)) this.watch();
  }

  /** A chat JSON's `failover_from`/`failover_count` for chats this PC took over (its old PC settles with them when it's back). */
  took(gid: string): { from: string; count: number } | null {
    const v = this.h.store.get(takenKey(gid));
    if (v === null || v === "") return null;
    try {
      const o = JSON.parse(v) as { from?: unknown; count?: unknown };
      return typeof o.from === "string" && typeof o.count === "number" ? { from: o.from, count: o.count } : null;
    } catch {
      return null;
    }
  }

  /**
   * The chat's old PC is back and finds `peer` took over its chat `own` at `count` messages: when nobody wrote in it
   * here since (this PC was off), it becomes a copy of the peer's (true): one chat, one PC that runs it. When someone
   * did (the two PCs couldn't reach each other and both went on), this PC's goes its own way under a new id and says
   * so, and the peer's comes beside it ("split"). While it runs here, later (false).
   */
  release(own: Chat, peer: string, hid: number, count: number): boolean | "split" {
    const e = this.h.engine();
    if (e?.running(own.id)) return false;
    const items = this.h.store.items(own.id);
    if (items.slice(count).some((i) => i.kind === "user")) {
      const gid = newUuid();
      this.h.store.set(takenKey(own.gid), "");
      this.h.store.setGid(own.id, gid);
      own.gid = gid;
      const name = this.mesh.nameOf(peer);
      const n = splitNotice(this.here(), name);
      (this.h.notice ?? ((id, icon, text, detail) => e?.notice(id, icon, text, detail)))(own.id, "monitor", n.text, n.detail);
      e?.reload();
      this.h.touch(own.id);
      this.h.touch(null);
      return "split";
    }
    this.h.store.saveChat({ ...own, sessionId: "" });
    this.h.store.setHome(own.id, peer, hid);
    // Handed on: what held it here for that is over.
    this.h.syncing?.drop(own.id);
    // Taken over here once before: that's settled, the peer has it now.
    this.h.store.set(takenKey(own.gid), "");
    own.home = peer;
    own.homeId = hid;
    e?.reload();
    return true;
  }
}
