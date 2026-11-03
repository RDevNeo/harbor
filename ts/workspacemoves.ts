import { existsSync } from "node:fs";
import { type Call, err, type Json, ok, type Reply } from "./packages/net/src/index.ts";
import { type Chat, type Repo, repoDir, type Store } from "./packages/store/src/index.ts";
import { chatWorkspace, type MoveItem, moveMenu, movedNotice, type Workspace } from "./packages/ui/src/logic/sidebar.ts";

/**
 * Move to workspace… for chats and projects (desktop and phone alike). It's placement only: which
 * workspace the sidebar's filter shows a chat or project under. Which PCs and people reach a chat,
 * and which chats the mesh copies, stay as they are.
 *
 * A chat's own workspace is kept with the chat on its home PC and goes to the other PCs in the mesh
 * chat JSON (`workspace`); a copy's move is sent home first (`POST /v1/chats/{id}/workspace`). A
 * project's is kept on the PC whose folder it is and travels in the chat JSON's `project`; one whose
 * folder is another PC's is sent there (`POST /v1/projects/do`, act `workspace`).
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
}

export interface MoveChoice {
  why: string | null;
  items: MoveItem[];
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
    if (existsSync(repoDir(r))) return "";
    return this.h.store.chats().find((c) => c.repoId === r.id && c.home !== "")?.home ?? "";
  }

  private pcWs(home: string): string {
    const ws = this.h.workspaces();
    return home === "" ? ws.mine : (ws.pcs.get(home) ?? "");
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
    const home = this.projectHome(r);
    const pcWs = this.pcWs(home);
    return moveMenu(this.h.workspaces().all, this.h.store.placement().repos.get(r.id) ?? "", pcWs, pcWs, this.name(home));
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
    if (c.home !== "") {
      const r = await this.h.forward(c.home, "POST", ["v1", "chats", String(c.homeId), "workspace"], { workspace: ws });
      if (older(r)) return err(409, `${this.h.pcName(c.home)} runs an older Harbor that can't move chats to a workspace: update it there first`);
      if (r.status >= 300) return r;
    }
    this.h.store.setChatWorkspace(c.id, ws);
    this.h.touch(c.id);
    const now = this.chatIn(this.chatOf(c.id) ?? c);
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
    // Its chats follow it: their copies on the other PCs hear of it with each of them.
    for (const c of this.h.store.chats()) if (c.repoId === r.id && c.home === "") this.h.touch(c.id);
    this.h.touch(null);
    const to = ws !== "" ? ws : this.pcWs(home);
    return ok({ ok: true, workspace: ws, in: to, notice: movedNotice(this.h.workspaces().all, to) });
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
    return null;
  }
}

export function choiceJson(m: MoveChoice): Json {
  return { why: m.why, items: m.items.map((i) => ({ id: i.id, to: i.to, label: i.label, hint: i.hint, on: i.on, back: i.back })) };
}
