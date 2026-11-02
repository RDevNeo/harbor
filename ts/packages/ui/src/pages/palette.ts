import { type Kv } from "../logic/settings.ts";
import { type Item, rank, RECENT_KEY, remember, SECTION_TITLES } from "../logic/palette.ts";

/** The properties and callbacks of slint/palette.slint's `PaletteBus`, as TypeScript sees them. */
export interface PaletteView {
  sections: { title: string; rows: { icon: string; title: string; detail: string; index: number }[] }[];
  selected: number;
  query: string;
  edited: (t: string) => void;
  move: (d: number) => void;
  pick: (i: number) => void;
  close: () => void;
}

export interface PaletteDeps {
  /** Everything the palette offers now, asked once per opening. */
  items: () => Item[];
  kv: Kv;
  /** A pick, after the palette is closed and the pick remembered. */
  run: (it: Item) => void;
  close: () => void;
}

export interface PaletteHandle {
  /** Starts again with an empty query. */
  open: () => void;
  /** Lists what matches `query`, leaving the text field as it is. */
  show: (query: string) => void;
}

export function paletteRecent(kv: Kv): string[] {
  try {
    const v: unknown = JSON.parse(kv.get(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mountPalette(bus: PaletteView, deps: PaletteDeps): PaletteHandle {
  let items: Item[] = [];
  let flat: Item[] = [];

  function show(query: string): void {
    const sections = rank(items, query, paletteRecent(deps.kv));
    flat = sections.flatMap(([, v]) => v);
    let k = 0;
    bus.sections = sections.map(([s, v]) => ({ title: SECTION_TITLES[s], rows: v.map((it) => ({ icon: it.icon, title: it.title, detail: it.detail, index: k++ })) }));
    bus.selected = Math.min(bus.selected, Math.max(0, flat.length - 1));
  }

  bus.edited = (t) => {
    bus.selected = 0;
    show(t);
  };
  bus.move = (d) => {
    const n = flat.length;
    if (n > 0) bus.selected = (((bus.selected + d) % n) + n) % n;
  };
  bus.pick = (i) => {
    const it = flat[i];
    if (it === undefined) return;
    deps.kv.set(RECENT_KEY, JSON.stringify(remember(paletteRecent(deps.kv), it.id)));
    deps.close();
    deps.run(it);
  };
  bus.close = () => deps.close();
  return {
    open() {
      items = deps.items();
      bus.query = "";
      bus.selected = 0;
      show("");
    },
    show,
  };
}
