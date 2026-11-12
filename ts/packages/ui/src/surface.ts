import { basename } from "node:path";

export type Dock = "right" | "bottom";

/** What a pane needs of a terminal (terminal.ts `Terminal`). */
export interface PaneTerm {
  readonly title: string;
  readonly cwd: string;
  readonly alive: boolean;
  kill(): void;
}

/** What a pane needs of a PC's file browser (net's `FileBrowser`). */
export interface PaneFiles {
  title(): string;
}

/** A patch's list panel (agents/src/patches.ts): its id ("file#panel:title") and its title. */
export interface PaneList {
  id: string;
  title: string;
}

export type Surface<T extends PaneTerm = PaneTerm> = { kind: "chooser" } | { kind: "terminal"; term: T } | { kind: "devices" } | { kind: "files"; files: PaneFiles } | { kind: "list"; list: PaneList };

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
    case "devices":
      return "Devices";
    case "files":
      return s.files.title();
    case "list":
      return s.list.title;
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
    if (s?.kind === "devices" && this.max === d) this.max = null;
    if (s?.kind === "chooser" || s?.kind === "terminal") this.host.focus(d, s.kind === "terminal");
    this.host.changed();
  }

  /** Terminals keep running. */
  hide(d: Dock): void {
    if (this.max === d) this.max = null;
    this.panes[d].open = false;
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
    if (p.surfaces.length === 0) {
      p.active = 0;
      this.hide(d);
      return;
    }
    p.active = Math.min(p.active, p.surfaces.length - 1);
    this.show(d, p.active);
  }

  toggleMax(d: Dock): void {
    if (this.showing(d)?.kind === "devices") return;
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

  /** A patch's list panel: the tab it has already, else a new one in the right pane. */
  openList(list: PaneList, d: Dock = "right"): void {
    for (const dock of [d, "right", "bottom"] as const) {
      const i = this.panes[dock].surfaces.findIndex((s) => s.kind === "list" && s.list.id === list.id);
      if (i >= 0) return this.show(dock, i);
    }
    this.place(d, { kind: "list", list });
  }

  terminalIn(dir: string): boolean {
    const root = dir.replace(/\/+$/, "");
    return Object.values(this.panes).some((p) => p.surfaces.some((s) => s.kind === "terminal" && s.term.alive && (s.term.cwd === root || s.term.cwd.startsWith(`${root}/`))));
  }

  /** Every terminal ends with the window. */
  dispose(): void {
    for (const p of Object.values(this.panes)) for (const s of p.surfaces) if (s.kind === "terminal") s.term.kill();
  }
}
