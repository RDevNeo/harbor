import { mkdirSync } from "node:fs";
import * as slint from "slint-ui";
import { items as readItems, openCopy, sidebar, type SideRow } from "./db.ts";
import { type Card, type Item, toCard } from "./items.ts";
import { runLoop } from "./loop.ts";
import { type Event, startTurn, type Turn } from "./turn.ts";
import source from "./app.slint" with { type: "text" };

interface AppWindow extends slint.ComponentHandle {
  rows: slint.Model<SideRow>;
  cards: slint.Model<Card>;
  chat_title: string;
  status: string;
  running: boolean;
  open_chat: (id: number) => void;
  send: (text: string) => void;
  stop: () => void;
  scroll_to_end: () => void;
}

interface UiModule {
  AppWindow: new () => AppWindow;
}

const dbPath = process.env.HTS_DB;
if (!dbPath) throw new Error("HTS_DB: the path of a copy of harbor.db");
const db = openCopy(dbPath);

// loadSource, not loadFile: inside a compiled executable the .slint file is no file on disk.
const ui = slint.loadSource(source, "app.slint") as unknown as UiModule;
const win = new ui.AppWindow();

const rows = new slint.ArrayModel<SideRow>(sidebar(db));
const cards = new slint.ArrayModel<Card>([]);
win.rows = rows;
win.cards = cards;

// Every chat opened stays in memory, like `transcripts` in app.rs.
const transcripts = new Map<number, Item[]>();
let current = 0;
let turn: Turn | null = null;
let pending = -1;

function setCards(list: Item[]) {
  while (cards.length > 0) cards.pop();
  cards.push(...list.map(toCard));
}

function scrollSoon() {
  setTimeout(() => win.scroll_to_end(), 40);
}

function openChat(id: number) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows.rowData(i);
    if (r && !r.project && (r.active || r.id === id)) rows.setRowData(i, { ...r, active: r.id === id });
    if (r && !r.project && r.id === id) win.chat_title = r.title;
  }
  let list = transcripts.get(id);
  if (!list) {
    list = readItems(db, id);
    transcripts.set(id, list);
  }
  current = id;
  pending = -1;
  setCards(list);
  scrollSoon();
}

function transcript(): Item[] {
  let list = transcripts.get(current);
  if (!list) {
    list = [];
    transcripts.set(current, list);
  }
  return list;
}

function push(it: Item) {
  transcript().push(it);
  cards.push(toCard(it));
  scrollSoon();
}

function apply(e: Event) {
  const list = transcript();
  switch (e.type) {
    case "text_delta": {
      const last = pending >= 0 ? list[pending] : undefined;
      if (last?.kind === "text") {
        last.text += e.text;
        cards.setRowData(pending, toCard(last));
      } else {
        pending = list.length;
        push({ kind: "text", text: e.text });
      }
      scrollSoon();
      break;
    }
    case "text_final": {
      const last = pending >= 0 ? list[pending] : undefined;
      if (last?.kind === "text") {
        last.text = e.text;
        cards.setRowData(pending, toCard(last));
      } else {
        push({ kind: "text", text: e.text });
      }
      pending = -1;
      break;
    }
    case "tool":
      push({ kind: "tool", id: e.id, name: e.name, summary: e.summary, input: e.input, result: null, is_error: false });
      break;
    case "result":
      push({ kind: "result", cost_usd: e.cost_usd ?? 0, duration_ms: e.duration_ms, turns: e.turns, input_tokens: e.input_tokens, output_tokens: e.output_tokens });
      win.status = `${e.input_tokens} in · ${e.output_tokens} out`;
      break;
    case "error":
      push({ kind: "error", text: e.text });
      break;
    case "session":
    case "thinking_delta":
    case "thinking_final":
    case "tool_result":
      break;
  }
}

function stopTurn() {
  turn?.stop();
}

function send(text: string) {
  const cwd = process.env.HTS_CWD;
  if (!text.trim() || turn) return;
  if (!cwd) {
    push({ kind: "error", text: "HTS_CWD is not set: no scratch folder to run the turn in." });
    return;
  }
  mkdirSync(cwd, { recursive: true });
  push({ kind: "user", text });
  win.running = true;
  win.status = "Working";
  pending = -1;
  const t = startTurn({
    bin: process.env.HTS_CLAUDE ?? "claude",
    cwd,
    model: process.env.HTS_MODEL ?? "haiku",
    prompt: text,
    onEvent: apply,
  });
  turn = t;
  void t.done.then((code) => {
    turn = null;
    win.running = false;
    if (code !== 0 && win.status === "Working") win.status = `exited ${code}`;
  });
}

win.open_chat = openChat;
win.send = send;
win.stop = stopTurn;

win.show();

const first = rows.rowData(1);
const chats: number[] = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows.rowData(i);
  if (r && !r.project) chats.push(r.id);
}
const toOpen = Number(process.env.HTS_OPEN ?? 0);
const openAt = Number(process.env.HTS_OPEN_AT ?? 0);
if (toOpen > 0) {
  const list = chats.slice(openAt, openAt + toOpen);
  let i = 0;
  const step = () => {
    const id = list[i++];
    if (id === undefined) return;
    openChat(id);
    setTimeout(step, 150);
  };
  step();
} else if (first && !first.project) {
  openChat(first.id);
}

const prompt = process.env.HTS_PROMPT;
if (prompt) setTimeout(() => send(prompt), 500);

await runLoop();
stopTurn();
