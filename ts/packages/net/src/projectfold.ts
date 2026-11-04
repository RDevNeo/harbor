import { statSync } from "node:fs";
import { type Repo, repoDir, type Store } from "@harbor/store";
import { cloneSame, homeRelative } from "./clone.ts";

/**
 * One project, one row: another PC's project (listed here from its chats' copies, its folder that
 * PC's) and a folder of it on this PC are the same project, shown and kept as one. Which folder of
 * this PC is "a folder of it" is the rule Harbor itself clones by: the same Git remote; for a
 * project without Git, the same name in the same place under the home folder (where a clone or a
 * copy of it would go here, clone.ts `homeRelative`).
 *
 * Added here while the other PC's is listed: the other PC's project takes the folder as its
 * `local` (no second row). Listed twice already (the folder was added first, or before 0.137): at
 * start, this PC's project stays (its path is what this PC's chats, phones and peers know it by)
 * and the other PC's folds into it, chats and all; it takes that PC's move and shares when they
 * put the project in this PC's workspace (a project shared with you shows as shared).
 */

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** origin's URL of the repository in `dir` ("" without one). */
export function gitRemote(dir: string): string {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

/** Whether this PC's folder `dir` (Git remote `remote`, "" none) is a folder of project `away`, another PC's. */
export function folderOf(away: Pick<Repo, "path" | "name" | "remote">, dir: string, remote: string, home: string): boolean {
  if (away.remote !== "" || remote !== "") return away.remote !== "" && remote !== "" && cloneSame(away.remote, remote);
  const base = dir.replace(/\/+$/, "").split("/").pop() ?? "";
  return base === away.name && homeRelative(away.path, home, away.name) === dir.replace(/\/+$/, "");
}

/** Another PC's project known here only by its copies: its folder isn't on this PC and the mesh says whose it is. */
function away(store: Store, r: Repo, here: (dir: string) => boolean): boolean {
  return r.local === null && !here(r.path) && store.projectPc(r.id) !== "";
}

/** The project of another PC that this PC's folder `dir` is a folder of: exactly one, else null. */
export function awayProjectOf(store: Store, dir: string, remote: string, home: string, here: (dir: string) => boolean = isDir): Repo | null {
  const found = store.repos().filter((r) => away(store, r, here) && folderOf(r, dir, remote, home));
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * Folder `dir` as a project here: the one it already is, the project of another PC it's a folder
 * of (its folder here from now on), or a new one. `remote` is its Git remote ("" none).
 */
export function addFolder(store: Store, dir: string, remote: string, home: string, here: (dir: string) => boolean = isDir): number {
  const known = store.repos().find((r) => repoDir(r) === dir || r.path === dir);
  if (known) return known.id;
  const theirs = awayProjectOf(store, dir, remote, home, here);
  if (theirs) {
    store.setRepoLocal(theirs.id, dir);
    return theirs.id;
  }
  const id = store.addRepo(dir);
  if (remote !== "") store.setRepoRemote(id, remote);
  return id;
}

/**
 * Projects listed twice, folded into one (at start, before anything reads them): another PC's
 * project that a project of this PC is a folder of joins it. Returns the pairs folded, [the other
 * PC's, this PC's].
 */
export function foldProjects(store: Store, home: string, here: (dir: string) => boolean = isDir): [number, number][] {
  const done: [number, number][] = [];
  const ws = store.get("account_ws") ?? "";
  const place = store.placement();
  for (const mine of store.repos()) {
    if (mine.local !== null || !here(mine.path)) continue;
    const theirs = awayProjectOf(store, mine.path, mine.remote, home, here);
    if (!theirs || theirs.id === mine.id) continue;
    const toUs = ws !== "" && (place.repos.get(theirs.id) === ws || (place.shared?.repos.get(theirs.id) ?? []).includes(ws));
    store.foldRepo(theirs.id, mine.id, toUs);
    done.push([theirs.id, mine.id]);
  }
  return done;
}

/** What `takesMainFrom` weighs for one project and one peer. */
export interface MainFrom {
  /** The PC holding the project's folder when it isn't on this PC (a mesh id, "" not known); null: it's here. */
  away: string | null;
  /** The peer that names a main chat for it. */
  peer: string;
  /** This PC's workspace and the peer's ("" none known). */
  mine: string;
  peerWs: string;
  /** The project's Move to workspace… ("" none) and Share with workspace… as this PC has them. */
  moved: string;
  shares: readonly string[];
}

/**
 * Whether this PC's row of a project opens the main chat `peer` has for it: a project's main chat is
 * its owner's, the same chat on every PC it's shown on. Another PC's project (its folder isn't here):
 * the main chat of the PC its folder is on. A project here too (one folded with that PC's: the same
 * remote, or the same name): only when it reached this PC's workspace through the peer, i.e. it's
 * further into this PC's workspace than into the peer's. Moving puts a project in another workspace
 * than its owner's (that workspace's PCs are the furthest), sharing adds other workspaces (their PCs
 * next; the owner may share it back with their own), and the owner's own workspace is neither.
 * Otherwise each PC keeps its own main chat.
 */
export function takesMainFrom(o: MainFrom): boolean {
  if (o.away !== null) return o.away !== "" && o.away === o.peer;
  if (o.moved === "" && o.shares.length === 0) return false;
  const depth = (ws: string): number => (ws === "" ? -1 : ws === o.moved ? 2 : o.shares.includes(ws) ? 1 : 0);
  return o.peerWs !== "" && depth(o.mine) > 0 && depth(o.mine) > depth(o.peerWs);
}
