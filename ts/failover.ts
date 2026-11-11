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
  switchedNotice,
  takenKey,
  type WaitingMessage,
} from "./packages/net/src/index.ts";
import { type Chat, repoDir, type Store } from "./packages/store/src/index.ts";

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
  candidates(repo: number | null, skip: string): FailoverPc[] {
    // The engine's own lists (in memory): this runs on every redraw of such a chat's composer.
    const e = this.h.engine();
    const r = repo === null ? undefined : (e?.repo(repo) ?? this.h.store.repos().find((x) => x.id === repo));
    const remote = (r?.remote ?? "") !== "";
    const claude = this.h.accounts().some((a) => a.kind === "Claude" && a.off !== true);
    const hereHas = r === undefined || existsSync(repoDir(r));
    const out: FailoverPc[] = [{ id: "", name: this.here(), ram: this.h.ram(), hasProject: hereHas, canClone: remote, claude }];
    if (!this.mesh.on) return out;
    const chats = e?.chats ?? this.h.store.chats();
    for (const p of this.mesh.peers.values()) {
      if (!p.online || p.id === skip || this.h.scope?.(p.id) === false) continue;
      // It runs chats of the project: it has its folder.
      const has = r === undefined || chats.some((c) => c.home === p.id && c.repoId === r.id);
      out.push({ id: p.id, name: p.name === "" ? p.id : p.name, ram: p.ram, hasProject: has, canClone: remote, claude: p.accounts.some((a) => a[2] === "claude") });
    }
    return out;
  }

  pick(c: Chat): FailoverPick {
    return pickFailover(this.candidates(c.repoId, c.home));
  }

  held(c: Chat): WaitingMessage[] {
    return parseHeld(this.h.store.get(heldKey(c.gid)));
  }

  /** The line over the composer of a chat whose PC is off; null when it isn't. */
  line(c: Chat | undefined | null): { text: string; warn: boolean } | null {
    if (!this.away(c)) return null;
    const pick = this.pick(c);
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
      const why = this.takeHere(c, off);
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

  private hold(c: Chat, msg: WaitingMessage, off: string, why: string): Reply {
    const list = this.held(c);
    list.push({ text: msg.text, files: msg.files, mentions: msg.mentions });
    this.h.store.set(heldKey(c.gid), JSON.stringify(list));
    this.h.touch(c.id);
    this.watch();
    return { status: 202, body: { ok: true, held: true, why: heldNotice(off, why) } };
  }

  /**
   * The copy becomes this PC's own chat: on a Claude account here, a new session with the
   * conversation so far, and a notice saying where it went. Null, or why it can't.
   */
  takeHere(c: Chat, off: string): string | null {
    const e = this.h.engine();
    if (!e) return "the engine isn't started";
    const acc = this.h.accounts().filter((a) => a.kind === "Claude" && a.off !== true);
    const want = this.h.store.get("default_account") ?? "claude";
    const account = acc.find((a) => a.id === want) ?? acc[0];
    if (!account) return "this PC has no Claude account";
    const count = this.h.store.items(c.id).length;
    const from = c.home;
    const hid = c.homeId;
    this.h.store.saveChat({ ...c, account: account.id, device: "" });
    this.h.store.setHome(c.id, "", 0);
    this.mesh.foreign.delete(c.id);
    this.mesh.homes.delete(c.id);
    this.mesh.ids.delete(`${from}\0${hid}`);
    this.h.forgetCopy(c.id);
    this.h.store.set(takenKey(c.gid), JSON.stringify({ from, name: off, count }));
    e.reload();
    // A copy with messages is a conversation that goes on (its PC may not have said it started).
    const n = switchedNotice(off, this.here(), c.started || count > 0);
    if (!e.handOver(c.id, `Claude on ${off}`, { icon: "monitor", ...n })) e.notice(c.id, "monitor", n.text, n.detail);
    this.h.touch(c.id);
    this.h.touch(null);
    return null;
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
   * The chat's old PC is back and finds `peer` took over its chat `own` at `count` messages: when
   * nothing happened here since (it was off), it becomes a copy of the peer's; true when it did.
   * When it went on here too (the two PCs couldn't reach each other), both keep theirs.
   */
  release(own: Chat, peer: string, hid: number, count: number): boolean {
    const e = this.h.engine();
    if (e?.running(own.id) || this.h.store.items(own.id).length > count) return false;
    this.h.store.saveChat({ ...own, sessionId: "" });
    this.h.store.setHome(own.id, peer, hid);
    // Taken over here once before: that's settled, the peer has it now.
    this.h.store.set(takenKey(own.gid), "");
    own.home = peer;
    own.homeId = hid;
    e?.reload();
    return true;
  }
}
