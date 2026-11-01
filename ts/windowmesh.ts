import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { hostname } from "node:os";
import { dest, err, type Hub, type Json, type Mesh, type PhoneRoutes, type RemoteState, type Reply, startsTurn, type StoreReplica } from "./packages/net/src/index.ts";
import type { Chat } from "./packages/store/src/index.ts";

export interface WindowMeshDeps {
  hub: Hub;
  mesh: Mesh;
  replica: StoreReplica;
  phone: PhoneRoutes;
  chat: (id: number) => Chat | undefined;
  /** meshctx.rs `outgoing` for the chat's project (null: none). */
  ctx: (repo: number | null) => Json;
  ownerName: () => string | null;
  env?: Record<string, string | undefined>;
}

/** api.rs `local_device`. */
export function localDevice(env: Record<string, string | undefined> = process.env): string {
  const id = env.HARBOR_MESH_ID ?? "";
  return id !== "" ? `pc:${id}` : `pc:${hostname().split(".")[0] ?? ""}`;
}

/** What the window does with a chat homed on another PC (mesh.rs `mesh_forward` and the leases), and the new chats it starts on one. */
export class WindowMesh {
  private readonly leases = new Map<string, { on: boolean; kind: string; draft: string; at: number }>();

  constructor(private readonly d: WindowMeshDeps) {}

  me(): string {
    return localDevice(this.d.env);
  }

  myName(): string {
    return this.d.hub.mesh.me.name || hostname().split(".")[0] || "";
  }

  /** The chat's home PC (null: this PC's own). */
  home(c: Chat): { name: string; online: boolean } | null {
    if (c.home === "") return null;
    return { name: this.d.hub.mesh.nameOf(c.home), online: this.d.hub.mesh.on && this.d.hub.mesh.online(c.home) };
  }

  peer(id: string): { name: string; online: boolean } | null {
    const p = this.d.hub.mesh.peer(id);
    return p ? { name: p.name, online: p.online && this.d.hub.mesh.on } : null;
  }

  remote(id: number): RemoteState | null {
    return this.d.replica.remote.get(id) ?? null;
  }

  /** Who types in the chat now (a copy: as its home PC says), this PC left out. */
  typers(id: number): { device: string; kind: string; label: string }[] {
    const r = this.remote(id);
    const all = r ? r.typing : this.d.hub.typing(id);
    return all.filter((t) => t.device !== this.me()).map((t) => ({ device: t.device, kind: t.kind, label: t.label }));
  }

  /** Which other devices have the chat open. */
  viewers(id: number): { device: string; kind: string; label: string }[] {
    const r = this.remote(id);
    const all = r ? r.viewing : this.d.hub.viewing(id).map((t) => ({ device: t.device, kind: t.kind, label: t.label }));
    return all.filter((t) => t.device !== this.me());
  }

  private sender(): [string, string] {
    const me = this.myName();
    const owner = this.d.ownerName();
    return [owner ? `${me} (${owner})` : me, this.me()];
  }

  private files(paths: readonly string[]): { name: string; data: Uint8Array }[] {
    return paths.map((p) => ({ name: basename(p), data: readFileSync(p) }));
  }

  /** A call about a copy, at its home PC (`tail` after `/v1/chats/{id}`). */
  async forward(c: Chat, method: string, tail: string[], body: Record<string, unknown>, files: readonly string[] = []): Promise<Reply> {
    const peer = this.d.hub.mesh.peer(c.home);
    const name = this.d.hub.mesh.nameOf(c.home);
    if (!peer?.online || !this.d.hub.mesh.on) return err(409, `${name} is off, so this chat is read-only until it's back`);
    let attached: { name: string; data: Uint8Array }[];
    try {
      attached = this.files(files);
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
    const ctx = startsTurn(method, tail) ? this.d.ctx(c.repoId) : null;
    return this.d.mesh.forward(dest(peer), name, method, ["v1", "chats", String(c.homeId), ...tail], body, attached, this.sender(), ctx);
  }

  /** mesh.rs `mesh_create`: the draft's first message starts a chat on another PC; the answer's id is the copy's here once it arrives (null: not yet). */
  async create(peerId: string, body: Record<string, unknown>, files: readonly string[], repo: number | null): Promise<Reply> {
    const peer = this.d.hub.mesh.peer(peerId);
    if (!peer) return err(404, "no such PC");
    if (!peer.online) return err(409, `${peer.name} is off: pick a PC that's on`);
    let attached: { name: string; data: Uint8Array }[];
    try {
      attached = this.files(files);
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
    const r = await this.d.mesh.forward(dest(peer), peer.name, "POST", ["v1", "chats"], { ...body, device: "" }, attached, this.sender(), this.d.ctx(repo));
    return this.d.phone.mapNew(peer.id, r, false);
  }

  /** mesh.rs `set_lease`: this PC's typing or viewing in a chat; kept here for its own chats, sent home for copies (renewed every few seconds). */
  lease(id: number, view: boolean, kind: string, on: boolean, draft: Record<string, unknown> | null): void {
    const c = this.d.chat(id);
    if (!c) return;
    const me = this.me();
    const label = this.myName();
    if (c.home === "") {
      if (view) this.d.hub.setViewing(id, me, label, kind !== "away", on);
      else this.d.hub.report(id, me, kind, label, on, draft, () => null);
      return;
    }
    const key = `${id}:${view}`;
    const every = view ? 5000 : 2500;
    const text = draft === null ? "" : JSON.stringify(draft);
    const was = this.leases.get(key);
    if (was && was.on === on && was.kind === kind && was.draft === text && Date.now() - was.at < every) return;
    this.leases.set(key, { on, kind, draft: text, at: Date.now() });
    this.d.mesh.forwardLease(id, view, me, kind, label, on, draft);
  }
}
