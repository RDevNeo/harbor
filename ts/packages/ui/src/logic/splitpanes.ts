// Split chat panes: up to four chats in the window's centre, in any layout a tree of splits gives (each split puts two
// sides left/right or top/bottom, nested). Pure: the layout, where a chat dragged from the sidebar or a pane dragged by
// its header would land, presets, and what kv keeps of it. The shell owns the state and draws it; the focused pane is
// the usual chat view, moved into its place.

/** The most panes the centre holds. */
export const MAX_PANES = 4;
/** kv: the panes, their layout and the focused one, kept across restarts. */
export const SPLIT_KEY = "split_panes";
/** A pane's least share of the split it's in, so a divider never squeezes one away. */
export const MIN_SHARE = 0.15;
/** What kv holds: 2 since the layout is any tree (v0.175.0 wrote the same shape without `v`). */
export const SPLIT_VERSION = 2;

/** A leaf names its pane by index into `chats`; a split puts `a` left of (h) or above (v) `b`, `ratio` of it to `a`. */
export type Node = { pane: number } | { dir: "h" | "v"; ratio: number; a: Node; b: Node };

export interface Split {
  /** Each pane's chat, by pane index (an id: where a pane is on screen is the tree's business). */
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

/** How near the centre's outer edge (shares of its width, height) a drop goes beside the whole layout. */
export interface Band {
  u: number;
  v: number;
}

export const BAND: Band = { u: 0.03, v: 0.04 };

export const single = (chat: number): Split => ({ chats: [chat], focus: 0, tree: { pane: 0 }, max: null });

const isLeaf = (n: Node): n is { pane: number } => "pane" in n;

/** The panes in reading order (the tree's leaves, left to right, top to bottom): Ctrl+1…4 and the presets' order. */
export function order(s: Split): number[] {
  const out: number[] = [];
  const walk = (n: Node): void => {
    if (isLeaf(n)) out.push(n.pane);
    else {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(s.tree);
  return out;
}

const halves = (n: Exclude<Node, { pane: number }>, r: Rect): [Rect, Rect] =>
  n.dir === "h"
    ? [
        { ...r, w: r.w * n.ratio },
        { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) },
      ]
    : [
        { ...r, h: r.h * n.ratio },
        { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) },
      ];

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Each pane's place in the centre, as shares of its width and height (indexed by pane; a hidden one is null). */
export function rects(s: Split): (Rect | null)[] {
  const out: (Rect | null)[] = s.chats.map(() => null);
  if (s.max !== null && s.max < s.chats.length) {
    out[s.max] = FULL;
    return out;
  }
  const walk = (n: Node, r: Rect): void => {
    if (isLeaf(n)) {
      if (n.pane < out.length) out[n.pane] = r;
      return;
    }
    const [ra, rb] = halves(n, r);
    walk(n.a, ra);
    walk(n.b, rb);
  };
  walk(s.tree, FULL);
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
    const [ra, rb] = halves(n, r);
    out.push({ path, dir: n.dir, at: n.dir === "h" ? rb.x : rb.y, area: r });
    walk(n.a, ra, `${path}a`);
    walk(n.b, rb, `${path}b`);
  };
  walk(s.tree, FULL, "");
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

// --- The tree's edits ---

/** How many panes `n` lines up along `dir`: a run of same-direction splits is one row (or column) of equals. */
const span = (n: Node, dir: "h" | "v"): number => (!isLeaf(n) && n.dir === dir ? span(n.a, dir) + span(n.b, dir) : 1);

/** Every split's sides as even as its panes: three columns are a third each, whichever way they nest. A layout's
 * shape changing (a pane added, moved, closed) evens it; a divider dragged after keeps its place until the next. */
export function balance(n: Node): Node {
  if (isLeaf(n)) return n;
  const a = span(n.a, n.dir);
  const b = span(n.b, n.dir);
  return { ...n, ratio: a / (a + b), a: balance(n.a), b: balance(n.b) };
}

/** Leaf `pane` gone, its sibling taking its room (no renumbering). */
function removeLeaf(n: Node, pane: number): Node | null {
  if (isLeaf(n)) return n.pane === pane ? null : n;
  const a = removeLeaf(n.a, pane);
  const b = removeLeaf(n.b, pane);
  if (a === null) return b;
  if (b === null) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** `leaf` put on `side` of pane `target` (-1: of the whole layout). */
function insertLeaf(n: Node, target: number, side: Side, leaf: Node): Node {
  const dir: "h" | "v" = side === "left" || side === "right" ? "h" : "v";
  const first = side === "left" || side === "top";
  const wrap = (x: Node): Node => ({ dir, ratio: 0.5, a: first ? leaf : x, b: first ? x : leaf });
  if (target < 0) return wrap(n);
  const walk = (x: Node): Node => {
    if (isLeaf(x)) return x.pane === target ? wrap(x) : x;
    return { ...x, a: walk(x.a), b: walk(x.b) };
  };
  return walk(n);
}

const swapLeaves = (n: Node, i: number, j: number): Node => {
  if (isLeaf(n)) return n.pane === i ? { pane: j } : n.pane === j ? { pane: i } : n;
  return { ...n, a: swapLeaves(n.a, i, j), b: swapLeaves(n.b, i, j) };
};

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

/** Pane `i` closes (its chat keeps running): its sibling takes its room, the rest evened; later indexes move down. */
export function close(s: Split, i: number): Split {
  if (s.chats.length < 2 || i < 0 || i >= s.chats.length) return s;
  const renumber = (n: Node): Node => (isLeaf(n) ? { pane: n.pane > i ? n.pane - 1 : n.pane } : { ...n, a: renumber(n.a), b: renumber(n.b) });
  const chats = s.chats.filter((_, k) => k !== i);
  // The focused pane gone: the next in reading order takes the keyboard (else the one before).
  let focus = s.focus;
  if (focus === i) {
    const o = order(s);
    const at = o.indexOf(i);
    focus = (o[at + 1] ?? o[at - 1] ?? 0) as number;
  }
  focus = focus > i ? focus - 1 : focus;
  const tree = balance(renumber(removeLeaf(s.tree, i) ?? { pane: 0 }));
  return { chats, focus: Math.min(focus, chats.length - 1), tree, max: s.max === null || s.max === i ? null : s.max > i ? s.max - 1 : s.max };
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

/** Panes `i` and `j` trade places (each keeps its chat, its transcript, the keyboard if it had it). */
export function swap(s: Split, i: number, j: number): Split {
  if (i === j || i < 0 || j < 0 || i >= s.chats.length || j >= s.chats.length) return s;
  return { ...s, tree: swapLeaves(s.tree, i, j), max: null };
}

/** Pane `i` taken out and put on `side` of pane `target` (-1: of the whole layout); it gets the keyboard. */
export function move(s: Split, i: number, target: number, side: Side): Split {
  if (i < 0 || i >= s.chats.length || target === i || target >= s.chats.length || s.chats.length < 2) return s;
  const rest = removeLeaf(s.tree, i);
  if (rest === null) return s;
  return { ...s, focus: i, tree: balance(insertLeaf(rest, target, side, { pane: i })), max: null };
}

// --- Dropping a chat dragged from the sidebar, or a pane dragged by its header ---

export interface Drop {
  kind: "split" | "replace" | "here" | "swap" | "move" | "none";
  /** The pane it lands on or next to (index; -1 beside the whole layout). */
  pane: number;
  side: Side | null;
  /** The highlighted zone, as shares of the centre: where the pane will be. */
  zone: Rect;
  /** "Open on the right · 2 of 4", "Replace this pane", "Swap", "Full width at the bottom". */
  label: string;
  /** Under a replace: "<title> keeps running". */
  sub: string;
}

const NONE: Drop = { kind: "none", pane: -1, side: null, zone: { x: 0, y: 0, w: 0, h: 0 }, label: "", sub: "" };

const where = (side: Side): string => (side === "left" ? "on the left" : side === "right" ? "on the right" : side === "top" ? "above" : "below");
const outerWhere = (side: Side): string => (side === "left" ? "Full height on the left" : side === "right" ? "Full height on the right" : side === "top" ? "Full width at the top" : "Full width at the bottom");

/** Where (u, v) is: the outer band's side (with two or more panes shown), else the pane under it and its part. */
type Spot = { outer: Side } | { pane: number; r: Rect; middle: boolean; side: Side } | null;

function spot(s: Split, u: number, v: number, band: Band, middle: boolean, outer: boolean): Spot {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const all = rects(s);
  const shown = all.filter((r) => r !== null).length;
  if (outer && shown > 1) {
    const edges: [Side, number][] = [
      ["left", u / band.u],
      ["right", (1 - u) / band.u],
      ["top", v / band.v],
      ["bottom", (1 - v) / band.v],
    ];
    const near = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (near[1] < 1) return { outer: near[0] };
  }
  const at = all.findIndex((r) => r !== null && u >= r.x && u <= r.x + r.w && v >= r.y && v <= r.y + r.h);
  if (at < 0) return null;
  const r = all[at] as Rect;
  const fu = (u - r.x) / r.w;
  const fv = (v - r.y) / r.h;
  const mid = middle && fu > 0.3 && fu < 0.7 && fv > 0.3 && fv < 0.7;
  const edges: [Side, number][] = [
    ["left", fu],
    ["right", 1 - fu],
    ["top", fv],
    ["bottom", 1 - fv],
  ];
  return { pane: at, r, middle: mid, side: edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0] };
}

/** Where `chat`, dragged to (u, v) (shares of the centre), would go. `title(chat)` names a pane's chat for "keeps running". */
export function dropAt(s: Split, chat: number, u: number, v: number, title: (chat: number) => string, band: Band = BAND): Drop {
  const n = s.chats.length;
  const existing = s.chats.indexOf(chat);
  // One pane (or one shown alone): its four sides; more: each pane's sides, its middle replaces it, the outer edges.
  const at = spot(s, u, v, band, n > 1 && s.max === null, n < MAX_PANES);
  if (at === null) return NONE;
  if (existing >= 0) return { ...NONE, kind: "here", pane: existing, zone: rects(s)[existing] ?? FULL, label: "Already open" };
  const replace = (i: number): Drop => ({ kind: "replace", pane: i, side: null, zone: rects(s)[i] ?? FULL, label: "Replace this pane", sub: `${title(s.chats[i] as number)} keeps running` });
  if ("outer" in at) {
    const next = dropped(s, chat, { ...NONE, kind: "split", pane: -1, side: at.outer });
    return { kind: "split", pane: -1, side: at.outer, zone: rects(next)[n] ?? FULL, label: `${outerWhere(at.outer)} · ${n + 1} of ${MAX_PANES}`, sub: "" };
  }
  // Four already: only a pane can be replaced.
  if (n >= MAX_PANES || at.middle) return replace(at.pane);
  // One shown alone: the new one goes beside the whole layout.
  const pane = s.max !== null ? -1 : at.pane;
  const next = dropped(s, chat, { ...NONE, kind: "split", pane, side: at.side });
  return { kind: "split", pane, side: at.side, zone: rects(next)[n] ?? FULL, label: `Open ${where(at.side)} · ${n + 1} of ${MAX_PANES}`, sub: "" };
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
  const target = s.max === null ? d.pane : -1;
  return { chats: [...s.chats, chat], focus: idx, tree: balance(insertLeaf(s.tree, target, d.side, { pane: idx })), max: null };
}

/** Where pane `i`, dragged by its header to (u, v), would go: another pane's middle swaps them, its sides move it there,
 * the centre's outer edges put it beside the whole layout. */
export function paneDropAt(s: Split, i: number, u: number, v: number, band: Band = BAND): Drop {
  if (s.chats.length < 2 || s.max !== null || i < 0 || i >= s.chats.length) return NONE;
  const at = spot(s, u, v, band, true, true);
  if (at === null) return NONE;
  if ("outer" in at) {
    const next = move(s, i, -1, at.outer);
    return { kind: "move", pane: -1, side: at.outer, zone: rects(next)[i] ?? FULL, label: outerWhere(at.outer), sub: "" };
  }
  if (at.pane === i) return { ...NONE, zone: at.r };
  if (at.middle) return { kind: "swap", pane: at.pane, side: null, zone: at.r, label: "Swap", sub: "" };
  const next = move(s, i, at.pane, at.side);
  return { kind: "move", pane: at.pane, side: at.side, zone: rects(next)[i] ?? FULL, label: `Move ${where(at.side)}`, sub: "" };
}

export function paneDropped(s: Split, i: number, d: Drop): Split {
  if (d.kind === "swap") return { ...swap(s, i, d.pane), focus: i };
  if (d.kind === "move" && d.side !== null) return move(s, i, d.pane, d.side);
  return s;
}

// --- The top bar's layout buttons ---

export type Preset = "cols" | "rows" | "main" | "2x2";
export const PRESETS: readonly Preset[] = ["cols", "rows", "main", "2x2"];
/** The panes a preset needs open. */
const NEEDS: Record<Preset, number> = { cols: 2, rows: 2, main: 3, "2x2": 4 };

/** `ids` side by side (h) or stacked (v), each an even share. */
const run = (ids: number[], dir: "h" | "v"): Node => {
  const [first, ...rest] = ids;
  if (rest.length === 0) return { pane: first as number };
  return { dir, ratio: 1 / ids.length, a: { pane: first as number }, b: run(rest, dir) };
};

const presetTree = (p: Preset, ids: number[]): Node => {
  switch (p) {
    case "cols":
      return run(ids, "h");
    case "rows":
      return run(ids, "v");
    case "main":
      return { dir: "h", ratio: 0.5, a: { pane: ids[0] as number }, b: run(ids.slice(1), "v") };
    case "2x2":
      return { dir: "v", ratio: 0.5, a: run(ids.slice(0, 2), "h"), b: run(ids.slice(2), "h") };
  }
};

/** A tree's shape, its panes left out: columns of three nest either way. */
const shape = (n: Node): string => {
  if (isLeaf(n)) return "p";
  const parts: string[] = [];
  const flat = (x: Node): void => {
    if (!isLeaf(x) && x.dir === n.dir) {
      flat(x.a);
      flat(x.b);
    } else parts.push(shape(x));
  };
  flat(n);
  return `${n.dir}(${parts.join(",")})`;
};

/** The layout shown, when it is one of the presets (else ""). */
export function presetOf(s: Split): Preset | "" {
  if (s.max !== null || s.chats.length < 2) return "";
  const mine = shape(s.tree);
  // Two by two either way round: two rows of two, or two columns of two.
  if (mine === "h(v(p,p),v(p,p))" && s.chats.length === 4) return "2x2";
  return PRESETS.find((p) => NEEDS[p] <= s.chats.length && shape(presetTree(p, order(s))) === mine) ?? "";
}

/** Can preset `p` be picked: it needs that many panes open (columns and rows any number). */
export function presetEnabled(s: Split, p: Preset): boolean {
  return s.chats.length >= NEEDS[p] && (p !== "2x2" || s.chats.length === 4);
}

export function presetTip(s: Split, p: Preset): string {
  const name = p === "cols" ? "Side by side" : p === "rows" ? "Stacked" : p === "main" ? "One big, the rest stacked beside it" : "Two by two";
  if (presetEnabled(s, p)) return name;
  return `${name} · needs ${NEEDS[p]} panes, drag a chat from the sidebar`;
}

/** Preset `p` with the panes open, in their reading order (the panes keep their chats). */
export function applyPreset(s: Split, p: Preset): Split {
  if (!presetEnabled(s, p)) return s;
  return { ...s, tree: presetTree(p, order(s)), max: null };
}

// --- kv ---

/** A saved tree checked: each pane once, ratios within bounds (clamped). Null: not a layout of `count` panes. */
const readTree = (n: unknown, count: number, seen: Set<number>): Node | null => {
  if (typeof n !== "object" || n === null) return null;
  const o = n as Record<string, unknown>;
  if (typeof o.pane === "number") {
    if (!Number.isInteger(o.pane) || o.pane < 0 || o.pane >= count || seen.has(o.pane)) return null;
    seen.add(o.pane);
    return { pane: o.pane };
  }
  if ((o.dir !== "h" && o.dir !== "v") || typeof o.ratio !== "number" || !Number.isFinite(o.ratio)) return null;
  const a = readTree(o.a, count, seen);
  const b = a === null ? null : readTree(o.b, count, seen);
  if (a === null || b === null) return null;
  return { dir: o.dir, ratio: Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, o.ratio)), a, b };
};

/** What kv holds, read: this version's, or v0.175.0's (the same fields without `v`; a tree it can't read becomes
 * columns, the chats kept). */
export function parse(raw: string | null | undefined): Split | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Split> & { v?: number };
    if (typeof o !== "object" || o === null || (o.v !== undefined && o.v > SPLIT_VERSION)) return null;
    const chats = o.chats;
    if (!Array.isArray(chats) || chats.length < 1 || chats.length > MAX_PANES || !chats.every((c) => Number.isInteger(c)) || new Set(chats).size !== chats.length) return null;
    const seen = new Set<number>();
    let tree = readTree(o.tree, chats.length, seen);
    if (tree === null || seen.size !== chats.length) tree = run(chats.map((_, i) => i), "h");
    const focus = Number.isInteger(o.focus) && (o.focus as number) >= 0 && (o.focus as number) < chats.length ? (o.focus as number) : 0;
    const max = Number.isInteger(o.max) && (o.max as number) >= 0 && (o.max as number) < chats.length ? (o.max as number) : null;
    return { chats, focus, tree, max };
  } catch {
    return null;
  }
}

export const serialize = (s: Split): string => JSON.stringify({ v: SPLIT_VERSION, chats: s.chats, focus: s.focus, tree: s.tree, max: s.max });
