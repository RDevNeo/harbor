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
const choice = (key: string, title: string, desc: string, options: string[], selected: number) => item({ kind: "choice", key, title, desc, options, selected });

export interface Kv {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

const onUnless0 = (kv: Kv, k: string) => kv.get(k) !== "0";
const offUnless1 = (kv: Kv, k: string) => kv.get(k) === "1";

/** autowork.rs `MAX_AUTO`. */
export const MAX_AUTO = 2;

/** What the General tab shows that isn't in kv. */
export interface GeneralEnv {
  trayActive: boolean;
  autostart: boolean;
  /** The Harbor line: "Harbor 0.108.0 (…)" and what the updater says (update.rs). */
  version: string;
  updateStatus: string;
  managed: boolean;
}

/** pages.rs `general_tab`: how threads behave, the background, recaps, automatic work and updates. */
export function generalSections(kv: Kv, env: GeneralEnv): SettingSection[] {
  const steer = (kv.get("follow_up") ?? "steer") !== "queue";
  const tray = env.trayActive ? "Also in the tray icon's menu." : "No tray was found on this desktop, so quit from here.";
  const updates: SettingItem[] = [
    item({ kind: env.managed ? "button" : "text", key: "update_check", title: `Harbor ${env.version}`, desc: env.updateStatus, label: "Check now" }),
    choice(
      "auto_update",
      "Updates",
      "Ask me: an Update button appears at the top when a new version or build is out; clicking it installs it and reloads Harbor in place, without losing your place. Automatically: new versions are downloaded and their signature checked in the background, then swapped in while you're away (the window closed, or left alone a few minutes with nothing typed), back on the same screen. Phones that haven't chosen for themselves follow this.",
      ["Ask me", "Automatically"],
      offUnless1(kv, "auto_update") ? 1 : 0,
    ),
  ];
  return [
    {
      title: "",
      rows: [
        choice(
          "follow_up",
          "While the agent works, Enter…",
          "Steer: your message reaches the agent right away, changing what it's working on. Queue: it waits and runs after the current turn. Ctrl+Enter does the other for one message. Agents that can't be steered (Cursor, Gemini, Grok, OpenCode, Meta) always queue.",
          ["Queue", "Steer"],
          steer ? 1 : 0,
        ),
        toggle(
          "resume_on_restart",
          "Continue threads after restarts",
          "A thread that was working when the computer restarted picks up where it stopped the next time Harbor opens. Turns still running across a Harbor reload always come back.",
          onUnless0(kv, "resume_on_restart"),
        ),
        toggle("order_by_activity", "Order threads by activity", "The sidebar lists the most recently active projects first. Off, you drag them into your own order.", offUnless1(kv, "order_by_activity")),
        toggle("fast_mode", "Fast mode", "Claude and Codex turns use fast mode where the model has it. Also in the composer's reasoning menu.", offUnless1(kv, "fast_mode")),
      ],
    },
    {
      title: "Background",
      rows: [
        toggle(
          "bg_keep",
          "Keep running in the background when the window is closed",
          "Phones and your other PCs keep reaching this PC, and the queue, automatic work, wake-ups and webhooks go on. Run Harbor again (or use its tray icon) to open the window.",
          onUnless0(kv, "bg_keep"),
        ),
        toggle("autostart", "Start Harbor when I log in", "Starts in the background, without a window, so this PC is reachable as soon as you log in.", env.autostart),
        item({
          kind: "button",
          key: "quit",
          title: "Quit Harbor completely",
          desc: `Stops everything: phones and other PCs can't reach this PC until Harbor runs again. Running agent turns finish on their own. ${tray}`,
          label: "Quit Harbor",
        }),
      ],
    },
    {
      title: "Recaps and suggestions",
      rows: [
        toggle(
          "recap_enabled",
          "Session recap",
          "When you come back to a chat a few minutes after its turn ended, a one-line summary of where it stands shows over the composer, like Claude Code's. Claude chats only; it uses a little of the chat account's usage (Haiku).",
          onUnless0(kv, "recap_enabled"),
        ),
        toggle(
          "suggest_enabled",
          "Prompt suggestions",
          "After each turn, the message you'd likely send next shows grayed in the empty composer. Tab or \u{2192} takes it, Enter then sends; on a phone, tap Use. Claude chats only (Haiku).",
          onUnless0(kv, "suggest_enabled"),
        ),
      ],
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
    { title: "Updates", rows: updates },
  ];
}

/** A toggle or choice of the General tab, written where the Rust app keeps it; false for what isn't a kv flag. */
export function setGeneral(kv: Kv, key: string, value: boolean | number): boolean {
  const b = (v: boolean) => (v ? "1" : "0");
  if (key === "follow_up" && typeof value === "number") kv.set("follow_up", value === 1 ? "steer" : "queue");
  else if (key === "auto_update" && typeof value === "number") kv.set("auto_update", b(value === 1));
  else if (["resume_on_restart", "order_by_activity", "fast_mode", "bg_keep", "recap_enabled", "suggest_enabled", "auto_fix", "auto_merge"].includes(key) && typeof value === "boolean") kv.set(key, b(value));
  else return false;
  return true;
}

/** The nav's tabs for a search (sidebar.rs `settings_nav`). */
export function navTabs(q: string): { slug: Tab; label: string; icon: string }[] {
  return searchTabs(q).map((t) => ({ slug: t, label: TABS[t].label, icon: TABS[t].icon }));
}

export { TAB_ORDER };
