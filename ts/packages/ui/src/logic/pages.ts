import { ICONS } from "../icons.ts";

export type Tab = "account" | "general" | "notifications" | "appearance" | "keybindings" | "voice" | "providers" | "integrations" | "secrets" | "devices" | "phones" | "webhooks";

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

export const TAB_ORDER: readonly Tab[] = ["account", "general", "notifications", "appearance", "keybindings", "voice", "providers", "integrations", "secrets", "devices", "phones", "webhooks"];

export function tabFromSlug(s: string): Tab | null {
  return TAB_ORDER.find((t) => t === s) ?? null;
}

/** The tabs a settings search keeps: the query in the name or the keywords, case aside (sidebar.rs `settings_nav`). */
export function searchTabs(q: string): Tab[] {
  const w = q.trim().toLowerCase();
  return TAB_ORDER.filter((t) => TABS[t].label.toLowerCase().includes(w) || TABS[t].keywords.includes(w));
}
