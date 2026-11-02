import { dayLabel } from "./cost.ts";
import type { Role } from "./store.ts";

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
}

/** Whether `c` can be project `repo`'s main chat now: an unsettled lead of that project. */
export function isMainOf(c: SidebarChat | null | undefined, repo: number): boolean {
  return !!c && c.role === "lead" && c.repoId === repo && !c.settled;
}

/** The sidebar `Tree` of `chats` for `repos` (in the sidebar's order); `mains` is each project's stored main chat, `snoozed` takes "r<project>" and "c<chat>". */
export function tree(repos: readonly number[], chats: readonly SidebarChat[], mains: ReadonlyMap<number, number>, snoozed: (key: string) => boolean): Tree {
  const leads = chats.filter((c) => c.role === "lead").sort((a, b) => b.updated - a.updated || b.id - a.id);
  const main = (r: number): number | null => {
    const m = mains.get(r);
    return m !== undefined && isMainOf(chats.find((c) => c.id === m), r) ? m : null;
  };
  const t: Tree = { projects: repos.map((r) => ({ id: r, snoozed: snoozed(`r${r}`), main: main(r), chats: [] })), threads: [], settled: [], snoozed: [] };
  for (const c of leads) {
    if (c.settled) t.settled.push(c.id);
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
