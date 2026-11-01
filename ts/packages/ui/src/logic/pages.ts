import { cost, type Item } from "@harbor/store";
import { ICONS } from "../icons.ts";

export type Tab = "account" | "general" | "notifications" | "appearance" | "keybindings" | "voice" | "providers" | "usage" | "integrations" | "secrets" | "devices" | "phones" | "webhooks";

interface TabInfo {
  label: string;
  icon: string;
  /** What the settings search matches besides the name. */
  keywords: string;
  desc: string;
}

/** Settings' tabs in the sidebar's order (pages.rs `Tab::ALL`); the key is the slug in snapshots and HARBOR_VIEW. */
export const TABS: Record<Tab, TabInfo> = {
  account: {
    label: "Account",
    icon: ICONS.USER_ROUND,
    keywords: "account google sign in sign out login logout workspace invite people members team email pcs",
    desc: "Your Google account, this PC's workspace and the people who share it. Settings follow your account to every PC you sign in on.",
  },
  general: {
    label: "General",
    icon: ICONS.SLIDERS,
    keywords: "restart resume continue order activity sort fast mode recap summary suggestion prompt background tray autostart login startup quit close",
    desc: "How threads behave.",
  },
  notifications: {
    label: "Notifications",
    icon: ICONS.BELL,
    keywords: "notify notifications alerts popups desktop phone quiet hours away finished needs input ci checks limit offline",
    desc: "What Harbor tells you about while you're elsewhere, on this desktop and on your phones.",
  },
  appearance: { label: "Appearance", icon: ICONS.PALETTE, keywords: "theme dark light omarchy colours colors density compact comfortable", desc: "How Harbor looks." },
  keybindings: { label: "Keybindings", icon: ICONS.KEYBOARD, keywords: "shortcuts keyboard keys hotkeys cheat sheet", desc: "Harbor's keyboard shortcuts. Changes apply at once." },
  voice: {
    label: "Voice",
    icon: ICONS.MIC,
    keywords: "voice dictation speech microphone mic whisper transcribe language model",
    desc: "Dictate into the composer. Speech is transcribed on this PC with whisper.cpp: private, free, offline.",
  },
  providers: { label: "Providers", icon: ICONS.BOT, keywords: "accounts claude codex cursor gemini sign in login models default", desc: "" },
  usage: {
    label: "Usage",
    icon: ICONS.GAUGE,
    keywords: "usage limits quota caps cap percent warn tokens cost weekly wait switch accounts notify history",
    desc: "What each account has used, how much of it Harbor may use, and what threads do at a limit.",
  },
  integrations: { label: "Integrations", icon: ICONS.PLUG, keywords: "apps mcp servers sign in tools", desc: "" },
  secrets: {
    label: "Secrets",
    icon: ICONS.LOCK,
    keywords: "keys api keys tokens passwords environment variables env credentials",
    desc: "Keys agents can use without seeing them: API keys, tokens. Agents ask for the ones they need.",
  },
  devices: {
    label: "Devices",
    icon: ICONS.MONITOR,
    keywords: "remote machines pcs tailscale ssh run agents elsewhere mcp bridge",
    desc: "Run agents on your other PCs. They work in that PC's folders, with this PC's MCP servers and apps.",
  },
  phones: {
    label: "Phones",
    icon: ICONS.SMARTPHONE,
    keywords: "android phone mobile app sign in api",
    desc: "Your chats on your phone: Harbor for Android signs in with Google and talks to this PC over your network, encrypted with both keys.",
  },
  webhooks: { label: "Webhooks", icon: ICONS.WEBHOOK, keywords: "hooks public url https certificate lets encrypt", desc: "" },
};

export const TAB_ORDER: readonly Tab[] = ["account", "general", "notifications", "appearance", "keybindings", "voice", "providers", "usage", "integrations", "secrets", "devices", "phones", "webhooks"];

/** "limits" is the Usage page's old name. */
export function tabFromSlug(s: string): Tab | null {
  if (s === "limits") return "usage";
  return TAB_ORDER.find((t) => t === s) ?? null;
}

/** The tabs a settings search keeps: the query in the name or the keywords, case aside (sidebar.rs `settings_nav`). */
export function searchTabs(q: string): Tab[] {
  const w = q.trim().toLowerCase();
  return TAB_ORDER.filter((t) => TABS[t].label.toLowerCase().includes(w) || TABS[t].keywords.includes(w));
}

export interface Totals {
  byAccount: Map<string, [turns: number, input: number, output: number, cost: number]>;
  /** Tokens per day of the last 14 (unix day). */
  byDay: Map<number, number>;
  days: Map<number, cost.Usage>;
  /** By project name ("" for chats without one). */
  byProject: Map<string, cost.Usage>;
  byChat: Map<number, cost.Usage>;
}

/** Sums turn results; `chats` is each chat's [account, project name], the account for results saved without one (pages.rs `sum_results`). */
export function sumResults(results: readonly [number, Item][], chats: Map<number, [string, string]>, today: number): Totals {
  const t: Totals = { byAccount: new Map(), byDay: new Map(), days: new Map(), byProject: new Map(), byChat: new Map() };
  const usage = <K>(m: Map<K, cost.Usage>, k: K) => {
    let u = m.get(k);
    if (!u) {
      u = cost.emptyUsage();
      m.set(k, u);
    }
    return u;
  };
  for (const [chat, it] of results) {
    if (it.kind !== "result") continue;
    const [acc, project] = chats.get(chat) ?? ["", ""];
    const a = it.account === "" ? acc : it.account;
    const e = t.byAccount.get(a) ?? [0, 0, 0, 0];
    t.byAccount.set(a, [e[0] + 1, e[1] + it.input_tokens, e[2] + it.output_tokens, e[3] + it.cost_usd]);
    const day = Math.floor(it.at / 86400);
    if (it.at > 0 && today - day < 14) {
      t.byDay.set(day, (t.byDay.get(day) ?? 0) + it.input_tokens + it.output_tokens);
      cost.addResult(usage(t.days, day), it);
    }
    cost.addResult(usage(t.byProject, project), it);
    cost.addResult(usage(t.byChat, chat), it);
  }
  return t;
}
