import { join } from "node:path";
import * as slint from "slint-ui";
import { uiDir } from "./assets.ts";
import type { TermKey } from "./logic/terminal.ts";
import { gridSize } from "./logic/terminal.ts";
import { runLoop } from "./loop.ts";
import { Terminal, type TermFrame } from "./terminal.ts";

interface TerminalWindow extends slint.ComponentHandle {
  dark: boolean;
  lines: TermFrame["rows"];
  cursor_row: number;
  cursor_col: number;
  cursor_text: string;
  scrolled: string;
  readonly cw: number;
  readonly rh: number;
  readonly vw: number;
  readonly vh: number;
  key: (k: TermKey | "none", text: string, ctrl: boolean, alt: boolean, shift: boolean) => void;
  paste: () => void;
  wheel: (n: number) => void;
  resized: (w: number, h: number) => void;
}

const ui = slint.loadFile(join(await uiDir(), "terminal.slint"), { style: "fluent", quiet: true });
const ctor = Reflect.get(ui, "TerminalWindow");
if (typeof ctor !== "function") throw new Error("terminal.slint has no TerminalWindow");
const win: TerminalWindow = new ctor();
win.dark = process.env.HTS_LIGHT === undefined;

let queued = false;
const draw = () => {
  queued = false;
  const f = term.frame(win.dark);
  win.lines = f.rows;
  win.cursor_row = f.cursor_row;
  win.cursor_col = f.cursor_col;
  win.cursor_text = f.cursor_text;
  win.scrolled = f.scrolled;
};
const wake = () => {
  if (!queued) {
    queued = true;
    setTimeout(draw, 8);
  }
};
const term = new Terminal("Terminal", process.cwd(), process.argv.slice(2).filter(Boolean), {}, wake);
const fit = (w: number, h: number) => {
  const [rows, cols] = gridSize(w, h, win.cw, win.rh);
  term.resize(rows, cols);
  wake();
};
win.resized = fit;
win.key = (k, text, ctrl, alt, shift) => term.key(k === "none" ? { text } : k, { ctrl, alt, shift });
win.wheel = (n) => {
  term.wheel(n);
  wake();
};
win.paste = () => {
  const p = Bun.spawnSync(["wl-paste", "-n"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  if (p.exitCode === 0) term.paste(p.stdout.toString());
};
void term.exited.then(() => process.exit(0));
win.show();
fit(win.vw, win.vh);
await runLoop();
