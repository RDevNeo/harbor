// The real window under Bun or Node (no Bun API, no Harbor package): runtimes.sh runs it on cost.py's compositor.
import { cpSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as slint from "slint-ui";
import { runLoop } from "../packages/ui/src/loop.ts";
import type { AppWindow, CardData, MdBlockData } from "../packages/ui/src/window.ts";

const IDLE_S = Number(process.env.HTS_IDLE_S ?? 20);
const STREAM_S = Number(process.env.HTS_STREAM_S ?? 20);
const ts = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "hts-runtimes-"));
cpSync(join(ts, "packages/ui/slint"), dir, { recursive: true });
symlinkSync(join(ts, "../assets/fonts"), join(dir, "fonts"));
const ui = slint.loadFile(join(dir, "app.slint"), { style: "fluent" }) as Record<string, unknown>;
const win = new (ui.AppWindow as new () => AppWindow)();

const words = "the quick brown fox jumps over the lazy dog while **harbor** keeps `every` chat in sync".split(" ");
const block = (text: string): MdBlockData => ({ kind: "p", text: slint.StyledText.fromMarkdown(text), code: "", level: 0, marker: "", depth: 0, quote: 0, cols: [], rows: 0, gap: 0, after: 16, bar_top: 0, bar_bottom: 0, trim: 0, plain: text, key: "" });
const card = (kind: CardData["kind"], seq: number, text = ""): CardData => ({ kind, seq, blocks: [], text, label: "", icon: "", tone: "", detail: "", result: "", open: false, pending: false, expandable: false, sender: "", files: [], steer: false, url: "", actions: [], time: "", media: [] });
const user = card("user", 0, "hello");
user.blocks = [block("hello")];
const cards = new slint.ArrayModel<CardData>([card("space", -1), user, card("text", 1), card("status", -2, "Working…"), card("space", -3)]);
const live = new slint.ArrayModel<MdBlockData>([]);
win.cards = cards;
win.live_blocks = live;
win.live_seq = 1;
win.view = "chat";
win.hero = false;
win.show();

function sample(): { cpu: number; switches: number; t: number } {
  const c = process.cpuUsage();
  let switches = 0;
  for (const task of readdirSync("/proc/self/task")) {
    const m = readFileSync(`/proc/self/task/${task}/status`, "utf8").match(/^voluntary_ctxt_switches:\s+(\d+)/m);
    switches += Number(m?.[1] ?? 0);
  }
  return { cpu: (c.user + c.system) / 1000, switches, t: performance.now() };
}
const report = (phase: string, a: ReturnType<typeof sample>) => {
  const b = sample();
  const s = (b.t - a.t) / 1000;
  const rss = Number(readFileSync("/proc/self/status", "utf8").match(/VmRSS:\s+(\d+)/)?.[1]) / 1024;
  console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", phase, cpu_pct: +((b.cpu - a.cpu) / 10 / s).toFixed(2), wakeups_s: +((b.switches - a.switches) / s).toFixed(1), rss_mb: Math.round(rss) }));
};

setTimeout(() => {
  const idle = sample();
  setTimeout(() => {
    report("idle", idle);
    const start = sample();
    let n = 0;
    const id = setInterval(() => {
      n += 2;
      const i = Math.floor((n - 1) / 60);
      const text = Array.from({ length: n - i * 60 }, (_, k) => words[k % words.length]).join(" ");
      if (i >= live.length) live.push(block(text));
      else live.setRowData(i, block(text));
      win.scroll_to_end();
    }, 50);
    setTimeout(() => {
      clearInterval(id);
      report("stream", start);
      process.exit(0);
    }, STREAM_S * 1000);
  }, IDLE_S * 1000);
}, 5000);
await runLoop();
