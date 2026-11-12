import { join } from "node:path";
import * as slint from "slint-ui";
import { dataDir, Store } from "@harbor/store";
import { voice } from "@harbor/media";
import { setHarborVersion } from "@harbor/mcp";
import pkg from "../../../package.json" with { type: "json" };
import { Desktop, spawnNotifySend, testNote } from "@harbor/net";
import { uiDir } from "./assets.ts";
import { Keys } from "./logic/keys.ts";
import { loadQr } from "./qr.ts";
import { tabFromSlug } from "./logic/pages.ts";
import { type NotifyEnv } from "./logic/settings-notifications.ts";
import { busOf } from "./pages/bus.ts";
import { mountSettings, settingsSpeech, type SettingsView } from "./pages/settings.ts";
import { runLoop } from "./loop.ts";

interface SettingsWindow extends slint.ComponentHandle {
  dark: boolean;
}

setHarborVersion(pkg.version);
const store = Store.open(dataDir());
const ui = slint.loadFile(join(await uiDir(), "settings.slint"), { style: "fluent", quiet: true });
const ctor = Reflect.get(ui, "SettingsWindow");
if (typeof ctor !== "function") throw new Error("settings.slint has no SettingsWindow");
const win: SettingsWindow = new ctor();
const bus = busOf<SettingsView>(win, "SettingsBus");
// HTS_LIGHT=1 (HARBOR_SHOT_LIGHT=1 through scripts/shot --env): the light theme.
const light = (process.env.HTS_LIGHT ?? process.env.HARBOR_SHOT_LIGHT) !== undefined;
win.dark = !light;

// The rig doesn't reach Hugging Face: a model download fails at once, here.
voice.setFetcher(() => Promise.reject(new Error("no network in the settings runner")));
const notify: NotifyEnv = { sendTest: () => void new Desktop({ send: spawnNotifySend }).testPopup(testNote()) };
// The rig has no terminal, updater, clipboard, Discord window or login to draw a code for: those buttons do nothing here.
await mountSettings(
  bus,
  {
    store,
    keys: Keys.load(store),
    speech: settingsSpeech(store),
    theme: {
      dark: () => win.dark,
      set: (dark) => {
        win.dark = !light && dark;
      },
    },
    back: () => {},
    providers: { login: () => {}, addClaudeAccount: () => {} },
    integrations: { discordWindow: () => {} },
    qr: await loadQr(),
    notify,
    copy: () => {},
  },
  tabFromSlug(process.argv[2] ?? "general") ?? "general",
);
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
