import { ICONS } from "../icons.ts";

export type Tab = "account" | "general" | "notifications" | "appearance" | "keybindings" | "voice" | "providers" | "integrations" | "secrets";

interface TabInfo {
  label: string;
  icon: string;
  /** What the settings search matches besides the name. */
  keywords: string;
}

/** Settings' tabs in the sidebar's order (pages.rs `Tab::ALL`); the key is the slug in snapshots and HARBOR_VIEW. */
export const TABS: Record<Tab, TabInfo> = {
  account: { label: "Workspace", icon: ICONS.USER_ROUND, keywords: "account google sign in sign out login logout workspace invite people members team email pcs devices machines phones android mobile rename name share run agents elsewhere" },
  general: { label: "General", icon: ICONS.SLIDERS, keywords: "auto fix merge background autostart login startup updates version" },
  notifications: { label: "Notifications", icon: ICONS.BELL, keywords: "notify notifications alerts popups desktop finished needs input ci checks limit offline" },
  appearance: { label: "Appearance", icon: ICONS.PALETTE, keywords: "theme dark light omarchy colours colors" },
  keybindings: { label: "Keybindings", icon: ICONS.KEYBOARD, keywords: "shortcuts keyboard keys hotkeys cheat sheet" },
  voice: { label: "Voice", icon: ICONS.MIC, keywords: "voice dictation speech microphone mic input device test parakeet transcribe dictionary model" },
  providers: { label: "Providers", icon: ICONS.BOT, keywords: "accounts claude codex cursor gemini sign in login models default" },
  integrations: { label: "Integrations", icon: ICONS.PLUG, keywords: "apps mcp servers sign in tools" },
  secrets: { label: "Secrets", icon: ICONS.LOCK, keywords: "keys api keys tokens passwords environment variables env credentials" },
};

export const TAB_ORDER: readonly Tab[] = ["general", "account", "notifications", "appearance", "keybindings", "voice", "providers", "integrations", "secrets"];

/** Pages that were folded into others: their old slugs still open where the content went. */
const MOVED: Record<string, Tab> = { devices: "account", phones: "account", webhooks: "general" };

export function tabFromSlug(s: string): Tab | null {
  return TAB_ORDER.find((t) => t === s) ?? (Object.hasOwn(MOVED, s) ? (MOVED[s] ?? null) : null);
}

/** The tabs a settings search keeps: the query in the name or the keywords, case aside (sidebar.rs `settings_nav`). */
export function searchTabs(q: string): Tab[] {
  const w = q.trim().toLowerCase();
  return TAB_ORDER.filter((t) => TABS[t].label.toLowerCase().includes(w) || TABS[t].keywords.includes(w));
}
