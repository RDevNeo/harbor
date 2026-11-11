import { ICONS } from "../icons.ts";
import { richTip } from "./tips.ts";

/** `GET /v1/workspace` as the PC answers it (phoneroutes.ts `workspaceInfo`); the phone's WorkBar reads the same. */
export interface WsInfo {
  git: boolean;
  mode?: "worktree" | "checkout";
  name?: string | null;
  path?: string;
  branch?: string;
  dirty?: number;
  base?: string;
  can_move?: boolean;
  move_why?: string | null;
  branch_lock?: string | null;
  pending?: string | null;
  can_rename?: boolean;
  can_rename_folder?: boolean;
  rename_why?: string | null;
  pushed?: string | null;
  folder_waits?: string | null;
  folder_to?: string | null;
  folder_named?: boolean;
}

/** A chat's worktree as its home PC tells it (chat JSON `worktree`): null when it has none. */
export interface WsMarker {
  name: string;
  gone: boolean;
}

/** Its branch's pull request (chatpr.ts `prJson`). */
export interface WsPr {
  state: string;
  label: string;
  title: string;
  url: string;
}

export type Tone = "" | "red" | "green" | "purple" | "muted";

export interface BarChip {
  icon: string;
  text: string;
  tone: Tone;
  tip: string;
}

/** The footer under the composer (worktree.rs `workspace_bar`, the phone's WorkBar): where the agent works, its branch, its PR. */
export interface Bar {
  shown: boolean;
  ws: BarChip | null;
  branch: BarChip | null;
  pr: BarChip | null;
  /** The chips do something (the PC's own git): false for another PC's or a device's chat. */
  live: boolean;
}

const none: Bar = { shown: false, ws: null, branch: null, pr: null, live: false };

export function prChip(pr: WsPr | null): BarChip | null {
  if (pr === null) return null;
  const icon = pr.state === "merged" ? ICONS.GIT_MERGE : pr.state === "closed" ? ICONS.PR_CLOSED : pr.state === "draft" ? ICONS.PR_DRAFT : ICONS.PR_OPEN;
  const tone: Tone = pr.state === "merged" ? "purple" : pr.state === "closed" ? "red" : pr.state === "draft" ? "muted" : "green";
  return { icon, text: pr.label, tone, tip: pr.title === "" ? pr.url : richTip({ title: pr.title, sub: pr.url }) };
}

/**
 * The footer for `info` (null: not asked yet, or the PC didn't answer), as WorkBar.show: "Worktree gone" in red with no
 * branch; a read-only "Worktree · <name>" for a chat whose worktree isn't on this PC (another PC's, a device's); outside
 * Git (a plain folder, no project, a device) or before the PC said, "Folder · <name>" (and a PR it knows of); else "Current checkout" / "New worktree" / "Worktree · <name>" and the branch
 * ("from <base>" for a new chat's new worktree), or what git is doing ("Creating worktree…").
 */
export function workBar(info: WsInfo | null, o: { draft: boolean; marker: WsMarker | null; pr: WsPr | null; home: string; pending: { branch: boolean; what: string } | null; folder?: string }): Bar {
  const pr = prChip(o.pr);
  // Not Git (a plain folder, no project, an SSH device), or the PC hasn't said yet: the folder it runs in, so the row is
  // always there and says where the agent works.
  const plain = (): Bar => {
    const path = (info?.git === false ? (info.path ?? "") : "") || (o.folder ?? "");
    return path === "" && pr === null ? none : { shown: true, ws: path === "" ? null : folderChip(path, o.home), branch: null, pr, live: false };
  };
  const git = info?.git === true;
  if (git && !o.draft && o.marker?.gone === true) return { shown: true, ws: { icon: ICONS.FOLDER_GIT, text: "Worktree gone", tone: "red", tip: `Its worktree, ${o.marker.name}, isn't there anymore` }, branch: null, pr, live: true };
  if (!git && !o.draft && o.marker !== null) {
    const on = o.home === "" ? "the PC it runs on" : o.home;
    return { shown: true, ws: { icon: ICONS.FOLDER_GIT, text: `Worktree · ${o.marker.name}`, tone: "", tip: `Runs in its own worktree on ${on}, ${o.marker.name}` }, branch: null, pr, live: false };
  }
  if (!git || info === null) return plain();
  const wt = info.mode === "worktree";
  const name = info.name ?? "";
  const ws: BarChip = { icon: wt ? ICONS.FOLDER_GIT : ICONS.FOLDER, text: name !== "" ? `Worktree · ${name}` : wt ? "New worktree" : "Current checkout", tone: "", tip: info.path ?? "" };
  let b = info.branch ?? "";
  if (o.draft && wt) b = `from ${info.base ?? ""}`;
  const branch: BarChip = { icon: ICONS.BRANCH, text: b === "" ? "…" : b, tone: "", tip: (info.dirty ?? 0) > 0 ? `${info.dirty} uncommitted change${info.dirty === 1 ? "" : "s"}` : "" };
  const pend = o.pending?.what ?? info.pending ?? "";
  if (pend !== "") {
    const busy: BarChip = { icon: ICONS.LOADER, text: pend, tone: "muted", tip: "" };
    if (o.pending?.branch === true) return { shown: true, ws, branch: busy, pr, live: true };
    return { shown: true, ws: busy, branch, pr, live: true };
  }
  return { shown: true, ws, branch, pr, live: true };
}

/** A folder outside Git: its name, its path (and the PC it's on) in the tip. */
export function folderChip(path: string, home: string, homeDir = process.env.HOME ?? ""): BarChip {
  const trimmed = path.replace(/\/+$/, "");
  const name = homeDir !== "" && trimmed === homeDir.replace(/\/+$/, "") ? "~" : trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
  return { icon: ICONS.FOLDER, text: `Folder · ${name}`, tone: "", tip: home === "" ? path : `${path}\non ${home}` };
}

/** What a click on the workspace chip opens (WorkBar.tapWorkspace): the chat's own worktree goes straight to renaming it. */
export function wsClick(info: WsInfo | null, draft: boolean): "rename" | "menu" | "none" {
  if (info === null || !info.git) return "none";
  if (!draft && (info.can_rename_folder ?? info.can_rename) === true) return "rename";
  return "menu";
}

/** What a click on the branch chip opens (WorkBar.tapBranch): a worktree's own branch goes straight to renaming it. */
export function branchClick(info: WsInfo | null, draft: boolean): "rename" | "picker" | "none" {
  if (info === null || !info.git) return "none";
  if (!draft && info.can_rename === true && (info.branch ?? "") !== "") return "rename";
  return "picker";
}

/** The note under "Rename branch" (WorkBar.rename): whether the worktree's folder follows. */
export function renameBranchNote(info: WsInfo): string {
  if (info.folder_named === true) return `The folder keeps its name, ${info.name ?? ""}: you named it.`;
  const waits = info.folder_waits ?? "";
  return `The worktree's folder follows the new name once nothing works in it${waits === "" ? "" : ` (${waits} now)`}.`;
}

/** The note under "Rename worktree" (WorkBar.renameFolder). */
export function renameFolderNote(info: WsInfo): string {
  const path = info.path ?? "";
  const cut = path.lastIndexOf("/");
  const where = cut > 0 ? path.slice(0, cut) : "the same folder";
  const to = info.folder_to ?? "";
  return `${to === "" ? "" : `Becomes ${to} once nothing works in it. `}Stays in ${where}; renaming the branch leaves it be from now on. It's renamed once nothing works in it, and removed with the thread unless it has uncommitted changes.`;
}
