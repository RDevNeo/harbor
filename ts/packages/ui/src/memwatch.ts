// Samples memory only while the window shows it: the sidebar gauge, the open chat's pill, their popovers.
import type { Chat } from "@harbor/store";
import { bytesText, chatRows, deviceRows, gauge, type Mem, type MemRow, parseMem, partsTotal, type PcCard, type PcMem, type Ram } from "./logic/mempop.ts";

export interface MemWatchDeps {
  /** This PC's RAM alone (cheap: /proc/meminfo). */
  ram(): Ram | null;
  /** This PC's numbers and, for one of its own chats, that chat's parts (memory.snapshot: a /proc scan). */
  local(chat: number | null): unknown;
  /** The chat on screen. */
  chat(): Chat | undefined;
  /** The window is on screen. */
  looking(): boolean;
  pcName(): string;
  homeName(c: Chat): string;
  /** The other PCs and their numbers (null without a mesh), then Runs on devices reached over SSH (`ssh`). */
  peers: (() => Promise<{ name: string; online: boolean; mem: unknown; asking?: boolean; note?: string; ssh?: boolean }[]>) | null;
  /** A copy's numbers from its home PC. */
  chatMemory: ((c: Chat) => Promise<unknown>) | null;
  show(v: { chat: string; pc: string; frac: number; low: boolean; tip: string }): void;
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
  private remote: { chat: number; mem: Mem | null; at: number } | null = null;
  private remoteAsking = false;
  private peers: PcMem[] | null = null;
  private peersAt = 0;
  private peersAsking = false;
  private lastChat = "";

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

  private screenKey(): string {
    return `${this.d.looking()}|${this.d.chat()?.id ?? ""}|${this.d.popId()}`;
  }

  /** Reads the numbers now and shows them (also into a memory popover that's open). */
  sample(): void {
    this.key = this.screenKey();
    this.at = Date.now();
    if (!this.d.looking()) return;
    const pop = this.d.popId();
    const c = this.d.chat();
    const own = c !== undefined && c.home === "";
    const here = own || pop === "mem-devices" ? parseMem(this.d.local(own ? c.id : null)) : { ram: this.d.ram(), running: 0, top: [], parts: null };
    const r = here?.ram ?? null;
    const chatMem = c === undefined ? null : own ? here : this.remoteOf(c);
    this.lastChat = c === undefined ? "" : chatMem ? bytesText(partsTotal(chatMem.parts ?? [])) : "—";
    this.showGauge(r);
    if (pop === "mem-chat" && c) {
      const rows = chatMem ? chatRows(chatMem, own ? this.d.pcName() : this.d.homeName(c)) : chatRows({ ram: null, running: 0, top: [], parts: [] }, this.d.homeName(c));
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
    this.d.show({ chat: this.lastChat, ...gauge(this.d.pcName(), r, pick, this.d.peers ? this.peers : null) });
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
    const r = this.remote?.chat === c.id ? this.remote : null;
    if ((!r || Date.now() - r.at >= REMOTE_MS) && !this.remoteAsking && this.d.chatMemory) {
      this.remoteAsking = true;
      void this.d
        .chatMemory(c)
        .catch(() => null)
        .then((v) => {
          this.remote = { chat: c.id, mem: parseMem(v), at: Date.now() };
          this.remoteAsking = false;
          if (this.d.chat()?.id === c.id) this.sample();
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
