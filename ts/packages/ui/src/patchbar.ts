// The open chat's patches (agents/src/patches.ts) in the window: the shelf of chips over the composer,
// their menus, and the list panels they open.
import { homedir } from "node:os";
import { basename } from "node:path";
import { patches } from "@harbor/agents";
import { type ChipAct, type PatchChipData, patchChips, signature } from "./logic/patchchips.ts";
import { tilde } from "./logic/app.ts";
import type { PaneList } from "./surface.ts";
import type { ListData, ListRow, PopItem } from "./window.ts";

type Row = PopItem & { act?: () => void };

export interface PatchWhere {
  /** The chat's folder (a draft's: its project's). */
  cwd: string;
  project: string | null;
  /** The open chat, or null for a draft. */
  chat: number | null;
}

export interface PatchBarHost {
  /** Where the composer is, or null where patches don't apply (another PC's chat, no window). */
  where(): PatchWhere | null;
  chipsChanged(chips: PatchChipData[]): void;
  runCommand(title: string, cwd: string, command: string): void;
  sendPrompt(text: string): void;
  openUrl(url: string): void;
  openPage(url: string): void;
  openList(list: PaneList): void;
  listsChanged(): void;
  popup(id: string, x: number, y: number, items: Row[]): void;
  item(label: string, act: () => void, extra?: Partial<PopItem>): Row;
  label(text: string): PopItem;
  separator(): PopItem;
  toast(text: string): void;
  /** Opens a file in the user's editor. */
  openFile(path: string): void;
}

interface ListState {
  panel: patches.PatchPanel;
  root: string;
  cwd: string;
  rows: patches.PanelItem[];
  loading: boolean;
  error: string;
  at: number;
}

export class PatchBar {
  readonly patches: patches.Patches;
  private files: patches.PatchFile[] = [];
  private acts: ChipAct[] = [];
  private sig = "";
  private said = new Set<string>();
  private lists = new Map<string, ListState>();
  readonly home: string;

  constructor(
    store: patches.TrustStore,
    private readonly host: PatchBarHost,
    home = homedir(),
  ) {
    this.home = home;
    this.patches = new patches.Patches(store);
    this.patches.onLoaded = () => this.refresh();
  }

  /** Scans the composer's patch folders: cheap, called every second and on every view change. */
  refresh(): void {
    const w = this.host.where();
    const files = w === null ? [] : this.patches.scan(patches.patchDirs(w.cwd, w.project, this.home));
    const sig = signature(files);
    if (sig === this.sig) return;
    this.sig = sig;
    this.files = files;
    for (const f of files) {
      const key = `${f.path}:${f.hash}:${f.state}:${f.error}`;
      if ((f.state === "error" || f.state === "blocked") && !this.said.has(key)) {
        this.said.add(key);
        this.host.toast(`Patch ${f.name}: ${f.error}`);
      }
    }
    const { chips, acts } = patchChips(files);
    this.acts = acts;
    this.host.chipsChanged(chips);
    // A list panel whose patch changed shows the new version's rows.
    for (const [id, l] of this.lists) {
      const p = this.panel(id);
      if (p && p.panel !== l.panel) {
        l.panel = p.panel;
        this.reload(id);
      }
    }
  }

  private panel(id: string): { panel: patches.PatchPanel; root: string } | null {
    for (const f of this.files) for (const p of f.panels) if (p.id === id) return { panel: p, root: f.root };
    return null;
  }

  click(i: number, x: number, y: number): void {
    const a = this.acts[i];
    if (a) this.act(a, x, y);
  }

  private act(a: ChipAct, x: number, y: number): void {
    const w = this.host.where();
    switch (a.kind) {
      case "action": {
        const v = a.action.value;
        if (a.action.kind === "url") return this.host.openUrl(v);
        if (a.action.kind === "prompt") return this.host.sendPrompt(v);
        return this.host.runCommand(a.action.title, w?.cwd ?? a.root, v);
      }
      case "panel":
        if (a.panel.url) return this.host.openPage(a.panel.url);
        this.openList(a.panel, a.root, w?.cwd ?? a.root);
        return;
      case "more": {
        const rows = a.acts.map((sub, j) => this.host.item(a.chips[j]?.text ?? "", () => this.act(sub, x, y), { icon: a.chips[j]?.icon ?? "" }));
        return this.host.popup("patch-more", x, y, rows);
      }
      case "trust": {
        const rows: Row[] = [{ ...this.host.label("A patch is code that runs in Harbor as you: read it first."), kind: "caption" }];
        for (const f of a.files) {
          rows.push(this.host.separator(), { ...this.host.label(tilde(f.path, this.home)), kind: "caption" });
          rows.push(this.host.item(`Open ${basename(f.path)}`, () => this.host.openFile(f.path), { icon: "" }));
          rows.push(
            this.host.item(
              `Trust ${f.name}`,
              () => {
                this.patches.trust(f);
                this.sig = "";
                this.refresh();
              },
              { icon: "" },
            ),
          );
        }
        return this.host.popup("patch-trust", x, y, rows);
      }
      case "problems": {
        const rows: Row[] = [];
        for (const f of a.files) {
          if (rows.length > 0) rows.push(this.host.separator());
          rows.push({ ...this.host.label(`${f.name}: ${f.error}`), kind: "caption" });
          rows.push(this.host.item(`Open ${basename(f.path)}`, () => this.host.openFile(f.path)));
        }
        return this.host.popup("patch-problems", x, y, rows);
      }
    }
  }

  private openList(panel: patches.PatchPanel, root: string, cwd: string): void {
    const had = this.lists.get(panel.id);
    this.lists.set(panel.id, { panel, root, cwd, rows: had?.rows ?? [], loading: false, error: "", at: 0 });
    this.host.openList({ id: panel.id, title: panel.title });
    this.reload(panel.id);
  }

  private reload(id: string): void {
    const l = this.lists.get(id);
    if (!l || l.loading) return;
    l.loading = true;
    l.error = "";
    this.host.listsChanged();
    const panel = l.panel;
    void patches.panelItems(panel, l.cwd, l.root).then(
      (rows) => {
        l.rows = rows;
        l.loading = false;
        l.at = Date.now();
        this.host.listsChanged();
      },
      (e: unknown) => {
        l.loading = false;
        l.error = e instanceof Error ? e.message : String(e);
        this.host.listsChanged();
      },
    );
  }

  /** What a list tab shows. */
  listView(id: string): { data: ListData; rows: ListRow[] } {
    const l = this.lists.get(id);
    if (!l) return { data: { title: "", note: "", source: "", loading: false, error: "This panel's patch isn't loaded here: open it from its button.", }, rows: [] };
    const name = basename(l.panel.patch).replace(/\.(ts|js|mjs)$/, "");
    return {
      data: { title: l.panel.title, note: l.panel.note ?? "", source: `${name} patch · ${tilde(l.root, this.home)}`, loading: l.loading, error: l.error },
      rows: listRows(l.rows),
    };
  }

  listAct(id: string, action: string, i: number): void {
    if (action === "refresh") return this.reload(id);
    const l = this.lists.get(id);
    const flat = l ? flatRows(l.rows) : [];
    const url = flat[i]?.url;
    if (action === "open" && url) this.host.openUrl(url);
  }

  closed(id: string): void {
    this.lists.delete(id);
  }
}

/** The rows with a heading before each new section, as the panel draws them. */
function flatRows(items: readonly patches.PanelItem[]): (patches.PanelItem & { head?: boolean })[] {
  const out: (patches.PanelItem & { head?: boolean })[] = [];
  let section: string | undefined;
  for (const it of items) {
    if (it.section !== undefined && it.section !== section) out.push({ title: it.section, head: true });
    section = it.section;
    out.push(it);
  }
  return out;
}

export function listRows(items: readonly patches.PanelItem[]): ListRow[] {
  return flatRows(items).map((r) => ({ head: r.head === true, title: r.title, detail: r.detail ?? "", trailing: r.trailing ?? "", link: r.head !== true && (r.url ?? "") !== "" }));
}
