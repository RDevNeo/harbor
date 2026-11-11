import { describe, expect, test } from "bun:test";
import {
  applyPreset,
  balance,
  close,
  dividers,
  dropAt,
  dropped,
  focus,
  type Node,
  opened,
  order,
  paneDropAt,
  paneDropped,
  parse,
  presetEnabled,
  presetOf,
  prune,
  rects,
  resize,
  serialize,
  single,
  type Split,
  toggleMax,
} from "../src/logic/splitpanes.ts";

const title = (c: number) => `chat ${c}`;
const drop = (s: Split, chat: number, u: number, v: number) => dropped(s, chat, dropAt(s, chat, u, v, title));
const paneDrop = (s: Split, i: number, u: number, v: number) => paneDropped(s, i, paneDropAt(s, i, u, v));
const near = (r: { x: number; y: number; w: number; h: number } | null | undefined, x: number, y: number, w: number, h: number) => {
  expect(r).not.toBeNull();
  for (const [a, b] of [
    [r?.x, x],
    [r?.y, y],
    [r?.w, w],
    [r?.h, h],
  ] as const)
    expect(a).toBeCloseTo(b, 5);
};
/** Three columns: chats 1, 2, 3 left to right. */
const three = () => drop(drop(single(1), 2, 0.9, 0.5), 3, 0.995, 0.5);

describe("split tree", () => {
  test("one pane: its four sides", () => {
    const s = single(10);
    const right = dropAt(s, 20, 0.9, 0.5, title);
    expect(right.kind).toBe("split");
    expect(right.label).toBe("Open on the right · 2 of 4");
    near(right.zone, 0.5, 0, 0.5, 1);
    const below = dropAt(s, 20, 0.5, 0.95, title);
    expect(below.label).toBe("Open below · 2 of 4");
    near(below.zone, 0, 0.5, 1, 0.5);
    const two = dropped(s, 20, right);
    expect(two.chats).toEqual([10, 20]);
    expect(two.focus).toBe(1);
    expect(presetOf(two)).toBe("cols");
    near(rects(drop(s, 20, 0.05, 0.5))[1], 0, 0, 0.5, 1);
    expect(presetOf(drop(s, 20, 0.5, 0.05))).toBe("rows");
  });

  test("outer edges: full height column, full width row, evened", () => {
    // Two side by side, then the very right edge: three even columns.
    const s = three();
    expect(order(s)).toEqual([0, 1, 2]);
    near(rects(s)[0], 0, 0, 1 / 3, 1);
    near(rects(s)[2], 2 / 3, 0, 1 / 3, 1);
    expect(presetOf(s)).toBe("cols");
    // The very bottom edge: a full-width row under the two.
    const two = drop(single(1), 2, 0.9, 0.5);
    const d = dropAt(two, 3, 0.5, 0.99, title);
    expect(d.kind).toBe("split");
    expect(d.pane).toBe(-1);
    expect(d.label).toBe("Full width at the bottom · 3 of 4");
    const t = dropped(two, 3, d);
    near(rects(t)[2], 0, 0.5, 1, 0.5);
    near(rects(t)[0], 0, 0, 0.5, 0.5);
    // Three columns + one full-width at the bottom.
    const f = drop(s, 4, 0.5, 0.99);
    near(rects(f)[3], 0, 0.5, 1, 0.5);
    near(rects(f)[1], 1 / 3, 0, 1 / 3, 0.5);
    // A full-width row on top of two, a full-height column left of two stacked.
    near(rects(drop(two, 3, 0.5, 0.01))[2], 0, 0, 1, 0.5);
    const stacked = drop(single(1), 2, 0.5, 0.95);
    near(rects(drop(stacked, 3, 0.01, 0.5))[2], 0, 0, 0.5, 1);
  });

  test("a pane's sides, its middle, and the cap", () => {
    let s = drop(single(1), 2, 0.9, 0.5);
    // Below pane 2: one tall left, two stacked right.
    const below = dropAt(s, 3, 0.75, 0.9, title);
    expect(below.label).toBe("Open below · 3 of 4");
    near(below.zone, 0.5, 0.5, 0.5, 0.5);
    s = dropped(s, 3, below);
    expect(presetOf(s)).toBe("main");
    // The middle of a pane replaces it.
    const mid = dropAt(s, 9, 0.25, 0.5, title);
    expect(mid.kind).toBe("replace");
    expect(mid.label).toBe("Replace this pane");
    expect(mid.sub).toBe("chat 1 keeps running");
    s = drop(s, 4, 0.25, 0.9);
    expect(s.chats).toEqual([1, 2, 3, 4]);
    expect(presetOf(s)).toBe("2x2");
    // Four: everything replaces, the outer edges too.
    const cap = dropAt(s, 5, 0.01, 0.1, title);
    expect(cap.kind).toBe("replace");
    s = dropped(s, 5, cap);
    expect(s.chats).toEqual([5, 2, 3, 4]);
    expect(s.focus).toBe(0);
    // A chat already in a pane is focused there.
    expect(dropAt(s, 3, 0.1, 0.1, title).kind).toBe("here");
    expect(dropped(s, 3, dropAt(s, 3, 0.1, 0.1, title)).focus).toBe(2);
  });

  test("dragging a pane: swap, move to a side, move to an outer edge", () => {
    const s = three();
    // Its own place: nothing.
    expect(paneDropAt(s, 0, 0.15, 0.5).kind).toBe("none");
    // Pane 0 onto the middle of the last: they trade places, the dragged one keeps the keyboard.
    const sw = paneDropAt(s, 0, 0.83, 0.5);
    expect(sw.kind).toBe("swap");
    const t = paneDropped(s, 0, sw);
    expect(order(t)).toEqual([2, 1, 0]);
    expect(t.chats).toEqual([1, 2, 3]);
    expect(t.focus).toBe(0);
    near(rects(t)[0], 2 / 3, 0, 1 / 3, 1);
    // Pane 0 under pane 2: two columns, the right one stacked.
    const m = paneDropAt(s, 0, 0.83, 0.9);
    expect(m.kind).toBe("move");
    expect(m.label).toBe("Move below");
    const mm = paneDropped(s, 0, m);
    near(rects(mm)[1], 0, 0, 0.5, 1);
    near(rects(mm)[0], 0.5, 0.5, 0.5, 0.5);
    near(m.zone, 0.5, 0.5, 0.5, 0.5);
    // The very bottom edge: pane 1 becomes a full-width row.
    const b = paneDrop(s, 1, 0.5, 0.99);
    near(rects(b)[1], 0, 0.5, 1, 0.5);
    near(rects(b)[0], 0, 0, 0.5, 0.5);
    expect(b.focus).toBe(1);
    // Back up: the full-width row to the left of pane 0 → three columns again.
    expect(presetOf(paneDrop(b, 1, 0.02, 0.25))).toBe("cols");
    // A pane shown alone isn't dragged anywhere.
    expect(paneDropAt(toggleMax(s, 0), 0, 0.5, 0.99).kind).toBe("none");
  });

  test("close gives the room to the sibling, evens, renumbers", () => {
    let s = applyPreset(drop(drop(drop(single(1), 2, 0.9, 0.5), 3, 0.9, 0.9), 4, 0.1, 0.9), "2x2");
    expect(presetOf(s)).toBe("2x2");
    s = focus(s, 3);
    s = close(s, 1);
    expect(s.chats).toEqual([1, 3, 4]);
    expect(s.focus).toBe(2);
    // Chat 2's pane (bottom left) gone: chat 3's, beside it, takes the whole bottom row.
    near(rects(s)[1], 0, 0.5, 1, 0.5);
    near(rects(s)[0], 0, 0, 0.5, 0.5);
    // Three columns, the first closed: two even halves (not 2/3 and 1/3).
    const c = close(three(), 0);
    near(rects(c)[0], 0, 0, 0.5, 1);
    near(rects(c)[1], 0.5, 0, 0.5, 1);
    // The focused one closed: the next in reading order takes the keyboard.
    expect(close(focus(three(), 1), 1).focus).toBe(1);
    s = close(close(s, 0), 0);
    expect(s.chats).toEqual([4]);
    expect(close(s, 0)).toBe(s);
  });

  test("balance evens runs of the same direction", () => {
    const t: Node = { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { dir: "h", ratio: 0.5, a: { pane: 1 }, b: { dir: "v", ratio: 0.2, a: { pane: 2 }, b: { pane: 3 } } } };
    const b = balance(t) as Extract<Node, { dir: "h" | "v" }>;
    expect(b.ratio).toBeCloseTo(1 / 3);
    const inner = b.b as Extract<Node, { dir: "h" | "v" }>;
    expect(inner.ratio).toBeCloseTo(0.5);
    expect((inner.b as Extract<Node, { dir: "h" | "v" }>).ratio).toBe(0.5);
  });

  test("open: focus its pane or take the focused one", () => {
    const s = drop(single(1), 2, 0.9, 0.5);
    expect(opened(s, 1).focus).toBe(0);
    expect(opened(s, 7).chats).toEqual([1, 7]);
  });

  test("resize at every level clamps; maximize hides the rest", () => {
    let s = drop(three(), 4, 0.83, 0.9);
    const ds = dividers(s);
    expect(ds.length).toBe(3);
    const inner = ds.find((d) => d.dir === "v");
    expect(inner).toBeDefined();
    s = resize(s, inner?.path ?? "", 0.8);
    near(rects(s)[2], 2 / 3, 0, 1 / 3, 0.8);
    s = resize(s, "", 0.01);
    expect(dividers(s).find((d) => d.path === "")?.at).toBeCloseTo(0.15);
    s = toggleMax(s, 1);
    expect(rects(s)[1]).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(rects(s)[0]).toBeNull();
    expect(dividers(s)).toEqual([]);
    expect(toggleMax(s, 1).max).toBeNull();
  });

  test("presets keep every pane, in reading order", () => {
    const s = three();
    expect(presetEnabled(s, "2x2")).toBe(false);
    expect(presetEnabled(s, "main")).toBe(true);
    expect(presetEnabled(drop(single(1), 2, 0.9, 0.5), "main")).toBe(false);
    const rows = applyPreset(s, "rows");
    expect(rows.chats).toEqual([1, 2, 3]);
    near(rects(rows)[2], 0, 2 / 3, 1, 1 / 3);
    expect(presetOf(rows)).toBe("rows");
    const main = applyPreset(paneDrop(s, 2, 0.15, 0.5), "main");
    expect(order(main)).toEqual([2, 1, 0]);
    near(rects(main)[2], 0, 0, 0.5, 1);
    expect(applyPreset(s, "2x2")).toBe(s);
  });

  test("kv: round trip, v0.175.0's value, bad input, pruning", () => {
    const s = drop(three(), 4, 0.5, 0.99);
    const raw = serialize(s);
    expect(JSON.parse(raw).v).toBe(2);
    expect(parse(raw)).toEqual(s);
    // What v0.175.0 wrote: no version, the same fields.
    const old = '{"chats":[7,8,9],"focus":2,"tree":{"dir":"h","ratio":0.5,"a":{"pane":0},"b":{"dir":"v","ratio":0.5,"a":{"pane":1},"b":{"pane":2}}},"max":null}';
    const p = parse(old);
    expect(p?.chats).toEqual([7, 8, 9]);
    expect(p?.focus).toBe(2);
    expect(p && presetOf(p)).toBe("main");
    // A tree that doesn't fit its chats: columns, the chats kept; a ratio out of bounds: clamped.
    expect(parse(JSON.stringify({ chats: [1, 2], focus: 0, tree: { pane: 0 } }))?.tree).toEqual({ dir: "h", ratio: 0.5, a: { pane: 0 }, b: { pane: 1 } });
    expect((parse(JSON.stringify({ chats: [1, 2], focus: 0, tree: { dir: "v", ratio: 0.99, a: { pane: 1 }, b: { pane: 0 } } }))?.tree as { ratio: number }).ratio).toBeCloseTo(0.85);
    expect(parse("{")).toBeNull();
    expect(parse(JSON.stringify({ v: 3, chats: [1], focus: 0, tree: { pane: 0 } }))).toBeNull();
    expect(parse(JSON.stringify({ chats: [1, 1], focus: 0, tree: { pane: 0 } }))).toBeNull();
    const q = prune(s, (c) => c !== 2);
    expect(q?.chats).toEqual([1, 3, 4]);
    expect(prune(single(1), () => false)).toBeNull();
  });
});
