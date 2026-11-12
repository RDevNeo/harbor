// What a restart keeps of the window (run.ts writes it to kv `reload_state` just before the new process takes
// over; the new one reads it once and deletes it) and what the composers keep through a crash (kv
// `composer_drafts`, written a moment after each change). Pure: the shell reads and applies them.

/** The composers' kv key: the new-chat draft and other PCs' chats in full, the cursor and picked tokens of all. */
export const COMPOSERS_KEY = "composer_drafts";
/** What the old window's composer took after its snapshot, while the new process started (kv, read once). */
export const LATE_KEY = "composer_late";
/** The new-chat draft's key in the composer maps (shell.ts DRAFT). */
export const DRAFT_KEY = 0;
/** A snapshot older than this is a restart that didn't happen as planned: only its drafts are taken. */
export const SNAPSHOT_FRESH_MS = 10 * 60_000;
/** How long after a change the composers are written. */
export const SAVE_MS = 300;

/** One composer: its text, the cursor (UTF-8 byte offset, as Slint has it), mentions as JSON, files (paths) and picked tokens. */
export interface ComposerEntry {
  text: string;
  cursor: number;
  mentions: unknown[];
  files: string[];
  picked: string[];
}

export type Composers = Map<number, ComposerEntry>;

/** A pane tab that can come back: a terminal comes back as a new shell in its folder (only shells: a command ended). */
export type PaneTab =
  | { kind: "chooser" }
  | { kind: "shell"; title: string; cwd: string }
  | { kind: "devices" }
  | { kind: "files"; device: string; path: string }
  | { kind: "list"; id: string; title: string };

export interface PaneSnap {
  open: boolean;
  active: number;
  tabs: PaneTab[];
}

export type PageSnap =
  | { kind: "settings"; tab: string; search: string; scroll: number; fields: Record<string, string> }
  | { kind: "prs" }
  | { kind: "issues" };

export interface TranscriptSnap {
  chat: number;
  /** Cards built (cards.ts Opened.limit). */
  limit: number;
  /** At the end (it follows new content); else `fromEnd` px from the view's top to the content's end. */
  follow: boolean;
  fromEnd: number;
  groups: number[];
  cards: number[];
}

/** A dialog that can open again, with what its field held. */
export type DialogSnap = { kind: "rename-chat"; id: number; input: string };

export interface UiSnapshot {
  /** When it was taken (ms). */
  at: number;
  view: { t: "chat"; id: number } | { t: "draft" };
  draftRepo: number | null;
  draftMain: boolean;
  /** Every composer, in full (a planned restart takes them all, the hub's own chats' too). */
  composers: Composers;
  sel: Record<string, string> | null;
  draftWt: { on: boolean; base: string } | null;
  draftHere: number[];
  draftPicked: [number, string][];
  page: PageSnap | null;
  pageBack: number | null;
  transcript: TranscriptSnap | null;
  sideQuery: string;
  sideScroll: number;
  panes: { right: PaneSnap; bottom: PaneSnap; max: "right" | "bottom" | null } | null;
  dialog: DialogSnap | null;
  /** The newest shared draft the window had taken, per chat (logic/shareddraft.ts). */
  revs: [number, number][];
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : []);

export function emptyComposer(e: Pick<ComposerEntry, "text" | "mentions" | "files">): boolean {
  return e.text.trim() === "" && e.mentions.length === 0 && e.files.length === 0;
}

export function composerFrom(v: unknown): ComposerEntry | null {
  const o = obj(v);
  if (o === null) return typeof v === "string" ? { text: v, cursor: Buffer.byteLength(v), mentions: [], files: [], picked: [] } : null;
  const text = str(o.text);
  const cursor = Math.max(0, Math.min(Buffer.byteLength(text), Math.round(num(o.cursor, Buffer.byteLength(text)))));
  return { text, cursor, mentions: Array.isArray(o.mentions) ? o.mentions : [], files: strs(o.files), picked: strs(o.picked) };
}

export function composersJson(c: Composers): Record<string, ComposerEntry> {
  const out: Record<string, ComposerEntry> = {};
  for (const [k, e] of c) if (!emptyComposer(e) || e.picked.length > 0) out[String(k)] = e;
  return out;
}

export function composersFrom(v: unknown): Composers {
  const out: Composers = new Map();
  for (const [k, e] of Object.entries(obj(v) ?? {})) {
    const id = Number(k);
    const c = composerFrom(e);
    if (Number.isInteger(id) && c !== null) out.set(id, c);
  }
  return out;
}

/**
 * kv `composer_drafts`: what a crash mustn't lose. This PC's own chats' text, mentions and files are the hub's
 * shared drafts (kv `shared_drafts`, net/src/hub.ts): only their cursor and picked tokens are here. The new-chat
 * draft and other PCs' chats (whose shared draft lives there) are here in full.
 */
export interface Kept {
  full: Composers;
  cursors: Map<number, number>;
  picked: Map<number, string[]>;
}

export function keptJson(all: Composers, own: (key: number) => boolean): Record<string, unknown> {
  const full: Composers = new Map();
  const cursors: Record<string, number> = {};
  const picked: Record<string, string[]> = {};
  for (const [k, e] of all) {
    if (!own(k)) full.set(k, e);
    else if (emptyComposer(e)) continue;
    else {
      cursors[String(k)] = e.cursor;
      if (e.picked.length > 0) picked[String(k)] = e.picked;
    }
  }
  return { full: composersJson(full), cursors, picked };
}

export function parseKept(text: string | null): Kept {
  const kept: Kept = { full: new Map(), cursors: new Map(), picked: new Map() };
  if (text === null || text === "") return kept;
  let o: Record<string, unknown> | null;
  try {
    o = obj(JSON.parse(text));
  } catch {
    return kept;
  }
  kept.full = composersFrom(o?.full);
  for (const [k, v] of Object.entries(obj(o?.cursors) ?? {})) if (Number.isInteger(Number(k)) && typeof v === "number" && v >= 0) kept.cursors.set(Number(k), Math.round(v));
  for (const [k, v] of Object.entries(obj(o?.picked) ?? {})) if (Number.isInteger(Number(k))) kept.picked.set(Number(k), strs(v));
  return kept;
}

function paneTab(v: unknown): PaneTab | null {
  const o = obj(v);
  switch (o?.kind) {
    case "chooser":
    case "devices":
      return { kind: o.kind };
    case "shell":
      return typeof o.cwd === "string" && o.cwd !== "" ? { kind: "shell", title: str(o.title, "~"), cwd: o.cwd } : null;
    case "files":
      return typeof o.device === "string" && o.device !== "" ? { kind: "files", device: o.device, path: str(o.path, "~") } : null;
    case "list":
      return typeof o.id === "string" && o.id !== "" ? { kind: "list", id: o.id, title: str(o.title) } : null;
    default:
      return null;
  }
}

function paneSnap(v: unknown): PaneSnap {
  const o = obj(v);
  const tabs = (Array.isArray(o?.tabs) ? o.tabs : []).map(paneTab).filter((t): t is PaneTab => t !== null);
  const active = Math.max(0, Math.min(tabs.length - 1, int(o?.active) ?? 0));
  return { open: o?.open === true && tabs.length > 0, active, tabs };
}

function pageSnap(v: unknown): PageSnap | null {
  const o = obj(v);
  if (o?.kind === "prs" || o?.kind === "issues") return { kind: o.kind };
  if (o?.kind !== "settings") return null;
  const fields: Record<string, string> = {};
  for (const [k, t] of Object.entries(obj(o.fields) ?? {})) if (typeof t === "string") fields[k] = t;
  return { kind: "settings", tab: str(o.tab, "general"), search: str(o.search), scroll: num(o.scroll), fields };
}

function transcriptSnap(v: unknown): TranscriptSnap | null {
  const o = obj(v);
  const chat = int(o?.chat);
  if (o === null || chat === null) return null;
  return { chat, limit: Math.max(1, int(o.limit) ?? 1), follow: o.follow !== false, fromEnd: num(o.fromEnd), groups: ints(o.groups), cards: ints(o.cards) };
}

/**
 * A snapshot as kv `reload_state` holds it: this shape, or the older one ({view, drafts: {id: text}, draft_repo,
 * draft_main}) an earlier Harbor leaves when it restarts into this one. Null: nothing usable.
 */
export function parseSnapshot(raw: Record<string, unknown> | null): UiSnapshot | null {
  if (raw === null) return null;
  const view = obj(raw.view);
  const viewId = int(view?.id);
  const composers = composersFrom(raw.composers);
  // The older shape: text alone.
  for (const [k, t] of Object.entries(obj(raw.drafts) ?? {})) {
    const id = Number(k);
    if (Number.isInteger(id) && typeof t === "string" && !composers.has(id)) composers.set(id, { text: t, cursor: Buffer.byteLength(t), mentions: [], files: [], picked: [] });
  }
  const sel = obj(raw.sel);
  const wt = obj(raw.draftWt);
  const panes = obj(raw.panes);
  const dialog = obj(raw.dialog);
  const dialogId = int(dialog?.id);
  return {
    at: num(raw.at),
    view: view?.t === "chat" && viewId !== null ? { t: "chat", id: viewId } : { t: "draft" },
    draftRepo: int(raw.draftRepo ?? raw.draft_repo),
    draftMain: (raw.draftMain ?? raw.draft_main) === true,
    composers,
    sel: sel === null ? null : Object.fromEntries(Object.entries(sel).filter((e): e is [string, string] => typeof e[1] === "string")),
    draftWt: wt === null ? null : { on: wt.on === true, base: str(wt.base) },
    draftHere: ints(raw.draftHere),
    draftPicked: (Array.isArray(raw.draftPicked) ? raw.draftPicked : []).filter((e): e is [number, string] => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === "string"),
    page: pageSnap(raw.page),
    pageBack: int(raw.pageBack),
    transcript: transcriptSnap(raw.transcript),
    sideQuery: str(raw.sideQuery),
    sideScroll: num(raw.sideScroll),
    panes: panes === null ? null : { right: paneSnap(panes.right), bottom: paneSnap(panes.bottom), max: panes.max === "right" || panes.max === "bottom" ? panes.max : null },
    dialog: dialog?.kind === "rename-chat" && dialogId !== null ? { kind: "rename-chat", id: dialogId, input: str(dialog.input) } : null,
    revs: (Array.isArray(raw.revs) ? raw.revs : []).filter((e): e is [number, number] => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === "number" && e[1] >= 0),
  };
}

/** The snapshot as it's written (a plain JSON object; `drafts` kept too, for an older Harbor started after this one). */
export function snapshotJson(s: UiSnapshot): Record<string, unknown> {
  const drafts: Record<string, string> = {};
  for (const [k, e] of s.composers) if (e.text.trim() !== "") drafts[String(k)] = e.text;
  return {
    v: 2,
    at: s.at,
    view: s.view,
    draft_repo: s.draftRepo,
    draft_main: s.draftMain,
    drafts,
    composers: composersJson(s.composers),
    sel: s.sel,
    draftWt: s.draftWt,
    draftHere: s.draftHere,
    draftPicked: s.draftPicked,
    page: s.page,
    pageBack: s.pageBack,
    transcript: s.transcript,
    sideQuery: s.sideQuery,
    sideScroll: s.sideScroll,
    panes: s.panes,
    dialog: s.dialog,
    revs: s.revs,
  };
}

/** Fresh enough to put the window back where it was (else only its drafts count). */
export function fresh(s: UiSnapshot, now: number): boolean {
  // An older Harbor's snapshot has no time: it was written just before this process started.
  return s.at === 0 || (now - s.at >= -60_000 && now - s.at < SNAPSHOT_FRESH_MS);
}

/** Calls `run` once, `ms` after the last `poke` (a burst of edits writes once). */
export class Debounce {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number,
    private readonly run: () => void,
  ) {}

  poke(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.ms);
  }

  /** Runs now if a run is due. */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.run();
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
