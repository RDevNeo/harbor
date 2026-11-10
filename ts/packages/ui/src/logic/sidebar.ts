import { NO_PLACEMENT, type Placement, sidebartree } from "@harbor/store";
import type { IconName } from "../icons.ts";
import { ago } from "./app.ts";
import { dayLabel, divEuclid, remEuclid } from "./cost.ts";
import { parseInt64 } from "./item.ts";
import { when } from "./limits.ts";
import { isAsciiDigit, isAlnum, isSpace } from "./text.ts";

export type Role = "lead" | "sub" | "chat";

export type SidebarChat = sidebartree.SidebarChat;
/** The fields of a store `Repo` the sidebar reads. */
export interface SidebarRepo {
  id: number;
  name: string;
}

/** An account workspace (account.rs `Workspace`). */
export interface Workspace {
  id: string;
  name: string;
}

export type Place = sidebartree.Place;
export type PlacedChat = sidebartree.PlacedChat;
export type Tree = sidebartree.Tree;
export const { carriedProjects, isMainOf, movedTo, sharedWith, tree } = sidebartree;

/** The sidebar's default width (px) and the bounds app.slint holds a dragged one to. */
export const SIDEBAR_W = 256;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_W_KEY = "sidebar_width";

/** The width a stored value names, held to the bounds; anything else is the default. */
export function parseSidebarWidth(v: string | null | undefined): number {
  const n = Number(v ?? "");
  if (v == null || v === "" || !Number.isFinite(n)) return SIDEBAR_W;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));
}

/** What's picked of the workspace filter `stored` (ids joined by commas) among `all`: gone ids drop out, and none is All (empty). Every one isn't All: a PC in no workspace shows only under All. */
export function picked(stored: string, all: readonly Workspace[]): string[] {
  const want = stored.split(",");
  return all.filter((w) => want.includes(w.id)).map((w) => w.id);
}

/** The workspace filter `stored` with workspace `id` turned on or off. */
export function toggled(stored: string, id: string, all: readonly Workspace[]): string {
  const on = picked(stored, all);
  const i = on.indexOf(id);
  if (i >= 0) on.splice(i, 1);
  else on.push(id);
  return picked(on.join(","), all).join(",");
}

/**
 * What's left of `t` under the workspace filter on `ws`. A chat is where Move to workspace… put it
 * (`place`: its own, its lead's, its project's), else in its home PC's workspace (`mine` for this
 * PC's, `pcs` for the others'). A project is in the workspace it was moved to, else its PC's
 * (`pcOf`: the PC its folder is on, see `projectWorkspace`); it also shows in another while one of
 * its unsettled leads is there.
 */
export function inWorkspaces(
  t: Tree,
  ws: readonly string[],
  mine: string,
  pcs: ReadonlyMap<string, string>,
  chats: readonly (SidebarChat & { parent: number | null })[],
  place: Placement = NO_PLACEMENT,
  pcOf: (repo: number) => string | null = () => null,
): Tree {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const shown = (w: string) => ws.includes(w);
  // Its own workspace, or one it's shared with (Share with workspace…: its own shares, its lead's, its project's).
  const ours = chats.filter((c) => shown(chatWorkspace(c, (id) => byId.get(id), place, mine, pcs)) || sharedWith(c, (id) => byId.get(id), place).all.some(shown));
  const ids = new Set(ours.map((c) => c.id));
  const repos = new Set(ours.filter((c) => !c.settled && c.role === "lead" && c.repoId !== null).map((c) => c.repoId));
  const keep = (list: number[]) => list.filter((c) => ids.has(c));
  const carried = carriedProjects(chats, place);
  const own = (p: number) => shown(projectWorkspace(p, place, pcOf(p), mine, pcs, carried)) || (place.shared?.repos.get(p) ?? []).some(shown);
  return {
    projects: t.projects.filter((p) => own(p.id) || repos.has(p.id)).map((p) => ({ ...p, chats: keep(p.chats) })),
    threads: keep(t.threads),
    settled: keep(t.settled),
    settledProjects: t.settledProjects.filter((p) => own(p) || ours.some((c) => c.repoId === p)),
  };
}

/**
 * The workspace project `id` shows in: where Move to workspace… put it (here, or as its PC says it
 * in its chats' copies, `carried`), else the workspace of the PC its folder is on. `pc` is that PC:
 * null for this one (`mine`), a mesh id for another (`pcs`), "" when none is known; another PC's
 * project, or one whose PC is in no workspace known here, is in none ("": shown only under All).
 */
export function projectWorkspace(id: number, place: Placement, pc: string | null, mine: string, pcs: ReadonlyMap<string, string>, carried: ReadonlyMap<number, string> = new Map()): string {
  const moved = place.repos.get(id) ?? "";
  if (moved !== "") return moved;
  if (pc === null) return mine;
  const theirs = carried.get(id) ?? "";
  if (theirs !== "") return theirs;
  return pc === "" ? "" : (pcs.get(pc) ?? "");
}

/** The workspace chat `c` shows in: where it was moved, else its home PC's ("" for a PC in none). */
export function chatWorkspace<C extends PlacedChat>(c: C, chat: (id: number) => C | undefined, place: Placement, mine: string, pcs: ReadonlyMap<string, string>): string {
  const moved = movedTo(c, chat, place);
  if (moved !== "") return moved;
  return c.home === "" ? mine : (pcs.get(c.home) ?? "");
}

/** One row of a Move to workspace… menu: picking it stores `id` as the item's own workspace ("": none, `base` applies). */
export interface MoveItem {
  id: string;
  /** The workspace it ends up in. */
  to: string;
  label: string;
  hint: string;
  /** It's there now. */
  on: boolean;
  /** The row back to its PC's workspace. */
  back: boolean;
}

/**
 * Move to workspace… for a chat or project: the account's workspaces with the one it's in now
 * ticked, then, when it's away from its PC's workspace `pcWs`, a row back to it. `own` is the
 * item's own assignment, `base` where it is without one (a chat: its project's or its PC's; a
 * project: its PC's): a pick of `base` clears `own`. `why` says why there's nothing to pick (no
 * account, a single workspace); the item is then greyed with it.
 */
export function moveMenu(all: readonly Workspace[], own: string, base: string, pcWs: string, pcName: string): { why: string | null; items: MoveItem[] } {
  if (all.length === 0) return { why: "Sign in with Google in Settings › Account to use workspaces", items: [] };
  if (all.length === 1) return { why: "Your account has one workspace: add or join another in Settings › Account", items: [] };
  const now = own !== "" ? own : base;
  const store = (to: string) => (to === base ? "" : to);
  const items: MoveItem[] = all.map((w) => ({ id: store(w.id), to: w.id, label: w.name, hint: w.id === pcWs ? `${pcName}'s Workspace` : "", on: w.id === now, back: false }));
  if (pcWs !== "" && now !== pcWs) {
    const home = all.find((w) => w.id === pcWs);
    items.push({ id: store(pcWs), to: pcWs, label: home ? `Back to ${home.name}` : `Back to ${pcName}'s Workspace`, hint: "Where its PC is", on: false, back: true });
  }
  return { why: null, items };
}

/** The notice after a move: "Moved to Team workspace". */
export function movedNotice(all: readonly Workspace[], to: string): string {
  const name = all.find((w) => w.id === to)?.name ?? "";
  if (name === "") return "Moved back to its PC's workspace";
  return /workspace/i.test(name) ? `Moved to ${name}` : `Moved to the workspace ${name}`;
}

/** One row of a Share with workspace… checklist. */
export interface ShareItem {
  id: string;
  label: string;
  hint: string;
  /** It shows there now (owner, shared with its project, or shared on its own). */
  on: boolean;
  /** The workspace it's in (Move to workspace… or its PC's): shown, not a toggle. */
  owner: boolean;
  /** Shared through its project: a toggle of the project's, not this chat's. */
  locked: boolean;
}

const NO_ACCOUNT = "Sign in with Google in Settings › Account to use workspaces";
const ONE_WORKSPACE = "Your account has one workspace: add or join another in Settings › Account";

/** A workspace's name for the menus ("its PC's workspace" when the account doesn't list it, "no workspace" for none). */
export function workspaceName(all: readonly Workspace[], id: string): string {
  if (id === "") return "no workspace";
  return all.find((w) => w.id === id)?.name ?? "a workspace of another account";
}

/**
 * Share with workspace… for a chat or project: every workspace of the account, the one it's in
 * (`owner`) shown as the owner and not a toggle, the ones its project shares it with (`inherited`)
 * ticked and locked, the rest ticked when shared on its own (`own`). Greyed with `why` like Move.
 */
export function shareMenu(all: readonly Workspace[], owner: string, own: readonly string[], inherited: readonly string[] = []): { why: string | null; line: string; items: ShareItem[] } {
  const line = shareLine(all, owner, [...own, ...inherited]);
  if (all.length === 0) return { why: NO_ACCOUNT, line, items: [] };
  if (all.length === 1) return { why: ONE_WORKSPACE, line, items: [] };
  const items = all.map((w): ShareItem => {
    if (w.id === owner) return { id: w.id, label: w.name, hint: "Owner: it's in this workspace", on: true, owner: true, locked: false };
    if (inherited.includes(w.id)) return { id: w.id, label: w.name, hint: "Shared with its project", on: true, owner: false, locked: true };
    return { id: w.id, label: w.name, hint: "", on: own.includes(w.id), owner: false, locked: false };
  });
  return { why: null, line, items };
}

/** "Owned by Sam's workspace · shared with Team" (the owner never counts as a share). */
export function shareLine(all: readonly Workspace[], owner: string, shares: readonly string[]): string {
  const others = [...new Set(shares)].filter((s) => s !== owner);
  const head = `Owned by ${workspaceName(all, owner)}`;
  return others.length === 0 ? `${head} · not shared` : `${head} · shared with ${others.map((s) => workspaceName(all, s)).join(", ")}`;
}

/** The notice after a tick in Share with workspace…. */
export function sharedNotice(all: readonly Workspace[], id: string, on: boolean): string {
  return on ? `Shared with ${workspaceName(all, id)}` : `No longer shared with ${workspaceName(all, id)}`;
}

/**
 * A row's shared mark: "" (not shared), "shared", or "here" when the filter `picked` shows it only
 * because it's shared with a picked workspace (its owner isn't picked); `tip` says owner and shares.
 */
export function shareMark(all: readonly Workspace[], owner: string, shares: readonly string[], picked: readonly string[]): { shared: "" | "shared" | "here"; shared_tip: string } {
  const others = shares.filter((s) => s !== owner);
  if (others.length === 0) return { shared: "", shared_tip: "" };
  const line = shareLine(all, owner, others);
  const here = picked.length > 0 && !picked.includes(owner) && others.some((s) => picked.includes(s));
  return here ? { shared: "here", shared_tip: `Shown here because it's shared. ${line}` } : { shared: "shared", shared_tip: line };
}

/** Last activity of a project: its newest chat's update. */
export function activity(repo: number, chats: readonly SidebarChat[]): number {
  return chats.filter((c) => c.repoId === repo).reduce((m, c) => Math.max(m, c.updated), 0);
}

/** The projects' ids in the sidebar's order: by hand (as given), or by last activity. */
export function sidebarOrder(repos: readonly SidebarRepo[], byActivity: boolean, chats: readonly SidebarChat[]): number[] {
  const ids = repos.map((r) => r.id);
  return byActivity ? ids.map((id) => [id, activity(id, chats)] as const).sort((a, b) => b[1] - a[1]).map(([id]) => id) : ids;
}

/** sidebar.rs `move_project`: the shown projects' order with `dragged` dropped above or below `target`. */
export function reordered(shown: readonly number[], dragged: number, target: number, above: boolean): number[] {
  const order = [...shown];
  const from = order.indexOf(dragged);
  const at = order.indexOf(target);
  if (from < 0 || at < 0) return order;
  const to = above ? at : at + 1;
  order.splice(from, 1);
  order.splice(Math.min(to > from ? to - 1 : to, order.length), 0, dragged);
  return order;
}

/** A project as the list draws it: the repo and the chat rows under it. */
export interface ProjectRows<C> {
  repo: SidebarRepo;
  chats: C[];
}

/** What the sidebar lists for search `query`: projects with their chat rows, Threads, Settled. Snoozed chats and projects stay in their places. */
export function sidebarList<C extends SidebarChat>(t: Tree, chats: readonly C[], repos: readonly SidebarRepo[], query: string): { projects: ProjectRows<C>[]; loose: C[]; settled: C[]; settledProjects: SidebarRepo[] } {
  const q = query.trim().toLowerCase();
  const chat = (id: number) => chats.find((c) => c.id === id);
  const all = (ids: readonly number[]) => ids.map(chat).filter((c): c is C => c !== undefined);
  const matches = (c: C) => q === "" || c.title.toLowerCase().includes(q);
  const projects: ProjectRows<C>[] = [];
  for (const p of t.projects) {
    const repo = repos.find((r) => r.id === p.id);
    if (!repo) continue;
    // A search finds a project by its name, or its main chat's title.
    const m = p.main === null ? undefined : chat(p.main);
    const named = repo.name.toLowerCase().includes(q) || (m !== undefined && q !== "" && matches(m));
    const cs = all(p.chats).filter((c) => named || matches(c));
    if (q === "" || named || cs.length > 0) projects.push({ repo, chats: cs });
  }
  const settledProjects = t.settledProjects.map((id) => repos.find((r) => r.id === id)).filter((r): r is SidebarRepo => r !== undefined && (q === "" || r.name.toLowerCase().includes(q)));
  return { projects, loose: all(t.threads).filter(matches), settled: all(t.settled), settledProjects };
}

/** A sidebar row as Alt+Up / Alt+Down walk them: `kind` is SideRow's ("project", "thread", "loose", "label", "settled-project"). */
export interface StepRow {
  kind: string;
  id: number;
  active: boolean;
}

/** Row kinds that open something when clicked: a project's main chat (or its page) or a chat. */
const OPENABLE: ReadonlySet<string> = new Set(["project", "thread", "loose", "settled-project"]);

/**
 * The row Alt+Up (`dir` -1) or Alt+Down (1) opens: the next openable row from the open one, in the sidebar's order
 * (pass the Settled rows after the others only while that section is open). Null at either end (no wrap-around).
 * With no row open (a new chat, Settings), Down goes to the first row and Up to the last.
 */
export function stepRow<R extends StepRow>(rows: readonly R[], dir: 1 | -1): R | null {
  const list = rows.filter((r) => OPENABLE.has(r.kind));
  const at = list.findIndex((r) => r.active);
  if (at < 0) return (dir > 0 ? list[0] : list.at(-1)) ?? null;
  return list[at + dir] ?? null;
}

/** Whether projects can be dragged into another order: by hand, with every one of them listed. */
export function canReorder(byActivity: boolean, query: string, shownWorkspaces: readonly string[]): boolean {
  return !byActivity && query.trim() === "" && shownWorkspaces.length === 0;
}

/** The manual order after dragging `dragged` to position `to` among `visible`; null when it isn't there. */
export function moveProject(visible: readonly number[], dragged: number, to: number): number[] | null {
  const order = [...visible];
  const from = order.indexOf(dragged);
  if (from < 0) return null;
  order.splice(from, 1);
  order.splice(Math.min(to > from ? to - 1 : to, order.length), 0, dragged);
  return order;
}

/** What the empty project list says, or null when it says nothing. */
export function emptyList(shownNames: readonly string[], filtered: boolean, query: string, looseEmpty: boolean, settledCount: number): { icon: IconName; title: string; text: string; action: string | null } | null {
  const q = query.trim();
  if (filtered && q === "") {
    if (!looseEmpty || settledCount > 0) return null;
    const of = shownNames.length === 1 ? (shownNames[0] ?? "") : "these workspaces";
    return { icon: "USERS", title: "Nothing here", text: `No chats of ${of} reach this PC.`, action: "Show all" };
  }
  if (q === "") return { icon: "FOLDER_PLUS", title: "No projects yet", text: "Add a folder or clone a repository to start.", action: "Add project" };
  return { icon: "SEARCH", title: "No match", text: "", action: null };
}

/** The workspace button's tip. */
export function workspaceTip(shownNames: readonly string[]): string {
  return shownNames.length === 0 ? "Workspace" : `Workspace: ${shownNames.join(", ")}`;
}

/** One row of the workspace menu; `pick` is the filter a click stores. */
export interface WorkspaceItem {
  icon: IconName;
  label: string;
  hint: string | null;
  on: boolean;
  pick: string;
}

/** The workspace menu, a checklist: All, then the account's workspaces. */
export function workspaceMenu(stored: string, all: readonly Workspace[], mine: string): WorkspaceItem[] {
  const shown = picked(stored, all);
  return [
    { icon: "LAYERS", label: "All", hint: "Every chat on this PC", on: shown.length === 0, pick: "" },
    ...all.map((w): WorkspaceItem => ({ icon: "USERS", label: w.name, hint: w.id === mine ? "This PC's workspace" : null, on: shown.includes(w.id), pick: toggled(stored, w.id, all) })),
  ];
}

/** The footer's count of running turns, "" for none. */
export function runningLabel(n: number): string {
  return n > 0 ? `${n} running` : "";
}

/** The Settled section's chevron. */
export function settledChevron(open: boolean): IconName {
  return open ? "DOWN" : "UP";
}


/** A row's status on its right (widgets.rs `Status`). */
export type Status =
  | { kind: "working"; secs: number }
  | { kind: "text"; icon: IconName | null; text: string; color: string }
  | { kind: "failed" }
  | { kind: "done" }
  /** Its own turn is done but something will wake it (agents waiting.ts): "Waiting", amber. */
  | { kind: "waiting"; text: string };

/** What a chat's own status is made of (it and its subagents'). */
export interface StatusFacts {
  /** Seconds since its team's running turn started; null when none runs. */
  working: number | null;
  /** Waiting out a usage limit: when it lifts (null: unknown). */
  paused: { at: number | null } | null;
  /** Someone on another device is writing in it. */
  typing: boolean;
  /** Another PC has it open. */
  viewed: boolean;
  failed: boolean;
  /** What wakes it again (a process, subagent, wake-up or key asked: "2 processes"), null for nothing. */
  waiting?: string | null;
  unread: boolean;
}

/** A chat's own status: working, waiting on a limit, written in or open elsewhere, failed, waiting on what wakes it, done until opened, else `idle`. */
export function ownStatus(f: StatusFacts, idle: Status, now: number, off: number): Status {
  if (f.working !== null) return { kind: "working", secs: f.working };
  if (f.paused) return { kind: "text", icon: "CLOCK", text: f.paused.at === null ? "limit" : when(f.paused.at, now, off), color: "amber-900" };
  if (f.typing) return { kind: "text", icon: "PEN_LINE", text: "", color: "blue-900" };
  if (f.viewed) return { kind: "text", icon: null, text: "●", color: "blue-900" };
  if (f.failed) return { kind: "failed" };
  if (f.waiting != null) return { kind: "waiting", text: f.waiting };
  if (f.unread) return { kind: "done" };
  return idle;
}

/** A chat row's idle status: when a snoozed one wakes (`snoozeLabel`), else when it was last active. */
export function chatIdle(snoozeLabel: string | null, updated: number, now: number): Status {
  return snoozeLabel === null ? { kind: "text", icon: null, text: ago(updated, now), color: "gray-800" } : { kind: "text", icon: "CLOCK", text: snoozeLabel, color: "gray-800" };
}

/** A project row's idle status: when a snoozed one wakes (`snoozeLabel`), else an alarm while one of its chats has a wake-up, else nothing. */
export function projectIdle(wakeUps: boolean, snoozeLabel: string | null = null): Status {
  if (snoozeLabel !== null) return { kind: "text", icon: "CLOCK", text: snoozeLabel, color: "gray-800" };
  return wakeUps ? { kind: "text", icon: "ALARM", text: "", color: "subtle" } : { kind: "text", icon: null, text: "", color: "gray-800" };
}

/** A chat in its own worktree: its mark after the title. */
export function worktreeMark(name: string, gone: boolean, active: boolean): { icon: IconName; color: string; tip: string } {
  return {
    icon: "FOLDER_GIT",
    color: gone ? "red-900" : active ? "fg" : "subtle",
    tip: gone ? `Its worktree, ${name}, is gone` : `Runs in its own worktree, ${name}`,
  };
}

/** A row's hover actions: Settle or Unsettle for chats (`settled` null for projects), and snooze unless settled. */
export function rowActions(settled: boolean | null): { settle: { icon: IconName; label: string } | null; snooze: boolean } {
  return {
    settle: settled === null ? null : settled ? { icon: "UNARCHIVE", label: "Unsettle" } : { icon: "CHECK", label: "Settle" },
    snooze: settled !== true,
  };
}

/** A chat row's context menu: its Settle entry, whether it can become the main chat and move to another project. */
export function chatMenu(c: SidebarChat, repoKnown: boolean): { settle: string; makeMain: boolean; move: boolean } {
  return { settle: c.settled ? "Unsettle" : "Settle", makeMain: c.role === "lead" && c.repoId !== null && repoKnown, move: c.role !== "sub" };
}

/** A project without an icon: its first letter or digit, upper case. */
export function projectInitial(name: string): string {
  for (const c of name) if (isAlnum(c)) return c.toUpperCase();
  return "";
}


/** When a snooze ("c<chat>" / "r<project>") ends, while it hasn't yet. */
export function snoozeUntil(snoozed: ReadonlyMap<string, number>, key: string, now: number): number | null {
  const u = snoozed.get(key);
  return u !== undefined && u > now ? u : null;
}

/** The snoozes due at `now`: their keys, the chats they wake (marked unread), and the seconds until the next of the others (1–60), null for none. */
export function dueSnoozes(snoozed: ReadonlyMap<string, number>, now: number): { due: string[]; woken: number[]; next: number | null } {
  const due: string[] = [];
  const woken: number[] = [];
  let next: number | null = null;
  for (const [k, u] of snoozed) {
    if (u <= now) {
      due.push(k);
      const id = k.startsWith("c") ? parseInt64(k.slice(1)) : null;
      if (id !== null) woken.push(id);
    } else next = next === null ? u : Math.min(next, u);
  }
  return { due, woken, next: next === null ? null : Math.min(60, Math.max(1, next - now)) };
}

/** The snooze menu's presets, [label, until]; `off` is the local zone's UTC offset. */
export function snoozePresets(now: number, off: number): [string, number][] {
  // Tomorrow 9:00 local time.
  const tomorrow = now - remEuclid(now + off, 86400) + 86400 + 9 * 3600;
  return [
    ["1 hour", now + 3600],
    ["3 hours", now + 3 * 3600],
    ["Tomorrow, 9:00", tomorrow],
    ["Next week", tomorrow + 6 * 86400],
  ];
}

/** What the snooze menu says under its custom field: when the typed snooze ends, or what reads as a time; "" while it's empty. */
export function snoozePreview(text: string, now: number, off: number): [number | null, string] {
  const u = parseSnooze(text, now, off);
  if (u !== null) return [u, `until ${snoozeLabel(u, now, off)}`];
  return [null, text.trim() === "" ? "" : "Try 5h, 1h30m, 2d or 18:00"];
}

/** When a snooze typed by hand ends (unix s): a duration ("5h", "1h30", "1.5h", "2d", "1w"; a bare number is hours) or the next local clock time ("18:00", "6:30pm", "at 9"). Null for anything else, under a minute or over a year. */
export function parseSnooze(text: string, now: number, off: number): number | null {
  const s = [...text]
    .filter((c) => !isSpace(c))
    .join("")
    .toLowerCase();
  if (s.startsWith("at")) {
    const t = clockTime(s.slice(2), true);
    return t === null ? null : nextLocal(t, now, off);
  }
  const t = clockTime(s, false);
  if (t !== null) return nextLocal(t, now, off);
  const secs = duration(s.startsWith("in") ? s.slice(2) : s);
  return secs !== null && secs >= 60 && secs <= 365 * 86400 ? now + secs : null;
}

/** Seconds after local midnight for "18:00", "6:30pm", "9am" (and a bare "9" when `bare`). */
function clockTime(text: string, bare: boolean): number | null {
  let s = text;
  let half: number | null = null;
  if (s.endsWith("am")) [s, half] = [s.slice(0, -2), 0];
  else if (s.endsWith("pm")) [s, half] = [s.slice(0, -2), 12];
  const colon = s.indexOf(":");
  let h: string;
  let m: string;
  if (colon >= 0) {
    [h, m] = [s.slice(0, colon), s.slice(colon + 1)];
    if (m.length !== 2) return null;
  } else if (half !== null || bare) [h, m] = [s, "0"];
  else return null;
  const digits = (x: string) => x.length > 0 && x.length <= 2 && [...x].every(isAsciiDigit);
  if (!digits(h) || !digits(m)) return null;
  const [hh, mm] = [Number(h), Number(m)];
  let hour: number;
  if (half !== null) {
    if (hh < 1 || hh > 12) return null;
    hour = (hh % 12) + half;
  } else if (hh < 24) hour = hh;
  else return null;
  return mm < 60 ? hour * 3600 + mm * 60 : null;
}

/** The next moment local clock time `t` comes round after `now`. */
function nextLocal(t: number, now: number, off: number): number {
  const ahead = t - remEuclid(now + off, 86400);
  return now + (ahead > 0 ? ahead : ahead + 86400);
}

const UNITS: [readonly string[], number][] = [
  [["m", "min", "mins", "minute", "minutes"], 60],
  [["h", "hr", "hrs", "hour", "hours"], 3600],
  [["d", "day", "days"], 86400],
  [["w", "wk", "week", "weeks"], 604800],
];

/** Seconds in "1h30m", "90m", "1.5h", "2d", "1w": a bare number is hours, and one after hours is minutes ("1h30"). */
function duration(s: string): number | null {
  let rest = s;
  let total = 0;
  let last = 0;
  while (rest !== "") {
    const n = /^[0-9.]*/.exec(rest)?.[0].length ?? 0;
    const num = rest.slice(0, n);
    const tail0 = rest.slice(n);
    const u = /^[^0-9.]*/.exec(tail0)?.[0].length ?? 0;
    const unit = tail0.slice(0, u);
    const tail = tail0.slice(u);
    if (!/^([0-9]+\.?[0-9]*|\.[0-9]+)$/.test(num)) return null;
    let size = UNITS.find(([names]) => names.includes(unit))?.[1] ?? null;
    if (size === null && unit === "" && tail === "" && last === 0) size = 3600;
    else if (size === null && unit === "" && tail === "" && last === 3600) size = 60;
    if (size === null) return null;
    total += Number(num) * size;
    last = size;
    rest = tail;
  }
  return Number.isFinite(total) ? Math.round(total) : null;
}

export const { snoozeLabel, snoozedLabel } = sidebartree;
