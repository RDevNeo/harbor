import { paths as osPaths } from "@harbor/os";
import { join } from "node:path";
import { home, projectsdir } from "@harbor/store";
import { searchTabs, TAB_ORDER, TABS, type Tab } from "./pages.ts";

/** One row of a settings card, as slint/settings.slint draws it (`SettingItem`). */
export interface SettingItem {
  kind: "toggle" | "choice" | "button" | "value" | "text";
  key: string;
  title: string;
  desc: string;
  on: boolean;
  options: string[];
  selected: number;
  label: string;
  enabled: boolean;
}

export interface SettingSection {
  title: string;
  rows: SettingItem[];
}

const item = (i: Partial<SettingItem> & Pick<SettingItem, "kind" | "key" | "title">): SettingItem => ({ desc: "", on: false, options: [], selected: 0, label: "", enabled: true, ...i });
const toggle = (key: string, title: string, desc: string, on: boolean) => item({ kind: "toggle", key, title, desc, on });

export interface Kv {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

const offUnless1 = (kv: Kv, k: string) => kv.get(k) === "1";

/** autowork.rs `MAX_AUTO`. */
export const MAX_AUTO = 2;

/** What the General tab shows that isn't in kv. */
export interface GeneralEnv {
  autostart: boolean;
  /** This Harbor's version, "0.124.0". */
  version: string;
  /** The home folder (paths show as ~/…); left out: this PC's. */
  home?: string;
  /** What this PC's desktop can do for computer use (mcp's computer.ts `statusLine`); left out: no section. */
  computer?: string;
}

/** Computer use's switches (mcp's computer.ts ON_KEY and PEERS_KEY): off until the user turns them on. */
export const COMPUTER = { on: "computer_use", peers: "computer_use_peers" } as const;

export function computerSection(kv: Kv, status: string): SettingSection {
  const on = offUnless1(kv, COMPUTER.on);
  return {
    title: "Computer use",
    rows: [
      toggle(
        COMPUTER.on,
        "Let agents see and control this screen",
        `Agents get a computer tool: screenshots, the mouse and the keyboard of this PC, as you would use them. The chat says when its agent starts, a notification pops up, and moving the pointer into the screen's top-left corner stops them for a minute. Below full access a chat may only take screenshots. ${status}`,
        on,
      ),
      { ...toggle(COMPUTER.peers, "Also for chats from other PCs", "Chats running on the PCs you share everything with (Settings › Workspace) may use this screen too.", offUnless1(kv, COMPUTER.peers)), enabled: on },
    ],
  };
}

/** The Projects folder row's buttons (pages/settings.ts opens the folder picker for `change`). */
export const PROJECTS_DIR = { change: "projects_dir:change", reset: "projects_dir:reset" } as const;

const tildeIn = (h: string, p: string): string => osPaths.tilde(p, h);

/** Projects: the folder new projects, clones, worktrees and chats without a project go in (projectsdir.ts). */
export function projectsSection(kv: Kv, h: string): SettingSection {
  const chosen = projectsdir.chosen(kv, h);
  const dir = tildeIn(h, projectsdir.projectsDir(kv, h));
  const desc =
    chosen === null
      ? `${dir}. New projects and clones go here. Pick a folder and worktrees go in its .worktrees folder too, and chats without a project in its chats folder.`
      : `${dir}. New projects and clones go here, worktrees in its .worktrees folder and chats without a project in its chats folder.`;
  const rows = [item({ kind: "button", key: PROJECTS_DIR.change, title: "Projects folder", desc, label: "Change…" })];
  if (chosen !== null) rows.push(item({ kind: "button", key: PROJECTS_DIR.reset, title: `Back to ${tildeIn(h, join(h, "Projects"))}`, desc: "New worktrees go to Harbor's data folder again and new chats without a project run in your home folder. Nothing already made moves.", label: "Reset" }));
  return { title: "Projects", rows };
}

/** The General tab: starting at login, automatic work and the version. The rest is fixed: Enter steers, threads continue after restarts, Harbor keeps running with the window closed, suggestions are on and updates install by themselves. */
export function generalSections(kv: Kv, env: GeneralEnv): SettingSection[] {
  return [
    {
      title: "Background",
      rows: [toggle("autostart", "Start Harbor when I log in", "Starts in the background, without a window, so this PC is reachable as soon as you log in.", env.autostart)],
    },
    {
      title: "Issues and pull requests",
      rows: [
        toggle(
          "auto_fix",
          "Auto-Fix",
          `Issues assigned to you in your projects' GitHub repos get a thread that fixes them on a branch and opens a PR, once per issue. Skips issues that already have an open PR; at most ${MAX_AUTO} auto threads run at once. Checked every 10 minutes.`,
          offUnless1(kv, "auto_fix"),
        ),
        toggle(
          "auto_merge",
          "Auto-Merge",
          "Your own open PRs in your projects, not drafts, with checks passing (or none) and no changes requested, get a thread that rebases, fixes and merges them, once per head commit.",
          offUnless1(kv, "auto_merge"),
        ),
      ],
    },
    projectsSection(kv, env.home ?? home()),
    worktreesSection(kv),
    ...(env.computer === undefined ? [] : [computerSection(kv, env.computer)]),
    { title: "Updates", rows: [item({ kind: "text", key: "version", title: `Harbor ${env.version}` }), ] },
  ];
}

/** Delete merged worktrees (wtclean.ts KEYS): on, with their branches, by default; the remote branch only when asked. */
export const WT_CLEAN = { worktree: "wt_clean_merged", branch: "wt_clean_branch", remote: "wt_clean_remote" } as const;

export function worktreesSection(kv: Kv): SettingSection {
  const on = kv.get(WT_CLEAN.worktree) !== "0";
  return {
    title: "Worktrees",
    rows: [
      toggle(WT_CLEAN.worktree, "Delete merged worktrees", "Once a chat's PR is merged and nothing works in its worktree, the worktree is removed; the chat stays and works in the project's checkout. Skipped when it has uncommitted changes or commits that aren't in the PR.", on),
      { ...toggle(WT_CLEAN.branch, "Also delete their branches", "The local branch goes too. Safe after a squash merge: only when it holds nothing the PR didn't.", kv.get(WT_CLEAN.branch) !== "0"), enabled: on },
      { ...toggle(WT_CLEAN.remote, "Also delete their branches on GitHub", "When the merged branch is still on the remote and points at the PR's last commit.", kv.get(WT_CLEAN.remote) === "1"), enabled: on },
    ],
  };
}

/** A toggle of the General tab, written to kv; false for what isn't a kv flag. */
export function setGeneral(kv: Kv, key: string, value: boolean | number): boolean {
  if ((key === "auto_fix" || key === "auto_merge" || Object.values(WT_CLEAN).includes(key as never) || Object.values(COMPUTER).includes(key as never)) && typeof value === "boolean") kv.set(key, value ? "1" : "0");
  else return false;
  return true;
}

/** The nav's tabs for a search (sidebar.rs `settings_nav`). */
export function navTabs(q: string): { slug: Tab; label: string; icon: string }[] {
  return searchTabs(q).map((t) => ({ slug: t, label: TABS[t].label, icon: TABS[t].icon }));
}

export { TAB_ORDER };
