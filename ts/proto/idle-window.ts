// The same window under Bun and under Node, for the idle comparison: no bun:sqlite, no Bun APIs.
import { readFileSync } from "node:fs";
import * as slint from "slint-ui";
import { runLoop, TICK_MS } from "./loop.ts";

interface Row {
  id: number;
  project: boolean;
  title: string;
  active: boolean;
}

interface Card {
  kind: string;
  text: string;
  meta: string;
}

interface Win extends slint.ComponentHandle {
  rows: slint.Model<Row>;
  cards: slint.Model<Card>;
  chat_title: string;
}

const source = readFileSync(new URL("./app.slint", import.meta.url), "utf8");
const ui = slint.loadSource(source, "app.slint") as unknown as { AppWindow: new () => Win };
const win = new ui.AppWindow();
const words = "the quick brown fox jumps over the lazy dog while harbor keeps every chat in sync".split(" ");
const para = (n: number) => Array.from({ length: n }, (_, i) => words[i % words.length]).join(" ");
win.rows = new slint.ArrayModel<Row>(Array.from({ length: 21 }, (_, i) => ({ id: i, project: i === 0, title: i === 0 ? "project" : `chat ${i} ${para(6)}`, active: i === 1 })));
win.cards = new slint.ArrayModel<Card>(
  Array.from({ length: 300 }, (_, i) => ({ kind: i % 7 === 0 ? "user" : i % 3 === 0 ? "line" : "text", text: para(20 + (i % 40)), meta: "" })),
);
win.chat_title = "chat 1";
win.show();

const mode = process.env.HTS_MODE ?? "visible";
if (mode === "hidden") setTimeout(() => win.hide(), 3000);
console.log(`ready ${typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`} ${mode}`);
await runLoop(Number(process.env.HTS_TICK ?? TICK_MS), false);
