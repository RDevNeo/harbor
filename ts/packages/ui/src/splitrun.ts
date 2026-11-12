// Split chat panes on screen (logic/splitpanes.ts has the layout): their headers, transcripts (each in models of its own
// that stay with the pane), the dividers, and a chat dragged from the sidebar (layout is by dragging only). The focused
// pane's transcript is built by the shell, as the usual view's, into that pane's models (`target`); the others' here.
// So the keyboard going to another pane builds nothing again: both transcripts stay as they are. A pane that isn't on
// screen (another page, a pane shown alone) holds no cards and its transcript is let go.
import * as slint from "slint-ui";
import { type Band, close, type Drop, dropAt, dropped, dividers, MAX_PANES, opened, order, paneDropAt, paneDropped, parse, prune, rects, resize, serialize, single, type Split, SPLIT_KEY, toggleMax } from "./logic/splitpanes.ts";
import type { MediaRows } from "./mediarows.ts";
import type { Pixels } from "./logos.ts";
import type { AppWindow, CardData, ComposerState, MdBlockData, PaneBody, StripRow, WorkBarData, PaneDiv, PaneDrop, PaneHead, StatusData } from "./window.ts";

/** What a pane says of its chat: its header (title, status), its composer and the footer under it (where the agent
 * works, its branch). */
export interface PaneInfo {
  title: string;
  status: StatusData | null;
  running: boolean;
  draft: string;
  composer: ComposerState;
  logo: Pixels;
  photo: Pixels | null;
  bar: WorkBarData;
  strip: StripRow[];
  stripView: { title: string; names: string; header: boolean; folded: boolean; open: boolean };
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
  /** The layout changed under the shown chat: the view built again (the focused pane's transcript moves between the
   * usual view's models and its pane's when a pane is maximized or shown among the others again). */
  relaid(): void;
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
  strip: slint.ArrayModel<StripRow>;
  liveSeq: number;
  running: boolean;
  built: boolean;
  dirty: boolean;
  /** Its cards were last built by the shell (it had the keyboard): built here once it no longer has. */
  byShell: boolean;
  media: MediaRows | null;
}

/** Where the shell builds the focused pane's transcript: its models, its images, its streaming reply. */
export interface PaneTarget {
  cards: slint.ArrayModel<CardData>;
  live: slint.ArrayModel<MdBlockData>;
  media: MediaRows | null;
  /** The streaming reply's card (-1: none) and whether the chat works. */
  setLive(seq: number, running: boolean): void;
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

const NO_PIXELS: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };

/** Images by identity (a logo or photo is the same object while it's the same), the rest by value. */
const withoutImages = (h: PaneHead): unknown => ({ ...h, logo: 0, badge_photo: 0 });
const sameHead = (a: PaneHead, b: PaneHead): boolean => a.logo === b.logo && a.badge_photo === b.badge_photo && JSON.stringify(withoutImages(a)) === JSON.stringify(withoutImages(b));
const sameStrip = (a: StripRow, b: StripRow): boolean => a.logo === b.logo && JSON.stringify({ ...a, logo: 0 }) === JSON.stringify({ ...b, logo: 0 });

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
  private bare = new WeakMap<CardData, CardData>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: SplitHost) {
    this.state = parse(host.get(SPLIT_KEY));
    const w = host.win;
    w.split_heads = this.heads;
    w.split_bodies = this.bodies;
    w.split_divs = this.divs;
    w.split_drop = NO_DROP;
    w.split_focus = (i, composer, fromEnd, follow) => this.focus(i, composer, follow ? null : fromEnd);
    w.split_close = (i) => this.close(i);
    // -1: the maximized pane back among the others (the title bar's button).
    w.split_solo = (i) => {
      const s = this.now();
      this.change(toggleMax(s, i < 0 ? (s.max ?? -1) : i));
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
      // The focused pane's transcript is the usual view's: the shell folds it (and loads earlier cards) as it does.
      if (s === this.focused()) return this.host.win.toggle(seq);
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

  /** The dirty panes built again (not the focused one: the shell builds it). */
  flush(): void {
    const f = this.focused();
    for (const s of this.slots) if (s.built && s.dirty && s !== f) this.fill(s);
  }

  /** The panes are on screen, the usual view's chat the focused one. */
  private onScreen(): Split | null {
    const s = this.state;
    const shown = this.host.shown();
    return s !== null && s.chats.length > 1 && s.max === null && shown !== null && s.chats[s.focus] === shown ? s : null;
  }

  private focused(): Slot | null {
    const s = this.onScreen();
    if (s === null) return null;
    const chat = s.chats[s.focus];
    return this.slots.find((x) => x.chat === chat) ?? null;
  }

  /** The chats of the panes on screen (none when the panes aren't). */
  onScreenChats(): number[] {
    const s = this.onScreen();
    if (s === null) return [];
    const all = rects(s);
    return s.chats.filter((_, i) => all[i] !== null);
  }

  /** Where the shell builds chat `chat`'s transcript: its pane's models while it's the focused pane on screen, else
   * null (the usual view's). */
  target(chat: number): PaneTarget | null {
    const s = this.onScreen();
    if (s === null || s.chats[s.focus] !== chat) return null;
    if (this.slots.length !== s.chats.length || this.slots.some((x, i) => x.chat !== s.chats[i])) this.reconcile(s);
    const slot = this.slots[s.focus];
    if (!slot) return null;
    slot.built = true;
    slot.dirty = false;
    slot.byShell = true;
    slot.media ??= this.host.media(() => {
      slot.dirty = true;
      this.host.schedule();
    });
    return {
      cards: slot.cards,
      live: slot.live,
      media: slot.media,
      setLive: (seq, running) => {
        if (seq === slot.liveSeq && running === slot.running) return;
        slot.liveSeq = seq;
        slot.running = running;
        this.refreshHeads();
      },
    };
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
    // A pane maximized is the usual single-chat view (its title bar, full composer, Agents column), with a button in
    // the title bar that brings the other panes back.
    const maxed = split && s !== null && s.max !== null;
    if (w.split_maxed !== maxed) w.split_maxed = maxed;
    if (!split || s === null || maxed) {
      const n = maxed ? 1 : (s?.chats.length ?? 1);
      if (w.split_count !== n) w.split_count = n;
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
    this.refreshHeads();
    // The panes on screen are built (once, then as their chats change; the focused one by the shell); the hidden ones
    // hold nothing.
    s.chats.forEach((_, i) => {
      const slot = this.slots[i] as Slot;
      if (all[i] === null) this.empty(slot);
      else if (i !== s.focus && (!slot.built || slot.dirty || slot.byShell)) this.fill(slot);
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
        // Its agents strip: a pane without the keyboard keeps it, as the focused one does.
        sync(slot.strip, i === s.focus ? [] : info.strip, sameStrip);
        return {
          chat,
          title: info.title,
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
          draft: info.draft,
          composer: info.composer,
          logo: info.logo,
          badge_photo: info.photo ?? NO_PIXELS,
          has_badge_photo: info.photo !== null,
          bar: info.bar,
          strip_title: info.stripView.title,
          strip_names: info.stripView.names,
          strip_header: info.stripView.header,
          strip_folded: info.stripView.folded,
          strip_open: info.stripView.open,
        };
      }),
      sameHead,
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
    const strip = new slint.ArrayModel<StripRow>([]);
    const slot: Slot = { chat, body: { cards, live, strip }, cards, live, strip, liveSeq: -1, running: false, built: false, dirty: false, byShell: false, media: null };
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
    s.byShell = false;
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
    s.byShell = false;
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
      this.host.relaid();
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
