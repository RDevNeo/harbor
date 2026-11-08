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
  /** Follow main (update/followmain.ts), where this copy can: its checkout, switch and status line. */
  followMain?: { checkout: string | null; on: boolean; line: string } | undefined;
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
    worktreesSection(kv),
    { title: "Updates", rows: [item({ kind: "text", key: "version", title: `Harbor ${env.version}` }), ...followMainRows(env.followMain)] },
  ];
}

/** kv key of Follow main (followmain.ts `KEY`), set through the follow-main object, not `setGeneral`. */
export const FOLLOW_MAIN = "follow_main";

function followMainRows(f: GeneralEnv["followMain"]): SettingItem[] {
  if (f === undefined) return [];
  const where = f.checkout === null ? "a Harbor checkout (none found among your projects)" : f.checkout;
  return [
    toggle(FOLLOW_MAIN, "Follow main", `Builds Harbor's main branch from ${where} whenever it changes, and runs it before it's released. ${f.line}`, f.on),
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
  if ((key === "auto_fix" || key === "auto_merge" || Object.values(WT_CLEAN).includes(key as never)) && typeof value === "boolean") kv.set(key, value ? "1" : "0");
  else return false;
  return true;
}

/** The nav's tabs for a search (sidebar.rs `settings_nav`). */
export function navTabs(q: string): { slug: Tab; label: string; icon: string }[] {
  return searchTabs(q).map((t) => ({ slug: t, label: TABS[t].label, icon: TABS[t].icon }));
}

export { TAB_ORDER };
