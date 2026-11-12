import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import { SPLIT_KEY } from "../src/logic/splitpanes.ts";
import { type SplitHost, SplitPanes } from "../src/splitrun.ts";
import type { AppWindow, CardData, PaneBody } from "../src/window.ts";

/** Two panes side by side (chats 1 and 2), chat 1's with the keyboard; each chat's cards are made once. */
function rig() {
  const kv = new Map<string, string>([[SPLIT_KEY, JSON.stringify({ v: 2, chats: [1, 2], focus: 0, tree: { dir: "h", ratio: 0.5, a: { pane: 0 }, b: { pane: 1 } }, max: null })]]);
  const made = new Map<number, CardData[]>();
  const cardsOf = (chat: number): CardData[] => {
    let c = made.get(chat);
    if (!c) made.set(chat, (c = [1, 2, 3].map((seq) => ({ kind: "text", seq, chat }) as unknown as CardData)));
    return c;
  };
  const built: number[] = [];
  let shown = 1;
  const win = {} as AppWindow;
  const host: SplitHost = {
    win,
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    shown: () => shown,
    exists: () => true,
    info: () => ({ title: "", status: null, running: false, draft: "", composer: {}, logo: { width: 1, height: 1, data: new Uint8Array(4) }, photo: null, bar: {}, strip: [], stripView: { title: "", names: "", header: false, folded: false, open: false } }) as never,
    cards: (chat) => {
      built.push(chat);
      return { cards: cardsOf(chat), running: false };
    },
    media: () => null,
    release: () => {},
    toggle: () => {},
    openChat: () => {},
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
    const t = split.target(shown);
    if (!t) throw new Error("no target");
    const next = cardsOf(shown);
    for (let i = 0; i < next.length; i++) if (i < t.cards.rowCount()) t.cards.rowData(i) !== next[i] && t.cards.setRowData(i, next[i] as CardData);
    else t.cards.push(next[i] as CardData);
    return t;
  };
  const bodies = () => win.split_bodies as unknown as slint.ArrayModel<PaneBody>;
  const focus = (chat: number) => {
    split.opened(chat);
    shown = chat;
    split.render();
    return shell();
  };
  const show = (chat: number) => {
    shown = chat;
    split.render();
  };
  return { split, built, bodies, shell, focus, show, win, render: () => split.render() };
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
  w.split_solo(-1);
  r.show(2);
  expect(w.split_maxed).toBe(false);
  expect(w.split_count).toBe(2);
  expect(r.split.target(2)).not.toBeNull();
});
