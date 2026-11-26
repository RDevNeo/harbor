// Persons tab, window side: drives PersonsBus (slint/persons.slint) from the engine's v1/persons routes (in-process
// through ctx.call — the same routes Hub for Android uses). Pictures are local files the engine cached, decoded here.
import * as slint from "slint-ui";
import { readFileSync, statSync } from "node:fs";
import { clipboard, images, picker } from "@harbor/media";
import { GLYPHS, type GlyphName } from "@harbor/net";
import { basename } from "node:path";
import type { TabCtx, TabUi } from "../api.ts";
import { sameRow, syncRows } from "../../modelsync.ts";
import { loadQr } from "../../qr.ts";
import { releaseBlocks } from "../../markdown.ts";
import { aiSlintParts, type PPartData } from "./aiparts.ts";
import { aiMenu, blockedNote, composerHint, failedMenu, messageMenu, moveEntries, placeOfRow, quoteInto, type MenuEntry, type MoveEntry } from "./menus.ts";
import { aiFolds, audioRow, byRecent, chatRows, shortAgo, listRows, matches, nextSpeed, personSections, sideRows, srImageSize, type AudioRow, type AudioStateJson, type ChatJson, type MsgRow, type PersonJson, type Row, type SrFileJson, type SrPaneJson, type StateJson, type UiState } from "./view.ts";

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
const NO_PX: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
/** The store owner's avatar colour behind their initials when the store has no icon (SrLogo's gray). */
const SR_OWNER_COLOR = "#71717a";

type Cb = (...a: never[]) => unknown;
interface Bus extends Record<string, unknown> {
  [k: string]: unknown;
}

interface PanelJson {
  person: Record<string, unknown> & { id: string; notes?: string; settled?: Record<string, string>; storeIds: string[]; listIds: string[]; socials?: string[]; discordId?: string; discordUsername?: string; email?: string; whatsapp?: string; name: string };
  name: string;
  initials: string;
  color: string;
  avatarPath: string | null;
  stores: { id: string; name: string; owner: boolean; color: string }[];
  lists: { id: string; name: string }[];
  identities: { kind: string; value: string; section: string | null; label: string }[];
  /** People linked into them: who, their identifiers, their own AI chats (still reachable). */
  linked?: { id: string; name: string; at: string; ids: string[]; aiChats: { section: string; chat: string }[] }[];
  socials: { url: string; platform: string | null; handle: string | null; note?: string; uploads: { title: string; url: string; thumb: string | null; meta?: string }[] }[];
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", wav: "audio/wav", txt: "text/plain", zip: "application/zip" };
const mimeOf = (f: string): string => MIME[f.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length > 1 ? `${w[0]![0] ?? ""}${w.at(-1)![0] ?? ""}`.toUpperCase() : (w[0] ?? "?").slice(0, 2).toUpperCase();
};
const hash = (id: string): number => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
const shortAgoText = (iso: string): string => shortAgo(iso);
const SECTION_LABEL: Record<string, string> = { stores: "Stores", creators: "Creators", spokpay: "SpokPay" };
const KIND_LABEL: Record<string, string> = { discord: "Discord", gmail: "Gmail", whatsapp: "WhatsApp" };
/** One entry of a Persons menu (showMenu): `children` makes it open a submenu. */
type MenuIn = { id?: string; label: string; icon?: string; sub?: string; hint?: string; danger?: boolean; sep?: boolean; header?: boolean; disabled?: boolean; checked?: boolean; children?: MenuIn[]; run?: () => void };

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"];

/** Decoded pictures by file (and size class), shared by every row that draws them. */
class Pictures {
  private done = new Map<string, { mtime: number; px: Pixels | null }>();
  private busy = new Set<string>();
  constructor(private readonly changed: () => void) {}

  get(path: string | null | undefined, cap = 96): Pixels | null {
    if (!path) return null;
    const key = `${cap}:${path}`;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.done.get(key);
    if (hit && hit.mtime === mtime) return hit.px;
    if (!this.busy.has(key)) {
      this.busy.add(key);
      void images
        .decodeBytes(new Uint8Array(readFileSync(path)), cap)
        .then(
          (r) => this.done.set(key, { mtime, px: r.image as Pixels }),
          () => this.done.set(key, { mtime, px: null }),
        )
        .finally(() => {
          this.busy.delete(key);
          this.changed();
        });
    }
    return hit?.px ?? null;
  }
}

class PersonsTab {
  private bus: Bus;
  private state: StateJson | null = null;
  private ui: UiState = { closed: new Set(), stores: new Set(), settledOpen: new Set(), open: null, allActive: true };
  private query = "";
  private chat: ChatJson | null = null;
  private panelData: PanelJson | null = null;
  private panelOpen = true;
  /** The composer writes to the person's AI (Person Hub's "To: AI | Name" switch), remembered per chat. */
  private aiMode = false;
  private toAi = new Map<string, boolean>();
  private replyTo: { id: string; name: string; text: string } | null = null;
  /** A message forwarded to the AI (Forward to AI): quoted in the AI composer, for the chat it came from. */
  private forwarded: { id: string; name: string; text: string } | null = null;
  /** Files going with the next message (paths on this PC); the AI composer has its own. */
  private files: string[] = [];
  private aiFiles: string[] = [];
  /** Unsent text per chat and recipient (kept when switching people or recipient). */
  private drafts = new Map<string, string>();
  private menuActions = new Map<string, () => void>();
  /** A menu entry's submenu (its PMenu rows), by the entry's id. */
  private subMenus = new Map<string, Record<string, unknown>[]>();
  private dialogOk: (() => Promise<void> | void) | null = null;
  private chipState = new Map<string, boolean>();
  private colorPick = "";
  private typingAt = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private toastAction: (() => void) | null = null;
  private pics: Pictures;
  private sideModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private listModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private msgModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private renderQueued = false;
  private chatSeq = 0;
  /**
   * The chat (chatKey) the user marked unread while it was open: it isn't marked seen again until it's opened again
   * (another chat, then this one). Without it the open chat's reload, which follows its row going unread, read it at once.
   */
  private holdUnread = "";
  private qr: ((text: string) => Pixels) | null = null;
  private alive = true;

  constructor(private readonly ctx: TabCtx) {
    this.bus = Reflect.get(ctx.win, "PersonsBus") as Bus;
    this.pics = new Pictures(() => this.render());
    const b = this.bus;
    b.side = this.sideModel;
    b.list = this.listModel;
    b.msgs = this.msgModel;
    const on = (name: string, f: Cb): void => {
      b[name] = f;
    };
    on("all_people", () => {
      this.stopAudio();
      this.leaveSr();
      this.ui.open = null;
      this.ui.allActive = true;
      this.chat = null;
      this.render();
    });
    on("open_person", ((id: string, section: string, store: string) => void this.openPerson(id, section, store)) as Cb);
    on("open_sr", ((ref: string) => this.openSiteRequest(ref)) as Cb);
    on("sr_menu", ((ref: string, x: number, y: number) => this.siteRequestMenu(ref, x, y)) as Cb);
    on("sr_close", () => {
      this.leaveSr();
      this.ui.allActive = true;
      this.render();
    });
    on("sr_status_menu", ((x: number, y: number) => this.srStatusMenu(x, y)) as Cb);
    on("sr_copy", () => {
      const p = this.sr?.pane;
      if (p) void clipboard.copyText(p.url).then(() => this.setToast(`Link to ${p.ref} copied`), () => this.setToast("The link could not be copied."));
    });
    on("sr_retry", () => void this.loadSr());
    on("sr_open_image", ((owner: string, i: number) => void this.srOpenImage(owner, i)) as Cb);
    on("sr_open_file", ((owner: string, i: number) => {
      const f = this.srFilesOf(owner).filter((x) => !x.image)[i];
      if (f) ctx.openExternal(f.url);
    }) as Cb);
    on("toggle_store", ((id: string) => this.toggle(this.ui.stores, id)) as Cb);
    on("toggle_section", ((sec: string) => (sec.startsWith("settled:") ? this.toggle(this.ui.settledOpen, sec.slice(8)) : this.toggle(this.ui.closed, sec))) as Cb);
    on("section_menu", ((sec: string, x: number, y: number) => this.sectionMenu(sec, x, y)) as Cb);
    on("row_menu", ((id: string, sec: string, store: string, x: number, y: number) => this.rowMenu(id, sec, store, x, y)) as Cb);
    on("store_menu", ((id: string, x: number, y: number) => this.storeMenu(id, x, y)) as Cb);
    on("edited_query", ((q: string) => {
      this.query = q;
      this.render();
    }) as Cb);
    on("close_chat", () => {
      this.stopAudio();
      this.ui.open = null;
      this.chat = null;
      this.render();
    });
    // the composer is the person chats' own: in a site request's pane it writes to the store (or to the AI about it)
    on("send", () => void (this.sr ? this.srSend() : this.send()));
    on("typing", () => this.typing());
    on("older", () => void this.older());
    on("toggle_panel", () => {
      this.panelOpen = !this.panelOpen;
      if (this.panelOpen) void this.loadPanel();
      this.render();
    });
    on("account_menu", ((x: number, y: number) => this.accountMenu(x, y)) as Cb);
    on("msg_menu", ((id: string, x: number, y: number) => this.msgMenu(id, x, y)) as Cb);
    on("open_file", ((id: string) => void this.openFile(id)) as Cb);
    on("open_image", ((id: string, i: number) => void this.openImage(id, i)) as Cb);
    on("attach", () => void (this.sr && !this.aiMode ? this.srAttach() : this.attach()));
    on("clear_attached", () => {
      if (this.aiMode) this.aiFiles = [];
      else if (this.sr) this.srFiles = [];
      else this.files = [];
      this.render();
    });
    on("set_to", ((to: string) => this.setTo(to === "ai")) as Cb);
    on("cancel_forward", () => {
      this.forwarded = null;
      this.render();
    });
    on("open_ai_chat", () => {
      const id = this.sr ? this.sr.pane?.aiChat : this.chat?.aiChat;
      if (id) this.ctx.openChat?.(id);
    });
    on("msg_unread", ((id: string) => this.markUnread(id)) as Cb);
    on("card_act", ((id: string, act: string) => void this.cardAct(id, act)) as Cb);
    on("cancel_reply", () => {
      this.replyTo = null;
      this.render();
    });
    on("toggle_ai", () => this.setTo(!this.aiMode));
    on("save_notes", ((text: string) => void this.saveNotes(text)) as Cb);
    on("open_url", ((url: string) => ctx.openExternal(url)) as Cb);
    // markdown.slint also reports selections ("sel:…") and keys ("scroll:…"): only web and mail links open
    on("md_link", ((url: string) => {
      if (/^(https?:|mailto:)/i.test(url)) ctx.openExternal(url);
    }) as Cb);
    on("use_draft", ((text: string) => this.useDraft(text)) as Cb);
    on("ai_fold", ((id: string) => {
      this.aiFold.set(id, !this.foldedNow.has(id));
      this.render();
    }) as Cb);
    on("menu_pick", ((id: string) => this.pick(id)) as Cb);
    on("menu_hover", ((id: string, y: number) => this.menuHover(id, y)) as Cb);
    on("menu_close", () => {
      b.menu_open = false;
      b.sub_open = false;
    });
    on("dialog_ok", () => void this.okDialog());
    on("dialog_cancel", () => this.closeDialog());
    on("chip", ((id: string) => {
      this.chipState.set(id, !this.chipState.get(id));
      this.renderChips();
    }) as Cb);
    on("color", ((id: string) => {
      this.colorPick = id;
      this.renderColors();
    }) as Cb);
    on("add_person", () => this.personDialog(null));
    on("prev", () => this.step(-1));
    on("next", () => this.step(1));
    on("toast_act", () => {
      const f = this.toastAction;
      this.setToast("");
      f?.();
    });
    on("audio_toggle", ((id: string) => void this.audioToggle(id)) as Cb);
    on("audio_seek", ((id: string, f: number) => void this.audioSeek(id, f)) as Cb);
    on("audio_speed", () => void this.audioSpeed());
    on("audio_transcribe", ((id: string) => void this.audioTranscribe(id)) as Cb);
    on("pick_toggle", ((id: string) => {
      if (this.picks.has(id)) this.picks.delete(id);
      else this.picks.add(id);
      this.renderPicks();
    }) as Cb);
    on("pick_query", ((q: string) => {
      this.pickQ = q;
      this.renderPicks();
    }) as Cb);
    on("unlink", ((id: string) => {
      const open = this.ui.open;
      if (open) this.unlinkDialog(open.id, id);
    }) as Cb);
    on("panel_menu", ((x: number, y: number) => {
      const open = this.ui.open;
      if (open) this.panelMenu(open.id, x, y);
    }) as Cb);
    ctx.onChanged(() => void this.refresh());
  }

  // ---------- data ----------

  async start(): Promise<void> {
    await this.refresh();
    void this.loop();
  }

  /** Long-poll: the engine answers when its rev moves (or after 25 s). */
  private async loop(): Promise<void> {
    while (this.alive) {
      try {
        const rev = this.state?.rev ?? 0;
        const r = await this.ctx.call("GET", "v1/persons/state", { rev: String(rev) });
        if (r.status === 200) this.applyState(r.body as StateJson);
        else await new Promise((res) => setTimeout(res, 2000));
      } catch {
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }

  private async refresh(): Promise<void> {
    try {
      const r = await this.ctx.call("GET", "v1/persons/state");
      if (r.status === 200) this.applyState(r.body as StateJson);
      else this.bus.note = String((r.body as { error?: string } | null)?.error ?? `Persons answered ${r.status}`);
    } catch (e) {
      this.bus.note = e instanceof Error ? e.message : String(e);
    }
  }

  private applyState(s: StateJson): void {
    if (s.loading) return;
    const before = this.state;
    this.state = s;
    if (s.audio !== undefined) this.applyAudio(s.audio ?? null);
    if (this.ui.open && !s.people.some((p) => p.id === this.ui.open?.id)) {
      this.ui.open = null;
      this.chat = null;
    }
    // a sign-in by QR code (WhatsApp's linked device, Discord's "Scan QR code"): its code in a dialog
    const linking = s.connections.find((c) => (c.kind === "whatsapp" || c.kind === "discord") && c.status === "signing-in");
    if (linking && (this.bus.dialog === "" || this.bus.dialog === "qr")) void this.showQr(linking.kind, linking.qr, linking.error, linking.id);
    else if (!linking && this.bus.dialog === "qr") {
      this.dialogCancel = null; // signed in (or gave up): nothing to cancel
      this.closeDialog();
    }
    this.render();
    // the open request follows its row in the list (a message, a move)
    const sr = this.sr;
    if (sr) {
      const was = before?.siteRequests?.rows.find((r) => r.ref === sr.ref);
      const now = s.siteRequests?.rows.find((r) => r.ref === sr.ref);
      if (now && was && now.at !== was.at && now.at > (sr.pane?.lastActivityAt ?? 0)) void this.loadSr();
    }
    // the open chat follows its person's row (a message, typing, presence)
    const open = this.ui.open;
    if (open) {
      const was = before?.people.find((p) => p.id === open.id);
      const now = s.people.find((p) => p.id === open.id);
      if (JSON.stringify(was?.rows) !== JSON.stringify(now?.rows) || before?.rev !== s.rev) void this.loadChat(false);
    }
  }

  private person(id: string): PersonJson | undefined {
    return this.state?.people.find((p) => p.id === id);
  }

  private async api(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await this.ctx.call(method, `v1/persons/${path}`, query, body);
    return { status: r.status, body: (r.body ?? {}) as Record<string, unknown> };
  }

  // ---------- rendering ----------

  private render(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      // one person's odd data must never end the window: a throw here would be an uncaught exception
      try {
        this.draw();
      } catch (e) {
        console.error(`hub: persons: drawing the page failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        this.bus.note = `Couldn't draw this page: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
  }

  private rowJs(r: Row): Record<string, unknown> {
    const px = r.avatarPath ? this.pics.get(r.avatarPath, r.kind === "store" ? 48 : 96) : null;
    return {
      kind: r.kind,
      id: r.id,
      section: r.section,
      store: r.store,
      name: r.name,
      initials: r.initials,
      color: r.color,
      avatar: px ?? NO_PX,
      has_avatar: !!px,
      presence: r.presence,
      status: r.status,
      tone: r.tone,
      channel: r.channel,
      time: r.time,
      unread: r.unread,
      typing: r.typing,
      owner: r.owner,
      active: r.active,
      expanded: r.expanded,
      count: r.count,
      depth: r.depth,
      dim: r.dim,
      tip: r.tip,
    };
  }

  private draw(): void {
    const b = this.bus;
    const s = this.state;
    if (!s) {
      b.view = "loading";
      return;
    }
    syncRows(this.sideModel, sideRows(s, this.ui).map((r) => this.rowJs(r)), sameRow);
    b.unread_total = s.unread;
    // the Persons tab's count in the tab row, at once (the window also reads it every 3 s from any tab)
    const tabsBus = Reflect.get(this.ctx.win, "TabsBus") as { persons_unread: number } | undefined;
    if (tabsBus && typeof s.unread === "number" && tabsBus.persons_unread !== s.unread) tabsBus.persons_unread = s.unread;
    const off = s.connections.filter((c) => c.status === "signed-out");
    b.note = off.length ? `${off.map((c) => `${SECTION_LABEL[c.section]} ${KIND_LABEL[c.kind]}`).join(", ")} signed out` : "";
    if (this.sr && this.ui.srOpen === this.sr.ref) {
      b.view = "sr";
      this.drawSr();
      return;
    }
    if (!this.ui.open || !this.chat) {
      b.view = this.ui.open ? "chat" : "list";
      const rows = listRows(s, this.query, this.ui.open);
      syncRows(this.listModel, rows.map((r) => this.rowJs(r)), sameRow);
      b.list_title = "All people";
      b.list_sub = this.query ? `${rows.length} of ${s.people.length} match “${this.query}”` : `${s.people.length} ${s.people.length === 1 ? "person" : "people"}`;
      if (!this.ui.open) return;
    }
    b.view = "chat";
    this.drawChat();
    this.drawPanel();
  }

  private drawChat(): void {
    const b = this.bus;
    const c = this.chat;
    if (!c) {
      b.c_loading = true;
      syncRows(this.msgModel, []);
      return;
    }
    const pp = c.person;
    const px = this.pics.get(pp.avatarPath, 96);
    b.c_name = pp.name;
    b.c_initials = pp.initials;
    b.c_color = pp.color;
    b.c_avatar = px ?? NO_PX;
    b.c_has_avatar = !!px;
    b.c_presence = pp.presence ?? "";
    b.c_status = c.typing ? (c.typing === "recording" ? "recording audio…" : "typing…") : pp.status?.text ?? "";
    b.c_tone = c.typing ? "green" : pp.status?.tone ?? "";
    b.c_channel = c.account?.kind ?? "";
    // the chat the composer sends on; with two of a kind (a linked person's other number) it says which
    b.c_account = c.account ? (c.account.to && c.account.to.includes(" · ") ? `${c.account.label} → ${c.account.to.split(" · ").slice(1).join(" · ")}` : c.account.label) : "No channel";
    b.c_accounts = c.accounts.length > 1;
    b.c_gmail = c.account?.kind === "gmail";
    b.c_connected = !!c.account?.connected;
    b.c_more = c.more;
    b.c_loading = false;
    b.c_empty = c.account ? "No messages yet." : "No channel to talk to them here: connect Discord, Gmail or WhatsApp in the section's +, and give them that identifier (Edit).";
    // the composer (Person Hub's): who it goes to, the reply / forward, the subject of a first email, the files
    const aiOn = c.aiOn !== false;
    if (!aiOn) this.aiMode = false;
    const kind = c.account?.kind ?? "";
    const blocked = blockedNote({ hasAccount: !!c.account, hasPeer: !!c.peer, connected: !!c.account?.connected, kind });
    b.c_ai_on = aiOn;
    b.c_can_send = !blocked;
    b.c_blocked = blocked ?? "";
    b.c_need_subject = kind === "gmail" && c.messages.length === 0 && c.outgoing.length === 0 && !blocked;
    b.c_hint = composerHint({ toAi: this.aiMode, forwarded: !!this.forwarded, name: pp.name, kind, me: kind === "gmail" ? c.account?.label.replace(/^Gmail · /, "").replace(/^Gmail$/, "") ?? "" : "" });
    b.has_ai_chat = !!c.aiChat;
    b.reply_name = this.aiMode ? "" : this.replyTo?.name ?? "";
    b.reply_text = this.aiMode ? "" : this.replyTo?.text ?? "";
    b.fwd_name = this.aiMode && this.forwarded ? this.forwarded.name : "";
    b.fwd_text = this.aiMode && this.forwarded ? this.forwarded.text : "";
    b.attached = (this.aiMode ? this.aiFiles : this.files).map((f) => basename(f)).join(", ");
    b.ai_mode = this.aiMode;
    b.panel = this.panelOpen;
    const rows = aiFolds(chatRows(c).slice(-400), this.aiFold);
    this.foldedNow = new Set(rows.filter((r) => r.folded).map((r) => r.id));
    this.keepParts(rows);
    const js = rows.map((r) => this.msgJs(r));
    // pictures (`images[].image`) compare by identity: never serialised (see sameRow)
    syncRows(this.msgModel, js, sameRow);
  }

  private attachPaths = new Map<string, string | null>();
  /** The AI answers the user folded (true) or opened (false) with their chevron, by row id: kept for the session. */
  private aiFold = new Map<string, boolean>();
  /** The answers folded on screen now (what a chevron click turns around). */
  private foldedNow = new Set<string>();
  /** Each AI answer's parts for its bubble, by row id, while its text stays the same (a streaming one is redone). */
  private aiParts = new Map<string, { key: string; parts: PPartData[] }>();

  private partsOf(r: MsgRow): PPartData[] {
    if (r.kind !== "ai") return [];
    const key = JSON.stringify(r.parts);
    const had = this.aiParts.get(r.id);
    if (had?.key === key) return had.parts;
    const owner = `persons-${r.id}`;
    releaseBlocks(owner);
    const parts = aiSlintParts(r.parts, owner);
    this.aiParts.set(r.id, { key, parts });
    return parts;
  }

  /** Forgets the parts of answers no longer shown (another chat open). */
  private keepParts(rows: readonly MsgRow[]): void {
    const shown = new Set(rows.map((r) => r.id));
    for (const id of this.aiParts.keys()) {
      if (shown.has(id)) continue;
      releaseBlocks(`persons-${id}`);
      this.aiParts.delete(id);
    }
  }

  /** A draft from the AI's answer into the composer, to send to the person. */
  private useDraft(text: string): void {
    this.setTo(false);
    this.bus.draft = text;
    this.render();
  }

  /** The chat's key for what the composer remembers (recipient, drafts). */
  private chatKey(): string {
    const o = this.ui.open;
    return o ? `${o.id}:${o.section}` : "";
  }

  /** What the composer remembers its recipient and drafts by: the open chat, or `sr:<ref>` in a site request's pane. */
  private composerKey(): string {
    return this.sr ? `sr:${this.sr.ref}` : this.chatKey();
  }

  /** Switches the composer between the person and their AI, each with its own draft. */
  private setTo(ai: boolean): void {
    const k = this.composerKey();
    if (!k || ai === this.aiMode) return;
    this.drafts.set(`${k}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    this.aiMode = ai;
    this.toAi.set(k, ai);
    this.bus.draft = this.drafts.get(`${k}:${ai ? "ai" : "person"}`) ?? "";
    if (ai) this.typingAt = 0;
    this.focusField();
    this.render();
  }

  /** The composer's field takes the focus (Person Hub's switchTo / startReply). */
  private focusField(): void {
    this.bus.focus_rev = (Number(this.bus.focus_rev) || 0) + 1;
  }

  private msgJs(r: MsgRow): Record<string, unknown> {
    const images = r.images.map((t) => {
      const known = this.localPath(t.url);
      const px = known ? this.pics.get(known, 640) : null;
      return { image: px ?? NO_PX, x: t.x, y: t.y, w: t.w, h: t.h };
    });
    return {
      kind: r.kind,
      id: r.id,
      mine: r.mine,
      text: r.text,
      time: r.time,
      meta: r.meta,
      reply: r.reply,
      has_reply: r.reply !== "",
      images,
      has_image: images.length > 0,
      img_w: r.imgW,
      img_h: r.imgH,
      files: r.files,
      first: r.first,
      failed: r.failed,
      sending: r.sending,
      streaming: r.streaming,
      to_ai: r.toAi,
      parts: this.partsOf(r),
      folded: r.folded,
      preview: r.preview,
      draft: r.draft,
      card_title: r.card.title,
      card_sub: r.card.sub,
      card_state: r.card.state,
      card_note: r.card.note,
      card_why: r.card.why,
      card_chat: r.card.chat,
      chan: r.chan,
      chan_label: r.chanLabel,
      has_audio: !!r.audio,
      a_key: r.audio?.key ?? "",
      a_dur: r.audio?.duration ?? 0,
      a_bars: r.audio?.bars ?? [],
      a_played: r.audio ? r.audio.played || (this.audioSt?.key === r.audio.key && this.audioSt.playing) : true,
      a_voice: !!r.audio?.voice,
      a_transcript: r.audio?.transcript ?? "",
      a_transcribing: !!r.audio && (r.audio.transcribing || this.transcribing.has(r.audio.key)),
      a_hidden: !!r.audio && !this.shownTranscripts.has(r.audio.key),
    };
  }

  /** A file route's local path when it's here; else fetched once in the background (then drawn again). */
  private localPath(url: string): string | null {
    const known = this.attachPaths.get(url);
    if (known !== undefined) return known;
    this.attachPaths.set(url, null);
    void this.fetchPath(url).then((p) => {
      this.attachPaths.set(url, p);
      if (p) this.render();
    });
    return null;
  }

  /** A file route's local path (the engine downloads it once). */
  private async fetchPath(url: string): Promise<string | null> {
    const u = new URL(url, "http://hub");
    const q: Record<string, string> = {};
    for (const [k, v] of u.searchParams) q[k] = v;
    q.path = "1";
    const r = await this.ctx.call("GET", u.pathname.replace(/^\//, ""), q).catch(() => null);
    const p = r && r.status === 200 ? (r.body as { path?: string }).path : undefined;
    return p ?? null;
  }

  private drawPanel(): void {
    const b = this.bus;
    const d = this.panelData;
    if (!d || !this.panelOpen) return;
    const px = this.pics.get(d.avatarPath, 256);
    b.p_name = d.name;
    b.p_initials = d.initials;
    b.p_color = d.color;
    b.p_avatar = px ?? NO_PX;
    b.p_has_avatar = !!px;
    const p = d.person;
    b.p_sub = [p.discordUsername ? `@${p.discordUsername}` : "", p.email ?? ""].filter(Boolean).join(" · ");
    b.p_socials = d.socials.map((s) => ({
      platform: s.platform ?? "Link",
      handle: s.handle ?? s.url,
      url: s.url,
      note: s.note ?? "",
      uploads: s.uploads.slice(0, 3).map((u) => {
        const f = u.thumb ? this.attachPaths.get(u.thumb) : null;
        if (u.thumb && f === undefined) {
          this.attachPaths.set(u.thumb, null);
          void this.ctx.call("GET", "v1/persons/img/url", { u: u.thumb, path: "1" }).then((r) => {
            const path = r.status === 200 ? (r.body as { path?: string }).path ?? null : null;
            this.attachPaths.set(u.thumb!, path);
            if (path) this.render();
          }, () => {});
        }
        const tpx = f ? this.pics.get(f, 320) : null;
        return { title: u.title, meta: u.meta ?? "", url: u.url, thumb: tpx ?? NO_PX, has_thumb: !!tpx };
      }),
    }));
    b.p_linked = (d.linked ?? []).map((l) => ({ id: l.id, name: l.name, sub: l.ids.join(" · "), initials: initials(l.name), color: COLORS[hash(l.id) % COLORS.length]!, avatar: NO_PX, has_avatar: false, on: false }));
    const order = this.order();
    const i = order.indexOf(p.id);
    b.p_pos = i >= 0 ? `${i + 1} of ${order.length}` : "";
  }

  // ---------- opening a person ----------

  private order(): string[] {
    const s = this.state;
    if (!s) return [];
    const open = this.ui.open;
    if (open && open.section) return sideRows(s, this.ui).filter((r) => r.kind === "person" && r.section === open.section && !r.dim).map((r) => r.id);
    return listRows(s, this.query, null).map((r) => r.id);
  }

  private step(d: number): void {
    const order = this.order();
    const cur = this.ui.open;
    if (!cur) return;
    const i = order.indexOf(cur.id);
    const next = order[i + d];
    if (next) void this.openPerson(next, cur.section, "");
  }

  private async openPerson(id: string, section: string, store: string): Promise<void> {
    if (this.ui.open?.id === id && this.ui.open.section === section && this.ui.open.store === store) return;
    const was = this.chatKey();
    if (was) this.drafts.set(`${was}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    this.stopAudio();
    this.leaveSr();
    this.ui.open = { id, section, store };
    this.holdUnread = "";
    this.ui.allActive = false;
    this.chat = null;
    this.panelData = null;
    this.replyTo = null;
    this.forwarded = null;
    this.files = [];
    this.aiFiles = [];
    const k = this.chatKey();
    this.aiMode = this.toAi.get(k) ?? false;
    this.bus.draft = this.drafts.get(`${k}:${this.aiMode ? "ai" : "person"}`) ?? "";
    this.bus.subject = "";
    this.render();
    await Promise.all([this.loadChat(true), this.panelOpen ? this.loadPanel() : Promise.resolve()]);
  }

  private account: string | null = null;

  private async loadChat(first: boolean): Promise<void> {
    const open = this.ui.open;
    if (!open) return;
    const seq = ++this.chatSeq;
    if (first) this.account = null;
    const q: Record<string, string> = { section: open.section };
    if (this.account) q.account = this.account;
    const r = await this.ctx.call("GET", `v1/persons/chat/${encodeURIComponent(open.id)}`, q).catch(() => null);
    if (seq !== this.chatSeq || this.ui.open !== open || !r || r.status !== 200) return;
    const c = r.body as ChatJson;
    this.chat = c;
    this.render();
    // seen: the newest message (as opening it in the official client does), unless it was just marked unread
    const unread = this.person(open.id)?.rows[open.section]?.unread ?? 0;
    if (unread > 0 && this.ctx.shown() && this.holdUnread !== this.chatKey()) void this.api("POST", `chat/${encodeURIComponent(open.id)}/read`, { section: open.section, account: c.account?.id });
  }

  /** The panel: at once with the socials as cached, then again once their latest uploads are read. */
  private async loadPanel(): Promise<void> {
    const open = this.ui.open;
    if (!open) return;
    const get = async (socials: string): Promise<boolean> => {
      const r = await this.api("GET", `person/${encodeURIComponent(open.id)}`, undefined, { socials }).catch(() => null);
      if (!r || r.status !== 200 || this.ui.open?.id !== open.id) return false;
      const first = this.panelData?.person.id !== open.id;
      this.panelData = r.body as unknown as PanelJson;
      if (first) this.bus.p_notes = this.panelData.person.notes ?? "";
      this.render();
      return true;
    };
    if (!(await get("cached"))) return;
    if (!this.panelData?.person.socials?.length) return;
    this.bus.p_socials_loading = true;
    await get("fresh");
    this.bus.p_socials_loading = false;
  }

  private async older(): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    const first = c?.messages[0];
    if (!open || !c || !first || !c.more) return;
    this.bus.c_loading = true;
    const r = await this.ctx.call("GET", `v1/persons/chat/${encodeURIComponent(open.id)}`, { section: open.section, before: first.id, ...(c.account ? { account: c.account.id } : {}) }).catch(() => null);
    this.bus.c_loading = false;
    if (!r || r.status !== 200 || this.chat !== c) return;
    const page = r.body as { messages: ChatJson["messages"]; more: boolean };
    c.messages = [...page.messages, ...c.messages.filter((m) => !page.messages.some((x) => x.id === m.id))];
    c.more = page.more && page.messages.length > 0;
    this.render();
  }

  // ---------- sending ----------

  private async send(): Promise<void> {
    const open = this.ui.open;
    const text = String(this.bus.draft ?? "").replace(/\s+$/, "");
    if (!open) return;
    if (this.aiMode) {
      // to the AI: the question, the forwarded message (empty question: the default one) and the files' paths
      const fwd = this.forwarded;
      const paths = this.aiFiles;
      if (!text.trim() && !fwd && !paths.length) return;
      this.bus.draft = "";
      this.forwarded = null;
      this.aiFiles = [];
      this.render();
      const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/ai`, { section: open.section || this.chat?.account?.section || "stores", text, account: this.chat?.account?.id, ...(fwd ? { forward: fwd.id } : {}), ...(paths.length ? { paths } : {}) });
      if (r.status !== 200) {
        this.bus.draft = text;
        this.forwarded = fwd;
        this.aiFiles = paths;
        this.setToast(`AI: ${String(r.body.error ?? "the Person AI didn't answer")}`);
      }
      void this.loadChat(false);
      return;
    }
    if (!text.trim() && !this.files.length) return;
    if (this.bus.c_can_send === false) return;
    const subject = String(this.bus.subject ?? "").trim();
    if (this.bus.c_need_subject && !subject) {
      this.setToast("Add a subject for the first email");
      return;
    }
    this.bus.draft = "";
    const body: Record<string, unknown> = { section: open.section, account: this.chat?.account?.id, text };
    if (this.replyTo) body.replyTo = this.replyTo.id;
    if (this.files.length) {
      const out: { name: string; type: string; data: string }[] = [];
      for (const f of this.files) {
        try {
          out.push({ name: basename(f), type: mimeOf(f), data: readFileSync(f).toString("base64") });
        } catch {
          this.setToast(`Can't read ${basename(f)}`);
          return;
        }
      }
      body.files = out;
      this.files = [];
    }
    if (subject && this.bus.c_need_subject) body.subject = subject;
    this.replyTo = null;
    this.bus.subject = "";
    this.render();
    const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/send`, body);
    if (r.status !== 200 || r.body.ok === false) this.setToast(String(r.body.error ?? "Not sent"));
    void this.loadChat(false);
  }

  private async attach(): Promise<void> {
    const got = await picker.pick({ title: "Attach files", multiple: true }).catch(() => [] as string[]);
    const ok: string[] = [];
    for (const f of got) {
      try {
        if (statSync(f).size > 25 << 20) this.setToast(`${basename(f)} is over 25 MB`);
        else ok.push(f);
      } catch {
        // gone
      }
    }
    if (this.aiMode) this.aiFiles = [...this.aiFiles, ...ok].slice(0, 10);
    else this.files = [...this.files, ...ok].slice(0, 10);
    this.render();
  }

  private typing(): void {
    if (this.sr) return;
    const open = this.ui.open;
    if (!open || this.aiMode || Date.now() - this.typingAt < 8000) return;
    this.typingAt = Date.now();
    void this.api("POST", `chat/${encodeURIComponent(open.id)}/typing`, { section: open.section, account: this.chat?.account?.id, on: true });
  }

  /** A file below the bubble (or the menu's Open attachment): its first file that isn't a picture, opened by the
   * system; a message with only pictures shows them in the lightbox. */
  private async openFile(id: string): Promise<void> {
    const m = this.chat?.messages.find((x) => x.id === id);
    const f = m?.files.find((x) => !x.image);
    if (!f) {
      if (m?.files.some((x) => x.image)) await this.openImage(id, 0);
      return;
    }
    const path = await this.fetchPath(f.url);
    if (path) this.ctx.openExternal(path);
    else this.setToast("Couldn't download that file");
  }

  /** A picture in a bubble was clicked: Hub's lightbox, browsing every picture of that message. */
  private async openImage(id: string, i: number): Promise<void> {
    const m = this.chat?.messages.find((x) => x.id === id);
    const imgs = m?.files.filter((x) => x.image) ?? [];
    if (!imgs.length) return;
    const paths = await Promise.all(
      imgs.map(async (f) => {
        const known = this.attachPaths.get(f.url);
        if (known) return known;
        const p = await this.fetchPath(f.url);
        if (p) this.attachPaths.set(f.url, p);
        return p;
      }),
    );
    const path = paths[Math.min(Math.max(i, 0), paths.length - 1)];
    if (!path) {
      this.setToast("Couldn't download that picture");
      return;
    }
    const group = paths.filter((p): p is string => !!p);
    if (this.ctx.openImage) this.ctx.openImage(path, group);
    else this.ctx.openExternal(path);
  }

  // ---------- voice messages and audio files ----------

  /** The engine's player as last heard (play, pause, its end). */
  private audioSt: AudioStateJson | null = null;
  /** Audio being transcribed (their bubble says so). */
  private transcribing = new Set<string>();

  private applyAudio(st: AudioStateJson | null): void {
    const was = this.audioSt;
    this.audioSt = st;
    const b = this.bus;
    b.a_key = st?.key ?? "";
    b.a_playing = !!st?.playing;
    b.a_pos = st ? st.pos + (st.playing ? Math.max(0, (Date.now() - st.at) / 1000) * st.speed : 0) : 0;
    b.a_dur = st?.duration ?? 0;
    b.a_speed = st?.speed ?? 1;
    if (st?.error && st.error !== was?.error) this.setToast(`Couldn't play it: ${st.error}`);
    // the played dot goes as it starts
    if (st?.playing && st.key !== was?.key) this.render();
  }

  /** The audio of a message in the open chat. */
  private audioOf(id: string): AudioRow | null {
    const c = this.chat;
    const m = c?.messages.find((x) => x.id === id);
    const f = m?.files.find((x) => x.kind === "audio" || (m.voice && !x.image));
    return m && f && c ? audioRow(f, m.voice, c.account?.conn ?? c.account?.id ?? "") : null;
  }

  private async audioCall(act: string, body: Record<string, unknown> = {}): Promise<void> {
    const r = await this.api("POST", `audio/${act}`, body).catch(() => null);
    if (!r) return;
    if (r.status !== 200) {
      this.setToast(String(r.body.error ?? "Audio didn't work"));
      return;
    }
    if (act !== "transcribe" && act !== "played") this.applyAudio(r.body as unknown as AudioStateJson);
  }

  private fileBody(a: AudioRow): Record<string, unknown> {
    return { key: a.key, account: a.account, url: a.raw, name: a.name, ...(a.duration ? { duration: a.duration } : {}) };
  }

  private async audioToggle(id: string): Promise<void> {
    const a = this.audioOf(id);
    if (!a) return;
    const st = this.audioSt;
    if (st?.key === a.key && st.playing) return this.audioCall("pause");
    // the same one paused: on from there; another one: from the start (the engine stops the one playing)
    await this.audioCall("play", { ...this.fileBody(a), ...(st?.key === a.key ? {} : { at: 0 }) });
  }

  private async audioSeek(id: string, frac: number): Promise<void> {
    const a = this.audioOf(id);
    if (!a) return;
    const st = this.audioSt;
    const dur = (st?.key === a.key ? st.duration : null) ?? a.duration;
    if (!dur) return this.audioToggle(id);
    const pos = frac * dur;
    if (st?.key === a.key && st.playing) return this.audioCall("play", { ...this.fileBody(a), at: pos });
    await this.audioCall("seek", { key: a.key, pos, duration: dur });
  }

  private async audioSpeed(): Promise<void> {
    const st = this.audioSt;
    const speed = nextSpeed(st?.speed ?? 1);
    const a = st?.playing && st.key ? this.chat?.messages.map((m) => this.audioOf(m.id)).find((x) => x?.key === st.key) : null;
    this.bus.a_speed = speed;
    await this.audioCall("speed", { speed, ...(a ? this.fileBody(a) : {}) });
  }

  /** Transcripts the user opened (hidden by default), for the session. */
  private shownTranscripts = new Set<string>();

  /** The bubble's button: show / hide its transcript, or make one (none yet, or the background one failed). */
  private async audioTranscribe(id: string): Promise<void> {
    const a = this.audioOf(id);
    if (a?.transcript) {
      if (!this.shownTranscripts.delete(a.key)) this.shownTranscripts.add(a.key);
      this.render();
      return;
    }
    if (!a || this.transcribing.has(a.key)) return;
    this.transcribing.add(a.key);
    this.render();
    try {
      const r = await this.api("POST", "audio/transcribe", this.fileBody(a)).catch(() => null);
      if (!r || r.status !== 200) this.setToast(String(r?.body.error ?? "Couldn't transcribe it"));
      else if (!String(r.body.text ?? "").trim()) this.setToast("No speech in it");
      else this.shownTranscripts.add(a.key);
    } finally {
      this.transcribing.delete(a.key);
    }
    await this.loadChat(false);
  }

  /** Stops what plays (another chat, the chat closed). */
  private stopAudio(): void {
    if (this.audioSt?.key) void this.audioCall("stop");
  }

  // ---------- Link with… / Unlink ----------

  private linkFor: string | null = null;
  private picks = new Set<string>();
  private pickQ = "";

  /** Link with…: pick the others who are the same human; they become one person (Unlink splits them back). */
  private linkDialog(id: string): void {
    const p = this.person(id);
    if (!p) return;
    this.linkFor = id;
    this.picks.clear();
    this.pickQ = "";
    this.bus.f_query = "";
    this.renderPicks();
    this.openDialog("link", `Link ${p.name} with…`, "Pick the people who are the same person on another channel. They become one: every channel's messages in one chat, their notes, stores and lists together. Unlink splits them back out.", "Link", async () => {
      const ids = [...this.picks];
      if (!ids.length) throw new Error("Pick at least one person");
      const names = ids.map((x) => this.person(x)?.name ?? "them");
      const r = await this.api("POST", `person/${encodeURIComponent(id)}/link`, { ids });
      if (r.status !== 200 || r.body.ok === false) throw new Error(String(r.body.error ?? "Not linked"));
      const linked = (r.body.linked as string[] | undefined) ?? ids;
      this.setToast(`Linked ${names.join(", ")} into ${p.name}`, "Undo", () => void (async () => {
        for (const x of linked) await this.api("POST", `person/${encodeURIComponent(id)}/unlink`, { id: x });
        await this.refresh();
        if (this.ui.open?.id === id) void Promise.all([this.loadChat(false), this.loadPanel()]);
      })());
      await this.refresh();
      if (this.ui.open && linked.includes(this.ui.open.id)) void this.openPerson(id, this.ui.open.section, "");
      else if (this.ui.open?.id === id) void Promise.all([this.loadChat(false), this.loadPanel()]);
    });
  }

  /** The picker's people: everyone else matching the search, picked ones first, then the same first name, then recent. */
  private renderPicks(): void {
    const s = this.state;
    const me = this.linkFor ? this.person(this.linkFor) : undefined;
    if (!s || !me) return;
    const first = (n: string): string => n.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)[0] ?? "";
    const mine = first(me.name);
    const rank = (p: PersonJson): number => (this.picks.has(p.id) ? 0 : mine && first(p.name) === mine ? 1 : 2);
    const people = s.people
      .filter((p) => p.id !== me.id && (this.picks.has(p.id) || matches(p, this.pickQ)))
      .sort((a, b) => rank(a) - rank(b) || byRecent(a, b))
      .slice(0, 200);
    this.bus.f_picks = people.map((p) => {
      const px = this.pics.get(p.avatarPath, 96);
      const r = p.rows[""];
      const sub = [r?.channel ? KIND_LABEL[r.channel] ?? r.channel : "", r?.lastAt ? shortAgoText(r.lastAt) : "", p.linked?.length ? `+${p.linked.length} linked` : ""].filter(Boolean).join(" · ");
      return { id: p.id, name: p.name, sub, initials: p.initials, color: p.color, avatar: px ?? NO_PX, has_avatar: !!px, on: this.picks.has(p.id) };
    });
    const names = [...this.picks].map((x) => this.person(x)?.name ?? "?");
    this.bus.f_picked = names.length ? `${names.length} picked: ${names.join(", ")}` : "Nobody picked yet.";
  }

  private unlinkDialog(id: string, linkedId: string): void {
    const p = this.person(id);
    const l = p?.linked?.find((x) => x.id === linkedId) ?? this.panelData?.linked?.find((x) => x.id === linkedId);
    if (!p || !l) return;
    this.confirm(`Unlink ${l.name}?`, `${l.name} goes back to being their own person, with their channels, notes, stores and lists as they were when linked. ${p.name} keeps the rest.`, "Unlink", async () => {
      const r = await this.api("POST", `person/${encodeURIComponent(id)}/unlink`, { id: linkedId });
      if (r.status !== 200) throw new Error(String(r.body.error ?? "Not unlinked"));
      await this.refresh();
      this.setToast(`${l.name} is on their own again`);
      if (this.ui.open?.id === id) void Promise.all([this.loadChat(false), this.loadPanel()]);
    });
  }

  /** The panel's ⋯: Link with…, Unlink, a linked person's own AI chats. */
  private panelMenu(id: string, x: number, y: number): void {
    const d = this.panelData;
    const linked = d?.person.id === id ? d.linked ?? [] : [];
    this.showMenu(x, y, [
      { label: "Link with…", run: () => this.linkDialog(id) },
      ...linked.map((l) => ({ label: `Unlink ${l.name}…`, run: () => this.unlinkDialog(id, l.id) })),
      ...linked.flatMap((l) => l.aiChats.map((c) => ({ label: `${l.name}'s AI chat`, sub: SECTION_LABEL[c.section] ?? c.section, run: () => this.ctx.openChat?.(c.chat) }))),
    ]);
  }

  // ---------- menus ----------

  private showMenu(x: number, y: number, items: MenuIn[], width = 264): void {
    this.menuActions.clear();
    this.subMenus.clear();
    this.bus.sub_open = false;
    let n = 0;
    const entry = (it: MenuIn): Record<string, unknown> => {
      const id = it.id ?? `m${n++}`;
      if (it.run) this.menuActions.set(id, it.run);
      if (it.children) this.subMenus.set(id, it.children.map(entry));
      return { id, label: it.label, icon: it.icon ?? "", sub: it.sub ?? "", hint: it.hint ?? "", danger: !!it.danger, sep: !!it.sep, header: !!it.header, disabled: !!it.disabled, checked: !!it.checked, submenu: !!it.children };
    };
    this.bus.menu = items.map(entry);
    this.bus.menu_w = width;
    this.bus.menu_x = x;
    this.bus.menu_y = y;
    this.bus.menu_open = true;
  }

  /** The pointer on a menu entry: its submenu opens beside it (another one closes). */
  private menuHover(id: string, y: number): void {
    const kids = this.subMenus.get(id);
    if (!kids) {
      if (this.bus.sub_open) this.bus.sub_open = false;
      return;
    }
    if (this.bus.sub_open && this.bus.sub_of === id) return;
    this.bus.sub_menu = kids;
    this.bus.sub_of = id;
    this.bus.sub_y = y;
    this.bus.sub_open = true;
  }

  private pick(id: string): void {
    this.bus.menu_open = false;
    this.bus.sub_open = false;
    if (id === "panel:edit" && this.ui.open) return this.personDialog(this.ui.open.id);
    if (id === "panel:rename" && this.ui.open) return this.renameDialog(this.ui.open.id);
    if (id === "panel:delete" && this.ui.open) return void this.deletePerson(this.ui.open.id);
    if (id === "panel:add-social" && this.ui.open) return this.socialDialog(this.ui.open.id);
    if (id.startsWith("panel:remove-social:") && this.ui.open) return void this.setSocials(this.ui.open.id, (l) => l.filter((u) => u !== id.slice(20)));
    this.menuActions.get(id)?.();
  }

  private sectionMenu(sec: string, x: number, y: number): void {
    const s = this.state;
    if (!s) return;
    const mine = s.connections.filter((c) => c.section === sec);
    const status = (c: (typeof mine)[number]): string => (c.status === "connected" ? (c.gateway === "up" || c.kind !== "discord" ? "Connected" : "Reconnecting…") : c.status === "connecting" || c.status === "starting" ? "Connecting…" : c.status === "signing-in" ? "Signing in…" : "Signed out");
    this.showMenu(x, y, [
      sec === "stores" ? { label: "New store", icon: "", run: () => this.storeDialog(null) } : { label: `Add to ${SECTION_LABEL[sec]}`, run: () => this.personDialog(null, sec) },
      ...(sec === "stores" ? [{ label: "Add person", run: () => this.personDialog(null, sec) }] : []),
      { sep: true, label: "" },
      { header: true, label: "CONNECTIONS" },
      ...(mine.length ? [] : [{ label: "None yet.", disabled: true }]),
      ...mine.map((c) => ({
        label: c.who || KIND_LABEL[c.kind] || c.kind,
        icon: c.kind,
        sub: `${KIND_LABEL[c.kind]} · ${status(c)}${c.error ? ` · ${c.error}` : ""}`,
        run: () => (c.status === "connected" ? this.confirm(`Disconnect ${KIND_LABEL[c.kind]}${c.who ? ` (${c.who})` : ""}?`, "It leaves this section and signs out. Connect it again to use it.", "Disconnect", async () => void (await this.api("DELETE", `connections/${encodeURIComponent(c.id)}`))) : void this.api("POST", `connections/${encodeURIComponent(c.id)}/connect`)),
      })),
      { sep: true, label: "" },
      ...["discord", "gmail", "whatsapp"].map((k) => ({ label: `Connect ${KIND_LABEL[k]}`, icon: k, run: () => void this.api("POST", "connections", { section: sec, kind: k }) })),
    ]);
  }

  private rowMenu(id: string, sec: string, store: string, x: number, y: number): void {
    const p = this.person(id);
    if (!p) return;
    const settled = !!(sec && p.settled[sec]);
    this.showMenu(x, y, [
      { label: "Open", run: () => void this.openPerson(id, sec, store) },
      { label: "Rename", icon: "", run: () => this.renameDialog(id) },
      { label: "Edit…", run: () => this.personDialog(id) },
      { label: "Link with…", run: () => this.linkDialog(id) },
      ...(p.linked ?? []).map((l) => ({ label: `Unlink ${l.name}…`, run: () => this.unlinkDialog(id, l.id) })),
      // in a section: Settle / Unsettle there; in All people: one for each section they're in (the panel has none)
      ...(sec
        ? [{ label: settled ? "Unsettle" : "Settle", run: () => void this.api("PATCH", `person/${encodeURIComponent(id)}`, { settle: { section: sec, on: !settled } }) }]
        : personSections(p).map((x) => {
            const on = !!p.settled[x];
            return { label: `${on ? "Unsettle" : "Settle"} in ${SECTION_LABEL[x] ?? x}`, run: () => void this.api("PATCH", `person/${encodeURIComponent(id)}`, { settle: { section: x, on: !on } }) };
          })),
      ...(store ? [{ label: `Remove from ${this.state?.stores.find((s) => s.id === store)?.name ?? "the store"}`, run: () => void this.removeFromStore(id, store) }] : []),
      ...(store ? [{ label: "Make store owner", run: () => void this.api("PATCH", `stores/${encodeURIComponent(store)}`, { ownerId: id }) }] : []),
      { sep: true, label: "" },
      { header: true, label: "MOVE TO" },
      ...this.moveItems(id, placeOfRow(sec, store)),
      { sep: true, label: "" },
      { label: "Delete", danger: true, run: () => void this.deletePerson(id) },
    ]);
  }

  /** Where a person is: their stores (and the ones they own), Creators, SpokPay (as menus.ts moveEntries' words). */
  private placesOf(id: string): string[] {
    const p = this.person(id);
    if (!p) return [];
    const owned = (this.state?.stores ?? []).filter((s) => s.ownerId === id).map((s) => s.id);
    return [...new Set([...p.storeIds, ...owned])].map((s) => `store:${s}`).concat(p.listIds.filter((l) => l === "creators" || l === "spokpay"));
  }

  /** Move to…'s entries (menus.ts), with their actions. */
  private moveItems(id: string, from: string): MenuIn[] {
    const item = (e: MoveEntry): MenuIn =>
      e.sep ? { sep: true, label: "" } : {
        label: e.label,
        ...(e.here ? { checked: true, disabled: true } : {}),
        ...(e.sub ? { children: e.sub.map(item) } : e.to === "new-store" ? { run: () => this.storeDialog(null, (sid) => void this.movePerson(id, from, `store:${sid}`)) } : { run: () => void this.movePerson(id, from, e.to) }),
      };
    return moveEntries({ places: this.placesOf(id), from, stores: this.state?.stores ?? [] }).map(item);
  }

  /** Move to…: they leave `from` ("" = everywhere) for `to`; their chats, notes, picture and AI come along. */
  private async movePerson(id: string, from: string, to: string): Promise<void> {
    const p = this.person(id);
    if (!p) return;
    const r = await this.api("POST", `person/${encodeURIComponent(id)}/move`, { to, ...(from ? { from } : {}) });
    if (r.status !== 200) return this.setToast(String(r.body.error ?? "Not moved"));
    await this.refresh();
    const where = to.startsWith("store:") ? this.state?.stores.find((s) => `store:${s.id}` === to)?.name ?? "the store" : SECTION_LABEL[to] ?? to;
    this.setToast(`Moved ${p.name} to ${where}`);
    // their open chat follows them to the new place
    if (this.ui.open?.id === id) void this.openPerson(id, to.startsWith("store:") ? "stores" : to, to.startsWith("store:") ? to.slice(6) : "");
  }

  // ---------- SpokPay › Site requests (Headquarters' Home list) ----------

  // ---------- a site request's pane (SpokPay's admin request page, in Hub) ----------

  /** The open request: its ref, the pane as last read, and whether a read is under way or failed. */
  private sr: { ref: string; pane: SrPaneJson | null; loading: boolean; error: string; sending: boolean; moving: boolean } | null = null;
  /** Pictures going with the next reply (paths on this PC); the drafts are the composer's (`sr:<ref>:person|ai`). */
  private srFiles: string[] = [];
  private srTimer: ReturnType<typeof setInterval> | null = null;
  private srSeq = 0;

  /** A request's row: its pane opens in the main area (read now, and every 30 s while it shows). */
  private openSiteRequest(ref: string): void {
    if (this.sr?.ref === ref && this.ui.srOpen === ref) return;
    const was = this.chatKey();
    if (was) this.drafts.set(`${was}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    this.stopAudio();
    this.leaveSr();
    this.ui.open = null;
    this.chat = null;
    this.ui.allActive = false;
    this.ui.srOpen = ref;
    this.sr = { ref, pane: null, loading: true, error: "", sending: false, moving: false };
    this.replyTo = null;
    this.forwarded = null;
    this.files = [];
    this.aiFiles = [];
    const k = this.composerKey();
    this.aiMode = this.toAi.get(k) ?? false;
    this.bus.draft = this.drafts.get(`${k}:${this.aiMode ? "ai" : "person"}`) ?? "";
    this.bus.subject = "";
    this.bus.sr_rev = (Number(this.bus.sr_rev) || 0) + 1;
    this.focusField();
    this.srTimer = setInterval(() => void this.loadSr(), 30_000);
    void this.loadSr();
    this.render();
  }

  /** The pane closes (another row, All people, Esc): its reply stays for next time. */
  private leaveSr(): void {
    if (this.sr) this.drafts.set(`${this.composerKey()}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    if (this.srTimer) clearInterval(this.srTimer);
    this.srTimer = null;
    this.sr = null;
    this.srFiles = [];
    this.aiFiles = [];
    this.forwarded = null;
    this.ui.srOpen = null;
  }

  /** Reads the request now (the engine marks what the store wrote seen). */
  private async loadSr(): Promise<void> {
    const sr = this.sr;
    if (!sr) return;
    const seq = ++this.srSeq;
    sr.loading = true;
    const r = await this.api("GET", `site-request/${encodeURIComponent(sr.ref)}`).catch((e: unknown) => ({ status: 0, body: { error: e instanceof Error ? e.message : String(e) } as Record<string, unknown> }));
    if (this.sr !== sr || seq !== this.srSeq) return;
    sr.loading = false;
    if (r.status === 200 && r.body.pane) {
      sr.pane = r.body.pane as SrPaneJson;
      sr.error = "";
    } else sr.error = String(r.body.error ?? `SpokPay answered ${r.status}`);
    this.render();
  }

  private drawSr(): void {
    const b = this.bus;
    const sr = this.sr!;
    const p = sr.pane;
    const row = this.state?.siteRequests?.rows.find((r) => r.ref === sr.ref);
    b.sr_ref = sr.ref;
    b.sr_loading = sr.loading;
    b.sr_error = p ? "" : sr.error;
    b.sr_moving = sr.moving;
    const icon = this.pics.get(p?.iconPath ?? row?.iconPath, 96);
    b.sr_icon = icon ?? NO_PX;
    b.sr_has_icon = !!icon;
    b.sr_initials = p?.initials ?? row?.initials ?? "";
    // the composer (the person chats' own): "To <avatar> <owner>", "Message <owner> on SpokPay", To: AI | <owner>
    const who = p?.person ?? null;
    const name = who?.name ?? p?.owner ?? row?.store ?? sr.ref;
    const face = who?.avatarPath ? this.pics.get(who.avatarPath, 96) : icon;
    b.c_name = name;
    b.c_initials = who?.initials ?? p?.initials ?? row?.initials ?? "";
    b.c_color = who?.color ?? SR_OWNER_COLOR;
    b.c_avatar = face ?? NO_PX;
    b.c_has_avatar = !!face;
    b.c_ai_on = true;
    b.c_can_send = !!p && !p.writeBlocked;
    b.c_blocked = p ? p.writeBlocked ?? "" : "Reading the request…";
    b.c_need_subject = false;
    b.c_hint = this.aiMode ? (this.forwarded ? composerHint({ toAi: true, forwarded: true, name, kind: "spokpay", me: "" }) : `Tell the AI what to do about ${sr.ref}`) : composerHint({ toAi: false, forwarded: false, name, kind: "spokpay", me: "" });
    b.has_ai_chat = !!p?.aiChat;
    b.reply_name = "";
    b.reply_text = "";
    b.fwd_name = this.aiMode && this.forwarded ? this.forwarded.name : "";
    b.fwd_text = this.aiMode && this.forwarded ? this.forwarded.text : "";
    b.attached = this.aiMode ? this.aiFiles.map((f) => basename(f)).join(", ") : this.srFiles.length ? `${this.srFiles.length === 1 ? "1 picture" : `${this.srFiles.length} pictures`}: ${this.srFiles.map((f) => basename(f)).join(", ")}` : "";
    b.ai_mode = this.aiMode;
    if (!p) {
      b.sr_subject = row?.subject || sr.ref;
      b.sr_store = row?.store ?? "";
      b.sr_status = "";
      b.sr_brief_sub = "";
      b.sr_items = [];
      b.sr_facts = [];
      b.sr_brief_imgs = [];
      b.sr_brief_files = [];
      return;
    }
    b.sr_subject = p.subject;
    b.sr_note = p.note ?? "";
    b.sr_status = p.statusLabel;
    b.sr_tone = p.tone;
    b.sr_store = p.store;
    b.sr_brief_title = p.brief.title;
    b.sr_brief_sub = p.brief.sub;
    b.sr_summary = p.brief.summary;
    b.sr_facts = p.factRows.map(([a, c]) => ({ a_label: a.label, a_text: a.text, b_label: c?.label ?? "", b_text: c?.text ?? "", two: !!c }));
    b.sr_brief_imgs = this.srImgs(p.brief.files);
    b.sr_brief_files = p.brief.files.filter((f) => !f.image).map((f) => f.name);
    b.sr_items = p.items.map((it) =>
      it.kind === "event"
        ? { kind: "event", id: it.id, mine: false, head: "", text: it.text, avatar: false, joins_prev: false, joins_next: false, images: [], files: [] }
        : { kind: "msg", id: it.id, mine: it.mine, head: it.joinsPrev ? "" : it.head, text: it.text, avatar: !it.joinsNext, joins_prev: it.joinsPrev, joins_next: it.joinsNext, images: this.srImgs(it.files), files: it.files.filter((f) => !f.image).map((f) => f.name) },
    );
    b.sr_more = p.hasMore;
    b.sr_finished = p.finished;
    b.sr_finished_note = p.finishedNote;
    b.sr_can_move = p.statuses.length > 1;
  }

  /** A list's pictures as drawn (each decoded once from the engine's copy; a placeholder until then). */
  private srImgs(files: SrFileJson[]): Record<string, unknown>[] {
    return files
      .filter((f) => f.image && f.src)
      .map((f) => {
        const path = this.localPath(f.src!);
        const px = path ? this.pics.get(path, 480) : null;
        const size = srImageSize(px?.width ?? 0, px?.height ?? 0);
        return { image: px ?? NO_PX, w: size.w, h: size.h };
      });
  }

  private srFilesOf(owner: string): SrFileJson[] {
    const p = this.sr?.pane;
    if (!p) return [];
    if (owner === "brief") return p.brief.files;
    const it = p.items.find((x) => x.id === owner);
    return it?.kind === "msg" ? it.files : [];
  }

  /** A picture of the brief or of a message: Hub's lightbox, browsing that one's pictures. */
  private async srOpenImage(owner: string, i: number): Promise<void> {
    const imgs = this.srFilesOf(owner).filter((f) => f.image && f.src);
    const paths = await Promise.all(imgs.map(async (f) => this.attachPaths.get(f.src!) || (await this.fetchPath(f.src!))));
    const path = paths[Math.min(Math.max(i, 0), paths.length - 1)];
    if (!path) {
      const url = imgs[i]?.url;
      if (url) this.ctx.openExternal(url);
      else this.setToast("Couldn't download that picture");
      return;
    }
    const group = paths.filter((x): x is string => !!x);
    if (this.ctx.openImage) this.ctx.openImage(path, group);
    else this.ctx.openExternal(path);
  }

  /** The status select: the current status, then SpokPay's moves from it; a final one (Complete, Close) asks first. */
  private srStatusMenu(x: number, y: number): void {
    const p = this.sr?.pane;
    if (!p || p.statuses.length < 2) return;
    const items: MenuIn[] = [{ label: "Status", header: true }];
    if (p.statusBlocked) items.push({ label: p.statusBlocked, disabled: true });
    for (const st of p.statuses)
      items.push({
        label: st.label,
        checked: st.current,
        disabled: st.current || !!p.statusBlocked,
        run: () => {
          if (st.status === "completed" || st.status === "closed") {
            const words = p.confirms[st.status];
            this.openDialog("confirm", words.title, words.text, words.ok, () => this.srMove(st.status, st.label));
          } else void this.srMove(st.status, st.label);
        },
      });
    this.showMenu(x, y, items, 232);
  }

  private async srMove(to: string, label: string): Promise<void> {
    const sr = this.sr;
    if (!sr) return;
    sr.moving = true;
    this.render();
    const r = await this.api("POST", `site-request/${encodeURIComponent(sr.ref)}/status`, { to }).catch((e: unknown) => ({ status: 0, body: { error: e instanceof Error ? e.message : String(e) } as Record<string, unknown> }));
    sr.moving = false;
    if (r.status === 200 && r.body.pane) {
      if (this.sr === sr) sr.pane = r.body.pane as SrPaneJson;
      this.setToast(`Now ${label.toLowerCase()}`);
    } else this.setToast(`Status not changed: ${String(r.body.error ?? "SpokPay didn't answer")}`);
    this.render();
  }

  /**
   * Send: to the store as SpokPay (the reply and its pictures), or, with "To: AI", a note to the Person AI about the
   * request (its context goes along, hidden); on a refusal the words and files come back to the composer.
   */
  private async srSend(): Promise<void> {
    const sr = this.sr;
    if (!sr) return;
    const text = String(this.bus.draft ?? "").replace(/\s+$/, "");
    const key = `${this.composerKey()}:${this.aiMode ? "ai" : "person"}`;
    const fail = (e: unknown): { status: number; body: Record<string, unknown> } => ({ status: 0, body: { error: e instanceof Error ? e.message : String(e) } });
    if (this.aiMode) {
      const paths = this.aiFiles;
      const fwd = this.forwarded;
      if (!text.trim() && !paths.length && !fwd) return;
      this.bus.draft = "";
      this.aiFiles = [];
      this.forwarded = null;
      this.render();
      const r = await this.api("POST", `site-request/${encodeURIComponent(sr.ref)}/ai`, { text, ...(paths.length ? { paths } : {}), ...(fwd ? { forward: fwd.id } : {}) }).catch(fail);
      if (r.status === 200 && r.body.chat != null) {
        const chat = String(r.body.chat);
        if (sr.pane) sr.pane.aiChat = chat;
        this.drafts.delete(key);
        this.setToast("Sent to the AI", "Open", () => this.ctx.openChat?.(chat));
      } else {
        if (this.sr === sr && this.aiMode) {
          if (!String(this.bus.draft ?? "")) this.bus.draft = text;
          if (!this.aiFiles.length) this.aiFiles = paths;
          if (!this.forwarded) this.forwarded = fwd;
        } else this.drafts.set(key, text);
        this.setToast(`AI: ${String(r.body.error ?? "the Person AI didn't answer")}`);
      }
      this.render();
      return;
    }
    const files = this.srFiles;
    if (sr.sending || !sr.pane || sr.pane.writeBlocked || (!text.trim() && !files.length)) return;
    const images: { name: string; type: string; data: string }[] = [];
    for (const f of files) {
      try {
        images.push({ name: basename(f), type: mimeOf(f), data: readFileSync(f).toString("base64") });
      } catch {
        this.setToast(`Can't read ${basename(f)}`);
        return;
      }
    }
    sr.sending = true;
    this.bus.draft = "";
    this.srFiles = [];
    this.render();
    const r = await this.api("POST", `site-request/${encodeURIComponent(sr.ref)}/reply`, { text: text.trim(), images, key: crypto.randomUUID() }).catch(fail);
    sr.sending = false;
    if (r.status === 200 && r.body.pane) {
      if (this.sr === sr) {
        sr.pane = r.body.pane as SrPaneJson;
        this.bus.sr_rev = (Number(this.bus.sr_rev) || 0) + 1;
      }
      this.drafts.delete(key);
    } else {
      if (this.sr === sr && !this.aiMode) {
        if (!String(this.bus.draft ?? "")) this.bus.draft = text;
        if (!this.srFiles.length) this.srFiles = files;
      } else this.drafts.set(key, text);
      this.setToast(`Not sent: ${String(r.body.error ?? "SpokPay didn't answer")}`);
    }
    this.render();
  }

  /** Pictures for the reply (SpokPay takes up to 5 images of 10 MB each). */
  private async srAttach(): Promise<void> {
    const got = await picker.pick({ title: "Add pictures", multiple: true, filter: ["Images", ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"]] }).catch(() => [] as string[]);
    const ok: string[] = [];
    for (const f of got) {
      try {
        if (!mimeOf(f).startsWith("image/")) this.setToast(`${basename(f)} is not a picture`);
        else if (statSync(f).size > 10 << 20) this.setToast(`${basename(f)} is over 10 MB`);
        else ok.push(f);
      } catch {
        // gone
      }
    }
    const all = [...this.srFiles, ...ok];
    if (all.length > 5) this.setToast("SpokPay takes up to 5 pictures a message");
    this.srFiles = all.slice(0, 5);
    this.focusField();
    this.render();
  }

  /** Right-click › Copy link (the request's admin page). */
  private siteRequestMenu(ref: string, x: number, y: number): void {
    const r = this.state?.siteRequests?.rows.find((x) => x.ref === ref);
    if (!r) return;
    this.showMenu(x, y, [{ label: "Copy link", icon: GLYPHS.LINK, run: () => void clipboard.copyText(r.url).then(() => this.setToast(`Link to ${ref} copied`), () => this.setToast("The link could not be copied.")) }], 200);
  }

  private storeMenu(id: string, x: number, y: number): void {
    const st = this.state?.stores.find((s) => s.id === id);
    if (!st) return;
    this.showMenu(x, y, [
      { label: `Add to ${st.name}`, run: () => this.personDialog(null, "stores", id) },
      { label: "Edit store…", run: () => this.storeDialog(id) },
      { sep: true, label: "" },
      { label: "Delete store", danger: true, run: () => this.confirm(`Delete ${st.name}?`, "Its people stay (they just leave the store).", "Delete", async () => void (await this.api("DELETE", `stores/${encodeURIComponent(id)}`))) },
    ]);
  }

  private accountMenu(x: number, y: number): void {
    const c = this.chat;
    if (!c) return;
    // every chat shows in the one timeline; this picks where the next message goes
    this.showMenu(x, y, [
      { header: true, label: "SEND ON" },
      ...c.accounts.map((a) => ({ label: a.to && a.to.includes(" · ") ? `${a.label} → ${a.to.split(" · ").slice(1).join(" · ")}` : a.label, icon: a.kind, sub: a.id === c.account?.id ? "In use" : a.connected === false ? "Not connected" : "", run: () => {
        this.account = a.id;
        void this.loadChat(false);
      } })),
    ]);
  }

  /** A shared menu's entries (menus.ts) with their actions; compact, as Person Hub's. */
  private showEntries(x: number, y: number, entries: (MenuEntry & { run?: () => void })[]): void {
    const glyph = (n?: GlyphName): string => (n ? GLYPHS[n] : "");
    const hint = entries.some((e) => e.hint);
    this.showMenu(x, y, entries.map((e) => ({ label: e.label, icon: glyph(e.icon), ...(e.hint ? { hint: e.hint } : {}), sep: !!e.sep, danger: !!e.danger, ...(e.run ? { run: e.run } : {}) })), hint ? 236 : 208);
  }

  private copy(text: string): void {
    void clipboard.copyText(text).then(() => this.setToast("Copied"), () => this.setToast("Couldn't copy"));
  }

  private markUnread(id: string): void {
    const open = this.ui.open;
    const c = this.chat;
    const m = c?.messages.find((x) => x.id === id);
    if (!open || !c || !m || m.fromMe) return;
    this.holdUnread = this.chatKey();
    void this.api("POST", `chat/${encodeURIComponent(open.id)}/unread`, { section: open.section, account: c.account?.id, messageId: m.id }).then(() => this.setToast("Marked as unread"));
  }

  private msgMenu(id: string, x: number, y: number): void {
    if (this.sr) return this.srMsgMenu(id, x, y);
    const open = this.ui.open;
    const c = this.chat;
    if (!open || !c) return;
    const canSend = this.bus.c_can_send !== false;
    if (id.startsWith("oo")) {
      const key = id.slice(1);
      const [retry, dismiss] = failedMenu();
      this.showEntries(x, y, [
        { ...retry!, run: () => void this.api("POST", `chat/${encodeURIComponent(open.id)}/retry`, { section: open.section, account: c.account?.id, key }) },
        { ...dismiss!, run: () => void this.api("POST", `chat/${encodeURIComponent(open.id)}/retry`, { section: open.section, account: c.account?.id, key, dismiss: true }) },
      ]);
      return;
    }
    if (id.startsWith("ai")) {
      const a = c.ai.find((x) => `ai${x.id}` === id);
      if (!a) return;
      // the drafts the AI fenced as ```reply (the engine's persons aiparts.ts), else the whole answer
      const drafts = a.role === "user" ? [] : (a.parts ?? []).flatMap((p) => (p.type === "draft" ? [p.text] : []));
      const entries = aiMenu({ drafts, text: a.text, canSend: canSend && a.role !== "user" });
      this.showEntries(x, y, entries.map((e) => ({ ...e, ...(e.use !== undefined ? { run: () => this.useDraft(e.use!) } : e.action === "copy" ? { run: () => this.copy(a.text) } : {}) })));
      return;
    }
    const m = c.messages.find((x) => x.id === id);
    if (!m) return;
    const who = m.fromMe ? "You" : c.person.name;
    const entries = messageMenu({ fromMe: m.fromMe, hasText: !!m.text, hasFiles: m.files.length > 0, canSend, aiOn: c.aiOn !== false, siteRequests: !!c.siteRequests, proposing: (c.proposing ?? []).some((p) => p.messageId === m.id && !p.error) });
    const run: Record<string, () => void> = {
      reply: () => {
        this.setTo(false);
        this.replyTo = { id: m.id, name: who, text: m.text.slice(0, 160) || (m.files.length ? "📎 attachment" : "") };
        this.focusField();
        this.render();
      },
      forward: () => {
        // Person Hub's Forward to AI: the AI composer, with this message quoted, ready for a question
        this.forwarded = { id: m.id, name: who, text: m.text.slice(0, 160) || (m.files[0] ? (m.voice ? "Voice message" : m.files[0].image ? "Photo" : m.files[0].name) : "Message") };
        this.setTo(true);
        this.focusField();
        this.render();
      },
      "site-request": () => void this.siteRequest(m.id),
      copy: () => this.copy(m.text),
      "open-file": () => void this.openFile(m.id),
      unread: () => this.markUnread(m.id),
    };
    this.showEntries(x, y, entries.map((e) => ({ ...e, ...(e.action ? { run: run[e.action] } : {}) })));
  }

  /**
   * A site request message's menu: the person chats' (messageMenu) as far as SpokPay's admin API and Hub can do it:
   * Quote (no reply to a message there), Forward to AI, Copy text, Open attachment.
   */
  private srMsgMenu(id: string, x: number, y: number): void {
    const p = this.sr?.pane;
    const it = p?.items.find((i) => i.id === id);
    if (!p || !it || it.kind !== "msg") return;
    const entries = messageMenu({ fromMe: it.mine, hasText: !!it.text, hasFiles: it.files.length > 0, canSend: !p.finished && !p.writeBlocked, aiOn: !p.finished, siteRequests: false, siteRequest: true });
    const run: Record<string, () => void> = {
      quote: () => {
        this.setTo(false);
        this.bus.draft = quoteInto(String(this.bus.draft ?? ""), it.text);
        this.focusField();
        this.render();
      },
      forward: () => {
        const f = it.files[0];
        this.forwarded = { id: it.id, name: it.author, text: it.text.slice(0, 160) || (f ? (f.image ? "Photo" : f.name) : "Message") };
        this.setTo(true);
        this.focusField();
        this.render();
      },
      copy: () => this.copy(it.text),
      "open-file": () => {
        const f = it.files[0];
        if (!f) return;
        if (f.image && f.src) void this.srOpenImage(it.id, 0);
        else this.ctx.openExternal(f.url);
      },
    };
    this.showEntries(x, y, entries.map((e) => ({ ...e, ...(e.action ? { run: run[e.action] } : {}) })));
  }

  // ---------- SpokPay site requests ----------

  /** Open Site Request: SpokPay's agent drafts it from this message; its card shows in the chat. */
  private async siteRequest(messageId: string): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    if (!open || !c) return;
    const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/site-request`, { section: open.section, account: c.account?.id, messageId });
    if (r.status !== 200) this.setToast(String(r.body.error ?? "Couldn't start the site request"));
    void this.loadChat(false);
  }

  /** A site request card's buttons: a proposal (p<id>) or one being drafted (q<message id>). */
  private async cardAct(rowId: string, act: string): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    if (!open || !c) return;
    if (rowId.startsWith("q")) {
      const mid = rowId.slice(1);
      const p = (c.proposing ?? []).find((x) => x.messageId === mid);
      if (act === "agent" && p?.chat) this.ctx.openChat?.(p.chat);
      else if (act === "local") await this.api("POST", `proposing/${encodeURIComponent(mid)}/local`, { personId: open.id, section: open.section, account: c.account?.id });
      else if (act === "dismiss") await this.api("DELETE", `proposing/${encodeURIComponent(mid)}`);
      void this.loadChat(false);
      return;
    }
    const p = (c.proposals ?? []).find((x) => `p${x.id}` === rowId);
    if (!p) return;
    const path = `proposal/${encodeURIComponent(p.id)}`;
    if (act === "agent" && p.chat) return this.ctx.openChat?.(p.chat);
    if (act === "edit") return this.proposalDialog(p.id);
    if (act === "discard") {
      await this.api("DELETE", path);
      this.setToast("Proposal discarded");
    } else if (act === "open") {
      if (!p.store) return this.proposalDialog(p.id);
      const r = await this.api("POST", `${path}/open`, {});
      if (r.status !== 200) this.setToast(String(r.body.error ?? "Not opened"));
      else if ((r.body.state as { kind?: string; ref?: string } | undefined)?.kind === "opened") this.setToast(`Site request ${(r.body.state as { ref: string }).ref} opened`);
    }
    void this.loadChat(false);
  }

  /** Edit a proposal before Open: the store (its SpokPay slug), the subject and the details the store reads. */
  private proposalDialog(id: string): void {
    const p = (this.chat?.proposals ?? []).find((x) => x.id === id);
    if (!p) return;
    const b = this.bus;
    b.f_store = p.store?.slug ?? "";
    b.f_subject = p.subject;
    b.f_details = p.details;
    this.openDialog("proposal", "Site request", "The store reads the subject and the details (in Portuguese). Open sends it to SpokPay.", "Save", async () => {
      const slug = String(b.f_store ?? "").trim().toLowerCase();
      if (slug && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error("The store is its SpokPay slug: lowercase letters, numbers and dashes");
      const subject = String(b.f_subject ?? "").trim();
      const details = String(b.f_details ?? "").trim();
      if (!subject || !details) throw new Error("A site request needs a subject and details");
      const fields = { category: p.category, subject, details, brief: (p as unknown as { brief?: unknown }).brief ?? {} };
      const r = await this.api("PATCH", `proposal/${encodeURIComponent(id)}`, { fields, store: slug ? { slug, name: slug === p.store?.slug ? p.store.name : slug } : null });
      if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
      void this.loadChat(false);
    });
  }

  // ---------- people ----------

  private async removeFromStore(id: string, store: string): Promise<void> {
    const p = this.person(id);
    if (!p) return;
    await this.api("PATCH", `person/${encodeURIComponent(id)}`, { storeIds: p.storeIds.filter((s) => s !== store) });
    this.setToast(`Removed ${p.name} from ${this.state?.stores.find((s) => s.id === store)?.name ?? "the store"}`, "Undo", () => void this.api("PATCH", `person/${encodeURIComponent(id)}`, { storeIds: p.storeIds }));
  }

  private async deletePerson(id: string): Promise<void> {
    const r = await this.api("DELETE", `person/${encodeURIComponent(id)}`);
    const p = r.body.person as Record<string, unknown> | undefined;
    if (this.ui.open?.id === id) {
      this.ui.open = null;
      this.chat = null;
    }
    this.render();
    if (p) this.setToast(`Deleted ${String(p.name || "them")}`, "Undo", () => void this.api("POST", "people", { ...p, restore: true }));
  }

  private async saveNotes(text: string): Promise<void> {
    const open = this.ui.open;
    if (!open || !this.panelData || (this.panelData.person.notes ?? "") === text) return;
    this.panelData.person.notes = text;
    await this.api("PATCH", `person/${encodeURIComponent(open.id)}`, { notes: text });
  }

  // ---------- dialogs ----------

  private openDialog(kind: string, title: string, text: string, ok: string, run: () => Promise<void> | void, danger = false): void {
    const b = this.bus;
    this.dialogCancel = null;
    b.d_title = title;
    b.d_text = text;
    b.d_ok = ok;
    b.d_danger = danger;
    b.d_error = "";
    b.d_busy = false;
    this.dialogOk = run;
    b.dialog = kind;
  }

  private dialogCancel: (() => void) | null = null;

  private closeDialog(): void {
    const c = this.dialogCancel;
    this.dialogCancel = null;
    this.bus.dialog = "";
    this.dialogOk = null;
    c?.();
  }

  private async okDialog(): Promise<void> {
    const f = this.dialogOk;
    if (!f) return this.closeDialog();
    this.bus.d_busy = true;
    try {
      await f();
      this.closeDialog();
    } catch (e) {
      this.bus.d_error = e instanceof Error ? e.message : String(e);
    } finally {
      this.bus.d_busy = false;
    }
  }

  private confirm(title: string, text: string, ok: string, run: () => Promise<void>): void {
    this.openDialog("confirm", title, text, ok, run, true);
  }

  private renameDialog(id: string): void {
    const p = this.person(id);
    if (!p) return;
    this.bus.f_name = p.name;
    this.openDialog("rename", `Rename ${p.name}`, "Your own name for them: shown everywhere, never overwritten by Discord, Gmail or WhatsApp.", "Rename", async () => {
      const name = String(this.bus.f_name ?? "").trim();
      if (name) await this.api("PATCH", `person/${encodeURIComponent(id)}`, { name });
    });
  }

  private async setSocials(id: string, fn: (l: string[]) => string[]): Promise<void> {
    const cur = this.panelData?.person.id === id ? this.panelData.person.socials ?? [] : [];
    const r = await this.api("PATCH", `person/${encodeURIComponent(id)}`, { socials: fn(cur) });
    if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
    if (this.ui.open?.id === id) await this.loadPanel();
  }

  private socialDialog(id: string): void {
    this.bus.f_socials = "";
    this.openDialog("social", "Add a social profile", "Paste their TikTok, Instagram or YouTube profile link: the panel shows its 3 latest uploads, and their picture becomes the profile's.", "Add", async () => {
      const url = String(this.bus.f_socials ?? "").trim();
      if (!/(tiktok\.com|instagram\.com|youtube\.com|youtu\.be)/i.test(url)) throw new Error("Paste a TikTok, Instagram or YouTube profile link");
      const before = this.panelData?.person.socials?.length ?? 0;
      await this.setSocials(id, (l) => [...l, url]);
      if ((this.panelData?.person.socials?.length ?? 0) === before) throw new Error("That isn't a profile link, or it's there already");
    });
  }

  private renderChips(): void {
    const s = this.state;
    if (!s) return;
    this.bus.f_chips = s.stores.map((st) => ({ id: `s:${st.id}`, label: st.name, on: !!this.chipState.get(`s:${st.id}`), color: st.color }));
    this.bus.f_lists = s.lists.map((l) => ({ id: `l:${l.id}`, label: l.name, on: !!this.chipState.get(`l:${l.id}`), color: "#64748b" }));
  }

  private renderColors(): void {
    this.bus.f_colors = COLORS.map((c) => ({ id: c, label: c, on: c === this.colorPick, color: c }));
  }

  private personDialog(id: string | null, section?: string, store?: string): void {
    const b = this.bus;
    const s = this.state;
    if (!s) return;
    this.chipState.clear();
    void (async () => {
      let p: PanelJson["person"] | null = null;
      if (id) {
        const r = await this.api("GET", `person/${encodeURIComponent(id)}`);
        if (r.status !== 200) return;
        p = (r.body as unknown as PanelJson).person;
      }
      b.f_name = p?.name ?? "";
      b.f_discord = p ? p.discordId || (p.discordUsername ? `@${p.discordUsername}` : "") : "";
      b.f_email = p?.email ?? "";
      b.f_whatsapp = p?.whatsapp ? `+${p.whatsapp}` : "";
      b.f_socials = (p?.socials ?? []).join(" ");
      for (const sid of p?.storeIds ?? (store ? [store] : [])) this.chipState.set(`s:${sid}`, true);
      for (const lid of p?.listIds ?? (section && section !== "stores" ? [section] : [])) this.chipState.set(`l:${lid}`, true);
      this.renderChips();
      this.openDialog("person", p ? `Edit ${p.name || "person"}` : "Add person", "", p ? "Save" : "Add", async () => {
        const discord = String(b.f_discord ?? "").trim().replace(/^@/, "");
        const fields: Record<string, unknown> = {
          name: String(b.f_name ?? "").trim(),
          email: String(b.f_email ?? "").trim(),
          whatsapp: String(b.f_whatsapp ?? "").trim(),
          storeIds: [...this.chipState].filter(([k, v]) => v && k.startsWith("s:")).map(([k]) => k.slice(2)),
          listIds: [...this.chipState].filter(([k, v]) => v && k.startsWith("l:")).map(([k]) => k.slice(2)),
          socials: String(b.f_socials ?? "").split(/\s+/).filter((u) => /^https:\/\//.test(u)),
        };
        if (/^\d{15,21}$/.test(discord)) fields.discordId = discord;
        else if (discord) fields.discordUsername = discord;
        else if (p) fields.discordId = "";
        if (p) {
          const r = await this.api("PATCH", `person/${encodeURIComponent(p.id)}`, fields);
          if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
          if (this.ui.open?.id === p.id) void this.loadPanel();
        } else {
          const r = await this.api("POST", "people", fields);
          if (r.status !== 200 || r.body.ok === false) throw new Error(String(r.body.error ?? "Not added"));
          const np = r.body.person as { id?: string } | undefined;
          await this.refresh();
          if (np?.id) void this.openPerson(np.id, section ?? "", store ?? "");
        }
      });
    })();
  }

  private storeDialog(id: string | null, created?: (storeId: string) => void): void {
    const st = id ? this.state?.stores.find((s) => s.id === id) : undefined;
    this.bus.f_name = st?.name ?? "";
    this.colorPick = st?.color ?? COLORS[(this.state?.stores.length ?? 0) % COLORS.length]!;
    this.renderColors();
    this.bus.f_chips = [];
    this.bus.f_lists = [];
    this.openDialog("store", st ? `Edit ${st.name}` : "New store", "", st ? "Save" : "Create", async () => {
      const name = String(this.bus.f_name ?? "").trim();
      if (!name) throw new Error("A store needs a name");
      const r = st ? await this.api("PATCH", `stores/${encodeURIComponent(st.id)}`, { name, color: this.colorPick }) : await this.api("POST", "stores", { name, color: this.colorPick });
      if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
      const sid = (r.body.store as { id?: string } | undefined)?.id;
      if (!st && sid && created) created(sid);
    });
  }

  private qrConn = "";

  private async showQr(kind: string, text: string | null, note: string | null, connId: string): Promise<void> {
    const how = kind === "discord"
      ? `In the Discord app on your phone: You › Scan QR code, scan this code, then confirm.${note ? `\n${note}` : ""}`
      : "On your phone: WhatsApp › Settings › Linked devices › Link a device, then scan this code.";
    if (this.bus.dialog !== "qr" || this.qrConn !== connId) {
      this.qrConn = connId;
      // closing the dialog cancels the sign-in (the connection goes back to signed out)
      this.openDialog("qr", kind === "discord" ? "Sign in to Discord" : "Link WhatsApp", how, "", () => {});
      this.dialogCancel = () => void this.api("POST", `connections/${encodeURIComponent(connId)}/cancel`);
    } else this.bus.d_text = how;
    if (!text) {
      this.bus.has_qr = false;
      return;
    }
    this.qr ??= (await loadQr()) as (t: string) => Pixels;
    this.bus.qr = this.qr(text);
    this.bus.has_qr = true;
  }

  private toggle(set: Set<string>, id: string): void {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.render();
  }

  private setToast(text: string, action = "", run?: () => void): void {
    this.bus.toast = text;
    this.bus.toast_action = action;
    this.toastAction = run ?? null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (text) this.toastTimer = setTimeout(() => this.setToast(""), action ? 8000 : 4000);
  }

  stop(): void {
    this.alive = false;
  }
}

let tab: PersonsTab | null = null;

export const personsUi: TabUi = {
  id: "persons",
  mount: async (ctx) => {
    tab = new PersonsTab(ctx);
    Reflect.set(Reflect.get(ctx.win, "PersonsBus") as object, "ready", true);
    await tab.start();
  },
  shown: (on) => {
    if (on) void tab?.["refresh"]();
  },
};
