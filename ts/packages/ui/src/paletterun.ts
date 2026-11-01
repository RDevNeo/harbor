import { homedir } from "node:os";
import { join } from "node:path";
import * as slint from "slint-ui";
import { dataDir, repoDir, Store } from "@harbor/store";
import { uiDir } from "./assets.ts";
import { paletteItems, rank, RECENT_KEY, SECTION_TITLES, type Item } from "./logic/palette.ts";
import { runLoop } from "./loop.ts";

interface Row {
  icon: string;
  title: string;
  detail: string;
  index: number;
}

interface PaletteWindow extends slint.ComponentHandle {
  dark: boolean;
  sections: { title: string; rows: Row[] }[];
  selected: number;
  edited: (t: string) => void;
  move: (d: number) => void;
  pick: (i: number) => void;
  close: () => void;
}

const store = Store.open(dataDir());
const tilde = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const items = paletteItems({
  repos: store.repos().map((r) => ({ id: r.id, name: r.name, dir: tilde(repoDir(r)) })),
  chats: store.chats().map((c) => ({ id: c.id, title: c.title, role: c.role, parent: c.parent, name: c.name, repoId: c.repoId, settled: c.settled, updated: c.updated })),
  devices: [],
  current: null,
  draftRepo: null,
  fast: store.get("fast_mode") === "1",
  forkable: false,
});
const recent = (() => {
  try {
    const v: unknown = JSON.parse(store.get(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
})();

const ui = slint.loadFile(join(await uiDir(), "palette.slint"), { style: "fluent" });
const ctor = Reflect.get(ui, "PaletteWindow");
if (typeof ctor !== "function") throw new Error("palette.slint has no PaletteWindow");
const win: PaletteWindow = new ctor();
win.dark = process.env.HTS_LIGHT === undefined;
let flat: Item[] = [];

function show(q: string): void {
  const sections = rank(items, q, recent);
  flat = sections.flatMap(([, v]) => v);
  let k = 0;
  win.sections = sections.map(([s, v]) => ({ title: SECTION_TITLES[s], rows: v.map((it) => ({ icon: it.icon, title: it.title, detail: it.detail, index: k++ })) }));
  win.selected = Math.min(win.selected, Math.max(0, flat.length - 1));
}

win.edited = (t) => {
  win.selected = 0;
  show(t);
};
win.move = (d) => {
  const n = flat.length;
  if (n > 0) win.selected = (((win.selected + d) % n) + n) % n;
};
win.pick = () => {};
win.close = () => {};
show(process.argv[2] ?? "");
win.show();
await runLoop();
