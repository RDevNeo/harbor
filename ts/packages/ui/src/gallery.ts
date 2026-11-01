import { join } from "node:path";
import * as slint from "slint-ui";
import { uiDir } from "./assets.ts";
import { runLoop } from "./loop.ts";

interface GalleryWindow extends slint.ComponentHandle {
  dark: boolean;
}

const dir = await uiDir();
const ui = slint.loadFile(join(dir, "gallery.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "Gallery");
if (typeof ctor !== "function") throw new Error("gallery.slint has no Gallery");
const win: GalleryWindow = new ctor();
win.dark = process.argv[2] !== "light";
win.show();
await runLoop();
