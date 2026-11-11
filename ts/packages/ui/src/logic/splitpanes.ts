// Split chat panes: up to four chats side by side in the window's centre. Pure: the layout (a tree of splits whose
// leaves are panes), where a chat dragged from the sidebar would land, presets, and what kv keeps of it. The shell
// owns the state and draws it; the focused pane is the usual chat view, moved into its place.

/** The most panes the centre holds. */
export const MAX_PANES = 4;
/** kv: the panes, their layout and the focused one, kept across restarts. */
export const SPLIT_KEY = "split_panes";
/** A pane's least share of the split it's in, so a divider never squeezes one away. */
export const MIN_SHARE = 0.15;

/** A leaf names its pane by index into `chats`; a split puts `a` left of (h) or above (v) `b`, `ratio` of it to `a`. */
export type Node = { pane: number } | { dir: "h" | "v"; ratio: number; a: Node; b: Node };

export interface Split {
  /** Each pane's chat, by pane number - 1. */
  chats: number[];
  /** The focused pane's index: the usual chat view, with the keyboard. */
  focus: number;
  tree: Node;
  /** A pane shown alone (its maximize toggle), the others kept; null: all shown. */
  max: number | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export const single = (chat: number): Split => ({ chats: [chat], focus: 0, tree: { pane: 0 }, max: null });

const isLeaf = (n: Node): n is { pane: number } => "pane" in n;

/** Each pane's place in the centre, as shares of its width and height (indexed by pane; a hidden one is null). */
export function rects(s: Split): (Rect | null)[] {
  const out: (Rect | null)[] = s.chats.map(() => null);
  if (s.max !== null && s.max < s.chats.length) {
    out[s.max] = { x: 0, y: 0, w: 1, h: 1 };
    return out;
  }
  const walk = (n: Node, r: Rect): void => {
    if (isLeaf(n)) {
      if (n.pane < out.length) out[n.pane] = r;
      return;
    }
    if (n.dir === "h") {
      walk(n.a, { ...r, w: r.w * n.ratio });
      walk(n.b, { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) });
    } else {
      walk(n.a, { ...r, h: r.h * n.ratio });
      walk(n.b, { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) });
    }
  };
  walk(s.tree, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/** A divider between the two sides of a split: `path` finds it ("a"/"b" steps from the root), `area` is the split's. */
export interface Divider {
  path: string;
  dir: "h" | "v";
  /** Where the line is (share of the centre): x for "h", y for "v". */
  at: number;
  area: Rect;
}

export function dividers(s: Split): Divider[] {
  if (s.max !== null || s.chats.length < 2) return [];
  const out: Divider[] = [];
  const walk = (n: Node, r: Rect, path: string): void => {
    if (isLeaf(n)) return;
    if (n.dir === "h") {
      out.push({ path, dir: "h", at: r.x + r.w * n.ratio, area: r });
      walk(n.a, { ...r, w: r.w * n.ratio }, `${path}a`);
      walk(n.b, { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) }, `${path}b`);
    } else {
      out.push({ path, dir: "v", at: r.y + r.h * n.ratio, area: r });
      walk(n.a, { ...r, h: r.h * n.ratio }, `${path}a`);
      walk(n.b, { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) }, `${path}b`);
    }
  };
  walk(s.tree, { x: 0, y: 0, w: 1, h: 1 }, "");
  return out;
}

const mapAt = (n: Node, path: string, f: (n: Node) => Node): Node => {
  if (path === "") return f(n);
  if (isLeaf(n)) return n;
  return path[0] === "a" ? { ...n, a: mapAt(n.a, path.slice(1), f) } : { ...n, b: mapAt(n.b, path.slice(1), f) };
};

/** Divider `path` dragged to `at` (share of the centre along its direction). */
export function resize(s: Split, path: string, at: number): Split {
  const d = dividers(s).find((x) => x.path === path);
  if (!d) return s;
  const [start, len] = d.dir === "h" ? [d.area.x, d.area.w] : [d.area.y, d.area.h];
  if (len <= 0) return s;
  const ratio = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, (at - start) / len));
  return { ...s, tree: mapAt(s.tree, path, (n) => (isLeaf(n) ? n : { ...n, ratio })) };
}

/** Opening `chat` (a sidebar click, a link): its pane is focused if it has one, else it takes the focused pane. */
export function opened(s: Split, chat: number): Split {
  const at = s.chats.indexOf(chat);
  if (at >= 0) return at === s.focus && (s.max === null || s.max === at) ? s : { ...s, focus: at, max: s.max === null ? null : at };
  const chats = s.chats.slice();
  chats[s.focus] = chat;
  return { ...s, chats };
}

export function focus(s: Split, i: number): Split {
  if (i < 0 || i >= s.chats.length || i === s.focus) return s;
  return { ...s, focus: i, max: s.max === null ? null : i };
}

/** Pane `i` closes (its chat keeps running): its sibling takes its room, later panes move up a number. */
export function close(s: Split, i: number): Split {
  if (s.chats.length < 2 || i < 0 || i >= s.chats.length) return s;
  const drop = (n: Node): Node | null => {
    if (isLeaf(n)) return n.pane === i ? null : { pane: n.pane > i ? n.pane - 1 : n.pane };
    const a = drop(n.a);
    const b = drop(n.b);
    if (a === null) return b;
    if (b === null) return a;
    return { ...n, a, b };
  };
  const chats = s.chats.filter((_, k) => k !== i);
  const focus = s.focus === i ? Math.min(i, chats.length - 1) : s.focus > i ? s.focus - 1 : s.focus;
  const tree = drop(s.tree) ?? { pane: 0 };
  return { chats, focus, tree, max: s.max === null || s.max === i ? null : s.max > i ? s.max - 1 : s.max };
}

/** Panes whose chat is gone (deleted, moved away) close; none left: null. */
export function prune(s: Split, alive: (chat: number) => boolean): Split | null {
  let out = s;
  for (let i = out.chats.length - 1; i >= 0; i--) {
    if (alive(out.chats[i] as number)) continue;
    if (out.chats.length === 1) return null;
    out = close(out, i);
  }
  return out;
}

/** Pane `i` shown alone, or (shown alone already) back with the others. */
export function toggleMax(s: Split, i: number): Split {
  if (s.chats.length < 2) return s;
  return s.max === i ? { ...s, max: null } : { ...s, focus: i, max: i };
}

// --- Dropping a chat dragged from the sidebar ---

export interface Drop {
  kind: "split" | "replace" | "here" | "none";
  /** The pane it lands on or next to (index). */
  pane: number;
  side: Side | null;
  /** The highlighted zone, as shares of the centre. */
  zone: Rect;
  /** "Open on the right · 2 of 4", "Replace pane 2". */
  label: string;
  /** Under a replace: "<title> keeps running". */
  sub: string;
}

const NONE: Drop = { kind: "none", pane: -1, side: null, zone: { x: 0, y: 0, w: 0, h: 0 }, label: "", sub: "" };

const half = (r: Rect, side: Side): Rect =>
  side === "left" ? { ...r, w: r.w / 2 } : side === "right" ? { ...r, x: r.x + r.w / 2, w: r.w / 2 } : side === "top" ? { ...r, h: r.h / 2 } : { ...r, y: r.y + r.h / 2, h: r.h / 2 };

/** Where `chat`, dragged to (u, v) (shares of the centre), would go. `title(chat)` names a pane's chat for "keeps running". */
export function dropAt(s: Split, chat: number, u: number, v: number, title: (chat: number) => string): Drop {
  if (u < 0 || u > 1 || v < 0 || v > 1) return NONE;
  const all = rects(s);
  const at = all.findIndex((r) => r !== null && u >= r.x && u <= r.x + r.w && v >= r.y && v <= r.y + r.h);
  if (at < 0) return NONE;
  const r = all[at] as Rect;
  const n = s.chats.length;
  const existing = s.chats.indexOf(chat);
  if (existing >= 0) return { ...NONE, kind: "here", pane: existing, zone: all[existing] ?? r, label: `Already in pane ${existing + 1}` };
  const replace = (): Drop => ({ kind: "replace", pane: at, side: null, zone: r, label: `Replace pane ${at + 1}`, sub: `${title(s.chats[at] as number)} keeps running` });
  // Four already (or one shown alone): only a pane can be replaced.
  if (n >= MAX_PANES) return replace();
  const count = `${n + 1} of ${MAX_PANES}`;
  if (n === 1 || s.max !== null) {
    const side: Side = u < r.x + r.w / 2 ? "left" : "right";
    return { kind: "split", pane: at, side, zone: half(r, side), label: `Open on the ${side} · ${count}`, sub: "" };
  }
  // Within a pane: its middle replaces it, nearer an edge splits it on that side.
  const fu = (u - r.x) / r.w;
  const fv = (v - r.y) / r.h;
  if (fu > 0.3 && fu < 0.7 && fv > 0.3 && fv < 0.7) return replace();
  const edges: [Side, number][] = [
    ["left", fu],
    ["right", 1 - fu],
    ["top", fv],
    ["bottom", 1 - fv],
  ];
  const side = edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  const where = side === "left" ? "left of" : side === "right" ? "right of" : side === "top" ? "above" : "below";
  return { kind: "split", pane: at, side, zone: half(r, side), label: `Open ${where} pane ${at + 1} · ${count}`, sub: "" };
}

/** The drop done: the chat gets its pane (focused). */
export function dropped(s: Split, chat: number, d: Drop): Split {
  if (d.kind === "here") return focus({ ...s, max: null }, d.pane);
  if (d.kind === "replace") {
    const chats = s.chats.slice();
    chats[d.pane] = chat;
    return { ...s, chats, focus: d.pane };
  }
  if (d.kind !== "split" || d.side === null || s.chats.length >= MAX_PANES) return s;
  const idx = s.chats.length;
  const leaf: Node = { pane: idx };
  const dir: "h" | "v" = d.side === "left" || d.side === "right" ? "h" : "v";
  const first = d.side === "left" || d.side === "top";
  const target = s.max === null ? d.pane : -1;
  const wrap = (n: Node): Node => {
    if (isLeaf(n)) {
      if (n.pane !== target) return n;
      return { dir, ratio: 0.5, a: first ? leaf : n, b: first ? n : leaf };
    }
    return { ...n, a: wrap(n.a), b: wrap(n.b) };
  };
  // One pane shown alone: the new one goes beside the whole layout.
  const tree = target === -1 ? { dir, ratio: 0.5, a: first ? leaf : s.tree, b: first ? s.tree : leaf } : wrap(s.tree);
  return { chats: [...s.chats, chat], focus: idx, tree, max: null };
}

// --- The top bar's layout buttons ---

export type Preset = "1" | "2" | "1+2" | "2x2";
export const PRESETS: readonly Preset[] = ["1", "2", "1+2", "2x2"];
const SLOTS: Record<Preset, number> = { "1": 1, "2": 2, "1+2": 3, "2x2": 4 };

const presetTree = (p: Preset): Node => {
  switch (p) {
    case "1":
      return { pane: 0 };
    case "2":
      return { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { pane: 1 } };
    case "1+2":
      return { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { dir: "v", ratio: 0.5, a: { pane: 1 }, b: { pane: 2 } } };
    case "2x2":
      return { dir: "v", ratio: 0.5, a: { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { pane: 1 } }, b: { dir: "h", ratio: 0.5, a: { pane: 2 }, b: { pane: 3 } } };
  }
};

/** The layout shown, when it is one of the presets (else ""). */
export function presetOf(s: Split): Preset | "" {
  if (s.max !== null || s.chats.length === 1) return "1";
  const shape = (n: Node): string => (isLeaf(n) ? "p" : `${n.dir}(${shape(n.a)},${shape(n.b)})`);
  const mine = shape(s.tree);
  return PRESETS.find((p) => SLOTS[p] === s.chats.length && shape(presetTree(p)) === mine) ?? "";
}

/** Can preset `p` be picked with the panes open: "1" shows the focused one alone; the rest need that many panes, and
 * a smaller one closes the panes past it (the focused one stays). */
export function presetEnabled(s: Split, p: Preset): boolean {
  return p === "1" ? s.chats.length > 1 : SLOTS[p] <= s.chats.length;
}

export function presetTip(s: Split, p: Preset): string {
  const name = p === "1" ? "One pane" : p === "2" ? "Two side by side" : p === "1+2" ? "One tall, two stacked" : "Two by two";
  if (p === "1") return s.max !== null ? "Show every pane" : `${name} · the others stay open`;
  const extra = s.chats.length - SLOTS[p];
  if (extra < 0) return `${name} · drag a chat from the sidebar to add a pane`;
  if (extra > 0) return `${name} · closes ${extra === 1 ? "a pane" : `${extra} panes`}, the chats keep running`;
  return name;
}

export function applyPreset(s: Split, p: Preset): Split {
  if (!presetEnabled(s, p)) return s;
  if (p === "1") return s.max !== null ? { ...s, max: null } : toggleMax(s, s.focus);
  let out: Split = { ...s, max: null };
  // Too many panes: the ones past the preset's count go, the focused one kept.
  while (out.chats.length > SLOTS[p]) {
    let drop = out.chats.length - 1;
    if (drop === out.focus) drop--;
    out = close(out, drop);
  }
  // The panes keep their numbers: the tree's leaves are in number order.
  return { ...out, tree: presetTree(p) };
}

// --- kv ---

const validTree = (n: unknown, count: number, seen: Set<number>): n is Node => {
  if (typeof n !== "object" || n === null) return false;
  const o = n as Record<string, unknown>;
  if (typeof o.pane === "number") {
    if (!Number.isInteger(o.pane) || o.pane < 0 || o.pane >= count || seen.has(o.pane)) return false;
    seen.add(o.pane);
    return true;
  }
  return (o.dir === "h" || o.dir === "v") && typeof o.ratio === "number" && o.ratio >= MIN_SHARE && o.ratio <= 1 - MIN_SHARE && validTree(o.a, count, seen) && validTree(o.b, count, seen);
};

export function parse(raw: string | null | undefined): Split | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Split>;
    const chats = o.chats;
    if (!Array.isArray(chats) || chats.length < 1 || chats.length > MAX_PANES || !chats.every((c) => Number.isInteger(c)) || new Set(chats).size !== chats.length) return null;
    const seen = new Set<number>();
    if (!validTree(o.tree, chats.length, seen) || seen.size !== chats.length) return null;
    const focus = Number.isInteger(o.focus) && (o.focus as number) >= 0 && (o.focus as number) < chats.length ? (o.focus as number) : 0;
    const max = Number.isInteger(o.max) && (o.max as number) >= 0 && (o.max as number) < chats.length ? (o.max as number) : null;
    return { chats, focus, tree: o.tree as Node, max };
  } catch {
    return null;
  }
}

export const serialize = (s: Split): string => JSON.stringify(s);
