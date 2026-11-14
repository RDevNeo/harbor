import { existsSync } from "node:fs";
import { type AccountDirectory, type CarryChat, type CarryFolder, ChatCloud, type CloudBehind, type CloudOwnChat, type CloudProject, type CloudSink, type CloudSource, type CloudWatch, type Hub, type Snap, type StoreReplica, type Syncing } from "./packages/net/src/index.ts";
import { githead, itemJson, parseDropped, repoDir, type Store } from "./packages/store/src/index.ts";

/** The epoch copies made from the workspace cloud are noted under: never a PC's, so the mesh fetches a copy's items afresh once its PC is back. */
export const CLOUD_EPOCH = -1;

export interface CloudSyncHost {
  stateDir: string;
  fp: () => string;
  store: Store;
  hub: Hub;
  /** The mesh's replica (made after the account service: asked for only once a round runs). */
  replica: () => StoreReplica;
  directory: () => AccountDirectory;
  /** A chat of this PC is running now. */
  running: (chat: number) => boolean;
  /** Copies were written: the window reads them again (a chat's items, or the list). */
  copied: (chat: number | null) => void;
  log?: ((line: string) => void) | undefined;
  /** Continue anywhere (continuehere.ts `carrySource`): this PC's chats' sessions and work go up too. */
  carry?: { carry(): CarryChat[]; snapshot(f: CarryFolder): Promise<Snap | null> } | undefined;
  /** The per-chat syncing state (syncing.ts): what the rounds find behind, and when the first read is done. */
  syncing?: Syncing | undefined;
  /** Tests: the clock and smaller transcript chunks. */
  clock?: (() => number) | undefined;
  chunkItems?: number | undefined;
  pokeMs?: number | undefined;
}

/** How long a project folder's presence is trusted (a missing one under /home costs macOS's automounter a look). */
const PROJECTS_EVERY_MS = 10 * 60_000;

/** The app's side of the workspace cloud (chatcloud.ts): this PC's chats and projects from its store, copies through the mesh's replica. */
export function chatCloud(h: CloudSyncHost): ChatCloud {
  let projects: { at: number; list: CloudProject[] } = { at: 0, list: [] };
  const source: CloudSource = {
    chats: () => {
      const r = h.replica();
      const own = r.ownChats();
      const mains = r.mainsNow();
      return own.map(
        (c): CloudOwnChat => ({
          hid: c.id,
          running: h.running(c.id),
          summary: () => h.store.summary(c.id),
          meta: () => r.cloudMeta(c, mains),
          items: () => r.transcript(c.id),
        }),
      );
    },
    projects: () => {
      const now = (h.clock ?? Date.now)();
      if (projects.at !== 0 && now - projects.at < PROJECTS_EVERY_MS) return projects.list;
      const place = h.store.placement();
      const list: CloudProject[] = [];
      for (const r of h.store.repos()) {
        const dir = repoDir(r);
        if (!existsSync(dir)) continue;
        list.push({
          path: dir,
          name: r.name,
          remote: r.remote,
          branch: githead.branchLabel(githead.branchOf(dir)),
          workspace: place.repos.get(r.id) ?? "",
          shared: [...(place.shared?.repos.get(r.id) ?? [])],
        });
      }
      projects = { at: now, list };
      return list;
    },
    dropped: () => h.replica().dropped().map((d) => ({ ...d })),
    ...(h.carry ? { carry: () => h.carry?.carry() ?? [], snapshot: (f: CarryFolder) => h.carry?.snapshot(f) ?? Promise.resolve(null) } : {}),
  };
  const sink: CloudSink = {
    pcOf: (fp) => {
      if (fp === "") return null;
      const d = h.directory();
      for (const p of [...d.workspaces.flatMap((w) => w.pcs), ...d.peers]) if (p.fp === fp && p.id !== "") return { id: p.id, name: p.name };
      return null;
    },
    online: (pc) => h.hub.mesh.online(pc),
    copy: (pc, hid) => {
      const id = h.hub.mesh.localId(pc, hid);
      const c = id === null ? undefined : h.store.chat(id);
      if (id === null || !c || c.home !== pc) return null;
      const s = h.store.summary(id);
      return { count: s.count, digest: s.digest, updated: c.updated };
    },
    chats: async (pc, chats, gone) => {
      await h.replica().applyChats(pc.id, CLOUD_EPOCH, { chats, gone });
      h.copied(null);
    },
    items: (pc, hid, count, items) => {
      h.replica().applyItems(pc, CLOUD_EPOCH, hid, { count, items: [...items].map(([seq, it]) => ({ seq, item: JSON.parse(itemJson(it)) as unknown })) });
    },
    projects: (pc, list) => {
      const r = h.replica();
      for (const p of list) r.applyProject(pc.id, p);
      h.copied(null);
    },
    dropped: (pc, list) => {
      h.replica().applyDropped(pc.id, parseDropped(list));
      h.copied(null);
    },
    ownGids: () => new Map(h.store.chats().flatMap((c) => (c.home === "" && c.gid !== "" ? [[c.gid, c.updated] as [string, number]] : []))),
  };
  const s = h.syncing;
  const watch: CloudWatch | undefined = s && {
    stale: () => s.boot("the first sync after signing in"),
    pulled: () => s.pulled(),
    behind: (list) => s.behind(behindChats(h, list)),
  };
  return new ChatCloud({ stateDir: h.stateDir, fp: h.fp, meId: () => h.hub.mesh.me.id, source, sink, log: h.log, clock: h.clock, chunkItems: h.chunkItems, pokeMs: h.pokeMs, watch });
}

/** The chats here the cloud's newer versions are of: a copy by its PC and id there, this PC's own by its gid. */
function behindChats(h: CloudSyncHost, list: readonly CloudBehind[]): Map<number, { key: string; why: string }> {
  const out = new Map<number, { key: string; why: string }>();
  for (const b of list) {
    if (b.gid !== "") {
      const id = h.store.chatIdByGid(b.gid);
      if (id !== null) out.set(id, { key: b.key, why: `${h.hub.mesh.nameOf(b.pc)} went on with it` });
      continue;
    }
    const id = h.hub.mesh.localId(b.pc, b.hid);
    if (id !== null) out.set(id, { key: b.key, why: "a newer version is coming from the cloud" });
  }
  return out;
}

/** The workspace cloud's log: everything with HARBOR_ACCOUNT_LOG=1, else its problems only, each once an hour (a sync that stopped shows in the journal). */
export function cloudLog(all: boolean, write: (line: string) => void = (l) => process.stderr.write(l), clock: () => number = Date.now): (line: string) => void {
  const seen = new Map<string, number>();
  return (line) => {
    if (!all) {
      if (!/^(sync:|couldn't|reading |carrying|the workspace's room|a row of this PC's|the account service has no)/.test(line)) return;
      const now = clock();
      const at = seen.get(line);
      if (at !== undefined && now - at < 3_600_000) return;
      if (seen.size > 200) seen.clear();
      seen.set(line, now);
    }
    write(`harbor: cloud: ${line}\n`);
  };
}
