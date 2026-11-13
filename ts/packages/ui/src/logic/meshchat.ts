import type { memory } from "@harbor/agents";
import type { Viewer } from "@harbor/net";
import type { Chat } from "@harbor/store";
import type { Mention } from "./mentions.ts";
import type { DraftIn } from "./shareddraft.ts";

/** The hub's side of a chat homed on another PC (mesh.rs forwarding and leases), as the window uses it. */
export interface ShellMesh {
  me(): string;
  /** This PC's name in the mesh (windowmesh.ts `myName`). */
  myName?(): string;
  home(c: Chat): { name: string; online: boolean } | null;
  peer(id: string): { name: string; online: boolean } | null;
  /** The mesh's other PCs, for chat links naming one (chatlink.ts). */
  peers?(): { name: string; online: boolean }[];
  remote(id: number): { running: boolean; queued: number; worktree?: string | null; branch?: string; pr?: unknown } | null;
  typers(id: number): { device: string; label: string }[];
  viewers(id: number): { device: string; kind: string; label: string }[];
  forward(c: Chat, method: string, tail: string[], body: Record<string, unknown>, files?: readonly string[]): Promise<{ status: number; body: unknown }>;
  create(peerId: string, body: Record<string, unknown>, files: readonly string[], repo: number | null): Promise<{ status: number; body: unknown }>;
  lease(id: number, view: boolean, kind: string, on: boolean, draft: Record<string, unknown> | null): void;
  /** This window looking at a copy (senders.ts Viewer); null for this PC's own chats. */
  viewer?(c: Chat): Viewer | null;
  /** The chat's shared composer draft (windowmesh.ts `draft`). */
  draft?(id: number): DraftIn | null;
  /** A message went out of the window's composer: the chat's draft empties everywhere. */
  sent?(id: number): void;
  /** Any change but a message to a copy whose PC is off: the chat becomes this PC's (failover.ts `adopt`): the chat, now
   *  this PC's, or why not. */
  adopt?(c: Chat): Chat | string;
  /** A chat whose PC is off: the line saying where the next message goes or that it waits (failover.ts); null: its PC is on. */
  failover?(c: Chat): { text: string; warn: boolean } | null;
  /** The other PCs and their memory (windowmesh.ts `memory`). */
  memory?(): Promise<{ name: string; online: boolean; mem: Record<string, unknown> | null }[]>;
  /** The SSH device one of this PC's chats runs on, with its RAM and the turn's processes there (windowmesh.ts `deviceMemory`). */
  deviceMemory?(c: { id: number; device: string }, running: boolean): memory.DeviceInfo | null;
  /** A copy's memory at its home PC (windowmesh.ts `chatMemory`). */
  chatMemory?(c: Chat): Promise<Record<string, unknown> | null>;
  /** Calls back with the chats whose state moved, for as long as the window lives. */
  watch?(changed: (chats: number[]) => void): void;
}

/** What the window does when a forwarded call didn't go: its composer gets the message back. */
export interface MeshChatHooks {
  /** `append`: the home PC was off (the text goes after what the composer holds); else only into an empty composer. */
  restore(chat: number, text: string, mentions: Mention[], append: boolean): void;
  changed(chat: number): void;
  opened?(chat: number): void;
  now?(): number;
}

const ERROR_MS = 12_000;

const errorOf = (body: unknown): string => {
  const e = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof e === "string" && e !== "" ? e : "it didn't work";
};

/** mesh.rs `mesh_forward`, `mesh_send`, `mesh_create`, `Msg::Done` and `mesh_composer` for the TypeScript window. */
export class MeshChat {
  private err: { chat: number; text: string; at: number } | null = null;

  constructor(
    private readonly m: ShellMesh,
    private readonly h: MeshChatHooks,
  ) {}

  private now(): number {
    return this.h.now?.() ?? Date.now();
  }

  foreign(c: Chat | undefined): c is Chat {
    return c !== undefined && c.home !== "";
  }

  writable(c: Chat): boolean {
    return !c.retired && (c.home === "" || this.m.home(c)?.online === true || this.m.failover !== undefined || this.m.adopt !== undefined);
  }

  /** A copy whose PC is off, which a change made here makes this PC's (`adopt`). */
  offCopy(c: Chat | undefined): c is Chat {
    return this.foreign(c) && !c.retired && this.m.home(c)?.online !== true && this.m.adopt !== undefined;
  }

  /** Before a change made here (a move to another project…): a copy whose PC is off becomes this PC's (`c` updated in
   *  place). True when the chat is this PC's now; false (and the composer says why) when it isn't. */
  takeOver(c: Chat | undefined, what: string): boolean {
    if (c === undefined || !this.foreign(c)) return c !== undefined;
    const own = this.offCopy(c) ? (this.m.adopt?.(c) ?? "") : `${this.homeName(c)} has it: change it there`;
    if (typeof own === "string") {
      this.fail(c.id, `Couldn't ${what}: ${own}`);
      return false;
    }
    Object.assign(c, own);
    return true;
  }

  /** The line over the composer of a chat whose PC is off (failover.ts); null: it's on, or this PC's chat. */
  failoverLine(c: Chat | undefined): { text: string; tone: "warn" | "pc" } | null {
    const l = this.foreign(c) && !c.retired && this.m.home(c)?.online !== true ? (this.m.failover?.(c) ?? null) : null;
    // No PC can run it: the amber warning; else the PC glyph (it goes on on another PC).
    return l === null ? null : { text: l.text, tone: l.warn ? "warn" : "pc" };
  }

  /** The composer's place while the chat's home PC is off (null: it can be written). */
  readOnly(c: Chat): string | null {
    if (!this.foreign(c) || this.writable(c) || c.retired) return null;
    const name = this.m.home(c)?.name ?? c.home;
    return `${name} is off. This chat runs there, so it's read-only until ${name} is back; then it catches up.`;
  }

  /** The PC a chat of another PC runs on, by name (its id while unknown). */
  /** Who this window is to a copy's sender rows: the messages this PC forwarded are its own, the home PC's show its owner. */
  viewer(c: Chat): Viewer | null {
    return c.home === "" ? null : (this.m.viewer?.(c) ?? null);
  }

  homeName(c: Chat): string {
    return this.m.home(c)?.name ?? c.home;
  }

  running(c: Chat | undefined): boolean {
    return this.foreign(c) && this.m.remote(c.id)?.running === true;
  }

  queued(c: Chat | undefined): number {
    return this.foreign(c) ? (this.m.remote(c.id)?.queued ?? 0) : 0;
  }

  /** The red line over the composer for 12 s after a call that didn't go. */
  error(chat: number): string {
    if (this.err === null || this.err.chat !== chat) return "";
    if (this.now() - this.err.at >= ERROR_MS) {
      this.err = null;
      return "";
    }
    return this.err.text;
  }

  private fail(chat: number, text: string): void {
    this.err = { chat, text, at: this.now() };
    this.h.changed(chat);
  }

  /**
   * A call about a copy at its home PC; false for this PC's own chats. A copy whose PC is off: a message goes on on
   * another PC or waits (windowmesh.ts → failover.ts); a stop has nothing to stop; any other change makes the chat this
   * PC's (`adopt`, `c` is updated in place) and false is answered, so the caller makes the change here as for its own.
   */
  call(c: Chat | undefined, what: string, method: string, tail: string[], body: Record<string, unknown>, files: readonly string[] = [], restore: { text: string; mentions: Mention[] } | null = null): boolean {
    if (!this.foreign(c)) return false;
    const home = this.m.home(c);
    const failover = what === "send" && this.m.failover !== undefined;
    if (home?.online !== true && !failover) {
      if (what === "stop") return true;
      const off = `${home?.name ?? c.home} is off`;
      const own = what === "send" ? off : (this.m.adopt?.(c) ?? off);
      if (typeof own !== "string") {
        Object.assign(c, own);
        return false;
      }
      this.fail(c.id, `Couldn't ${what}: ${own}`);
      if (restore) this.h.restore(c.id, restore.text, restore.mentions, true);
      return true;
    }
    void this.m.forward(c, method, tail, body, files).then(
      (r) => this.done(c.id, what, r, restore),
      (e: unknown) => this.done(c.id, what, { status: 503, body: { error: e instanceof Error ? e.message : String(e) } }, restore),
    );
    return true;
  }

  private done(chat: number, what: string, r: { status: number; body: unknown }, restore: { text: string; mentions: Mention[] } | null): void {
    if (r.status < 300) {
      this.h.changed(chat);
      return;
    }
    this.fail(chat, `Couldn't ${what}: ${errorOf(r.body)}`);
    if (restore) this.h.restore(chat, restore.text, restore.mentions, false);
  }

  /** The composer's message for a copy, steering or queued while its turn runs. */
  send(c: Chat | undefined, text: string, files: readonly string[], mentions: Mention[], mode: "steer" | "queue"): boolean {
    return this.call(c, "send", "POST", ["send"], { text, mentions, mode }, files, { text, mentions });
  }

  stop(c: Chat | undefined): boolean {
    return this.call(c, "stop", "POST", ["stop"], { hold: true });
  }

  patch(c: Chat | undefined, body: Record<string, unknown>): boolean {
    return this.call(c, "change the chat", "PATCH", [], body);
  }

  fork(c: Chat | undefined, seq: number): boolean {
    return this.call(c, "fork the chat", "POST", ["fork"], { seq });
  }

  rename(c: Chat | undefined, title: string): boolean {
    return this.call(c, "rename the chat", "PATCH", [], { title });
  }

  /** Deleted at its home PC (its copies everywhere go with it). */
  remove(c: Chat | undefined): boolean {
    return this.call(c, "delete the chat", "DELETE", [], {});
  }

  /** mesh.rs `mesh_create`: the draft's first message starts the chat on PC `peer`; its copy here opens once it arrives. */
  create(peer: string, body: Record<string, unknown>, files: readonly string[], repo: number | null, draft: number, restore: { text: string; mentions: Mention[] }, made?: (gid: string) => void): boolean {
    const p = this.m.peer(peer);
    if (p === null) return false;
    if (!p.online) {
      this.fail(draft, `${p.name} is off: pick a PC that's on`);
      this.h.restore(draft, restore.text, restore.mentions, true);
      return true;
    }
    void this.m.create(peer, body, files, repo).then(
      (r) => {
        const b = typeof r.body === "object" && r.body !== null ? (r.body as { id?: unknown; gid?: unknown }) : {};
        const id = b.id;
        if (r.status >= 300) this.done(draft, "start the chat", r, restore);
        else {
          if (typeof b.gid === "string" && b.gid !== "") made?.(b.gid);
          if (typeof id === "number") this.h.opened?.(id);
        }
      },
      (e: unknown) => this.done(draft, "start the chat", { status: 503, body: { error: e instanceof Error ? e.message : String(e) } }, restore),
    );
    return true;
  }

  /** mesh.rs `local_typing`: this PC's composer in the chat, and what it holds. */
  typed(chat: number, on: boolean, draft: Record<string, unknown> | null): void {
    this.m.lease(chat, false, "pc", on, draft);
  }

  /** mesh.rs `mesh_viewing`: this PC has the chat open. */
  viewed(chat: number, focused: boolean, on: boolean): void {
    this.m.lease(chat, true, focused ? "focused" : "away", on, null);
  }

  /** phonesui.rs `typing_label`: who else writes in the chat now. */
  typing(chat: number): string {
    const who = this.m.typers(chat);
    return who.length === 0 ? "" : `\u{270E}  ${who.map((t) => t.label).join(", ")}`;
  }

  /** chat.rs: the Send button's tip while someone else types (the message waits for them). */
  sendTip(chat: number): string {
    const t = this.m.typers(chat)[0];
    return t ? `Queue (Enter): ${t.label} is typing; it goes out when they're done` : "Send (Enter)";
  }

  /** mesh.rs `mesh_badges`: the other PCs that have the chat open ("away" when not focused there). */
  viewers(chat: number): string {
    return this.m
      .viewers(chat)
      .map((v) => (v.kind === "away" ? `${v.label} (away)` : v.label))
      .join(", ");
  }
}
