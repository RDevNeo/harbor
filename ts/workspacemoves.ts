import { existsSync } from "node:fs";
import { type Call, err, type Json, ok, type Reply } from "./packages/net/src/index.ts";
import { type Chat, NO_PLACEMENT, type Repo, repoDir, type Store } from "./packages/store/src/index.ts";
import { carriedProjects, chatWorkspace, type MoveItem, moveMenu, movedNotice, projectWorkspace, type ShareItem, shareMenu, sharedNotice, sharedWith, type Workspace } from "./packages/ui/src/logic/sidebar.ts";

/**
 * Move to workspace… for chats and projects (desktop and phone alike). It's placement only: which
 * workspace the sidebar's filter shows a chat or project under. Which PCs and people reach a chat,
 * and which chats the mesh copies, stay as they are.
 *
 * A chat's own workspace is kept with the chat on its home PC and goes to the other PCs in the mesh
 * chat JSON (`workspace`); a copy's move is sent home first (`POST /v1/chats/{id}/workspace`). A
 * project's is kept on the PC whose folder it is and travels in the chat JSON's `project`; one whose
 * folder is another PC's is sent there (`POST /v1/projects/do`, act `workspace`).
 *
 * Share with workspace… goes the same way: a list of extra workspaces kept, carried and forwarded
 * like the move (`shared`, `project.shared`; `POST /v1/chats/{id}/share`, act `share`). The owner
 * stays the workspace it's in; the filter also shows it under each shared one. Placement only too.
 */
export interface MovesHost {
  store: Store;
  /** The account's workspaces, this PC's ("" for none) and each PC's by mesh id. */
  workspaces(): { all: Workspace[]; mine: string; pcs: ReadonlyMap<string, string> };
  /** A PC of the mesh by its id. */
  pcName(id: string): string;
  /** A call on to PC `peer` (`/mesh/v1/call`). */
  forward(peer: string, method: string, path: string[], body: Record<string, unknown>): Promise<Reply>;
  /** Peers, phones and the window hear chat `chat` changed (null: the list). */
  touch(chat: number | null): void;
  /** A copy whose PC is off becomes this PC's, so the change is made here (failover.ts `adopt`): the chat, or why
   *  not; null: its PC is on (the change goes there). */
  adoptOff?(c: Chat): Chat | string | null;
}

export interface MoveChoice {
  why: string | null;
  items: MoveItem[];
}

/** Share with workspace…'s checklist: `line` is "Owned by X · shared with Y". */
export interface ShareChoice {
  why: string | null;
  line: string;
  items: ShareItem[];
}

const WS_ID = /^[A-Za-z0-9_.:-]{0,120}$/;
const older = (r: Reply): boolean => {
  const e = typeof r.body === "object" && r.body !== null ? (r.body as { error?: unknown }).error : undefined;
  return r.status === 404 && typeof e === "string" && /no such (call|chat action)|unknown call|not found/.test(e);
};

export class WorkspaceMoves {
  constructor(private readonly h: MovesHost) {}

  private chatOf(id: number): Chat | undefined {
    return this.h.store.chat(id);
  }

  /** The PC whose folder project `r` is: "" for this one (or none known), else the PC its copies come from. */
  projectHome(r: Repo): string {
    return this.projectPc(r) ?? "";
  }

  /** Project `r`'s PC: null for this one, else the PC its copies come from ("" none known). */
  private projectPc(r: Repo): string | null {
    if (existsSync(repoDir(r))) return null;
    return this.h.store.chats().find((c) => c.repoId === r.id && c.home !== "")?.home ?? this.h.store.projectPc(r.id);
  }

  private pcWs(home: string): string {
    const ws = this.h.workspaces();
    return home === "" ? ws.mine : (ws.pcs.get(home) ?? "");
  }

  /** The workspace of project `r`'s PC ("" when that PC is in none known here). */
  private projectPcWs(r: Repo): string {
    const pc = this.projectPc(r);
    return pc === null ? this.h.workspaces().mine : pc === "" ? "" : this.pcWs(pc);
  }

  private name(home: string): string {
    return home === "" ? "This PC" : this.h.pcName(home);
  }

  /** Where chat `c` is now (its own, its lead's or project's, its PC's). */
  chatIn(c: Chat): string {
    const ws = this.h.workspaces();
    return chatWorkspace(c, (id) => this.chatOf(id), this.h.store.placement(), ws.mine, ws.pcs);
  }

  /** Chat `c`'s Move to workspace… menu. */
  chatMenu(c: Chat): MoveChoice {
    if (c.role === "sub") return { why: "A sub-agent is where its lead is", items: [] };
    const place = this.h.store.placement();
    const own = place.chats.get(c.id) ?? "";
    const inherited = c.home !== "" ? (place.carried.get(c.id) ?? "") : c.repoId === null ? "" : (place.repos.get(c.repoId) ?? "");
    const pcWs = this.pcWs(c.home);
    return moveMenu(this.h.workspaces().all, own, inherited !== "" ? inherited : pcWs, pcWs, this.name(c.home));
  }

  /** Project `r`'s Move to workspace… menu. */
  projectMenu(r: Repo): MoveChoice {
    const pc = this.projectPc(r);
    const ws = this.h.workspaces();
    const place = this.h.store.placement();
    // Where it is without a move of its own here: its PC's move as its chats' copies carry it, else its PC's workspace.
    const base = projectWorkspace(r.id, NO_PLACEMENT, pc, ws.mine, ws.pcs, carriedProjects(this.h.store.chats(), place));
    return moveMenu(ws.all, place.repos.get(r.id) ?? "", base, this.projectPcWs(r), this.name(pc ?? ""));
  }

  private check(ws: unknown, forwarded: boolean): string | Reply {
    if (typeof ws !== "string" || !WS_ID.test(ws)) return err(400, 'send {"workspace": id}, "" for its PC\'s');
    // Another PC's account may know workspaces this one doesn't: a forwarded move is taken as it comes.
    if (!forwarded && ws !== "" && !this.h.workspaces().all.some((w) => w.id === ws)) return err(400, "that isn't one of your account's workspaces");
    return ws;
  }

  /** Puts chat `c` in workspace `ws` ("": no own one). A copy's goes to its home PC first. */
  async moveChat(c: Chat, wsIn: unknown, forwarded = false): Promise<Reply> {
    const ws = this.check(wsIn, forwarded);
    if (typeof ws !== "string") return ws;
    if (c.role === "sub") return err(409, "a sub-agent is where its lead is: move its lead");
    const own = c.home === "" ? null : (this.h.adoptOff?.(c) ?? null);
    if (typeof own === "string") return err(409, own);
    if (own !== null) c = own;
    if (c.home !== "") {
      const r = await this.h.forward(c.home, "POST", ["v1", "chats", String(c.homeId), "workspace"], { workspace: ws });
      if (older(r)) return err(409, `${this.h.pcName(c.home)} runs an older Harbor that can't move chats to a workspace: update it there first`);
      if (r.status >= 300) return r;
    }
    this.h.store.setChatWorkspace(c.id, ws);
    // Moved to a workspace it was shared with: that's its own now, not a share.
    const now = this.chatIn(this.chatOf(c.id) ?? c);
    this.dropShare(this.h.store.placement().shared?.chats.get(c.id), now, (l) => this.h.store.setChatShares(c.id, l));
    this.h.touch(c.id);
    return ok({ ok: true, workspace: ws, in: now, notice: movedNotice(this.h.workspaces().all, now) });
  }

  /** Puts project `r` in workspace `ws` ("": its PC's). One whose folder is another PC's goes there first. */
  async moveProject(r: Repo, wsIn: unknown, forwarded = false): Promise<Reply> {
    const ws = this.check(wsIn, forwarded);
    if (typeof ws !== "string") return ws;
    const home = forwarded ? "" : this.projectHome(r);
    if (home !== "") {
      const f = await this.h.forward(home, "POST", ["v1", "projects", "do"], { project: r.path, act: "workspace", workspace: ws });
      if (older(f) || (f.status === 400 && /^act:/.test(String((f.body as { error?: unknown } | null)?.error ?? ""))))
        return err(409, `${this.h.pcName(home)} runs an older Harbor that can't move projects to a workspace: update it there first`);
      if (f.status >= 300) return f;
    }
    this.h.store.setRepoWorkspace(r.id, ws);
    const to = ws !== "" ? ws : forwarded ? this.h.workspaces().mine : this.projectPcWs(r);
    this.dropShare(this.h.store.placement().shared?.repos.get(r.id), to, (l) => this.h.store.setRepoShares(r.id, l));
    this.touchProject(r);
    return ok({ ok: true, workspace: ws, in: to, notice: movedNotice(this.h.workspaces().all, to) });
  }

  /** Its chats follow a project: their copies on the other PCs hear of it with each of them. */
  private touchProject(r: Repo): void {
    for (const c of this.h.store.chats()) if (c.repoId === r.id && c.home === "") this.h.touch(c.id);
    this.h.touch(null);
  }

  private dropShare(list: readonly string[] | undefined, ws: string, set: (l: string[]) => void): void {
    if (list?.includes(ws)) set(list.filter((x) => x !== ws));
  }

  /** Where project `r` is now: where it was moved, else its PC's workspace. */
  projectIn(r: Repo): string {
    const ws = this.h.workspaces();
    const place = this.h.store.placement();
    return projectWorkspace(r.id, place, this.projectPc(r), ws.mine, ws.pcs, carriedProjects(this.h.store.chats(), place));
  }

  /** Chat `c`'s Share with workspace… checklist: its owner, its project's shares (locked), its own. */
  chatShares(c: Chat): ShareChoice {
    const place = this.h.store.placement();
    const owner = this.chatIn(c);
    const s = sharedWith(c, (id) => this.chatOf(id), place);
    const own = s.all.filter((x) => !s.inherited.includes(x));
    const m = shareMenu(this.h.workspaces().all, owner, own, s.inherited);
    if (c.role === "sub") return { ...m, why: "A sub-agent is shared where its lead is", items: [] };
    return m;
  }

  /** Project `r`'s Share with workspace… checklist. */
  projectShares(r: Repo): ShareChoice {
    return shareMenu(this.h.workspaces().all, this.projectIn(r), this.h.store.placement().shared?.repos.get(r.id) ?? []);
  }

  private shareCheck(ws: unknown, on: unknown, forwarded: boolean): string | Reply {
    if (typeof ws !== "string" || ws === "" || !WS_ID.test(ws) || typeof on !== "boolean") return err(400, 'send {"workspace": id, "on": true or false}');
    if (!forwarded && !this.h.workspaces().all.some((w) => w.id === ws)) return err(400, "that isn't one of your account's workspaces");
    return ws;
  }

  /** Shares chat `c` with workspace `ws` (`on`) or stops sharing it. A copy's goes to its home PC first. */
  async shareChat(c: Chat, wsIn: unknown, on: unknown, forwarded = false): Promise<Reply> {
    const ws = this.shareCheck(wsIn, on, forwarded);
    if (typeof ws !== "string") return ws;
    if (c.role === "sub") return err(409, "a sub-agent is shared where its lead is: share its lead");
    if (!forwarded && on === true && ws === this.chatIn(c)) return err(409, "it's already in that workspace");
    const own = c.home === "" ? null : (this.h.adoptOff?.(c) ?? null);
    if (typeof own === "string") return err(409, own);
    if (own !== null) c = own;
    if (c.home !== "") {
      const r = await this.h.forward(c.home, "POST", ["v1", "chats", String(c.homeId), "share"], { workspace: ws, on });
      if (older(r)) return err(409, `${this.h.pcName(c.home)} runs an older Harbor that can't share chats with a workspace: update it there first`);
      if (r.status >= 300) return r;
    }
    const was = this.h.store.placement().shared?.chats.get(c.id) ?? [];
    const list = on === true ? [...was, ws] : was.filter((x) => x !== ws);
    this.h.store.setChatShares(c.id, list);
    this.h.touch(c.id);
    return ok({ ok: true, shared: [...(this.h.store.placement().shared?.chats.get(c.id) ?? [])], notice: sharedNotice(this.h.workspaces().all, ws, on === true) });
  }

  /** Shares project `r` (and so its chats) with workspace `ws` or stops. One whose folder is another PC's goes there first. */
  async shareProject(r: Repo, wsIn: unknown, on: unknown, forwarded = false): Promise<Reply> {
    const ws = this.shareCheck(wsIn, on, forwarded);
    if (typeof ws !== "string") return ws;
    if (!forwarded && on === true && ws === this.projectIn(r)) return err(409, "it's already in that workspace");
    const home = forwarded ? "" : this.projectHome(r);
    if (home !== "") {
      const f = await this.h.forward(home, "POST", ["v1", "projects", "do"], { project: r.path, act: "share", workspace: ws, on });
      if (older(f) || (f.status === 400 && /^act:/.test(String((f.body as { error?: unknown } | null)?.error ?? ""))))
        return err(409, `${this.h.pcName(home)} runs an older Harbor that can't share projects with a workspace: update it there first`);
      if (f.status >= 300) return f;
    }
    const was = this.h.store.placement().shared?.repos.get(r.id) ?? [];
    this.h.store.setRepoShares(r.id, on === true ? [...was, ws] : was.filter((x) => x !== ws));
    this.touchProject(r);
    return ok({ ok: true, shared: [...(this.h.store.placement().shared?.repos.get(r.id) ?? [])], notice: sharedNotice(this.h.workspaces().all, ws, on === true) });
  }

  /** `GET /v1/chats/{id}/workspaces` and `POST /v1/chats/{id}/workspace`, or null for another call. */
  async route(call: Call, c: Chat): Promise<Reply | null> {
    const p = call.path;
    if (p.length !== 4 || p[0] !== "v1" || p[1] !== "chats") return null;
    if (call.method === "GET" && p[3] === "workspaces") return ok(choiceJson(this.chatMenu(c)));
    if (call.method === "POST" && p[3] === "workspace") {
      const b = typeof call.body === "object" && call.body !== null ? (call.body as Record<string, unknown>) : {};
      return this.moveChat(c, b.workspace, call.from !== undefined && call.from !== null);
    }
    if (call.method === "GET" && p[3] === "shares") return ok(shareJson(this.chatShares(c)));
    if (call.method === "POST" && p[3] === "share") {
      const b = typeof call.body === "object" && call.body !== null ? (call.body as Record<string, unknown>) : {};
      return this.shareChat(c, b.workspace, b.on, call.from !== undefined && call.from !== null);
    }
    return null;
  }
}

export function choiceJson(m: MoveChoice): Json {
  return { why: m.why, items: m.items.map((i) => ({ id: i.id, to: i.to, label: i.label, hint: i.hint, on: i.on, back: i.back })) };
}

export function shareJson(m: ShareChoice): Json {
  return { why: m.why, line: m.line, items: m.items.map((i) => ({ id: i.id, label: i.label, hint: i.hint, on: i.on, owner: i.owner, locked: i.locked })) };
}

/** kv: chats with no project that others started here before they were placed at start are placed (once). */
export const STARTS_PLACED = "starts_placed";

/**
 * Once, for chats started before this rule: a chat of this PC with no project and no workspace of its own, started by
 * someone else, goes in their workspace as a new one does (phone.ts `placeNew`). `whose(dev)` is the workspace for the
 * device its first message was written on ("phone:<pairing>", "pc:<id>"; "" leaves it). Returns how many moved.
 */
export function placeOlderStarts(store: Store, whose: (dev: string) => string): number {
  const place = store.placement();
  let n = 0;
  for (const c of store.chats()) {
    if (c.home !== "" || c.repoId !== null || c.role === "sub" || (place.chats.get(c.id) ?? "") !== "") continue;
    const first = store.firstItem(c.id);
    const dev = first?.kind === "user" ? (first.dev ?? "") : "";
    const ws = dev === "" ? "" : whose(dev);
    if (ws === "") continue;
    store.setChatWorkspace(c.id, ws);
    n++;
  }
  return n;
}
