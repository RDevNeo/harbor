// browser.rs: the Servo engine runs in the separate `harbor-browser` process; frames arrive as files in
// the run dir, input goes back as JSON lines.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Pixels } from "./logos.ts";
import { web } from "./logic/browser.ts";

/** Engines that stopped within this long of starting count toward "it keeps crashing". */
const QUICK_MS = 5_000;
const exits: [number, string][] = [];

/** The engine keeps stopping right after it starts: its last words ("" when it said none); null otherwise. */
export function crashing(at = Date.now()): string | null {
  while (exits.length > 0 && at - (exits[0]?.[0] ?? 0) >= 60_000) exits.shift();
  return exits.length >= 3 ? (exits[exits.length - 1]?.[1] ?? "") : null;
}

export function clearCrashes(): void {
  exits.length = 0;
}

const SOURCE = resolve(import.meta.dir, "../../../../browser");

/** Where the engine is: $HARBOR_BROWSER, beside the running executable, or this checkout's build. */
export function helperPath(env: Record<string, string | undefined> = process.env, exe = process.execPath): string | null {
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() === true;
  if (env.HARBOR_BROWSER) return isFile(env.HARBOR_BROWSER) ? env.HARBOR_BROWSER : null;
  return [join(dirname(exe), "harbor-browser"), join(SOURCE, "target/release/harbor-browser")].find(isFile) ?? null;
}

/** The engine's source, for "Build engine" (a checkout only). */
export function sourceDir(): string | null {
  return existsSync(join(SOURCE, "Cargo.toml")) ? SOURCE : null;
}

/** The page's host for its error screen ("localhost:3000"). */
export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const CURSORS: Record<string, string> = {
  Pointer: "pointer",
  Text: "text",
  VerticalText: "text",
  Grab: "grab",
  Grabbing: "grabbing",
  Move: "move",
  AllScroll: "move",
  NotAllowed: "not-allowed",
  NoDrop: "not-allowed",
  Wait: "wait",
  Progress: "progress",
  Crosshair: "crosshair",
  EwResize: "ew-resize",
  EResize: "ew-resize",
  WResize: "ew-resize",
  ColResize: "col-resize",
  NsResize: "ns-resize",
  NResize: "ns-resize",
  SResize: "ns-resize",
  RowResize: "row-resize",
  None: "none",
};

/** Slint's key text for the keys Servo takes by name. */
const NAMED: Record<string, string> = {
  "\n": "Enter",
  "\r": "Enter",
  "\u{8}": "Backspace",
  "\t": "Tab",
  "\u{1b}": "Escape",
  "\u{f700}": "ArrowUp",
  "\u{f701}": "ArrowDown",
  "\u{f702}": "ArrowLeft",
  "\u{f703}": "ArrowRight",
  "\u{f729}": "Home",
  "\u{f72b}": "End",
  "\u{f72c}": "PageUp",
  "\u{f72d}": "PageDown",
  "\u{7f}": "Delete",
  "\u{f727}": "Insert",
};

export interface KeyMods {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** browser.rs `forward_input`'s keys: what to send for a Slint key event, nothing for keys Servo doesn't take. */
export function keyMessages(text: string, down: boolean, m: KeyMods): Record<string, unknown>[] {
  const named = NAMED[text];
  if (named !== undefined) return [{ t: "key", key: named, code: "", down, ...m }];
  const chars = [...text];
  if (chars.length !== 1) return [];
  if (m.ctrl || m.meta) return [{ t: "key", key: text.toLowerCase(), code: "", down, ...m }];
  const cp = text.codePointAt(0) ?? 0;
  // Text goes as a press and a release together, like egui's Text events.
  if (!down || cp < 0x20 || (cp >= 0xf700 && cp <= 0xf8ff)) return [];
  return [
    { t: "key", key: text, code: "", down: true },
    { t: "key", key: text, code: "", down: false },
  ];
}

export interface EngineState {
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  cursor: string;
  frame: Pixels | null;
}

export class BrowserEngine {
  readonly state: EngineState;
  private readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private readonly started = Date.now();
  private lastErr = "";
  private size: [number, number] = [1024, 768];
  private exited = false;
  private owed = false;

  constructor(
    helper: string,
    private readonly frames: string,
    url: string,
    private readonly wake: () => void,
  ) {
    this.state = { url, title: "", loading: true, back: false, forward: false, cursor: "default", frame: null };
    this.proc = Bun.spawn([helper, frames, url, "1024", "768", "1"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // One frame at a time: the engine paints the next only after our "got".
    this.send({ t: "acks", on: true });
    void this.read(this.proc.stdout, (l) => this.onLine(l));
    void this.read(this.proc.stderr, (l) => {
      if (l.trim() !== "") this.lastErr = l;
    });
    void this.proc.exited.then(() => {
      this.exited = true;
      if (Date.now() - this.started < QUICK_MS) exits.push([Date.now(), this.lastErr]);
      this.wake();
    });
  }

  get title(): string {
    return this.state.title;
  }

  get alive(): boolean {
    return !this.exited;
  }

  private async read(s: ReadableStream<Uint8Array>, line: (l: string) => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of s) {
      buf += dec.decode(chunk, { stream: true });
      let i = buf.indexOf("\n");
      while (i >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
        i = buf.indexOf("\n");
      }
    }
  }

  send(v: Record<string, unknown>): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(v)}\n`);
      this.proc.stdin.flush();
    } catch {
      // it is stopping: its exit is seen by `exited`
    }
  }

  private onLine(l: string): void {
    let v: Record<string, unknown>;
    try {
      const p: unknown = JSON.parse(l);
      if (typeof p !== "object" || p === null) return;
      v = Object.fromEntries(Object.entries(p));
    } catch {
      return;
    }
    const s = this.state;
    const str = (k: string) => (typeof v[k] === "string" ? v[k] : "");
    switch (v.t) {
      case "frame":
        this.frame(Number(v.w) || 0, Number(v.h) || 0, Number(v.buf) || 0);
        break;
      case "url":
        s.url = str("url");
        break;
      case "title":
        s.title = str("title");
        break;
      case "loading":
        s.loading = v.on === true;
        break;
      case "nav":
        s.back = v.back === true;
        s.forward = v.forward === true;
        break;
      case "cursor":
        s.cursor = CURSORS[str("name")] ?? "default";
        break;
      default:
        return;
    }
    this.wake();
  }

  private frame(w: number, h: number, buf: number): void {
    try {
      const bytes = readFileSync(`${this.frames}.${buf}`);
      // A frame at the wrong size means a resize was lost (sent before the page existed): ask again.
      if (w !== this.size[0] || h !== this.size[1]) this.send({ t: "resize", w: this.size[0], h: this.size[1] });
      if (w > 0 && bytes.length === w * h * 4) this.state.frame = { width: w, height: h, data: new Uint8Array(bytes) };
    } catch {
      // the next frame replaces it
    }
    this.owed = true;
  }

  /** The frame was drawn: the engine may paint the next. A tab that isn't shown never says so, and costs nothing. */
  took(): void {
    if (!this.owed) return;
    this.owed = false;
    this.send({ t: "got" });
  }

  load(url: string): void {
    this.send({ t: "load", url });
    this.state.url = url;
  }

  /** The page's size in device pixels. */
  resize(w: number, h: number): void {
    if ((w === this.size[0] && h === this.size[1]) || w <= 8 || h <= 8) return;
    this.size = [w, h];
    this.send({ t: "resize", w, h });
  }

  /** "Open in my browser" is offered for web pages only. */
  get external(): string | null {
    return web(this.state.url) ? this.state.url : null;
  }

  kill(): void {
    this.proc.kill();
    for (const b of [0, 1]) rmSync(`${this.frames}.${b}`, { force: true });
  }
}
