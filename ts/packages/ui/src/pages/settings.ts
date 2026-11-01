import { basename } from "node:path";
import { homedir } from "node:os";
import { type Store } from "@harbor/store";
import { voiceCtl } from "@harbor/media";
import { mcp } from "@harbor/mcp";
import { providers } from "@harbor/agents";
import { autostart, setAutostart } from "../background.ts";
import { type Keys, label } from "../logic/keys.ts";
import { tabFromSlug, TABS, type Tab } from "../logic/pages.ts";
import { generalSections, navTabs, setGeneral, type SettingSection } from "../logic/settings.ts";
import { appearanceApplied, appearanceView, setAppearance, type AppearanceView } from "../logic/settings-appearance.ts";
import { type Block } from "../logic/settings-blocks.ts";
import { type IntData, type IntHost } from "../logic/settings-integrations.ts";
import { editNotifications, notificationsSections, notifyPressed, setNotifications, type NotifyEnv, type NotifySection } from "../logic/settings-notifications.ts";
import { keysAct, keysKey, keysView, type KeysView } from "../logic/settings-keybindings.ts";
import { type ProvidersData } from "../logic/settings-providers.ts";
import { type UsageData } from "../logic/settings-usage.ts";
import { voiceChose, voiceEdited, voiceFacts, voicePressed, voiceToggled, voiceView, type VoiceView } from "../logic/settings-voice.ts";
import { type WebhooksHost, type WhData } from "../logic/settings-webhooks.ts";
import { type Pixels } from "../logos.ts";
import { blockTabs } from "../settingsrun-blocks.ts";
import { integrationsFeed } from "../settingsrun-integrations.ts";
import { providerLogos, providersFeed, type ProvidersHost } from "../settingsrun-providers.ts";
import { usageFeed } from "../settingsrun-usage.ts";
import { webhooksFeed } from "../settingsrun-webhooks.ts";
import { resolveDark } from "../theme.ts";
import { trayActive } from "../tray.ts";

/** The properties and callbacks of slint/settings.slint's `SettingsBus`, as TypeScript sees them. */
export interface SettingsView {
  tabs: { slug: string; label: string; icon: string }[];
  tab: string;
  tab_label: string;
  desc: string;
  sections: SettingSection[];
  nav_open: boolean;
  appearance: AppearanceView;
  providers: ProvidersData;
  providers_act: (id: string, what: string) => void;
  usage: UsageData;
  usage_act: (what: string, a: string, n: number) => void;
  usage_settled: () => void;
  integrations: IntData;
  integrations_act: (what: string, id: string, a: string, b: string) => void;
  integrations_valid: (client: string, secret: string) => boolean;
  webhooks: WhData;
  webhooks_act: (what: string, a: string) => void;
  notifications: NotifySection[];
  notify_edited: (k: string, t: string) => void;
  keybindings: KeysView;
  keys_act: (what: string, arg: string) => void;
  keys_key: (key: string, ctrl: boolean, shift: boolean, alt: boolean) => void;
  voice: VoiceView;
  voice_edited: (k: string, t: string) => void;
  blocks: Block[];
  blocks_pressed: (k: string) => void;
  blocks_toggled: (k: string, v: boolean) => void;
  blocks_edited: (k: string, t: string) => void;
  blocks_submitted: (k: string, a: string, b: string, c: string) => string;
  pick: (s: string) => void;
  searched: (t: string) => void;
  back: () => void;
  hide_nav: () => void;
  show_nav: () => void;
  toggled: (k: string, v: boolean) => void;
  chose: (k: string, n: number) => void;
  pressed: (k: string) => void;
}

/** What the page needs from the window around it; the buttons that need a terminal, a clipboard or a browser go through here. */
export interface SettingsDeps {
  store: Store;
  quit: () => void;
  keys: Keys;
  speech: voiceCtl.VoiceCtl;
  theme: { dark: () => boolean; set: (dark: boolean, compact: boolean) => void };
  back: () => void;
  providers: Omit<ProvidersHost, "modelsFor">;
  integrations: Omit<IntHost, "changed" | "openUrl" | "copy">;
  webhooks: Omit<WebhooksHost, "changed" | "copy" | "deleteWebhook">;
  funnel: () => { base: string | null; stale: number | null };
  qr: (url: string) => Pixels;
  notify: NotifyEnv;
  copy: (text: string) => void;
}

export interface SettingsHandle {
  show: (tab?: Tab) => void;
}

/** The dictation controller the Voice tab drives: no peers to forward to, nowhere to type into. */
export function settingsSpeech(store: Store): voiceCtl.VoiceCtl {
  const speech = new voiceCtl.VoiceCtl({ store, mesh: { on: () => false, me: () => ({ name: "" }), peers: () => [], http: () => Promise.resolve([0, null]) }, insert: () => {}, toast: () => {}, wake: () => {}, account: () => null });
  speech.load();
  return speech;
}

/** Fills the Settings bus and answers its callbacks; the page opens on `tab` and `show` redraws it, optionally on another. */
export async function mountSettings(bus: SettingsView, deps: SettingsDeps, first: Tab = "general"): Promise<SettingsHandle> {
  const { store, keys, speech } = deps;
  let tab = first;
  const logos = await providerLogos();
  const usageTab = usageFeed(store, logos);
  const integrationsTab = await integrationsFeed({ ...deps.integrations, changed: () => show(), openUrl: (u) => mcp.openUrl(u), copy: deps.copy }, deps.qr);
  const webhooksTab = webhooksFeed(store, { ...deps.webhooks, changed: () => show(), copy: deps.copy, deleteWebhook: (id) => { store.deleteWebhook(id); } }, deps.funnel);
  const providersTab = await providersFeed(store, { ...deps.providers, modelsFor: providers.staticModels }, logos);
  const blocks = await blockTabs(store, () => show(), (t) => {
    tab = t;
    show();
  });

  function sections(t: Tab): SettingSection[] {
    if (t === "general") return generalSections(store, { trayActive: trayActive(), autostart: autostart(), version: "0.108.0 (ts)", updateStatus: "Built from source: updates come from your checkout, not from GitHub.", managed: false });
    return [];
  }

  function applyAppearance(): void {
    const a = appearanceApplied(store);
    deps.theme.set(resolveDark(a.mode, homedir()), a.compact);
    bus.appearance = appearanceView(store);
  }

  function show(next?: Tab): void {
    if (next !== undefined) tab = next;
    applyAppearance();
    const dark = deps.theme.dark();
    bus.tabs = navTabs("");
    bus.tab = tab;
    bus.tab_label = TABS[tab].label;
    bus.desc = TABS[tab].desc;
    bus.sections = sections(tab);
    if (tab === "notifications") bus.notifications = notificationsSections(store);
    if (tab === "keybindings") bus.keybindings = keysView(keys);
    if (tab === "voice") bus.voice = voiceView(voiceFacts(speech, label(keys.get("voice"))));
    if (tab === "providers") bus.providers = providersTab.view(dark);
    if (tab === "usage") bus.usage = usageTab.view(dark);
    if (tab === "integrations") bus.integrations = integrationsTab.view(dark);
    if (tab === "webhooks") bus.webhooks = webhooksTab.view();
    bus.blocks = blocks.get(tab)?.blocks() ?? [];
  }

  bus.pick = (s) => {
    tab = tabFromSlug(s) ?? tab;
    show();
  };
  bus.searched = (q) => {
    bus.tabs = navTabs(q);
  };
  bus.toggled = (k, v) => {
    if (k === "autostart") setAutostart(v, { exe: basename(process.execPath) === "bun" ? null : process.execPath, managed: false });
    setGeneral(store, k, v);
    setNotifications(store, k, v);
    voiceToggled(speech, k, v);
    show();
  };
  bus.chose = (k, n) => {
    setGeneral(store, k, n);
    setAppearance(store, k, n);
    voiceChose(speech, k, n);
    show();
  };
  bus.usage_act = (what, a, n) => {
    usageTab.act(what, a, n);
  };
  bus.usage_settled = () => show();
  bus.integrations_act = integrationsTab.act;
  bus.integrations_valid = integrationsTab.valid;
  bus.webhooks_act = webhooksTab.act;
  bus.providers_act = (id, what) => {
    providersTab.act(id, what);
    show();
  };
  bus.notify_edited = (k, t) => {
    editNotifications(store, k, t);
  };
  bus.voice_edited = (k, t) => {
    voiceEdited(speech, k, t);
  };
  bus.keys_act = (what, arg) => {
    keysAct(keys, store, what, arg);
    show();
  };
  bus.keys_key = (key, ctrl, shift, alt) => {
    keysKey(keys, store, key, ctrl, shift, alt);
    show();
  };
  bus.blocks_pressed = (k) => {
    blocks.get(tab)?.pressed(k);
    show();
  };
  bus.blocks_toggled = (k, v) => {
    blocks.get(tab)?.toggled(k, v);
    show();
  };
  bus.blocks_edited = (k, t) => {
    blocks.get(tab)?.edited(k, t);
  };
  bus.blocks_submitted = (k, a, b, c) => {
    const err = blocks.get(tab)?.submitted(k, [a, b, c]) ?? "";
    if (err === "") show();
    return err;
  };
  bus.pressed = (k) => {
    if (k === "quit") deps.quit();
    notifyPressed(k, deps.notify);
    void voicePressed(speech, k).then(() => show());
  };
  bus.back = deps.back;
  bus.hide_nav = () => {
    bus.nav_open = false;
  };
  bus.show_nav = () => {
    bus.nav_open = true;
  };
  show();
  return { show };
}
