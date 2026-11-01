import { homedir } from "node:os";
import { join } from "node:path";
import * as slint from "slint-ui";
import { dataDir, Store } from "@harbor/store";
import { uiDir } from "./assets.ts";
import { autostart } from "./background.ts";
import { generalSections, navTabs, setGeneral, type SettingSection } from "./logic/settings.ts";
import { appearanceApplied, appearanceView, setAppearance, type AppearanceView } from "./logic/settings-appearance.ts";
import { providerLogos, providersFeed } from "./settingsrun-providers.ts";
import { usageFeed } from "./settingsrun-usage.ts";
import { integrationsFeed } from "./settingsrun-integrations.ts";
import { webhooksFeed } from "./settingsrun-webhooks.ts";
import { type WhData } from "./logic/settings-webhooks.ts";
import { type IntData } from "./logic/settings-integrations.ts";
import { mcp } from "@harbor/mcp";
import { type UsageData } from "./logic/settings-usage.ts";
import { providers } from "@harbor/agents";
import { type ProvidersData } from "./logic/settings-providers.ts";
import { editNotifications, notificationsSections, notifyPressed, setNotifications, type NotifyEnv, type NotifySection } from "./logic/settings-notifications.ts";
import { Desktop, spawnNotifySend, testNote } from "@harbor/net";
import { Keys, label } from "./logic/keys.ts";
import { voiceChose, voiceEdited, voiceFacts, voicePressed, voiceToggled, voiceView, type VoiceView } from "./logic/settings-voice.ts";
import { voice, voiceCtl } from "@harbor/media";
import { keysAct, keysKey, keysView, type KeysView } from "./logic/settings-keybindings.ts";
import { resolveDark } from "./theme.ts";
import { tabFromSlug, TABS, type Tab } from "./logic/pages.ts";
import { runLoop } from "./loop.ts";
import { trayActive } from "./tray.ts";
import { blockTabs } from "./settingsrun-blocks.ts";
import { type Block } from "./logic/settings-blocks.ts";

interface SettingsWindow extends slint.ComponentHandle {
  dark: boolean;
  tabs: { slug: string; label: string; icon: string }[];
  tab: string;
  tab_label: string;
  desc: string;
  sections: SettingSection[];
  compact: boolean;
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
  voice: VoiceView;
  voice_edited: (k: string, t: string) => void;
  keys_key: (key: string, ctrl: boolean, shift: boolean, alt: boolean) => void;
  blocks: Block[];
  blocks_pressed: (k: string) => void;
  blocks_toggled: (k: string, v: boolean) => void;
  blocks_edited: (k: string, t: string) => void;
  blocks_submitted: (k: string, a: string, b: string, c: string) => string;
  pick: (s: string) => void;
  searched: (t: string) => void;
  toggled: (k: string, v: boolean) => void;
  chose: (k: string, n: number) => void;
  pressed: (k: string) => void;
}

const store = Store.open(dataDir());
const ui = slint.loadFile(join(await uiDir(), "settings.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "SettingsWindow");
if (typeof ctor !== "function") throw new Error("settings.slint has no SettingsWindow");
const win: SettingsWindow = new ctor();
win.dark = process.env.HTS_LIGHT === undefined;
let tab: Tab = tabFromSlug(process.argv[2] ?? "general") ?? "general";
// The rig has no terminal or updater: these buttons do nothing here.
const logos = await providerLogos();
const usageTab = usageFeed(store, logos);
// The rig has no clipboard, no Discord window and no Discord login to draw a code for.
const integrationsTab = await integrationsFeed({ changed: () => show(), openUrl: (u) => mcp.openUrl(u), copy: () => {}, discordWindow: () => {} }, () => ({ width: 1, height: 1, data: new Uint8Array(4) }));
// The rig has no terminal, clipboard or Funnel: the buttons that need them do nothing here.
const webhooksTab = webhooksFeed(store, { changed: () => show(), copy: () => {}, terminal: () => {}, deleteWebhook: (id) => { store.deleteWebhook(id); }, checkFunnel: () => {}, disableFunnel: () => {}, kick: () => {} }, () => ({ base: null, stale: null }));
const providersTab = await providersFeed(store, { login: () => {}, addClaudeAccount: () => {}, updateAll: () => {}, modelsFor: providers.staticModels }, logos);

const keys = Keys.load(store);
// The rig doesn't reach Hugging Face: a model download fails at once, here.
voice.setFetcher(() => Promise.reject(new Error("no network in the settings runner")));
const speech = new voiceCtl.VoiceCtl({ store, mesh: { on: () => false, me: () => ({ name: "" }), peers: () => [], http: () => Promise.resolve([0, null]) }, insert: () => {}, toast: () => {}, wake: () => {}, account: () => null });
speech.load();
const notifyEnv: NotifyEnv = { sendTest: () => void new Desktop({ send: spawnNotifySend }).testPopup(testNote()) };

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
  win.dark = process.env.HTS_LIGHT === undefined && resolveDark(a.mode, homedir());
  win.compact = a.compact;
  win.appearance = appearanceView(store);
}

function show(): void {
  applyAppearance();
  win.tabs = navTabs("");
  win.tab = tab;
  win.tab_label = TABS[tab].label;
  win.desc = TABS[tab].desc;
  win.sections = sections(tab);
  if (tab === "notifications") win.notifications = notificationsSections(store);
  if (tab === "keybindings") win.keybindings = keysView(keys);
  if (tab === "voice") win.voice = voiceView(voiceFacts(speech, label(keys.get("voice"))));
  if (tab === "providers") win.providers = providersTab.view(win.dark);
  if (tab === "usage") win.usage = usageTab.view(win.dark);
  if (tab === "integrations") win.integrations = integrationsTab.view(win.dark);
  if (tab === "webhooks") win.webhooks = webhooksTab.view();
  win.blocks = blocks.get(tab)?.blocks() ?? [];
}

win.pick = (s) => {
  tab = tabFromSlug(s) ?? tab;
  show();
};
win.searched = (q) => {
  win.tabs = navTabs(q);
};
win.toggled = (k, v) => {
  setGeneral(store, k, v);
  setNotifications(store, k, v);
  voiceToggled(speech, k, v);
  show();
};
win.chose = (k, n) => {
  setGeneral(store, k, n);
  setAppearance(store, k, n);
  voiceChose(speech, k, n);
  show();
};
win.usage_act = (what, a, n) => {
  usageTab.act(what, a, n);
};
win.usage_settled = show;
win.integrations_act = integrationsTab.act;
win.integrations_valid = integrationsTab.valid;
win.webhooks_act = webhooksTab.act;
win.providers_act = (id, what) => {
  providersTab.act(id, what);
  show();
};
win.notify_edited = (k, t) => {
  editNotifications(store, k, t);
};
win.voice_edited = (k, t) => {
  voiceEdited(speech, k, t);
};
win.keys_act = (what, arg) => {
  keysAct(keys, store, what, arg);
  show();
};
win.keys_key = (key, ctrl, shift, alt) => {
  keysKey(keys, store, key, ctrl, shift, alt);
  show();
};
win.blocks_pressed = (k) => {
  blocks.get(tab)?.pressed(k);
  show();
};
win.blocks_toggled = (k, v) => {
  blocks.get(tab)?.toggled(k, v);
  show();
};
win.blocks_edited = (k, t) => {
  blocks.get(tab)?.edited(k, t);
};
win.blocks_submitted = (k, a, b, c) => {
  const err = blocks.get(tab)?.submitted(k, [a, b, c]) ?? "";
  if (err === "") show();
  return err;
};
win.pressed = (k) => {
  notifyPressed(k, notifyEnv);
  void voicePressed(speech, k).then(show);
};
show();
// A rig's way to see further down a page: HTS_SCROLL=px wheels the page once, a moment after it opens.
const scrolled = Number(process.env.HTS_SCROLL ?? 0);
if (scrolled > 0) setTimeout(() => win.window.dispatchEvent({ type: "pointer-scrolled", position: { x: 700, y: 500 }, deltaX: 0, deltaY: -scrolled }), 2500);
// A rig's way to click and type: HTS_DO is steps joined by ";", "click X,Y" or "key ctrl+shift+K" (esc, backspace, enter by name), 300 ms apart from 2.5 s after the window opens.
const MODS: Readonly<Record<string, string>> = { ctrl: "\u{11}", shift: "\u{10}", alt: "\u{12}" };
const NAMED: Readonly<Record<string, string>> = { esc: "\u{1b}", backspace: "\u{8}", enter: "\n" };
function drive(step: string): void {
  const [what = "", arg = ""] = step.trim().split(" ");
  if (what === "click") {
    const [x = 0, y = 0] = arg.split(",").map(Number);
    win.window.dispatchEvent({ type: "pointer-moved", position: { x, y } });
    win.window.dispatchEvent({ type: "pointer-pressed", position: { x, y }, button: "left" });
    win.window.dispatchEvent({ type: "pointer-released", position: { x, y }, button: "left" });
  } else if (what === "key") {
    const parts = arg.split("+");
    const key = parts.pop() ?? "";
    const mods = parts.map((m) => MODS[m] ?? "");
    for (const m of mods) win.window.dispatchEvent({ type: "key-pressed", text: m });
    const text = NAMED[key] ?? key;
    win.window.dispatchEvent({ type: "key-pressed", text });
    win.window.dispatchEvent({ type: "key-released", text });
    for (const m of mods.reverse()) win.window.dispatchEvent({ type: "key-released", text: m });
  }
}
const steps = (process.env.HTS_DO ?? "").split(";").filter((s) => s.trim() !== "");
steps.forEach((s, i) => setTimeout(() => drive(s), 2500 + 300 * i));
win.show();
await runLoop();
