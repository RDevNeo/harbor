import { homedir } from "node:os";
import { join } from "node:path";
import * as slint from "slint-ui";
import { dataDir, repoDir, Store } from "@harbor/store";
import { uiDir } from "./assets.ts";
import { paletteItems } from "./logic/palette.ts";
import { runLoop } from "./loop.ts";
import { busOf } from "./pages/bus.ts";
import { mountPalette, type PaletteView } from "./pages/palette.ts";

interface PaletteWindow extends slint.ComponentHandle {
  dark: boolean;
}

const store = Store.open(dataDir());
const tilde = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const ui = slint.loadFile(join(await uiDir(), "palette.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "PaletteWindow");
if (typeof ctor !== "function") throw new Error("palette.slint has no PaletteWindow");
const win: PaletteWindow = new ctor();
win.dark = process.env.HTS_LIGHT === undefined;
const palette = mountPalette(busOf<PaletteView>(win, "PaletteBus"), {
  items: () =>
    paletteItems({
      repos: store.repos().map((r) => ({ id: r.id, name: r.name, dir: tilde(repoDir(r)) })),
      chats: store.chats().map((c) => ({ id: c.id, title: c.title, role: c.role, parent: c.parent, name: c.name, repoId: c.repoId, settled: c.settled, updated: c.updated })),
      devices: [],
      current: null,
      draftRepo: null,
      fast: store.get("fast_mode") === "1",
      forkable: false,
    }),
  kv: store,
  run: () => {},
  close: () => {},
});
palette.open();
palette.show(process.argv[2] ?? "");
win.show();
await runLoop();
