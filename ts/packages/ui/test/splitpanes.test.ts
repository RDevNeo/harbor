import { describe, expect, test } from "bun:test";
import { applyPreset, close, dividers, dropAt, dropped, focus, opened, parse, presetEnabled, presetOf, prune, rects, resize, serialize, single, type Split, toggleMax } from "../src/logic/splitpanes.ts";

const title = (c: number) => `chat ${c}`;
const drop = (s: Split, chat: number, u: number, v: number) => dropped(s, chat, dropAt(s, chat, u, v, title));

describe("split panes", () => {
  test("one pane: left and right halves", () => {
    const s = single(10);
    const right = dropAt(s, 20, 0.8, 0.5, title);
    expect(right.kind).toBe("split");
    expect(right.side).toBe("right");
    expect(right.label).toBe("Open on the right · 2 of 4");
    expect(right.zone).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(dropAt(s, 20, 0.2, 0.5, title).label).toBe("Open on the left · 2 of 4");
    const two = dropped(s, 20, right);
    expect(two.chats).toEqual([10, 20]);
    expect(two.focus).toBe(1);
    expect(rects(two)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
    expect(presetOf(two)).toBe("2");
    const left = drop(s, 20, 0.1, 0.5);
    expect(rects(left)[1]).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  test("three by where dropped, then four, then only replace", () => {
    let s = drop(single(1), 2, 0.9, 0.5);
    // Below pane 2: one tall left, two stacked right.
    const below = dropAt(s, 3, 0.75, 0.95, title);
    expect(below.label).toBe("Open below pane 2 · 3 of 4");
    s = dropped(s, 3, below);
    expect(presetOf(s)).toBe("1+2");
    expect(rects(s)[2]).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    // The middle of a pane replaces it.
    const mid = dropAt(s, 9, 0.25, 0.5, title);
    expect(mid.kind).toBe("replace");
    expect(mid.sub).toBe("chat 1 keeps running");
    s = drop(s, 4, 0.25, 0.95);
    expect(s.chats).toEqual([1, 2, 3, 4]);
    expect(presetOf(s)).toBe("");
    const cap = dropAt(s, 5, 0.1, 0.1, title);
    expect(cap.kind).toBe("replace");
    expect(cap.label).toBe("Replace pane 1");
    s = dropped(s, 5, cap);
    expect(s.chats).toEqual([5, 2, 3, 4]);
    expect(s.focus).toBe(0);
    // A chat already in a pane is focused there.
    expect(dropAt(s, 3, 0.1, 0.1, title).kind).toBe("here");
    expect(dropped(s, 3, dropAt(s, 3, 0.1, 0.1, title)).focus).toBe(2);
  });

  test("close gives the room to the sibling and renumbers", () => {
    let s = applyPreset(drop(drop(drop(single(1), 2, 0.9, 0.5), 3, 0.9, 0.9), 4, 0.1, 0.9), "2x2");
    expect(presetOf(s)).toBe("2x2");
    s = focus(s, 3);
    s = close(s, 1);
    expect(s.chats).toEqual([1, 3, 4]);
    expect(s.focus).toBe(2);
    expect(rects(s)[0]).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    s = close(close(s, 0), 0);
    expect(s.chats).toEqual([4]);
    expect(close(s, 0)).toBe(s);
  });

  test("open: focus its pane or take the focused one", () => {
    const s = drop(single(1), 2, 0.9, 0.5);
    expect(opened(s, 1).focus).toBe(0);
    expect(opened(s, 7).chats).toEqual([1, 7]);
  });

  test("resize clamps and maximize hides the rest", () => {
    let s = drop(single(1), 2, 0.9, 0.5);
    const [d] = dividers(s);
    expect(d?.at).toBe(0.5);
    s = resize(s, "", 0.02);
    expect(rects(s)[0]?.w).toBeCloseTo(0.15);
    s = toggleMax(s, 1);
    expect(rects(s)).toEqual([null, { x: 0, y: 0, w: 1, h: 1 }]);
    expect(dividers(s)).toEqual([]);
    expect(toggleMax(s, 1).max).toBeNull();
  });

  test("presets", () => {
    const s = drop(drop(single(1), 2, 0.9, 0.5), 3, 0.9, 0.9);
    expect(presetEnabled(s, "2x2")).toBe(false);
    const two = applyPreset(focus(s, 2), "2");
    expect(two.chats).toEqual([1, 3]);
    expect(two.focus).toBe(1);
    expect(applyPreset(s, "1").max).toBe(s.focus);
  });

  test("kv round trip, bad input, pruning", () => {
    const s = drop(drop(single(1), 2, 0.9, 0.5), 3, 0.9, 0.9);
    expect(parse(serialize(s))).toEqual(s);
    expect(parse("{")).toBeNull();
    expect(parse(JSON.stringify({ chats: [1, 1], focus: 0, tree: { pane: 0 } }))).toBeNull();
    expect(parse(JSON.stringify({ chats: [1, 2], focus: 0, tree: { pane: 0 } }))).toBeNull();
    const p = prune(s, (c) => c !== 2);
    expect(p?.chats).toEqual([1, 3]);
    expect(prune(single(1), () => false)).toBeNull();
  });
});
