import { dayLabel } from "./cost.ts";
import type { Placement, Role } from "./store.ts";

const divEuclid = (a: number, b: number): number => Math.floor(a / b);
const remEuclid = (a: number, b: number): number => ((a % b) + b) % b;

/** The fields of a store `Chat` the sidebar reads. */
export interface SidebarChat {
  id: number;
  repoId: number | null;
  title: string;
  settled: boolean;
  updated: number;
  role: Role;
  /** The PC whose Harbor owns the chat; "" is this one. */
  home: string;
}

/** A chat as Move to workspace… places it: a sub-agent follows its lead. */
export type PlacedChat = Pick<SidebarChat, "id" | "role" | "repoId" | "home"> & { parent: number | null };

/**
 * The workspace Move to workspace… put chat `c` in, "" for none (its home PC's applies): its own,
 * else its project's (a copy's as its home PC says it, and only when that PC is this owner's:
 * another person's chats stay in their PC's workspace); a sub-agent's is its lead's.
 */
export function movedTo<C extends PlacedChat>(c: C, chat: (id: number) => C | undefined, p: Placement): string {
  let x = c;
  for (let hop = 0; hop < 8 && x.role === "sub" && x.parent !== null; hop++) {
    const lead = chat(x.parent);
    if (!lead) break;
    x = lead;
  }
  const own = p.chats.get(x.id);
  if (own !== undefined) return own;
  if (x.home !== "") return follows(x, p) ? (p.carried.get(x.id) ?? "") : "";
  return x.repoId === null ? "" : (p.repos.get(x.repoId) ?? "");
}

/** Each project's workspace as its PC says it, from the copies of its chats (`place.carried`). */
export function carriedProjects(chats: readonly Pick<SidebarChat, "id" | "repoId" | "home">[], place: Placement): Map<number, string> {
  const out = new Map<number, string>();
  if (place.carried.size === 0) return out;
  for (const c of chats) {
    if (c.home === "" || c.repoId === null || out.has(c.repoId)) continue;
    const w = place.carried.get(c.id) ?? "";
    if (w !== "") out.set(c.repoId, w);
  }
  return out;
}

/** Whether copy `c` follows its project's move and shares: a chat of another PC of this PC's owner (`Placement.mates`), not someone else's. */
function follows(c: Pick<SidebarChat, "home">, p: Placement): boolean {
  return p.mates?.has(c.home) === true;
}

function leadOf<C extends PlacedChat>(c: C, chat: (id: number) => C | undefined): C {
  let x = c;
  for (let hop = 0; hop < 8 && x.role === "sub" && x.parent !== null; hop++) {
    const lead = chat(x.parent);
    if (!lead) break;
    x = lead;
  }
  return x;
}

/**
 * The workspaces Share with workspace… shares chat `c` with, besides the one it's in: its own
 * shares and its project's (a copy's as its home PC says them, only for this owner's PCs: a
 * project shared with you brings the project, not other people's chats in it); a sub-agent's are its lead's.
 * `inherited` is the project's part alone.
 */
export function sharedWith<C extends PlacedChat>(c: C, chat: (id: number) => C | undefined, p: Placement): { all: string[]; inherited: string[] } {
  const s = p.shared;
  if (!s) return { all: [], inherited: [] };
  const x = leadOf(c, chat);
  const inherited = [...((x.home !== "" ? (follows(x, p) ? s.carried.get(x.id) : undefined) : x.repoId === null ? undefined : s.repos.get(x.repoId)) ?? [])];
  return { all: [...new Set([...(s.chats.get(x.id) ?? []), ...inherited])], inherited };
}

/** A project in the sidebar `Tree`. */
export interface Place {
  id: number;
  /** Snoozed: it shows only while searching. */
  snoozed: boolean;
  /** Its main chat, drawn as the project row itself (in none of the lists). */
  main: number | null;
  /** Its other chats, each on a row of its own. */
  chats: number[];
}

/** Where every chat sits: projects in the sidebar's order, Threads (leads of no project here), Settled, and snoozed leads (shown only while searching). */
export interface Tree {
  projects: Place[];
  threads: number[];
  settled: number[];
  snoozed: number[];
  /** Settled projects, in the sidebar's order: under Settled, every chat of theirs too. */
  settledProjects: number[];
}

/** Whether `c` can be project `repo`'s main chat now: an unsettled lead of that project. */
export function isMainOf(c: SidebarChat | null | undefined, repo: number): boolean {
  return !!c && c.role === "lead" && c.repoId === repo && !c.settled;
}

/** The sidebar `Tree` of `chats` for `repos` (in the sidebar's order); `mains` is each project's stored main chat, `snoozed` takes "r<project>" and "c<chat>", `settledRepos` the settled projects. */
export function tree(repos: readonly number[], chats: readonly SidebarChat[], mains: ReadonlyMap<number, number>, snoozed: (key: string) => boolean, settledRepos: ReadonlySet<number> = new Set()): Tree {
  const leads = chats.filter((c) => c.role === "lead").sort((a, b) => b.updated - a.updated || b.id - a.id);
  const main = (r: number): number | null => {
    const m = mains.get(r);
    return m !== undefined && isMainOf(chats.find((c) => c.id === m), r) ? m : null;
  };
  const t: Tree = {
    projects: repos.filter((r) => !settledRepos.has(r)).map((r) => ({ id: r, snoozed: snoozed(`r${r}`), main: main(r), chats: [] })),
    threads: [],
    settled: [],
    snoozed: [],
    settledProjects: repos.filter((r) => settledRepos.has(r)),
  };
  for (const c of leads) {
    if (c.settled || (c.repoId !== null && settledRepos.has(c.repoId))) t.settled.push(c.id);
    else if (t.projects.some((p) => p.main === c.id)) {
      // The project row is the main chat.
    } else if (snoozed(`c${c.id}`)) t.snoozed.push(c.id);
    else {
      const p = t.projects.find((p) => p.id === c.repoId);
      if (p) p.chats.push(c.id);
      else t.threads.push(c.id);
    }
  }
  return t;
}


/** How the snooze menu names a time: "Today, 23:40", "Tomorrow, 9:00", "Thu, 14:00" within the week, "Mon 9 Nov, 14:00" after. */
export function snoozeLabel(until: number, now: number, off: number): string {
  const day = divEuclid(until + off, 86400);
  const t = remEuclid(until + off, 86400);
  const hm = `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`;
  const date = dayLabel(day);
  const d = day - divEuclid(now + off, 86400);
  if (d === 0) return `Today, ${hm}`;
  if (d === 1) return `Tomorrow, ${hm}`;
  if (d >= 2 && d <= 6) return `${date.slice(0, 3)}, ${hm}`;
  return `${date}, ${hm}`;
}

/** When a snoozed chat wakes, as its row says it; null when it isn't snoozed. */
export function snoozedLabel(until: number | null, now: number, off: number): string | null {
  return until === null ? null : snoozeLabel(until, now, off);
}

/**
 * What of `chats` and `repos` shows (the desktop's sidebar and pages, the phone's state): chats homed on a PC this account
 * doesn't use (`has` false: account.ts `pcScope`) don't, nor do projects all of whose chats are such copies, unless the
 * project's folder is on this PC (`here`, asked only for those).
 */
export function inScope<C extends { home: string; repoId: number | null }, R extends { id: number }>(
  chats: readonly C[],
  repos: readonly R[],
  has: (home: string) => boolean,
  here: (repo: R) => boolean,
): { chats: C[]; repos: R[] } {
  const shown = chats.filter((c) => c.home === "" || has(c.home));
  if (shown.length === chats.length) return { chats: shown, repos: [...repos] };
  const visible = new Set<number>();
  for (const c of shown) if (c.repoId !== null) visible.add(c.repoId);
  const hidden = new Set<number>();
  for (const c of chats) if (c.repoId !== null && !visible.has(c.repoId)) hidden.add(c.repoId);
  return { chats: shown, repos: repos.filter((r) => !hidden.has(r.id) || here(r)) };
}
