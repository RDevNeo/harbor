// Samples memory only while the window shows it: the sidebar gauge, the chips of the chats on screen (the usual view's,
// or each split pane's), their popovers.
import type { Chat } from "@harbor/store";
import { bytesText, chatRows, deviceRows, gauge, type Mem, type MemRow, parseChats, parseMem, partsTotal, type PcCard, type PcMem, type Ram } from "./logic/mempop.ts";

/** A chat whose parts this PC is asked for (memory.ts `ChatAsk`): `project`, its project's other chats when it's the main chat. */
export interface MemAsk {
  id: number;
  project?: readonly number[];
}

/** A chat's chip: its figure ("—" while there's none) and whether that is its project's (a main chat of this PC). */
export interface MemFigure {
  text: string;
  project: boolean;
}

export interface MemWatchDeps {
  /** This PC's RAM alone (cheap: /proc/meminfo). */
  ram(): Ram | null;
  /** This PC's numbers and, for its own chats in `asks`, each one's parts (memory.snapshot: one /proc scan). */
  local(asks: readonly MemAsk[]): unknown;
  /** The chats on screen: the usual view's, or each split pane's. */
  chats(): Chat[];
  /** A project's main chat: the project's other chats (its figure is then the project's); null for any other chat. */
  project(c: Chat): number[] | null;
  /** The window is on screen. */
  looking(): boolean;
  pcName(): string;
  homeName(c: Chat): string;
  /** The other PCs and their numbers (null without a mesh), then Runs on devices reached over SSH (`ssh`). */
  peers: (() => Promise<{ name: string; online: boolean; mem: unknown; asking?: boolean; note?: string; ssh?: boolean }[]>) | null;
  /** A copy's numbers from its home PC. */
  chatMemory: ((c: Chat) => Promise<unknown>) | null;
  show(v: { chats: Map<number, MemFigure>; pc: string; frac: number; low: boolean; tip: string }): void;
  /** The popover on screen ("mem-chat", "mem-devices" or another). */
  popId(): string;
  /** `cards[i]`: row i's submenu, null for none. */
  rows(rows: MemRow[], cards: (PcCard | null)[]): void;
  /** The PC whose RAM the sidebar's gauge shows, as the peers list names it ("" = this PC). */
  sidebarPc(): string;
}

/** Numbers this old get read again. */
const FRESH_MS = 5_000;
/** A copy's numbers come over the network: less often. */
const REMOTE_MS = 10_000;
/** Another PC's numbers for the sidebar's gauge, while the popover is closed. */
const SIDEBAR_MS = 10_000;

export class MemWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private key = "";
  private at = 0;
  /** Copies' numbers from their home PCs, by chat. */
  private remote = new Map<number, { mem: Mem | null; at: number }>();
  private remoteAsking = new Set<number>();
  private peers: PcMem[] | null = null;
  private peersAt = 0;
  private peersAsking = false;
  private lastChats = new Map<number, MemFigure>();
  /** The chat whose chip opened the "mem-chat" popover (-1: the first on screen). */
  private popChat = -1;

  constructor(private readonly d: MemWatchDeps) {}

  /** Polled: the window has no event for a popover opening or the chat changing that reaches here. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const key = this.screenKey();
      if (key !== this.key || Date.now() - this.at >= FRESH_MS) this.sample();
    }, 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The "mem-chat" popover is chat `id`'s (its chip was clicked). */
  pick(id: number): void {
    this.popChat = id;
  }

  private screenKey(): string {
    const ids = this.d.chats().map((c) => c.id);
    return `${this.d.looking()}|${ids.join(",")}|${this.d.popId()}|${this.popChat}`;
  }

  /** Reads the numbers now and shows them (also into a memory popover that's open). */
  sample(): void {
    this.key = this.screenKey();
    this.at = Date.now();
    if (!this.d.looking()) return;
    const pop = this.d.popId();
    const chats = this.d.chats();
    const asks = new Map<number, MemAsk>();
    for (const c of chats) {
      if (c.home !== "") continue;
      const project = this.d.project(c);
      asks.set(c.id, project === null ? { id: c.id } : { id: c.id, project });
    }
    const raw = asks.size > 0 || pop === "mem-devices" ? this.d.local([...asks.values()]) : null;
    const here = raw !== null ? parseMem(raw) : { ram: this.d.ram(), running: 0, top: [], parts: null };
    const mine = parseChats(raw);
    const mems = new Map<number, Mem | null>();
    this.lastChats = new Map();
    for (const c of chats) {
      const m = c.home === "" ? (mine.get(c.id) ?? null) : this.remoteOf(c);
      mems.set(c.id, m);
      this.lastChats.set(c.id, { text: m ? bytesText(partsTotal(m.parts ?? [])) : "—", project: asks.get(c.id)?.project !== undefined });
    }
    for (const id of this.remote.keys()) if (!mems.has(id)) this.remote.delete(id);
    this.showGauge(here?.ram ?? null);
    const c = chats.find((x) => x.id === this.popChat) ?? chats[0];
    if (pop === "mem-chat" && c) {
      const own = c.home === "";
      const m = mems.get(c.id) ?? null;
      const rows = chatRows(m ?? { ram: null, running: 0, top: [], parts: [] }, own && m ? this.d.pcName() : this.d.homeName(c), asks.get(c.id)?.project !== undefined);
      this.d.rows(rows, rows.map(() => null));
    }
    if (pop === "mem-devices") {
      const { rows, cards } = this.devices(here);
      this.d.rows(rows, cards);
    }
  }

  /** The gauge, from this PC's RAM `r` or, when the sidebar shows another PC, from its last answer (asked every SIDEBAR_MS). */
  private showGauge(r: Ram | null): void {
    const pick = this.d.sidebarPc();
    if (pick !== "" && this.d.popId() !== "mem-devices") this.askPeers(SIDEBAR_MS);
    this.d.show({ chats: this.lastChats, ...gauge(this.d.pcName(), r, pick, this.d.peers ? this.peers : null) });
  }

  /** Asks the other PCs when the last answer is `ms` old; a fresh answer redraws what shows it. */
  private askPeers(ms: number): void {
    const ask = this.d.peers;
    if (!ask || this.peersAsking || Date.now() - this.peersAt < ms) return;
    this.peersAsking = true;
    void ask()
      .catch(() => [])
      .then((list) => {
        this.peers = list.map((p) => ({ name: p.name, online: p.online, mem: parseMem(p.mem), asking: p.asking === true, note: p.note ?? "", ssh: p.ssh === true }));
        this.peersAt = Date.now();
        this.peersAsking = false;
        if (!this.d.looking()) return;
        if (this.d.popId() === "mem-devices") this.sample();
        else if (this.d.sidebarPc() !== "") this.showGauge(this.d.ram());
      });
  }

  /** A copy's numbers, asked of its home PC at most every REMOTE_MS. */
  private remoteOf(c: Chat): Mem | null {
    const r = this.remote.get(c.id);
    if ((!r || Date.now() - r.at >= REMOTE_MS) && !this.remoteAsking.has(c.id) && this.d.chatMemory) {
      this.remoteAsking.add(c.id);
      void this.d
        .chatMemory(c)
        .catch(() => null)
        .then((v) => {
          this.remote.set(c.id, { mem: parseMem(v), at: Date.now() });
          this.remoteAsking.delete(c.id);
          if (this.d.chats().some((x) => x.id === c.id)) this.sample();
        });
    }
    return r?.mem ?? null;
  }

  private devices(here: Mem | null): { rows: MemRow[]; cards: (PcCard | null)[] } {
    this.askPeers(FRESH_MS);
    const out = deviceRows({ name: this.d.pcName() || "This PC", online: true, mem: here }, this.peers ?? [], this.d.sidebarPc());
    if (this.peers === null && this.d.peers) {
      out.rows.push({ kind: "usage-note", icon: "", label: "Asking your other PCs…", desc: "", checked: false, enabled: false, badge: "", value: 0 });
      out.cards.push(null);
    }
    return out;
  }
}
