import { type IBufferCell, Terminal as Xterm } from "@xterm/headless";
import { ansiPalette, fade, idxColor, keyBytes, type Mods, pasteBytes, rgb, type TermKey } from "./logic/terminal.ts";
import { token } from "./theme.ts";

/** A run of cells with one style, as terminal.slint draws it. */
export interface TermRun {
  col: number;
  n: number;
  text: string;
  fg: string;
  bg: string;
  has_bg: boolean;
  underline: boolean;
}

export interface TermFrame {
  rows: { runs: TermRun[] }[];
  /** The cursor's cell, or -1 when it isn't drawn (hidden, scrolled back, or the shell is gone). */
  cursor_row: number;
  cursor_col: number;
  cursor_text: string;
  /** "↑ N lines" while scrolled back, else empty. */
  scrolled: string;
}

/**
 * terminal.rs `Terminal`: a PTY running a shell (or `argv`), parsed by xterm's headless
 * emulator. `env` values of null remove the variable.
 */
export class Terminal {
  private readonly term: Xterm;
  private readonly proc: Bun.Subprocess;
  private size: [number, number] = [24, 80];
  private scroll = 0;
  private cursorHidden = false;
  alive = true;
  readonly exited: Promise<number>;
  /** The user's shell, not a command (a restart opens a new one in its folder). */
  readonly shell: boolean;

  constructor(
    readonly title: string,
    readonly cwd: string,
    argv: string[],
    env: Record<string, string | null>,
    wake: () => void,
  ) {
    this.shell = argv.length === 0;
    const [rows, cols] = this.size;
    this.term = new Xterm({ rows, cols, scrollback: 5000, allowProposedApi: true });
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (p) => this.dectcem(p, false));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (p) => this.dectcem(p, true));
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...env })) if (typeof v === "string") vars[k] = v;
    this.proc = Bun.spawn(argv.length > 0 ? argv : [process.env.SHELL ?? "/bin/bash"], {
      cwd,
      env: vars,
      terminal: { rows, cols, data: (_t, d) => this.term.write(d, wake) },
    });
    this.exited = this.proc.exited.then((code) => {
      this.alive = false;
      wake();
      return code;
    });
  }

  private dectcem(params: (number | number[])[], hide: boolean): boolean {
    if (params.includes(25)) this.cursorHidden = hide;
    return false;
  }

  write(s: string): void {
    if (!s || !this.alive) return;
    this.scroll = 0;
    this.proc.terminal?.write(s);
  }

  key(k: TermKey | { text: string }, m: Mods): void {
    this.write(keyBytes(k, m, this.term.modes.applicationCursorKeysMode));
  }

  paste(s: string): void {
    this.write(pasteBytes(s, this.term.modes.bracketedPasteMode));
  }

  resize(rows: number, cols: number): void {
    if ((rows === this.size[0] && cols === this.size[1]) || rows < 2 || cols < 4) return;
    this.size = [rows, cols];
    this.proc.terminal?.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  /** A wheel turn of `lines` (up is positive): scrolls back, or sends arrows to a full-screen program. */
  wheel(lines: number): void {
    if (lines === 0) return;
    if (this.term.buffer.active.type === "alternate") {
      const seq = lines > 0 ? "\x1b[A" : "\x1b[B";
      this.proc.terminal?.write(seq.repeat(Math.min(10, Math.abs(lines))));
    } else this.scroll = Math.min(this.term.buffer.active.baseY, Math.max(0, this.scroll + lines));
  }

  kill(): void {
    this.proc.kill();
  }

  /** Resolves once everything received so far is parsed. */
  settled(): Promise<void> {
    return new Promise((r) => this.term.write("", r));
  }

  frame(dark: boolean): TermFrame {
    const b = this.term.buffer.active;
    const ansi = ansiPalette(dark);
    const fgDef = token("fg", dark);
    const bgDef = token("bg200", dark);
    const top = b.baseY - this.scroll;
    const color = (c: IBufferCell, fg: boolean): string | null => {
      if (fg ? c.isFgDefault() : c.isBgDefault()) return null;
      const v = fg ? c.getFgColor() : c.getBgColor();
      if (fg ? c.isFgRGB() : c.isBgRGB()) return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
      return idxColor(v, ansi);
    };
    const rows: { runs: TermRun[] }[] = [];
    const cell = b.getNullCell();
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(top + y);
      const runs: (TermRun & { key: string })[] = [];
      let cur: (TermRun & { key: string }) | null = null;
      for (let x = 0; line && x < this.term.cols; x++) {
        if (!line.getCell(x, cell)) break;
        const key = `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}:${cell.isInverse()}:${cell.isBold()}:${cell.isDim()}:${cell.isUnderline()}`;
        if (cur === null || cur.key !== key) {
          let fg = color(cell, true) ?? fgDef;
          let bg = color(cell, false) ?? bgDef;
          if (cell.isInverse()) [fg, bg] = [bg, fg];
          if (cell.isDim()) fg = fade(fg, 0.6, bg);
          cur = { key, col: x, n: 0, text: "", fg, bg, has_bg: bg !== bgDef, underline: cell.isUnderline() !== 0 };
          runs.push(cur);
        }
        cur.n++;
        if (cell.getWidth() !== 0) cur.text += cell.getChars() || " ";
      }
      rows.push({ runs: runs.filter((r) => r.has_bg || r.text.trim() !== "").map(({ key: _, ...r }) => r) });
    }
    const showCursor = this.scroll === 0 && !this.cursorHidden && this.alive;
    const cy = b.cursorY;
    const cx = b.cursorX;
    const under = showCursor ? (b.getLine(b.baseY + cy)?.getCell(cx)?.getChars() ?? "") : "";
    return { rows, cursor_row: showCursor ? cy : -1, cursor_col: showCursor ? cx : -1, cursor_text: under, scrolled: this.scroll > 0 ? `↑ ${this.scroll} lines` : "" };
  }
}
