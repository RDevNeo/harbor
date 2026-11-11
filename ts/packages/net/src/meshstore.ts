import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { blankChat, digest, githead, NO_PLACEMENT, type Placement, shareList, itemHash, itemJson, parseAccess, parseItem, parseRole, repoDir, type Chat, type Item, type Repo, type Store } from "@harbor/store";
import type { Call } from "./api.ts";
import { err, type Reply } from "./http.ts";
import { draftFromJson, draftJson, previewTail, type Hub, type SharedDraft } from "./hub.ts";
import type { MeshApp } from "./mesh.ts";
import { F64, type Json } from "./wire.ts";

/** Gives the event loop a turn after every 8 ms of work, so a long chat list never holds the window
 * (and the turns, and every other peer) for seconds. */
function yielder(): () => Promise<void> {
  let at = performance.now();
  return async () => {
    if (performance.now() - at < 8) return;
    await new Promise<void>((r) => setImmediate(r));
    at = performance.now();
  };
}

/** What the agents know of one of this PC's chats; an idle chat without it. */
export interface LiveChat {
  running: boolean;
  sinceMs: number | null;
  queued: number;
  status: Json;
}

/** A copy's live state as its home PC says it (mesh.rs `Remote`). */
export interface RemoteState {
  running: boolean;
  sinceMs: number | null;
  queued: number;
  status: Json;
  forks: [number, number][];
  typing: { device: string; kind: string; label: string; text: string }[];
  viewing: { device: string; kind: string; label: string }[];
  draft: SharedDraft | null;
  worktree: string | null;
  /** The branch it works on there, as the sidebar names it ("" none known; older PCs don't say). */
  branch?: string;
  pr: Json;
  cwd: string | null;
}

export interface StoreReplicaOptions {
  store: Store;
  hub: Hub;
  version: string;
  /** The app's phone-API routes, for `POST /mesh/v1/call`. */
  route?: (call: Call) => Promise<Reply>;
  live?: (chat: number) => LiveChat | null;
  /** A chat's items as they are now (the Engine's transcript while it streams); else the store's. */
  items?: (chat: number) => Item[];
  /** The Engine's transcript only while it holds one in memory (null: the saved one is current). */
  liveItems?: (chat: number) => Item[] | null;
  /** This PC's accounts as hello tells them to `peer` (meshaccounts.ts `helloAccounts`; `shared: false` on those `peer` may not use). */
  accounts?: (peer?: string) => Json[];
  update?: () => Json;
  about?: () => { owner: string; github: string; owner_suggested: boolean };
  followUp?: () => "steer" | "queue";
  /** Its branch's pull request as chat JSON `pr` says it (null: none). */
  pr?: (chat: Chat) => Json;
  /** The bars under a chat's transcript as its phone API says them. */
  status?: (chat: number) => Json;
  /** The forks made from a chat: [item they branch after, the fork chat]. */
  forks?: (chat: number) => [number, number][];
  /** Messages held for a chat (the queue's and those waiting for its turn to end). */
  queued?: (chat: number) => number;
  /** The name of the worktree folder a chat runs in. */
  worktree?: (chat: Chat) => string | null;
  /** Copies were written: a copy's items (its id), or the list and settings (null). */
  copied?: (chat: number | null) => void;
  /** A chat this PC took over while its PC was off (failover.ts): from which PC, at how many messages. */
  took?: (gid: string) => { from: string; count: number } | null;
  /** That PC, back, settles with it: its own chat `own` becomes a copy of `peer`'s (true) or stays (false). */
  release?: (own: Chat, peer: string, hid: number, count: number) => boolean;
  /** Where a chat's agent works (its worktree, else its project); null: the project's folder. */
  cwd?: (chat: Chat) => string | null;
  /** Whether project `repo`'s row here opens the main chat `peer` names for it (projectfold.ts `takesMainFrom`); absent: never. */
  mainFrom?: (repo: number, peer: string) => boolean;
}

/** A git remote as projects are matched by it: host and path, lowercase, no ".git". */
export function remoteKey(r: string): string {
  let s = r.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  s = s.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "");
  return s.replace(/^([^/:]+):(?!\d)/, "$1/");
}

export function sameRemote(a: string, b: string): boolean {
  return a !== "" && b !== "" && remoteKey(a) === remoteKey(b);
}

/** An item inside a `json!` answer: a map, so its keys go out sorted; a cost stays a float. */
export function itemValue(it: Item): Json {
  const v = JSON.parse(itemJson(it)) as Record<string, Json>;
  if (it.kind === "result") v.cost_usd = new F64(it.cost_usd);
  return v;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** The mesh's app side on a harbor.db: this PC's chats served as mesh.rs serves them, peers' kept as copies. */
export class StoreReplica implements MeshApp {
  readonly remote = new Map<number, RemoteState>();
  private isince = new Map<string, [number, number]>();
  private revs = new Map<number, [bigint, number][]>();
  private looked = new Map<number, number>();
  private list: Chat[] = [];
  private repos: Repo[] = [];
  private place: Placement = NO_PLACEMENT;

  constructor(readonly o: StoreReplicaOptions) {
    this.reload();
  }

  /** Re-reads chats and projects and rebuilds the hub's id maps (mesh.rs `mesh_index`). */
  reload(): void {
    this.list = this.o.store.chats();
    this.repos = this.o.store.repos();
    this.place = this.o.store.placement();
    const m = this.o.hub.mesh;
    m.gids.clear();
    m.foreign.clear();
    m.ids.clear();
    m.homes.clear();
    for (const c of this.list) {
      m.gids.set(c.id, c.gid);
      if (c.home !== "") {
        m.foreign.add(c.id);
        m.ids.set(`${c.home}\0${c.homeId}`, c.id);
        m.homes.set(c.id, [c.home, c.homeId]);
      }
    }
  }

  private itemsOf(chat: number): Item[] {
    return this.o.items?.(chat) ?? this.o.store.items(chat);
  }

  /** One of this PC's chats changed (its items or settings): peers and phones hear of it. */
  touch(chat: number): void {
    this.reload();
    this.o.hub.touch(chat, true);
  }

  helloExtra(peer?: string) {
    const a = this.o.about?.() ?? { owner: "", github: "", owner_suggested: false };
    return { version: this.o.version, accounts: this.o.accounts?.(peer) ?? [], update: this.o.update?.() ?? null, ...a };
  }

  private idleStatus(): Json {
    return { queue: [], working: null, waiting: null, limit: null, agents: null, folder: null, can_steer: false, held: false, follow_up: this.o.followUp?.() ?? "steer" };
  }

  private cwd(c: Chat): string {
    const at = this.o.cwd?.(c) ?? null;
    if (at !== null) return at;
    const r = c.repoId === null ? null : this.repos.find((x) => x.id === c.repoId);
    return r ? repoDir(r) : homedir();
  }

  /** A transcript's length and digest as peers compare them: the saved one's are cached by the store. */
  private summary(chat: number): { count: number; digest: bigint } {
    const live = this.o.liveItems?.(chat) ?? null;
    return live ? { count: live.length, digest: digest(live) } : this.o.store.summary(chat);
  }

  /** Each project's main chat here (its gid), as chat JSON `project.main` names it: an unsettled lead of that project, own or a copy. */
  private mainGids(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [repo, id] of this.o.store.mainChats()) {
      const c = this.list.find((x) => x.id === id);
      if (c && c.role === "lead" && c.repoId === repo && !c.settled && c.gid !== "") out.set(repo, c.gid);
    }
    return out;
  }

  private chatJson(c: Chat, full: boolean, mains: ReadonlyMap<number, string> = new Map()): Json {
    const hub = this.o.hub;
    const r = c.repoId === null ? null : (this.repos.find((x) => x.id === c.repoId) ?? null);
    const sum = full ? this.summary(c.id) : null;
    const live = this.o.live?.(c.id) ?? null;
    const typing = hub.typing(c.id).map((t) => {
      const v: Record<string, Json> = { device: t.device, kind: t.kind, label: t.label };
      if (t.text !== "") v.text = t.text;
      return v;
    });
    const draft = hub.draft(c.id);
    return {
      id: c.id,
      gid: c.gid,
      title: c.title,
      // `main`: the project's main chat here, by gid ("" none): a PC this project was shared or moved to opens the same one.
      project: r ? { name: r.name, path: r.path, remote: r.remote, workspace: this.place.repos.get(r.id) ?? "", shared: [...(this.place.shared?.repos.get(r.id) ?? [])], main: mains.get(r.id) ?? "" } : null,
      workspace: this.place.chats.get(c.id) ?? "",
      // Share with workspace…: the extra workspaces it shows in (its own; the project's go in `project`).
      shared: [...(this.place.shared?.chats.get(c.id) ?? [])],
      account: c.account,
      model: c.model,
      effort: c.effort,
      access: c.access,
      device: c.device,
      settled: c.settled,
      retired: c.retired,
      updated: c.updated,
      role: c.role,
      parent: c.parent,
      name: c.name,
      started: c.started,
      count: sum ? sum.count : 0,
      digest: sum ? sum.digest.toString(16).padStart(16, "0") : null,
      running: live?.running ?? false,
      since_ms: live?.sinceMs ?? null,
      queued: this.o.queued?.(c.id) ?? live?.queued ?? 0,
      status: this.o.status?.(c.id) ?? live?.status ?? this.idleStatus(),
      forks: this.o.forks?.(c.id) ?? [],
      typing,
      draft: draft ? draftJson(draft) : null,
      viewing: hub.viewing(c.id).map((t) => ({ device: t.device, kind: t.kind, label: t.label })),
      worktree: this.o.worktree?.(c) ?? null,
      // Its folder's branch (its worktree's, else its project's checkout's): the sidebars of the other PCs show it.
      branch: githead.branchLabel(githead.branchOf(this.cwd(c))),
      pr: this.o.pr?.(c) ?? null,
      cwd: this.cwd(c),
      ...this.tookJson(c.gid),
    };
  }

  private tookJson(gid: string): Record<string, Json> {
    const t = this.o.took?.(gid) ?? null;
    return t === null ? {} : { failover_from: t.from, failover_count: t.count };
  }

  async chats(since: number, full: boolean): Promise<{ chats: Json[]; update: Json }> {
    this.reload();
    const own = this.list
      .filter((c) => c.home === "")
      .filter((c) => full || this.o.hub.chatRev(c.id) > since)
      .sort((a, b) => Number(a.role === "sub") - Number(b.role === "sub") || a.id - b.id);
    const out: Json[] = [];
    const turn = yielder();
    const mains = this.mainGids();
    for (const c of own) {
      out.push(this.chatJson(c, full, mains));
      await turn();
    }
    return { chats: out, update: this.o.update?.() ?? null };
  }

  items(chat: number, since: number): Json | null {
    const c = this.list.find((x) => x.id === chat) ?? this.o.store.chats().find((x) => x.id === chat);
    if (!c || c.home !== "") return null;
    const hub = this.o.hub;
    const items = this.itemsOf(chat);
    const at = hub.chatRev(chat);
    const revs = this.revs.get(chat) ?? [];
    const fresh = this.looked.get(chat) === at && revs.length === items.length && at !== 0;
    if (!fresh) {
      this.looked.set(chat, at);
      const fps = items.map(itemHash);
      revs.length = Math.min(revs.length, fps.length);
      if (fps.some((f, i) => revs[i]?.[0] !== f)) {
        const rev = hub.bump();
        fps.forEach((f, i) => {
          const r = revs[i];
          if (!r) revs.push([f, rev]);
          else if (r[0] !== f) revs[i] = [f, rev];
        });
      }
      this.revs.set(chat, revs);
    }
    const out: Json[] = [];
    items.forEach((it, i) => {
      if (since === 0 || (revs[i]?.[1] ?? 0) > since) out.push({ seq: i, item: itemValue(it) });
    });
    return { epoch: hub.epoch, rev: hub.rev(), count: items.length, items: out };
  }

  /** The project a copy goes in: by the same folder, else remote, else name, else a new entry. */
  private repoFor(p: Record<string, unknown>): number | null {
    const path = s(p, "path");
    if (path === "") return null;
    const name = s(p, "name");
    const remote = s(p, "remote");
    const found =
      this.repos.find((r) => r.path === path) ?? this.repos.find((r) => sameRemote(r.remote, remote)) ?? this.repos.find((r) => name !== "" && r.name === name);
    // A project whose folder is another PC's takes the workspace that PC moved it to; one here keeps its own.
    const ws = typeof p.workspace === "string" ? p.workspace : null;
    // Its shares the same way (an older PC sends none: left as they are).
    const shares = Array.isArray(p.shared) ? shareList(p.shared) : null;
    const adopt = (id: number) => {
      if (ws !== null && (this.place.repos.get(id) ?? "") !== ws) {
        this.o.store.setRepoWorkspace(id, ws);
        this.place = this.o.store.placement();
      }
      if (shares !== null && (this.place.shared?.repos.get(id) ?? []).join(",") !== shares.join(",")) {
        this.o.store.setRepoShares(id, shares);
        this.place = this.o.store.placement();
      }
    };
    if (found) {
      if (!existsSync(repoDir(found))) {
        if (remote !== "" && found.remote !== remote) {
          this.o.store.setRepoRemote(found.id, remote);
          this.repos = this.o.store.repos();
        }
        adopt(found.id);
      }
      return found.id;
    }
    const id = this.o.store.addRepo(path);
    if (remote !== "") this.o.store.setRepoRemote(id, remote);
    this.repos = this.o.store.repos();
    if (!existsSync(path)) adopt(id);
    return id;
  }

  /**
   * Which PC holds project `repo`'s folder, for when no copy of its chats is left here to say it:
   * the first PC whose chats arrive in it, then the one that names the project by the same path.
   */
  private rememberPc(repo: number, peer: string, path: string): void {
    const was = this.o.store.projectPc(repo);
    if (was === peer) return;
    if (was === "" || this.repos.find((r) => r.id === repo)?.path === path) this.o.store.setProjectPc(repo, peer);
  }

  private upsert(peer: string, m: Record<string, unknown>): number | null {
    const hid = int(m.id);
    if (hid === null) return null;
    const gid = s(m, "gid");
    const mesh = this.o.hub.mesh;
    const existingId = mesh.localId(peer, hid) ?? this.list.find((c) => gid !== "" && c.gid === gid)?.id ?? null;
    const existing = existingId === null ? null : (this.list.find((c) => c.id === existingId) ?? null);
    // This PC's own chat: unless `peer` took it over while this PC was off and nothing happened here since (failover.ts).
    if (existing && existing.home === "") {
      const count = int(m.failover_count);
      if (s(m, "failover_from") !== mesh.me.id || count === null || !(this.o.release?.(existing, peer, hid, count) ?? false)) return null;
    }
    const repo = m.project === null || m.project === undefined ? null : this.repoFor(obj(m.project));
    if (repo !== null) this.rememberPc(repo, peer, s(obj(m.project), "path"));
    const parentHid = int(m.parent);
    const c: Chat = blankChat({
      id: existingId ?? 0,
      repoId: repo,
      title: s(m, "title"),
      started: m.started === true,
      account: s(m, "account"),
      model: s(m, "model"),
      effort: s(m, "effort"),
      access: parseAccess(s(m, "access")),
      settled: m.settled === true,
      updated: int(m.updated) ?? 0,
      role: parseRole(s(m, "role") || "chat"),
      parent: parentHid === null ? null : mesh.localId(peer, parentHid),
      name: s(m, "name"),
      device: s(m, "device"),
      gid,
      home: peer,
      homeId: hid,
      retired: m.retired === true,
    });
    let id: number;
    if (existing) {
      this.o.store.saveChat(c);
      id = existing.id;
      Object.assign(existing, c);
    } else {
      const made = this.o.store.createChat(c);
      id = made.id;
      this.list.push(made);
    }
    // Move to workspace…: the chat's own and its project's, as its home PC has them (older PCs send neither).
    const own = typeof m.workspace === "string" ? m.workspace : "";
    const carried = m.project !== null && m.project !== undefined ? s(obj(m.project), "workspace") : "";
    const moved = (this.place.chats.get(id) ?? "") !== own || (this.place.carried.get(id) ?? "") !== carried;
    if (moved) {
      this.o.store.setChatWorkspace(id, own);
      this.o.store.setCarriedWorkspace(id, carried);
      this.place = this.o.store.placement();
    }
    // Share with workspace…: the same two, as lists (older PCs send neither: none).
    const ownShares = shareList(m.shared);
    const carriedShares = m.project !== null && m.project !== undefined ? shareList(obj(m.project).shared) : [];
    const same = (a: readonly string[] | undefined, b: string[]) => (a ?? []).join(",") === b.join(",");
    if (!same(this.place.shared?.chats.get(id), ownShares) || !same(this.place.shared?.carried.get(id), carriedShares)) {
      this.o.store.setChatShares(id, ownShares);
      this.o.store.setCarriedShares(id, carriedShares);
      this.place = this.o.store.placement();
    }
    mesh.ids.set(`${peer}\0${hid}`, id);
    mesh.foreign.add(id);
    mesh.homes.set(id, [peer, hid]);
    mesh.gids.set(id, gid);
    const leases = (k: string) =>
      (Array.isArray(m[k]) ? (m[k] as unknown[]) : []).map((t) => {
        const o = obj(t);
        return { device: s(o, "device"), kind: s(o, "kind"), label: s(o, "label"), text: previewTail(s(o, "text")) };
      });
    const forks: [number, number][] = [];
    for (const f of Array.isArray(m.forks) ? m.forks : []) {
      if (!Array.isArray(f)) continue;
      const seq = int(f[0]);
      const fh = int(f[1]);
      const local = fh === null ? null : mesh.localId(peer, fh);
      if (seq !== null && seq >= 0 && local !== null) forks.push([seq, local]);
    }
    const status = structuredClone((m.status ?? null) as Json);
    const agents = obj(obj(status).waiting).agents;
    if (Array.isArray(agents)) {
      for (const a of agents) {
        const o = obj(a);
        const h = int(o.id);
        o.id = (h === null ? null : mesh.localId(peer, h)) ?? 0;
      }
    }
    const wt = s(m, "worktree");
    const cwd = s(m, "cwd");
    this.remote.set(id, {
      running: m.running === true,
      sinceMs: int(m.since_ms),
      queued: int(m.queued) ?? 0,
      status,
      forks,
      typing: leases("typing"),
      viewing: leases("viewing").map(({ device, kind, label }) => ({ device, kind, label })),
      draft: draftFromJson(m.draft),
      worktree: wt === "" ? null : wt,
      branch: s(m, "branch"),
      pr: (m.pr ?? null) as Json,
      cwd: cwd.startsWith("/") ? cwd : null,
    });
    this.o.hub.touch(id, true);
    return id;
  }

  async applyChats(peer: string, epoch: number, body: Record<string, unknown>): Promise<[number, number][]> {
    this.reload();
    const turn = yielder();
    const full = body.full === true;
    const wants: [number, number][] = [];
    const listed = new Set<number>();
    // The main chat the peer names for each project (older PCs name none).
    const mains = new Map<number, string>();
    for (const x of Array.isArray(body.chats) ? body.chats : []) {
      const m = obj(x);
      const hid = int(m.id);
      if (hid === null) continue;
      listed.add(hid);
      const local = this.upsert(peer, m);
      const p = m.project === null || m.project === undefined ? null : obj(m.project);
      if (p !== null && typeof p.main === "string" && p.main !== "") {
        const repo = this.list.find((c) => c.id === (local ?? this.o.hub.mesh.localId(peer, hid)))?.repoId ?? null;
        if (repo !== null) mains.set(repo, p.main);
      }
      if (local === null) continue;
      const k = `${peer}\0${hid}`;
      const known = this.isince.get(k);
      const since = known && known[0] === epoch ? known[1] : 0;
      let need = true;
      if (full) {
        const d = typeof m.digest === "string" && /^[0-9a-f]{1,16}$/i.test(m.digest) ? BigInt(`0x${m.digest}`) : null;
        need = d !== this.o.store.summary(local).digest;
        await turn();
      }
      if (need) wants.push([hid, full && since === 0 ? 0 : since]);
    }
    const gone: number[] = full
      ? this.list.filter((c) => c.home === peer && !listed.has(c.homeId)).map((c) => c.id)
      : (Array.isArray(body.gone) ? body.gone : [])
          .map((g) => int(g))
          .filter((g): g is number => g !== null)
          .map((h) => this.o.hub.mesh.localId(peer, h))
          .filter((x): x is number => x !== null);
    for (const id of gone) {
      this.o.store.deleteChat(id);
      this.remote.delete(id);
    }
    this.reload();
    this.takeMains(peer, mains);
    this.o.copied?.(null);
    return wants;
  }

  /**
   * The main chats `peer` names (project here → gid): a project shared or moved here by its owner, or
   * another PC's, opens its owner's main chat (`mainFrom`), a copy or this PC's own. A main chat this
   * PC had made for it gives way: kept as a chat of the project when it has anything in it, else it goes.
   */
  private takeMains(peer: string, mains: ReadonlyMap<number, string>): void {
    if (mains.size === 0 || !this.o.mainFrom) return;
    const now = this.o.store.mainChats();
    let changed = false;
    for (const [repo, gid] of mains) {
      const c = this.list.find((x) => x.gid === gid);
      if (!c || c.role !== "lead" || c.repoId !== repo || c.settled) continue;
      const was = now.get(repo) ?? 0;
      if (was === c.id || !this.o.mainFrom(repo, peer)) continue;
      this.o.store.setMainChat(repo, c.id);
      changed = true;
      const old = was === 0 ? null : (this.list.find((x) => x.id === was) ?? null);
      const empty = old !== null && old.home === "" && !old.started && this.o.store.items(old.id).length === 0 && !this.list.some((x) => x.parent === old.id);
      if (empty) this.o.store.deleteChat(old.id);
      console.error(`harbor: project ${repo}'s main chat is ${this.o.hub.mesh.nameOf(peer)}'s (chat ${c.id})${old === null ? "" : empty ? `; its empty main chat ${old.id} went` : `; chat ${old.id} stays a chat of it`}`);
    }
    if (changed) this.reload();
  }

  applyItems(peer: string, epoch: number, hid: number, body: Record<string, unknown>): void {
    const id = this.o.hub.mesh.localId(peer, hid);
    if (id === null) return;
    const items: Item[] = this.o.store.items(id);
    const count = int(body.count) ?? 0;
    items.length = Math.min(items.length, Math.max(0, count));
    let whole = true;
    for (const e of Array.isArray(body.items) ? body.items : []) {
      const o = obj(e);
      const seq = int(o.seq);
      const it = parseItem(JSON.stringify(o.item ?? null));
      if (seq === null || seq < 0 || it === null) continue;
      if (seq < items.length) items[seq] = it;
      else if (seq === items.length) items.push(it);
      else whole = false;
    }
    whole = whole && items.length === count;
    this.isince.set(`${peer}\0${hid}`, [epoch, whole ? (int(body.rev) ?? 0) : 0]);
    this.o.store.saveItems(id, items);
    this.o.hub.touch(id, false);
    this.o.copied?.(id);
  }

  async route(call: Call): Promise<Reply> {
    const p = call.path;
    if (call.method === "POST" && p.length === 3 && p[0] === "mesh" && p[1] === "v1" && p[2] === "call") {
      const b = obj(call.body);
      const path = (Array.isArray(b.path) ? b.path : []).filter((x): x is string => typeof x === "string");
      if (path[0] !== "v1") return err(400, "not a call");
      if (!this.o.route) return err(404, "unknown mesh call");
      const from = { peer: call.device, name: this.o.hub.mesh.nameOf(call.device), ctx: b.ctx ?? null, sender: [...s(b, "sender")].slice(0, 60).join(""), device: [...s(b, "device")].slice(0, 60).join(""), who: [...s(b, "who")].slice(0, 60).join(""), dev: [...s(b, "dev")].slice(0, 100).join(""), via: b.via === "phone" ? ("phone" as const) : b.via === "pc" ? ("pc" as const) : null };
      const r = await this.o.route({ method: s(b, "method") || "GET", path, query: [], body: b.body ?? null, token: "", device: "", global: false, from });
      const rb = obj(r.body);
      if (r.status < 300 && typeof rb.id === "number" && Number.isInteger(rb.id)) return { status: r.status, body: { ...(rb as Record<string, Json>), home: this.o.hub.mesh.me.id } };
      return r;
    }
    return err(404, "unknown mesh call");
  }
}
