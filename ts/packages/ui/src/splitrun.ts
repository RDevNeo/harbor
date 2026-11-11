// Split chat panes on screen (logic/splitpanes.ts has the layout). The focused pane is the shell's usual chat view;
// this keeps the others: their headers, transcripts (built here, each in models of its own that stay with the pane),
// the dividers, the layout buttons, and a chat dragged from the sidebar. A pane that isn't on screen (another page,
// a pane shown alone) holds no cards and its transcript is let go.
import * as slint from "slint-ui";
import { applyPreset, type Band, close, type Drop, dropAt, dropped, dividers, MAX_PANES, opened, order, paneDropAt, paneDropped, parse, PRESETS, presetEnabled, presetOf, presetTip, type Preset, prune, rects, resize, serialize, single, type Split, SPLIT_KEY, toggleMax } from "./logic/splitpanes.ts";
import type { MediaRows } from "./mediarows.ts";
import type { AppWindow, CardData, MdBlockData, PaneBody, PaneDiv, PaneDrop, PaneHead, PanePreset, StatusData } from "./window.ts";

/** What a pane says of its chat: its header (title, status), its composer and the footer under it (where the agent
 * works, its branch). */
export interface PaneInfo {
  title: string;
  ws: string;
  branch: string;
  status: StatusData | null;
  running: boolean;
  draft: string;
  model: string;
}

export interface SplitHost {
  readonly win: AppWindow;
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
  /** The chat the usual view shows (null: another view is up). */
  shown(): number | null;
  exists(chat: number): boolean;
  info(chat: number): PaneInfo;
  /** A pane's transcript: the cards (as the usual view builds them) and whether a reply streams in it. */
  cards(chat: number, media: MediaRows | null): { cards: CardData[]; running: boolean };
  media(changed: () => void): MediaRows | null;
  /** A chat that left the screen: its transcript and built cards go (unless something else still shows it). */
  release(chat: number): void;
  toggle(chat: number, seq: number): void;
  openChat(chat: number, fromEnd: number | null): void;
  focusComposer(): void;
  cardAct(seq: number, action: string): void;
  sidebar(): void;
  /** Cards were marked dirty: the shell's next flush builds them. */
  schedule(): void;
  sameCard(a: CardData, b: CardData): boolean;
  sameBlock(a: MdBlockData, b: MdBlockData): boolean;
}

interface Slot {
  chat: number;
  body: PaneBody;
  cards: slint.ArrayModel<CardData>;
  live: slint.ArrayModel<MdBlockData>;
  liveSeq: number;
  running: boolean;
  built: boolean;
  dirty: boolean;
  media: MediaRows | null;
}

const NO_DROP: PaneDrop = { kind: "", pane: -1, x: 0, y: 0, w: 0, h: 0, label: "", sub: "", cap: false };

function sync<T>(model: slint.ArrayModel<T>, next: readonly T[], same: (a: T, b: T) => boolean): void {
  const n = model.rowCount();
  for (let i = 0; i < next.length; i++) {
    const v = next[i] as T;
    if (i < n) {
      const cur = model.rowData(i);
      if (cur === undefined || !same(cur, v)) model.setRowData(i, v);
    } else model.push(v);
  }
  if (n > next.length) model.remove(next.length, n - next.length);
}

const sameJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The status pill: the sidebar's status, said in a word. */
export function pillOf(s: StatusData | null): { pill: string; tone: PaneHead["tone"] } {
  if (s === null) return { pill: "", tone: "" };
  switch (s.kind) {
    case "working":
    case "busy":
      return { pill: "Working", tone: "blue" };
    case "waiting":
      return { pill: "Waiting", tone: "amber" };
    case "limited":
      return { pill: "Limited", tone: "amber" };
    case "failed":
      return { pill: "Failed", tone: "red" };
    case "done":
      return { pill: "Done", tone: "green" };
    default:
      return { pill: "Idle", tone: "gray" };
  }
}

export class SplitPanes {
  private state: Split | null;
  private slots: Slot[] = [];
  private heads = new slint.ArrayModel<PaneHead>([]);
  private bodies = new slint.ArrayModel<PaneBody>([]);
  private divs = new slint.ArrayModel<PaneDiv>([]);
  private presets = new slint.ArrayModel<PanePreset>([]);
  private bare = new WeakMap<CardData, CardData>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: SplitHost) {
    this.state = parse(host.get(SPLIT_KEY));
    const w = host.win;
    w.split_heads = this.heads;
    w.split_bodies = this.bodies;
    w.split_divs = this.divs;
    w.split_presets = this.presets;
    w.split_drop = NO_DROP;
    w.split_focus = (i, composer, fromEnd, follow) => this.focus(i, composer, follow ? null : fromEnd);
    w.split_close = (i) => this.close(i);
    w.split_solo = (i) => this.change(toggleMax(this.now(), i));
    w.split_preset = (id) => {
      if ((PRESETS as readonly string[]).includes(id)) this.change(applyPreset(this.now(), id as Preset));
    };
    w.split_resize = (path, at) => this.resize(path, at);
    w.split_drag = (chat, u, v, bu, bv) => this.drag(chat, u, v, { u: bu, v: bv });
    w.split_dropped = (chat, u, v, bu, bv) => this.drop(chat, u, v, { u: bu, v: bv });
    w.split_move = (i, u, v, bu, bv) => this.paneDrag(i, u, v, { u: bu, v: bv });
    w.split_moved = (i, u, v, bu, bv) => this.paneDrop(i, u, v, { u: bu, v: bv });
    w.split_drag_end = () => (w.split_drop = NO_DROP);
    w.split_toggle = (i, seq) => {
      const s = this.slots[i];
      if (!s) return;
      this.host.toggle(s.chat, seq);
      this.fill(s);
    };
    w.split_act = (i, seq, a) => {
      const chat = this.state?.chats[i];
      if (chat === undefined) return;
      if (this.state?.focus !== i) this.host.openChat(chat, null);
      this.host.cardAct(seq, a);
    };
  }

  /** The panes now, with the usual view's chat as the one pane when nothing is split. */
  private now(): Split {
    const shown = this.host.shown();
    return this.state ?? single(shown ?? -1);
  }

  /** How many panes are open (1 when nothing is split). */
  count(): number {
    return this.state?.chats.length ?? 1;
  }

  /** Chat `id` is in a pane on screen that the usual view doesn't show. */
  holds(id: number): boolean {
    const s = this.state;
    if (s === null || s.chats.length < 2 || s.max !== null) return false;
    const i = s.chats.indexOf(id);
    return i >= 0 && i !== s.focus;
  }

  /** The chats the sidebar marks as open in a pane: chat → that pane has the keyboard. */
  marks(): Map<number, boolean> {
    const out = new Map<number, boolean>();
    const s = this.state;
    if (s === null || s.chats.length < 2 || this.host.shown() === null) return out;
    s.chats.forEach((c, i) => out.set(c, i === s.focus));
    return out;
  }

  /** The usual view opens `chat`: its pane takes the keyboard, or it takes the focused pane's place. */
  opened(chat: number): void {
    const before = this.state;
    const next = before === null ? null : opened(before, chat);
    if (before !== null && next !== null && next.chats[next.focus] !== before.chats[before.focus]) {
      const gone = before.chats.filter((c) => !next.chats.includes(c));
      this.state = next;
      for (const c of gone) this.host.release(c);
    } else this.state = next;
    this.save();
  }

  /** Something changed chat `id` (null: several): a pane showing it is built again at the next flush. */
  changed(id: number | null): boolean {
    let any = false;
    for (const s of this.slots) {
      if (!s.built || (id !== null && s.chat !== id)) continue;
      s.dirty = true;
      any = true;
    }
    return any;
  }

  /** Every second while something streams: the panes whose chat works ("Working… 12s"). */
  running(live: (chat: number) => boolean): void {
    for (const s of this.slots) if (s.built && live(s.chat)) s.dirty = true;
    this.flush();
  }

  /** The dirty panes built again. */
  flush(): void {
    for (const s of this.slots) if (s.built && s.dirty) this.fill(s);
  }

  /** Lays the panes out (the usual view's chat is the focused one) and fills those on screen. */
  render(): void {
    const w = this.host.win;
    const shown = this.host.shown();
    let s = this.state;
    if (s !== null) {
      const p = prune(s, (c) => this.host.exists(c));
      if (p !== s) {
        this.state = s = p;
        this.save();
      }
    }
    const split = s !== null && s.chats.length > 1 && shown !== null && s.chats[s.focus] === shown;
    if (!split || s === null) {
      if (w.split_count !== (s?.chats.length ?? 1)) w.split_count = s?.chats.length ?? 1;
      for (const slot of this.slots) this.empty(slot);
      // Off screen, the panes keep only their chats (and come back with them).
      if (this.heads.rowCount() > 0) sync(this.heads, [], sameJson);
      if (this.divs.rowCount() > 0) sync(this.divs, [], sameJson);
      return;
    }
    this.reconcile(s);
    const all = rects(s);
    const f = all[s.focus] ?? { x: 0, y: 0, w: 1, h: 1 };
    if (w.split_fx !== f.x) w.split_fx = f.x;
    if (w.split_fy !== f.y) w.split_fy = f.y;
    if (w.split_fw !== f.w) w.split_fw = f.w;
    if (w.split_fh !== f.h) w.split_fh = f.h;
    sync(
      this.divs,
      dividers(s).map((d) => ({ path: d.path, dir: d.dir, at: d.at, ax: d.area.x, ay: d.area.y, aw: d.area.w, ah: d.area.h })),
      sameJson,
    );
    const preset = presetOf(s);
    sync(
      this.presets,
      PRESETS.map((p) => ({ id: p, on: preset === p, enabled: presetEnabled(s, p), tip: presetTip(s, p) })),
      sameJson,
    );
    this.refreshHeads();
    // The panes on screen are built (once, then as their chats change); the hidden ones hold nothing.
    s.chats.forEach((_, i) => {
      const slot = this.slots[i] as Slot;
      if (i === s.focus || all[i] === null) this.empty(slot);
      else if (!slot.built || slot.dirty) this.fill(slot);
    });
    if (w.split_count !== s.chats.length) w.split_count = s.chats.length;
  }

  /** The headers: titles, statuses, drafts (the sidebar refreshes them). */
  refreshHeads(): void {
    const s = this.state;
    if (s === null || this.slots.length !== s.chats.length || this.host.shown() === null || s.chats.length < 2) return;
    const all = rects(s);
    sync(
      this.heads,
      s.chats.map((chat, i): PaneHead => {
        const r = all[i];
        const info = this.host.info(chat);
        const slot = this.slots[i] as Slot;
        return {
          chat,
          title: info.title,
          ws: info.ws,
          branch: info.branch,
          ...pillOf(info.status),
          focused: i === s.focus,
          shown: r !== null,
          maxed: s.max === i,
          x: r?.x ?? 0,
          y: r?.y ?? 0,
          w: r?.w ?? 0,
          h: r?.h ?? 0,
          running: slot.running,
          live_seq: slot.liveSeq,
          draft: info.draft.replace(/\s+/g, " ").trim(),
          model: info.model,
        };
      }),
      sameJson,
    );
  }

  /** The slots follow the panes: a chat keeps its slot (its models) wherever its pane goes. */
  private reconcile(s: Split): void {
    const old = this.slots;
    const next = s.chats.map((chat) => old.find((x) => x.chat === chat) ?? this.slot(chat));
    for (const x of old) if (!next.includes(x)) this.empty(x);
    this.slots = next;
    const n = this.bodies.rowCount();
    next.forEach((x, i) => {
      if (i >= n) this.bodies.push(x.body);
      else if (this.bodies.rowData(i) !== x.body) this.bodies.setRowData(i, x.body);
    });
    if (n > next.length) this.bodies.remove(next.length, n - next.length);
  }

  private slot(chat: number): Slot {
    const cards = new slint.ArrayModel<CardData>([]);
    const live = new slint.ArrayModel<MdBlockData>([]);
    const slot: Slot = { chat, body: { cards, live }, cards, live, liveSeq: -1, running: false, built: false, dirty: false, media: null };
    return slot;
  }

  /** Builds pane `s`'s transcript; a streaming reply's blocks go to its live model, as the usual view does. */
  private fill(s: Slot): void {
    s.media ??= this.host.media(() => {
      s.dirty = true;
      this.host.schedule();
    });
    const { cards, running } = this.host.cards(s.chat, s.media);
    s.built = true;
    s.dirty = false;
    let at = -1;
    if (running) {
      for (let i = cards.length - 1; i >= 0; i--) {
        const k = cards[i]?.kind;
        if (k === "text") at = i;
        if (k !== "status" && k !== "space") break;
      }
    }
    const card = cards[at];
    let out = cards;
    if (card) {
      sync(s.live, card.blocks as MdBlockData[], this.host.sameBlock);
      let bare = this.bare.get(card);
      if (!bare) this.bare.set(card, (bare = { ...card, blocks: [] }));
      out = cards.slice();
      out[at] = bare;
    } else if (s.live.rowCount() > 0) sync(s.live, [], this.host.sameBlock);
    sync(s.cards, out, this.host.sameCard);
    const seq = card ? card.seq : -1;
    if (seq !== s.liveSeq || running !== s.running) {
      s.liveSeq = seq;
      s.running = running;
      this.refreshHeads();
    }
  }

  /** Pane `s` off screen: no cards, its transcript let go (unless the usual view shows its chat). */
  private empty(s: Slot): void {
    if (!s.built) return;
    s.built = false;
    s.dirty = false;
    if (s.cards.rowCount() > 0) sync(s.cards, [], this.host.sameCard);
    if (s.live.rowCount() > 0) sync(s.live, [], this.host.sameBlock);
    // Two sweeps: the first forgets what was used, the second lets every decoded image go.
    s.media?.sweep();
    s.media?.sweep();
    s.media = null;
    if (s.chat !== this.host.shown()) this.host.release(s.chat);
  }

  private focus(i: number, composer: boolean, fromEnd: number | null): void {
    const chat = this.state?.chats[i];
    if (chat === undefined) return;
    if (this.state?.focus !== i) this.host.openChat(chat, fromEnd);
    // The keyboard goes to the focused pane's composer (a click on its one-line composer, or anywhere in it).
    if (composer || this.state?.focus === i) this.host.focusComposer();
  }

  private close(i: number): void {
    const s = this.state;
    if (s === null || s.chats.length < 2) return;
    this.change(close(s, i));
  }

  /** A new layout: the focused pane's chat opened if it changed, else laid out again. */
  private change(next: Split): void {
    const before = this.state;
    if (next === before) return;
    const gone = before === null ? [] : before.chats.filter((c) => !next.chats.includes(c));
    this.state = next.chats.length === 1 ? null : next;
    this.save();
    const chat = next.chats[next.focus] as number;
    if (chat !== this.host.shown()) this.host.openChat(chat, null);
    else {
      this.render();
      this.host.sidebar();
    }
    for (const c of gone) if (c !== this.host.shown()) this.host.release(c);
  }

  private resize(path: string, at: number): void {
    const s = this.state;
    if (s === null) return;
    this.state = resize(s, path, at);
    this.render();
    this.save(400);
  }

  private dropAt(chat: number, u: number, v: number, band: Band): Drop {
    return dropAt(this.now(), chat, u, v, (c) => this.host.info(c).title, band);
  }

  private show(d: Drop, cap: boolean): void {
    const next: PaneDrop = { kind: d.kind, pane: d.pane, x: d.zone.x, y: d.zone.y, w: d.zone.w, h: d.zone.h, label: d.label, sub: d.sub, cap };
    if (!sameJson(next, this.host.win.split_drop)) this.host.win.split_drop = next;
  }

  private drag(chat: number, u: number, v: number, band: Band): void {
    if (this.host.shown() === null) return;
    this.show(this.dropAt(chat, u, v, band), this.count() >= MAX_PANES);
  }

  private drop(chat: number, u: number, v: number, band: Band): void {
    this.host.win.split_drop = NO_DROP;
    if (this.host.shown() === null) return;
    const d = this.dropAt(chat, u, v, band);
    if (d.kind === "none") return;
    this.change(dropped(this.now(), chat, d));
  }

  /** Pane `i` dragged by its header over (u, v): where it would go (a swap, a side, an outer edge). */
  private paneDrag(i: number, u: number, v: number, band: Band): void {
    const s = this.state;
    if (s === null || this.host.shown() === null) return;
    this.show(paneDropAt(s, i, u, v, band), false);
  }

  private paneDrop(i: number, u: number, v: number, band: Band): void {
    this.host.win.split_drop = NO_DROP;
    const s = this.state;
    if (s === null || this.host.shown() === null) return;
    const d = paneDropAt(s, i, u, v, band);
    if (d.kind === "none") return;
    this.change(paneDropped(s, i, d));
  }

  /** Ctrl+1…4: the panes in reading order take the keyboard; Ctrl+W: the focused pane closes (its chat keeps running). */
  key(ctrl: boolean, alt: boolean, shift: boolean, key: string): boolean {
    const s = this.state;
    if (s === null || s.chats.length < 2 || this.host.shown() === null || !ctrl || alt || shift) return false;
    if (/^[1-4]$/.test(key)) {
      const i = order(s)[Number(key) - 1];
      if (i === undefined) return false;
      this.focus(i, true, null);
      return true;
    }
    if (key.toLowerCase() === "w") {
      this.close(s.focus);
      return true;
    }
    return false;
  }

  private save(ms = 0): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    const write = () => {
      this.saveTimer = null;
      this.host.set(SPLIT_KEY, this.state === null ? "" : serialize(this.state));
    };
    if (ms === 0) write();
    else this.saveTimer = setTimeout(write, ms);
  }
}
