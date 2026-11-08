import { basename } from "node:path";
import { type Store } from "@harbor/store";
import { voiceCtl } from "@harbor/media";
import { harborVersion, mcp } from "@harbor/mcp";
import { providers } from "@harbor/agents";
import { AUTOSTART_DEFAULT_KEY, autostart, installedLauncher, setAutostart } from "../background.ts";
import { type Keys, label } from "../logic/keys.ts";
import { tabFromSlug, TABS, type Tab } from "../logic/pages.ts";
import { generalSections, navTabs, setGeneral, type SettingSection } from "../logic/settings.ts";
import { parseMode } from "../theme.ts";
import { type Block } from "../logic/settings-blocks.ts";
import { type IntData, type IntHost } from "../logic/settings-integrations.ts";
import { editNotifications, notificationsSections, notifyPressed, setNotifications, type NotifyEnv, type NotifySection } from "../logic/settings-notifications.ts";
import { keysAct, keysKey, keysView, type KeysView } from "../logic/settings-keybindings.ts";
import { type ProvidersData } from "../logic/settings-providers.ts";
import { voiceChose, voiceEdited, voiceFacts, voicePressed, voiceToggled, voiceView, type VoiceView } from "../logic/settings-voice.ts";
import { type Pixels } from "../logos.ts";
import { type SettingsRuntime } from "../settingsrun-devices.ts";
import { blockTabs } from "../settingsrun-blocks.ts";
import { integrationsFeed } from "../settingsrun-integrations.ts";
import { providerLogos, providersFeed, type ProvidersHost } from "../settingsrun-providers.ts";

/** The properties and callbacks of slint/settings.slint's `SettingsBus`, as TypeScript sees them. */
export interface SettingsView {
  tabs: { slug: string; label: string; icon: string }[];
  tab: string;
  tab_label: string;
  sections: SettingSection[];
  nav_open: boolean;
  providers: ProvidersData;
  providers_act: (id: string, what: string) => void;
  integrations: IntData;
  integrations_act: (what: string, id: string, a: string, b: string) => void;
  integrations_valid: (client: string, secret: string) => boolean;
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
  runtime?: SettingsRuntime | undefined;
  keys: Keys;
  speech: voiceCtl.VoiceCtl;
  theme: { dark: () => boolean; set: (dark: boolean) => void };
  back: () => void;
  providers: Omit<ProvidersHost, "modelsFor">;
  integrations: Omit<IntHost, "changed" | "openUrl" | "copy">;
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
  const integrationsTab = await integrationsFeed({ ...deps.integrations, changed: () => show(), openUrl: (u) => mcp.openUrl(u), copy: deps.copy }, deps.qr);
  const providersTab = await providersFeed(store, { ...deps.providers, modelsFor: providers.staticModels }, logos);
  const blocks = await blockTabs(store, () => show(), deps.copy, deps.runtime);

  function sections(t: Tab): SettingSection[] {
    if (t === "general") return generalSections(store, { autostart: autostart(), version: deps.runtime?.version ?? harborVersion() });
    return [];
  }

  /** Light or dark as kv `theme` holds it now (the sidebar's button, or another PC's pick synced in). */
  function applyTheme(): void {
    deps.theme.set(parseMode(store.get("theme") ?? "") === "dark");
  }

  function show(next?: Tab): void {
    if (next !== undefined) tab = next;
    applyTheme();
    const dark = deps.theme.dark();
    bus.tabs = navTabs("");
    bus.tab = tab;
    bus.tab_label = TABS[tab].label;
    bus.sections = sections(tab);
    if (tab === "notifications") bus.notifications = notificationsSections(store);
    if (tab === "keybindings") bus.keybindings = keysView(keys);
    if (tab === "voice") bus.voice = voiceView(voiceFacts(speech, label(keys.get("voice"))));
    if (tab === "providers") bus.providers = providersTab.view(dark);
    if (tab === "integrations") bus.integrations = integrationsTab.view(dark);
    bus.blocks = blocks.get(tab)?.blocks() ?? [];
  }

  const refreshInputs = () => void speech.refreshInputs().then(() => show());
  // An SSH device being set up to transcribe: its step shows as it goes.
  let hostState = "";
  setInterval(() => {
    if (tab !== "voice" || speech.hostState() === hostState) return;
    hostState = speech.hostState();
    show();
  }, 1000).unref();
  // WhatsApp's link may start on a phone (hub /v1/apps/whatsapp/link): its QR shows here too.
  let waSeen = "";
  setInterval(() => {
    if (tab !== "integrations") return;
    const p = mcp.pending("whatsapp");
    const seen = `${p === undefined ? "-" : (p.qr ?? "")}|${mcp.signedIn("whatsapp")}`;
    if (seen === waSeen) return;
    waSeen = seen;
    show();
  }, 1000).unref();
  bus.pick = (s) => {
    tab = tabFromSlug(s) ?? tab;
    if (tab === "voice") refreshInputs();
    show();
  };
  bus.searched = (q) => {
    bus.tabs = navTabs(q);
  };
  bus.toggled = (k, v) => {
    if (k === "autostart") {
      try {
        setAutostart(v, { exe: installedLauncher() ?? (basename(process.execPath) === "bun" ? null : process.execPath), managed: false });
        store.set(AUTOSTART_DEFAULT_KEY, "1");
      } catch {
        // the entry couldn't be written: the toggle shows what is there
      }
    }
    setGeneral(store, k, v);
    setNotifications(store, k, v);
    voiceToggled(speech, k, v);
    show();
  };
  bus.chose = (k, n) => {
    setGeneral(store, k, n);
    voiceChose(speech, k, n);
    show();
  };
  bus.integrations_act = integrationsTab.act;
  bus.integrations_valid = integrationsTab.valid;
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
    if (k === "voice:test") { void speech.testMicrophone(() => show()); return; }
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
  if (first === "voice") refreshInputs();
  return { show: (next) => { show(next); if (next === "voice") refreshInputs(); } };
}
