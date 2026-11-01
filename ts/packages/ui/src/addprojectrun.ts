import { join } from "node:path";
import * as slint from "slint-ui";
import { git } from "@harbor/agents";
import { dataDir, Store } from "@harbor/store";
import { type AddProjectView, attachAddProject } from "./addproject.ts";
import { uiDir } from "./assets.ts";
import { appMark } from "./logos.ts";
import { runLoop } from "./loop.ts";
import { token } from "./theme.ts";

interface AddProjectWindow extends slint.ComponentHandle, AddProjectView {
  dark: boolean;
}

const store = Store.open(dataDir());
const ui = slint.loadFile(join(await uiDir(), "addproject.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "AddProjectWindow");
if (typeof ctor !== "function") throw new Error("addproject.slint has no AddProjectWindow");
const win: AddProjectWindow = new ctor();
win.dark = process.env.HTS_LIGHT === undefined;
attachAddProject(win, store, await appMark("github", token("fg", win.dark), win.dark), {
  added: () => {},
  done: () => process.exit(0),
  openUrl: git.openUrl,
});
for (const k of (process.argv[2] ?? "").split(",").filter(Boolean)) {
  if (k.startsWith("=")) win.edited(k.slice(1));
  else win.key(k === "up" || k === "down" || k === "enter" || k === "add" || k === "back" ? k : "esc");
}
win.show();
await runLoop();
