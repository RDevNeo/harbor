// The window alone with a reply streaming into it; runs on cost.py's private compositor (bench.sh).
import * as slint from "slint-ui";
import { processEvents } from "slint-ui/rust-module.cjs";
import type { Item } from "@harbor/store";
import { newOpened, sameBlock, transcriptCards } from "../packages/ui/src/cards.ts";
import { type CardData, loadWindow, type MdBlockData } from "../packages/ui/src/window.ts";

const OLD = Number(process.env.HTS_OLD ?? 0);
const SECS = Number(process.env.HTS_SECS ?? 30);
const HZ = Number(process.env.HTS_HZ ?? 20);
const LIVE = process.env.HTS_LIVE !== "0";
const words = "the quick brown fox jumps over the lazy dog while **harbor** keeps `every` chat in sync across all the machines on this mesh".split(" ");

function reply(n: number): string {
  let t = "";
  for (let i = 0; i < n; i++) {
    t += `${words[i % words.length]} `;
    if (i % 60 === 59) t += "\n\n";
    if (i % 300 === 299) t += "```\nsome code here\n```\n\n";
  }
  return t;
}

function sync<T>(model: slint.ArrayModel<T>, next: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  const n = Math.min(model.length, next.length);
  for (let i = 0; i < n; i++) {
    const v = next[i] as T;
    const old = model.rowData(i);
    if (old === undefined || !same(old, v)) model.setRowData(i, v);
  }
  if (model.length > next.length) model.remove(next.length, model.length - next.length);
  else if (next.length > n) model.push(...next.slice(n));
}

const win = await loadWindow();
const cards = new slint.ArrayModel<CardData>([]);
const live = new slint.ArrayModel<MdBlockData>([]);
win.cards = cards;
win.live_blocks = live;
win.view = "chat";
win.hero = false;
const items: Item[] = [];
for (let i = 0; i < OLD; i++) {
  items.push({ kind: "user", text: `question ${i}`, files: [], at: 1, mentions: [], sender: "", intent: "" });
  items.push({ kind: "text", text: reply(300), at: 1 });
}
items.push({ kind: "user", text: "hello", files: [], at: 1, mentions: [], sender: "", intent: "" });
const streaming: Item = { kind: "text", text: "", at: 1 };
items.push(streaming);
const open = newOpened();
const bare = new WeakMap<CardData, CardData>();
win.show();

const cpu = () => {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
};
let n = 0;
let peMs = 0;
let upMs = 0;
let frames = 0;
let t0 = performance.now();
const end = performance.now() + SECS * 1000;
let nextUpdate = performance.now();
while (performance.now() < end) {
  const now = performance.now();
  if (now >= nextUpdate) {
    nextUpdate += 1000 / HZ;
    n += 2;
    items[items.length - 1] = { ...streaming, text: reply(n) };
    const c0 = cpu();
    const next = transcriptCards(items, false, [], open, "Working… 3s  ·  Esc to stop", 0);
    const at = next.findLastIndex((c) => c.kind === "text");
    const card = next[at];
    if (LIVE && card) {
      sync(live, card.blocks, sameBlock);
      win.live_seq = card.seq;
      let b = bare.get(card);
      if (!b) bare.set(card, (b = { ...card, blocks: [] }));
      next[at] = b;
    }
    sync(cards, next);
    win.scroll_to_end();
    upMs += cpu() - c0;
  }
  const c0 = cpu();
  processEvents();
  peMs += cpu() - c0;
  frames++;
  await Bun.sleep(16);
  if (performance.now() - t0 >= 5000) {
    const dt = performance.now() - t0;
    console.log(JSON.stringify({ words: n, updates_cpu_pct: +((upMs / dt) * 100).toFixed(2), process_events_cpu_pct: +((peMs / dt) * 100).toFixed(2), ms_per_update: +(((upMs + peMs) / dt) * 1000 / HZ).toFixed(2) }));
    peMs = upMs = frames = 0;
    t0 = performance.now();
  }
}
process.exit(0);
