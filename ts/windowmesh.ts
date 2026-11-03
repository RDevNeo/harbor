import { linkSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import { dest, draftEmpty, draftFileOf, err, POLL, resolveUpload, safeName, type Hub, type Json, type Mesh, type PhoneRoutes, type RemoteState, type Reply, type Sender, startsTurn, type StoreReplica, type Viewer } from "./packages/net/src/index.ts";
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
  /** The hub's uploads folder: the window's attached files go there (hard-linked) so the chat's other devices get them. */
  uploadsDir?: string;
}

/** A chat's shared composer draft as the window takes it (`files`: paths here; null: keep the window's own). */
export interface WindowDraft {
  text: string;
  files: string[] | null;
  mentions: unknown[];
  by: string;
  rev: number;
}

/** api.rs `local_device`. */
export function localDevice(env: Record<string, string | undefined> = process.env): string {
  const id = env.HARBOR_MESH_ID ?? "";
  return id !== "" ? `pc:${id}` : `pc:${hostname().split(".")[0] ?? ""}`;
}

/** What the window does with a chat homed on another PC (mesh.rs `mesh_forward` and the leases), and the new chats it starts on one. */
export class WindowMesh {
  private readonly leases = new Map<string, { on: boolean; kind: string; draft: string; at: number }>();

  /** Files attached in the window, by path: their upload id (the same file under the uploads folder). */
  private readonly shared = new Map<string, string>();

  constructor(private readonly d: WindowMeshDeps) {}

  /** The upload id of a file attached in the window to `chat`: hard-linked into the uploads folder (Rust's way), or
   * symlinked where it can't be (another file system); null when neither goes. */
  private uploadOf(chat: number, path: string): string | null {
    const dir = this.d.uploadsDir;
    if (!dir) return null;
    if (path.startsWith(`${dir}/`)) {
      const rel = path.slice(dir.length + 1);
      if (resolveUpload(dir, rel) !== null) return rel;
    }
    const known = this.shared.get(path);
    if (known !== undefined && resolveUpload(dir, known) !== null) return known;
    try {
      const sub = join(dir, String(chat));
      mkdirSync(sub, { recursive: true });
      const id = `${chat}/${Date.now()}-${safeName(basename(path))}`;
      try {
        linkSync(path, join(dir, id));
      } catch {
        symlinkSync(path, join(dir, id));
      }
      this.shared.set(path, id);
      return id;
    } catch {
      return null;
    }
  }

  /** The window's path for an upload: the file it attached when it's one of those. */
  private pathOf(upload: string): string {
    for (const [p, id] of this.shared) if (id === upload) return p;
    const dir = this.d.uploadsDir;
    return (dir ? resolveUpload(dir, upload) : null) ?? "";
  }

  /** The chat's shared draft (PROTOCOL.md "Typing"): this PC's hub's for its own chats, the home PC's for a copy. A copy's
   * files are the home PC's uploads, so they stay out (null) unless a message took them (a cleared draft). */
  draft(id: number): WindowDraft | null {
    const c = this.d.chat(id);
    if (!c) return null;
    if (c.home !== "") {
      const r = this.remote(id)?.draft ?? null;
      if (!r) return null;
      return { text: r.text, files: r.by === "" && draftEmpty(r) ? [] : null, mentions: r.mentions, by: r.by, rev: r.rev };
    }
    const d = this.d.hub.draft(id);
    if (!d) return null;
    return { text: d.text, files: d.files.map((f) => this.pathOf(f.id)).filter((p) => p !== ""), mentions: d.mentions, by: d.by, rev: d.rev };
  }

  /** A message went out of the window's composer: the chat's draft empties on every device (a copy's home PC does it when the message gets there). */
  sent(id: number): void {
    const c = this.d.chat(id);
    if (c && c.home === "") this.d.hub.clearDraft(id);
  }

  /** Calls `changed` with the chats whose state moved (drafts among them), for as long as the window lives. */
  watch(changed: (chats: number[]) => void): void {
    const hub = this.d.hub;
    void (async () => {
      let since = hub.rev();
      for (;;) {
        const [rev, chats] = await hub.wait(since, POLL);
        since = rev;
        if (chats.length > 0) changed(chats);
      }
    })();
  }

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

  peers(): { name: string; online: boolean }[] {
    const m = this.d.hub.mesh;
    return [...m.peers.values()].map((p) => ({ name: p.name, online: p.online && m.on }));
  }

  /** The other PCs and their memory (`GET /mesh/v1/memory` there; null while off or on a Harbor too old to say). */
  async memory(): Promise<{ name: string; online: boolean; mem: Record<string, unknown> | null }[]> {
    const m = this.d.hub.mesh;
    return Promise.all([...m.peers.values()].map(async (p) => ({ name: p.name, online: p.online && m.on, mem: await this.d.mesh.memoryOf(p.id, null) })));
  }

  /** A copy's memory at its home PC, with the chat's parts there. */
  chatMemory(c: Chat): Promise<Record<string, unknown> | null> {
    return c.home === "" ? Promise.resolve(null) : this.d.mesh.memoryOf(c.home, c.homeId);
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

  /** This window looking at a copy: its own messages carry this PC's device id (or, from before, its label). */
  viewer(c: Chat): Viewer | null {
    if (c.home === "") return null;
    const p = this.d.hub.mesh.peer(c.home);
    return { dev: this.me(), label: this.sender()[0], home: { name: p?.name ?? this.d.hub.mesh.nameOf(c.home), owner: p?.owner ?? "" } };
  }

  private sender(): Sender {
    const me = this.myName();
    const owner = this.d.ownerName();
    return [owner ? `${me} (${owner})` : me, this.me(), owner ?? "", "pc", this.me()];
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
      else {
        // The window's files go as upload ids: the phones and PCs that open the chat get them too.
        const files = draft && Array.isArray(draft.files) ? draft.files.filter((f): f is string => typeof f === "string").map((p) => this.uploadOf(id, p)).filter((x): x is string => x !== null) : null;
        const dir = this.d.uploadsDir ?? "";
        const d = draft && files !== null ? { ...draft, files } : draft;
        this.d.hub.report(id, me, kind, label, on, d, (u) => (dir === "" ? null : draftFileOf(dir, u)));
      }
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
