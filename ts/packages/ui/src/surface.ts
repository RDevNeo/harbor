import { basename } from "node:path";

export type Dock = "right" | "bottom";

/** What a pane needs of a terminal (terminal.ts `Terminal`). */
export interface PaneTerm {
  readonly title: string;
  readonly cwd: string;
  readonly alive: boolean;
  kill(): void;
}

/** What a pane needs of a browser engine (browser.ts `BrowserEngine`). */
export interface PaneEngine {
  readonly title: string;
  load(url: string): void;
  kill(): void;
}

/** What a pane needs of a PC's file browser (net's `FileBrowser`). */
export interface PaneFiles {
  title(): string;
}

export type Surface<T extends PaneTerm = PaneTerm> = { kind: "chooser" } | { kind: "terminal"; term: T } | { kind: "browser"; url: string; engine?: PaneEngine } | { kind: "devices" } | { kind: "files"; files: PaneFiles };

export interface Pane<T extends PaneTerm> {
  surfaces: Surface<T>[];
  active: number;
  open: boolean;
}

export interface SurfaceHost<T extends PaneTerm> {
  /** A PTY running `argv` (the user's shell when empty) in `cwd`; null when it couldn't start (the host says why). */
  spawn(title: string, cwd: string, argv: string[]): T | null;
  /** The panes changed: their tabs, which is open, which is maximized. */
  changed(): void;
  /** Keyboard focus to a pane's terminal (or its chooser) once it shows. */
  focus(d: Dock, terminal: boolean): void;
}

export function title(s: Surface): string {
  switch (s.kind) {
    case "chooser":
      return "New";
    case "terminal":
      return s.term.title;
    case "browser": {
      // surface.rs: the page's title once it has one (not Servo's error page's).
      const t = s.engine?.title ?? "";
      return t !== "" && t !== "Error loading page" ? t : s.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
    case "devices":
      return "Devices";
    case "files":
      return s.files.title();
  }
}

/** A tab's title, cut as surface.rs `tab` cuts it. */
export function tabTitle(s: Surface): string {
  return [...title(s)].slice(0, 26).join("");
}

export class Surfaces<T extends PaneTerm> {
  readonly panes: Record<Dock, Pane<T>> = { right: { surfaces: [], active: 0, open: false }, bottom: { surfaces: [], active: 0, open: false } };
  max: Dock | null = null;

  constructor(private readonly host: SurfaceHost<T>) {}

  showing(d: Dock): Surface<T> | undefined {
    const p = this.panes[d];
    return p.open ? p.surfaces[p.active] : undefined;
  }

  private show(d: Dock, i: number): void {
    const p = this.panes[d];
    p.active = Math.min(i, Math.max(0, p.surfaces.length - 1));
    p.open = true;
    const s = p.surfaces[p.active];
    if (s?.kind === "chooser" || s?.kind === "terminal") this.host.focus(d, s.kind === "terminal");
    this.host.changed();
  }

  /** Its browser engines stop (their URL is kept); terminals keep running. */
  hide(d: Dock): void {
    if (this.max === d) this.max = null;
    this.panes[d].open = false;
    for (const s of this.panes[d].surfaces) if (s.kind === "browser") this.stopEngine(s);
    this.host.changed();
  }

  /** What was picked in an empty chooser tab takes its place. */
  private place(d: Dock, s: Surface<T>): void {
    const p = this.panes[d];
    if (p.surfaces[p.active]?.kind === "chooser") p.surfaces[p.active] = s;
    else {
      p.surfaces.push(s);
      p.active = p.surfaces.length - 1;
    }
    this.show(d, p.active);
  }

  /** The top bar's panel buttons: each pane opens and closes on its own. */
  toggleDock(d: Dock): void {
    if (this.panes[d].open) return this.hide(d);
    if (this.panes[d].surfaces.length === 0) this.panes[d].surfaces.push({ kind: "chooser" });
    this.show(d, this.panes[d].active);
  }

  add(d: Dock): void {
    const p = this.panes[d];
    p.surfaces.push({ kind: "chooser" });
    this.show(d, p.surfaces.length - 1);
  }

  open(d: Dock, i: number): void {
    this.show(d, i);
  }

  close(d: Dock, i: number): void {
    const p = this.panes[d];
    const [gone] = p.surfaces.splice(i, 1);
    if (gone?.kind === "terminal") gone.term.kill();
    if (gone?.kind === "browser") gone.engine?.kill();
    if (p.surfaces.length === 0) {
      p.active = 0;
      this.hide(d);
      return;
    }
    p.active = Math.min(p.active, p.surfaces.length - 1);
    this.show(d, p.active);
  }

  toggleMax(d: Dock): void {
    this.max = this.max === d ? null : d;
    this.host.changed();
  }

  openTerminal(name: string, cwd: string, argv: string[] = [], d: Dock = "bottom"): void {
    const term = this.host.spawn(name, cwd, argv);
    if (term) this.place(d, { kind: "terminal", term });
  }

  /** Ctrl+`: the shell of where the user is, in the bottom pane. */
  toggleTerminal(cwd: string): void {
    const d: Dock = "bottom";
    if (this.showing(d)?.kind === "terminal") return this.hide(d);
    const i = this.panes[d].surfaces.findIndex((s) => s.kind === "terminal" && s.term.cwd === cwd && s.term.alive);
    if (i >= 0) this.show(d, i);
    else this.openTerminal(basename(cwd) || "~", cwd, [], d);
  }

  /** The browser lives in the right pane, or wherever one is open already. */
  openBrowser(url: string, d: Dock = "right"): void {
    for (const dock of [d, "right", "bottom"] as const) {
      const i = this.panes[dock].surfaces.findIndex((s) => s.kind === "browser");
      const s = this.panes[dock].surfaces[i];
      if (s?.kind === "browser") {
        s.url = url;
        s.engine?.load(url);
        return this.show(dock, i);
      }
    }
    this.place(d, { kind: "browser", url });
  }

  /** Ctrl+Shift+B. */
  toggleBrowser(url: string): void {
    if (this.showing("right")?.kind === "browser") return this.hide("right");
    this.openBrowser(url);
  }

  openDevices(d: Dock): void {
    for (const dock of [d, "right", "bottom"] as const) {
      const i = this.panes[dock].surfaces.findIndex((s) => s.kind === "devices");
      if (i >= 0) return this.show(dock, i);
    }
    this.place(d, { kind: "devices" });
  }

  /** devices.rs: a PC's files open in a new tab each time. */
  openFiles(d: Dock, files: PaneFiles): void {
    const p = this.panes[d];
    p.surfaces.push({ kind: "files", files });
    this.show(d, p.surfaces.length - 1);
  }

  stopEngine(s: Surface<T> & { kind: "browser" }): void {
    s.engine?.kill();
    delete s.engine;
  }

  /** Every terminal ends with the window. */
  dispose(): void {
    for (const p of Object.values(this.panes)) for (const s of p.surfaces) if (s.kind === "terminal") s.term.kill();
    for (const p of Object.values(this.panes)) for (const s of p.surfaces) if (s.kind === "browser") this.stopEngine(s);
  }
}

/** surface.rs `listening_ports`: what listens on loopback or every address (dev servers), from /proc/net/tcp{,6}. */
export function listeningPorts(tables: readonly string[], hookPort: number): number[] {
  const ports: number[] = [];
  for (const text of tables) {
    for (const l of text.split("\n").slice(1)) {
      const cols = l.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const [addr = "", hex = ""] = (cols[1] ?? "").split(":");
      const port = Number.parseInt(hex, 16);
      if (!Number.isFinite(port)) continue;
      const local = addr === "0100007F" || /^0+$/.test(addr) || (addr.startsWith("0000") && addr.endsWith("01000000"));
      const harbor = port >= hookPort && port < hookPort + 10;
      if (local && port >= 1024 && !harbor && !ports.includes(port)) ports.push(port);
    }
  }
  return ports.sort((a, b) => a - b).slice(0, 10);
}
