import { Terminal } from "@xterm/headless";

export interface Shell {
  write(text: string): void;
  resize(cols: number, rows: number): void;
  /** The visible screen, one string per row, without trailing blanks. */
  screen(): string[];
  /** Resolves once everything received so far has been parsed. */
  settled(): Promise<void>;
  title(): string;
  cursor(): { x: number; y: number };
  alternateScreen(): boolean;
  kill(): void;
  exited: Promise<number>;
}

export interface ShellOptions {
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export function startShell(o: ShellOptions): Shell {
  const term = new Terminal({ cols: o.cols, rows: o.rows, allowProposedApi: true, scrollback: 10_000 });
  let title = "";
  term.onTitleChange((t) => {
    title = t;
  });
  const proc = Bun.spawn(o.argv, {
    cwd: o.cwd,
    env: { ...process.env, TERM: "xterm-256color", ...o.env },
    terminal: {
      cols: o.cols,
      rows: o.rows,
      data: (_t, data) => term.write(data),
    },
  });
  const pty = proc.terminal;
  if (!pty) throw new Error("Bun.spawn gave no terminal");
  return {
    write: (text) => pty.write(text),
    resize: (cols, rows) => {
      pty.resize(cols, rows);
      term.resize(cols, rows);
    },
    screen: () => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let y = 0; y < term.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
      return out;
    },
    settled: () => new Promise((resolve) => term.write("", resolve)),
    title: () => title,
    cursor: () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }),
    alternateScreen: () => term.buffer.active.type === "alternate",
    kill: () => proc.kill(),
    exited: proc.exited,
  };
}
