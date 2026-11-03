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
    { title: "Updates", rows: [item({ kind: "text", key: "version", title: `Harbor ${env.version}` })] },
  ];
}

/** A toggle of the General tab, written to kv; false for what isn't a kv flag. */
export function setGeneral(kv: Kv, key: string, value: boolean | number): boolean {
  if ((key === "auto_fix" || key === "auto_merge") && typeof value === "boolean") kv.set(key, value ? "1" : "0");
  else return false;
  return true;
}

/** The nav's tabs for a search (sidebar.rs `settings_nav`). */
export function navTabs(q: string): { slug: Tab; label: string; icon: string }[] {
  return searchTabs(q).map((t) => ({ slug: t, label: TABS[t].label, icon: TABS[t].icon }));
}

export { TAB_ORDER };
