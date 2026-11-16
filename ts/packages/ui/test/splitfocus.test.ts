import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import { parse, SPLIT_KEY } from "../src/logic/splitpanes.ts";
import { type SplitHost, SplitPanes } from "../src/splitrun.ts";
import type { AppWindow, CardData, PaneBody } from "../src/window.ts";

/** What v2 kept: one split, chats 1 and 2 side by side, chat 1's pane with the keyboard. */
const V2 = JSON.stringify({ v: 2, chats: [1, 2], focus: 0, tree: { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { pane: 1 } }, max: null });

/** Two panes side by side (chats 1 and 2), chat 1's with the keyboard; each chat's cards are made once. `kv` starts
 * from another rig's (a restart). */
function rig(kv = new Map<string, string>([[SPLIT_KEY, V2]])) {
  const made = new Map<number, CardData[]>();
  const cardsOf = (chat: number): CardData[] => {
    let c = made.get(chat);
    if (!c) made.set(chat, (c = [1, 2, 3].map((seq) => ({ kind: "text", seq, chat }) as unknown as CardData)));
    return c;
  };
  const built: number[] = [];
  /** Chats deleted or settled. */
  const gone = new Set<number>();
  let shown: number | null = 1;
  const win = {} as AppWindow;
  const host: SplitHost = {
    win,
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    shown: () => shown,
    alive: (c) => !gone.has(c),
    info: () => ({ title: "", status: null, running: false, draft: "", composer: {}, logo: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, photo: null, bar: {}, strip: [], stripView: { title: "", names: "", header: false, folded: false, open: false } }) as never,
    cards: (chat) => {
      built.push(chat);
      return { cards: cardsOf(chat), running: false };
    },
    media: () => null,
    release: () => {},
    toggle: () => {},
    // The shell's openChat: the usual view shows it, the panes follow.
    openChat: (chat) => open(chat),
    focusComposer: () => {},
    cardAct: () => {},
    sidebar: () => {},
    relaid: () => split.render(),
    schedule: () => {},
    sameCard: (a, b) => a === b,
    sameBlock: (a, b) => a === b,
  };
  const split = new SplitPanes(host);
  /** The shell building the open chat: into the focused pane's models. */
  const shell = () => {
    if (shown === null) throw new Error("no chat shown");
    const t = split.target(shown);
    if (!t) throw new Error("no target");
    const next = cardsOf(shown);
    for (let i = 0; i < next.length; i++) if (i < t.cards.rowCount()) t.cards.rowData(i) !== next[i] && t.cards.setRowData(i, next[i] as CardData);
    else t.cards.push(next[i] as CardData);
    return t;
  };
  const bodies = () => win.split_bodies as unknown as slint.ArrayModel<PaneBody>;
  const heads = () => win.split_heads as unknown as slint.ArrayModel<{ chat: number; focused: boolean }>;
  const focus = (chat: number) => {
    split.opened(chat);
    shown = chat;
    split.render();
    return shell();
  };
  const show = (chat: number | null) => {
    shown = chat;
    split.render();
  };
  /** A chat opened from anywhere (the sidebar, a link, a notification, the new-chat draft's first message): the shell's
   * `openChat` and `showSent`. */
  const open = (chat: number) => {
    split.opened(chat);
    shown = chat;
    split.render();
  };
  /** `chat` dragged from the sidebar onto the centre's (u, v) and dropped. */
  const drop = (chat: number, u: number, v: number) => win.split_dropped(chat, u, v, 0.03, 0.04);
  /** The stored splits as kv holds them: each one's chats and its focused one. */
  const stored = () => parse(kv.get(SPLIT_KEY)).map((s) => ({ chats: s.chats, focus: s.chats[s.focus] }));
  return { split, built, bodies, heads, shell, focus, show, open, drop, stored, gone, kv, win, shown: () => shown, render: () => split.render() };
}

test("the focused pane's transcript is built by the shell into that pane's own models", () => {
  const r = rig();
  r.render();
  const t = r.shell();
  expect(r.built).toEqual([2]);
  expect(t.cards).toBe(r.bodies().rowData(0)?.cards as unknown as slint.ArrayModel<CardData>);
  expect(t.cards.rowCount()).toBe(3);
});

test("another pane taking the keyboard builds nothing again: both transcripts keep their models and rows", () => {
  const r = rig();
  r.render();
  r.shell();
  const before = [0, 1].map((i) => r.bodies().rowData(i)?.cards as unknown as slint.ArrayModel<CardData>);
  const rows = before.map((m) => [...Array(m.rowCount()).keys()].map((i) => m.rowData(i)));
  r.built.length = 0;
  const t = r.focus(2);
  // The pane that had the keyboard is built here now (from the same cards: nothing changes), the new one isn't.
  expect(r.built).toEqual([1]);
  expect(t.cards).toBe(before[1] as slint.ArrayModel<CardData>);
  const after = [0, 1].map((i) => r.bodies().rowData(i)?.cards as unknown as slint.ArrayModel<CardData>);
  expect(after[0]).toBe(before[0] as slint.ArrayModel<CardData>);
  expect(after[1]).toBe(before[1] as slint.ArrayModel<CardData>);
  expect(after.map((m) => [...Array(m.rowCount()).keys()].map((i) => m.rowData(i)))).toEqual(rows);
  // And back.
  r.built.length = 0;
  r.focus(1);
  expect(r.built).toEqual([2]);
  expect(r.bodies().rowData(0)?.cards).toBe(before[0] as never);
});

test("a maximized pane is the usual single-chat view; the title bar's button shows every pane again", () => {
  const r = rig();
  r.render();
  r.shell();
  const w = r.win;
  w.split_solo(1);
  r.show(2);
  expect(w.split_maxed).toBe(true);
  expect(w.split_count).toBe(1);
  expect(r.split.target(2)).toBeNull();
  // Maximized is kept with the split: another chat opened and this one again, it's still the one shown.
  r.open(9);
  expect(w.split_maxed).toBe(false);
  r.open(2);
  expect(w.split_maxed).toBe(true);
  // Opening the other pane's chat shows that pane instead, still maximized.
  r.open(1);
  expect(w.split_maxed).toBe(true);
  expect(r.split.target(1)).toBeNull();
  w.split_solo(-1);
  expect(r.shown()).toBe(1);
  expect(w.split_maxed).toBe(false);
  expect(w.split_count).toBe(2);
  expect(r.split.target(1)).not.toBeNull();
});

test("a chat in no split shows as the usual view, never as blank panes; panes come back filled after another page", () => {
  const r = rig();
  r.render();
  r.shell();
  // A chat put on screen that no split holds: the usual view, no pane headers over it.
  r.show(9);
  expect(r.win.split_count).toBe(1);
  r.split.refreshHeads();
  expect(r.heads().rowCount()).toBe(0);
  // Another page (the draft screen): the panes let their transcripts go...
  r.show(null);
  expect([0, 1].map((i) => r.bodies().rowData(i)?.cards.rowCount())).toEqual([0, 0]);
  // ...and coming back to a pane's chat builds both again.
  r.built.length = 0;
  r.focus(1);
  expect(r.win.split_count).toBe(2);
  expect(r.built).toEqual([2]);
  expect([0, 1].map((i) => r.bodies().rowData(i)?.cards.rowCount())).toEqual([3, 3]);
  expect(r.heads().rowCount()).toBe(2);
});

test("a chat in no split, opened while a split shows, shows alone in the full view: no pane is replaced, the split is kept", () => {
  const r = rig();
  r.render();
  r.shell();
  expect(r.split.onScreenChats()).toEqual([1, 2]);
  r.open(7);
  expect(r.win.split_count).toBe(1);
  expect(r.split.count()).toBe(1);
  expect(r.split.onScreenChats()).toEqual([]);
  expect(r.split.target(7)).toBeNull();
  expect(r.split.holds(1)).toBe(false);
  expect(r.split.marks().size).toBe(0);
  r.split.refreshHeads();
  expect(r.heads().rowCount()).toBe(0);
  // The panes let their transcripts go while they're off screen.
  expect([0, 1].map((i) => r.bodies().rowData(i)?.cards.rowCount())).toEqual([0, 0]);
  expect(r.stored()).toEqual([{ chats: [1, 2], focus: 1 }]);
  // Ctrl+W on a chat shown alone isn't the split's.
  expect(r.split.key(true, false, false, "w")).toBe(false);
  expect(r.stored()).toEqual([{ chats: [1, 2], focus: 1 }]);
});

test("reopening a chat of a stored split brings the whole split back, that chat's pane focused", () => {
  const r = rig();
  r.render();
  r.shell();
  r.open(7);
  r.focus(2);
  expect(r.win.split_count).toBe(2);
  expect(r.split.onScreenChats()).toEqual([1, 2]);
  expect(r.heads().rowCount()).toBe(2);
  expect([0, 1].map((i) => r.heads().rowData(i)?.focused)).toEqual([false, true]);
  expect(r.split.marks()).toEqual(
    new Map([
      [1, false],
      [2, true],
    ]),
  );
  expect(r.split.holds(1)).toBe(true);
  expect(r.stored()).toEqual([{ chats: [1, 2], focus: 2 }]);
  expect([0, 1].map((i) => r.bodies().rowData(i)?.cards.rowCount())).toEqual([3, 3]);
});

test("the new-chat draft's first message opens the new chat alone; the stored split stays for its chats", () => {
  const r = rig();
  r.render();
  r.shell();
  // The new-chat draft: the panes go off screen...
  r.show(null);
  // ...and the chat its first message started (7) comes on screen by itself.
  r.open(7);
  expect(r.win.split_count).toBe(1);
  expect(r.split.onScreenChats()).toEqual([]);
  expect(r.split.target(7)).toBeNull();
  expect(r.stored()).toEqual([{ chats: [1, 2], focus: 1 }]);
  // A split chat opened from the draft screen brings its split back.
  r.show(null);
  r.open(2);
  expect(r.win.split_count).toBe(2);
  expect(r.split.onScreenChats()).toEqual([1, 2]);
});

test("two stored splits: each chat opens its own, a chat dragged from one into the other moves there", () => {
  const r = rig();
  r.render();
  r.shell();
  // C (3) opened alone, D (4) dragged next to it: a second split.
  r.open(3);
  r.drop(4, 0.9, 0.5);
  expect(r.shown()).toBe(4);
  expect(r.split.onScreenChats()).toEqual([3, 4]);
  expect(r.stored()).toEqual([
    { chats: [1, 2], focus: 1 },
    { chats: [3, 4], focus: 4 },
  ]);
  // A shows A+B, D shows C+D.
  r.open(1);
  expect(r.split.onScreenChats()).toEqual([1, 2]);
  expect(r.split.holds(2)).toBe(true);
  expect(r.split.holds(3)).toBe(false);
  r.open(4);
  expect(r.split.onScreenChats()).toEqual([3, 4]);
  expect(r.heads().rowCount()).toBe(2);
  // Dragging B into C+D moves it: A+B, left with A, dissolves.
  r.drop(2, 0.995, 0.5);
  expect(r.split.onScreenChats()).toEqual([3, 4, 2]);
  expect(r.stored()).toEqual([{ chats: [3, 4, 2], focus: 2 }]);
  r.open(1);
  expect(r.win.split_count).toBe(1);
  expect(r.split.onScreenChats()).toEqual([]);
});

test("a pane closed down to one chat dissolves the split: that chat shows alone", () => {
  const r = rig();
  r.render();
  r.shell();
  r.drop(3, 0.995, 0.5);
  expect(r.stored()).toEqual([{ chats: [1, 2, 3], focus: 3 }]);
  // Ctrl+W: the focused pane (3) closes, its chat keeps running; the split keeps 1 and 2, the one before it focused.
  expect(r.split.key(true, false, false, "w")).toBe(true);
  expect(r.stored()).toEqual([{ chats: [1, 2], focus: 2 }]);
  expect(r.shown()).toBe(2);
  expect(r.split.onScreenChats()).toEqual([1, 2]);
  // 3 opened again is in no split now: alone.
  r.open(3);
  expect(r.win.split_count).toBe(1);
  r.open(1);
  // A pane's X on the other pane: one chat is left, the split dissolves, chat 1 alone in the full view.
  r.win.split_close(1);
  expect(r.stored()).toEqual([]);
  expect(r.kv.get(SPLIT_KEY)).toBe("");
  expect(r.shown()).toBe(1);
  expect(r.win.split_count).toBe(1);
  r.open(2);
  expect(r.win.split_count).toBe(1);
  expect(r.split.onScreenChats()).toEqual([]);
});

test("the stored splits, their layout and focus, are kept across a restart (kv and the restart's snapshot)", () => {
  const r = rig();
  r.render();
  r.shell();
  r.open(3);
  r.drop(4, 0.5, 0.95);
  r.win.split_resize("", 0.7);
  r.open(1);
  const snap = r.split.snapshot();
  // The next process, from kv.
  const next = rig(new Map(r.kv));
  next.open(3);
  expect(next.split.onScreenChats()).toEqual([3, 4]);
  expect(next.stored()).toEqual([
    { chats: [1, 2], focus: 1 },
    { chats: [3, 4], focus: 3 },
  ]);
  // Stacked, as dragged below (the resize waits to be written: the snapshot has it).
  const restored = rig(new Map([[SPLIT_KEY, ""]]));
  restored.split.restore(snap);
  restored.open(4);
  expect(restored.split.onScreenChats()).toEqual([3, 4]);
  expect(parse(restored.split.snapshot())[1]?.tree).toEqual({ dir: "v", ratio: 0.7, a: { pane: 0 }, b: { pane: 1 } });
  expect(restored.stored()).toEqual([
    { chats: [1, 2], focus: 1 },
    { chats: [3, 4], focus: 4 },
  ]);
});

test("a deleted or settled chat leaves its split; a split left with one chat dissolves", () => {
  const r = rig();
  r.render();
  r.shell();
  r.drop(3, 0.995, 0.5);
  r.open(5);
  r.drop(6, 0.9, 0.5);
  expect(r.stored()).toEqual([
    { chats: [1, 2, 3], focus: 3 },
    { chats: [5, 6], focus: 6 },
  ]);
  // 2 deleted, 6 settled: A+B+C keeps 1 and 3, the other split dissolves.
  r.gone.add(2);
  r.gone.add(6);
  r.open(1);
  expect(r.split.onScreenChats()).toEqual([1, 3]);
  expect(r.stored()).toEqual([{ chats: [1, 3], focus: 1 }]);
  r.open(5);
  expect(r.win.split_count).toBe(1);
  // A settled chat can't be dragged into a split.
  r.drop(6, 0.9, 0.5);
  expect(r.win.split_count).toBe(1);
  expect(r.stored()).toEqual([{ chats: [1, 3], focus: 1 }]);
  // A restart drops them as well.
  const kv = new Map([[SPLIT_KEY, JSON.stringify({ v: 3, splits: [{ chats: [1, 2], focus: 0 }, { chats: [5, 6, 7], focus: 0 }] })]]);
  const next = rig(kv);
  next.gone.add(2);
  next.gone.add(7);
  next.open(6);
  expect(next.split.onScreenChats()).toEqual([5, 6]);
  expect(next.stored()).toEqual([{ chats: [5, 6], focus: 6 }]);
});
