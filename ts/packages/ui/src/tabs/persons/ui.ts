// Persons tab, window side: drives PersonsBus (slint/persons.slint) from the engine's v1/persons routes (in-process
// through ctx.call — the same routes Hub for Android uses). Pictures are local files the engine cached, decoded here.
import * as slint from "slint-ui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { clipboard, images, picker } from "@harbor/media";
import { audio as osAudio, desktop as osDesktop } from "@harbor/os";
import { GLYPHS, type GlyphName } from "@harbor/net";
import { dataDir } from "@harbor/store";
import { basename, join } from "node:path";
import type { TabCtx, TabUi } from "../api.ts";
import { sameRow, syncRows } from "../../modelsync.ts";
import { loadQr } from "../../qr.ts";
import { releaseBlocks } from "../../markdown.ts";
import { aiSlintParts, type PPartData } from "./aiparts.ts";
import { attachMeta, attachType } from "./attachkind.ts";
import { messageLinks } from "./links.ts";
import { AttachPreviews } from "./attachprev.ts";
import { customEmojiUrl, emojiCategories, emojiRows, inlineLayout, insertAt, jumboEmoji, plainEmoji, searchEmoji, type EmojiEntry } from "./emoji.ts";
import { aiMenu, blockedNote, composerHint, CONTACT_FIELD, failedMenu, messageMenu, moveEntries, placeOfRow, quoteInto, type MenuEntry, type MoveEntry } from "./menus.ts";
import { fwdSubtitle, pickable, pickerRows, quoteMeta, stepPick, type FwdProject } from "./fwdproject.ts";
import { aiFolds, LIST_SECTIONS, audioRow, blankRow, byRecent, CHAT_PAGE, chatRows, shownFor, discordLinks, friendButton, hhmm, shortAgo, listRows, matches, moveSection, nextSpeed, personSections, sectionOrder, servesSection, sideRows, srImageSize, srTimeline, type AiJson, type AudioRow, type AudioStateJson, type ChatJson, type ImgTile, type MsgRow, type PersonJson, type Row, type SrFileJson, type SrPaneJson, type StateJson, type UiState } from "./view.ts";

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
const NO_PX: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
/** A video tile asks for its poster by itself up to this size (the engine downloads the video for it); a larger one once opened. */
const POSTER_AUTO = 48 << 20;
/** The store owner's avatar colour behind their initials when the store has no icon (SrLogo's gray). */
const SR_OWNER_COLOR = "#71717a";

type Cb = (...a: never[]) => unknown;
/** An attached audio file playing here: where it was paused (s), and since when it plays (ms). */
type TilePlay = { path: string; handle: osAudio.Playing | null; pos: number; since: number };
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
const SECTION_LABEL: Record<string, string> = { stores: "Stores", creators: "Creators", spokpay: "SpokPay", neobux: "Neobux", personal: "Personal" };
const KIND_LABEL: Record<string, string> = { discord: "Discord", gmail: "Gmail", whatsapp: "WhatsApp", instagram: "Instagram" };
/** One entry of a Persons menu (showMenu): `children` makes it open a submenu. */
type MenuIn = { id?: string; label: string; icon?: string; sub?: string; hint?: string; danger?: boolean; sep?: boolean; header?: boolean; disabled?: boolean; checked?: boolean; children?: MenuIn[]; run?: () => void };

/** The picker's Recent tab before anything was picked (Discord's frequently used). */
const RECENT_START = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "✅", "👀", "😊", "😅", "🤔", "👏", "💯", "🚀", "😎", "🥲"];
const EMOJI_COLS = 9;

/** kv: the composers' unsent text per chat and recipient, and which chats write to the AI (kept across starts). */
export const DRAFTS_KEY = "persons_drafts";
/** Drafts from kv as {drafts, toAi} maps; anything odd left out. */
export function draftsFrom(text: string | null): { drafts: Map<string, string>; toAi: Map<string, boolean> } {
  const out = { drafts: new Map<string, string>(), toAi: new Map<string, boolean>() };
  if (!text) return out;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return out;
  }
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  for (const [k, v] of Object.entries(rec(rec(o).drafts))) if (typeof v === "string" && v.trim() !== "") out.drafts.set(k, v);
  for (const [k, v] of Object.entries(rec(rec(o).toAi))) if (v === true) out.toAi.set(k, true);
  return out;
}
/** What kv keeps of them: non-empty drafts, chats switched to the AI. */
export function draftsJson(drafts: ReadonlyMap<string, string>, toAi: ReadonlyMap<string, boolean>): string {
  const d: Record<string, string> = {};
  for (const [k, v] of drafts) if (v.trim() !== "") d[k] = v;
  const a: Record<string, boolean> = {};
  for (const [k, v] of toAi) if (v) a[k] = true;
  return JSON.stringify({ drafts: d, toAi: a });
}

/** Where the tab was, as TabUi.snapshot gives it (an update's restart, a crash). */
export interface PersonsSnap {
  open: { id: string; section: string; store: string } | null;
  allActive: boolean;
  sr: string | null;
  query: string;
  panelOpen: boolean;
  sideHidden: boolean;
  aiMode: boolean;
  draft: string;
  cursor: number;
  subject: string;
  replyTo: { id: string; name: string; text: string } | null;
  forwarded: { id: string; name: string; text: string } | null;
  files: string[];
  aiFiles: string[];
  srFiles: string[];
  /** Each chat's place (PersonsTab.places: at its end, or the row at the view's top and its offset), the open
   *  chat's as it is now: a restart reopens every chat where it was left, as within a run. */
  places: [string, { end: boolean; id: string; off: number }][];
}

export function personsSnapFrom(v: unknown): PersonsSnap | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string").slice(0, 10) : []);
  const msg = (x: unknown): { id: string; name: string; text: string } | null => {
    const m = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    return m && typeof m.id === "string" && m.id !== "" ? { id: m.id, name: str(m.name), text: str(m.text) } : null;
  };
  const op = o.open && typeof o.open === "object" ? (o.open as Record<string, unknown>) : null;
  const places: PersonsSnap["places"] = [];
  for (const e of Array.isArray(o.places) ? o.places : []) {
    if (!Array.isArray(e) || typeof e[0] !== "string" || !e[1] || typeof e[1] !== "object") continue;
    const pl = e[1] as Record<string, unknown>;
    const id = str(pl.id);
    const off = typeof pl.off === "number" && Number.isFinite(pl.off) ? pl.off : 0;
    if (pl.end === true || id !== "") places.push([e[0], { end: pl.end === true, id, off }]);
  }
  return {
    open: op && typeof op.id === "string" && op.id !== "" ? { id: op.id, section: str(op.section), store: str(op.store) } : null,
    allActive: o.allActive !== false,
    sr: typeof o.sr === "string" && o.sr !== "" ? o.sr : null,
    query: str(o.query),
    panelOpen: o.panelOpen !== false,
    sideHidden: o.sideHidden === true,
    aiMode: o.aiMode === true,
    draft: str(o.draft),
    cursor: typeof o.cursor === "number" && o.cursor >= 0 ? Math.round(o.cursor) : -1,
    subject: str(o.subject),
    replyTo: msg(o.replyTo),
    forwarded: msg(o.forwarded),
    files: strs(o.files),
    aiFiles: strs(o.aiFiles),
    srFiles: strs(o.srFiles),
    places: places.slice(-200),
  };
}

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
  /** Add friend clicked: the request is on its way (the person's id). */
  private friending: string | null = null;
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
  /** The files going with the next message, as preview tiles over the composer (PAttach). */
  private tileModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private previews: AttachPreviews;
  /** An attached audio file playing here (its tile's play button): where it was paused, and since when it plays. */
  private tilePlay: TilePlay | null = null;
  private renderQueued = false;
  private chatSeq = 0;
  /** The open chat's newest rows drawn (CHAT_PAGE at first; more as it scrolls up, or to show a row jumped to). */
  private shownRows = CHAT_PAGE;
  /**
   * The chat (chatKey) the user marked unread while it was open: it isn't marked seen again until it's opened again
   * (another chat, then this one). Without it the open chat's reload, which follows its row going unread, read it at once.
   */
  private holdUnread = "";
  private qr: ((text: string) => Pixels) | null = null;
  private alive = true;
  /** kv `persons_drafts` as last written, and the write that's due. */
  private draftsKept = "";
  private draftsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The first state read (start): a restore waits for it. */
  private started: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: TabCtx) {
    this.bus = Reflect.get(ctx.win, "PersonsBus") as Bus;
    this.pics = new Pictures(() => this.render());
    this.previews = new AttachPreviews(() => this.render());
    // What was typed before (the last run, a crash or an update's restart): every chat's draft and recipient.
    const kept = draftsFrom(ctx.kv?.get(DRAFTS_KEY) ?? null);
    this.drafts = kept.drafts;
    this.toAi = kept.toAi;
    this.draftsKept = draftsJson(this.drafts, this.toAi);
    const b = this.bus;
    b.side = this.sideModel;
    b.attach_tiles = this.tileModel;
    b.list = this.listModel;
    b.msgs = this.msgModel;
    const on = (name: string, f: Cb): void => {
      b[name] = f;
    };
    on("all_people", () => {
      this.keepPlace();
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
    // a section's head dragged onto another's: it takes that one's place (kept in folds.json)
    on("section_drop", ((from: string, to: string) => {
      b.drag_sec = "";
      b.drag_over = "";
      this.moveSectionTo(from, to);
    }) as Cb);
    on("row_menu", ((id: string, sec: string, store: string, x: number, y: number) => this.rowMenu(id, sec, store, x, y)) as Cb);
    on("store_menu", ((id: string, x: number, y: number) => this.storeMenu(id, x, y)) as Cb);
    on("edited_query", ((q: string) => {
      this.query = q;
      this.render();
    }) as Cb);
    on("add_friend", () => void this.addFriend());
    on("close_chat", () => {
      this.keepPlace();
      this.stopAudio();
      this.ui.open = null;
      this.chat = null;
      this.render();
    });
    // the composer is the person chats' own: in a site request's pane it writes to the store (or to the AI about it)
    on("send", () => void (this.sr ? this.srSend() : this.send()));
    on("typing", () => this.typing());
    on("older", () => void this.older());
    on("jump_reply", ((id: string) => void this.jumpReply(id)) as Cb);
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
    // the composer's emoji picker: the smiley button, a tab, the search, a pick (into the draft at its cursor)
    b.emoji_cats = [{ icon: "🕘", label: "Recent" }, ...emojiCategories().map((c) => ({ icon: c.icon, label: c.label }))];
    on("emoji_toggle", ((x: number, y: number) => this.emojiToggle(x, y)) as Cb);
    on("emoji_tab", ((i: number) => {
      this.emojiTab = i;
      b.emoji_query = "";
      this.emojiGrid();
    }) as Cb);
    on("emoji_search", ((q: string) => this.emojiGrid(q)) as Cb);
    on("emoji_pick", ((e: string) => this.emojiPick(e)) as Cb);
    on("emoji_first", () => {
      const q = String(b.emoji_query ?? "");
      const first = q.trim() ? searchEmoji(q, 1)[0] : this.emojiList(this.emojiTab)[0];
      if (first) this.emojiPick(first.e);
    });
    // Ctrl+V / Shift+Insert in the composer: a picture on the clipboard joins the message (the text pastes as usual)
    on("paste", () => void this.pasteImage());
    on("remove_attached", ((i: number) => {
      const f = this.curFiles[i];
      if (f === undefined) return;
      this.curFiles = this.curFiles.filter((x, j) => j !== i || x !== f);
      this.render();
    }) as Cb);
    // a tile clicked: the lightbox browses the pictures and videos attached; the rest opens in the system's app
    on("open_attached", ((i: number) => {
      const f = this.curFiles[i];
      if (f === undefined) return;
      if (this.ctx.openImage) this.ctx.openImage(f, this.curFiles);
      else this.ctx.openExternal(f);
    }) as Cb);
    on("play_attached", ((i: number) => this.playAttached(i)) as Cb);
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
    on("fp_edited", ((t: string) => {
      b.fp_can_send = t.trim() !== "";
    }) as Cb);
    on("fp_toggle", () => this.fwdToggle());
    on("fp_search", ((q: string) => {
      const f = this.fwd;
      if (!f) return;
      f.query = q;
      f.hi = pickable(pickerRows(f.projects, q, f.selected))[0]?.id ?? "";
      this.renderFwd();
    }) as Cb);
    on("fp_pick", ((id: string) => this.fwdPick(id)) as Cb);
    on("fp_key", ((k: string) => {
      const f = this.fwd;
      if (!f) return;
      if (k === "escape") return this.fwdClosePicker();
      if (k === "enter") return f.hi ? this.fwdPick(f.hi) : undefined;
      f.hi = stepPick(pickerRows(f.projects, f.query, f.selected), f.hi, k === "up" ? -1 : 1);
      this.renderFwd();
    }) as Cb);
    on("dialog_cancel", () => this.closeDialog());
    on("chip", ((id: string) => {
      // Add contact's platform: one at a time
      if (b.dialog === "contact") return this.renderContactKind(id);
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
    this.started = (async () => {
      await this.loadFolds();
      await this.refresh();
    })();
    await this.started;
    void this.loop();
  }

  // ---------- kept across starts ----------

  /** The composer's draft went into its map, and the maps to kv half a second later (a burst of keys writes once). */
  private draftsChanged(): void {
    if (this.draftsTimer) return;
    this.draftsTimer = setTimeout(() => {
      this.draftsTimer = null;
      this.keepDrafts();
    }, 500);
  }

  private keepDrafts(): void {
    const k = this.composerKey();
    if (k) this.drafts.set(`${k}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    for (const [key, v] of this.drafts) if (v === "") this.drafts.delete(key);
    const json = draftsJson(this.drafts, this.toAi);
    if (json === this.draftsKept) return;
    this.draftsKept = json;
    this.ctx.kv?.setLater(DRAFTS_KEY, json);
  }

  /** Where the tab is (TabUi.snapshot): the page, the open chat or request, the composer in full, the scroll. */
  snapshot(): PersonsSnap {
    this.keepDrafts();
    const b = this.bus;
    this.keepPlace();
    return {
      open: this.ui.open ? { ...this.ui.open } : null,
      allActive: this.ui.allActive,
      sr: this.sr?.ref ?? null,
      query: this.query,
      panelOpen: this.panelOpen,
      sideHidden: b.side_hidden === true,
      aiMode: this.aiMode,
      draft: String(b.draft ?? ""),
      cursor: Number(b.draft_cursor) || 0,
      subject: String(b.subject ?? ""),
      replyTo: this.replyTo ? { ...this.replyTo } : null,
      forwarded: this.forwarded ? { ...this.forwarded } : null,
      files: [...this.files],
      aiFiles: [...this.aiFiles],
      srFiles: [...this.srFiles],
      places: [...this.places].slice(-200),
    };
  }

  /** Back where a snapshot left it: the page before the first data is read (no flash of All people), then the chat,
   *  its composer as it was (recipient, text, cursor, reply, files) and its place in the conversation. */
  async restore(v: unknown): Promise<void> {
    const s = personsSnapFrom(v);
    if (!s) return;
    const b = this.bus;
    this.query = s.query;
    b.query = s.query;
    this.panelOpen = s.panelOpen;
    b.side_hidden = s.sideHidden;
    for (const [k, pl] of s.places) if (!this.places.has(k)) this.places.set(k, pl);
    await this.started;
    if (!this.alive) return;
    const there = (id: string): boolean => this.state?.people.some((p) => p.id === id) ?? false;
    if (s.sr) this.openSiteRequest(s.sr);
    else if (s.open && there(s.open.id)) await this.openPerson(s.open.id, s.open.section, s.open.store);
    else {
      this.render();
      return;
    }
    if (s.aiMode !== this.aiMode) this.setTo(s.aiMode);
    const exist = (fs: string[]): string[] => fs.filter((f) => existsSync(f));
    this.files = exist(s.files);
    this.aiFiles = exist(s.aiFiles);
    this.srFiles = exist(s.srFiles);
    this.replyTo = s.replyTo;
    this.forwarded = s.forwarded;
    b.draft = s.draft;
    b.subject = s.subject;
    if (s.cursor >= 0) {
      const at = Math.min(s.cursor, Buffer.byteLength(s.draft));
      b.draft_cursor = at;
      b.draft_anchor = at;
      b.cursor_to = at;
      b.cursor_rev = (Number(b.cursor_rev) || 0) + 1;
    }
    if (s.draft !== "") this.focusField();
    this.render();
    const k = this.chatKey();
    const pl = this.places.get(k);
    if (!pl || pl.end || !this.ui.open) return;
    // The row it was at may be in an older page: those are read again, then the chat goes back to it.
    for (let i = 0; i < 40; i++) {
      if (!this.chat) await new Promise((r) => setTimeout(r, 50));
      const c = this.chat;
      if (this.chatKey() !== k) return;
      if (!c || c.messages.length === 0 || c.messages.some((m) => m.id === pl.id) || !c.more) break;
      await this.fetchOlder();
    }
    if (this.chat && this.chatKey() === k) setTimeout(() => this.chat && this.chatKey() === k && this.placeOpened(this.chat), 30);
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
    // Every change of the composer (a send that empties it, a switch, a reply) is a render: the drafts go to kv after.
    this.draftsChanged();
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
    b.c_friend = friendButton(c.relation ?? null, this.friending === pp.id);
    b.c_gmail = c.account?.kind === "gmail";
    b.c_connected = !!c.account?.connected;
    const all = chatRows(c);
    // more above: older rows not drawn yet, or older pages the engine has
    b.c_more = c.more || all.length > this.shownRows;
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
    this.paintAttached(b);
    b.ai_mode = this.aiMode;
    b.panel = this.panelOpen;
    this.countArrived(c);
    const rows = aiFolds(all.slice(-this.shownRows), this.aiFold);
    this.foldedNow = new Set(rows.filter((r) => r.folded).map((r) => r.id));
    this.keepParts(rows);
    const js = rows.map((r) => this.msgJs(r));
    // pictures (`images[].image`) compare by identity: never serialised (see sameRow)
    syncRows(this.msgModel, js, sameRow);
  }

  /** The files the composer on screen sends with its next message: the AI's, a site request's reply's or the person's. */
  private get curFiles(): string[] {
    return this.aiMode ? this.aiFiles : this.sr ? this.srFiles : this.files;
  }
  private set curFiles(v: string[]) {
    if (this.aiMode) this.aiFiles = v;
    else if (this.sr) this.srFiles = v;
    else this.files = v;
  }

  /** The composer's attachments as preview tiles: a picture, a video's still, a PDF's first page (decoded small, once),
   *  an audio file's play button, else the type's icon; each with its name, type, length or pages, and size. */
  private paintAttached(b: Bus): void {
    const list = this.curFiles;
    b.attached = list.map((f) => basename(f)).join(", ");
    this.previews.keepOnly([...this.files, ...this.aiFiles, ...this.srFiles]);
    if (this.tilePlay && !list.includes(this.tilePlay.path)) this.stopTileAudio();
    const tiles = list.map((p) => {
      const t = attachType(p);
      const info = this.previews.get(p);
      const px = info.still ? this.pics.get(info.still, 192) : null;
      return {
        name: basename(p),
        kind: t.kind,
        thumb: px ?? NO_PX,
        has_thumb: !!px,
        icon: GLYPHS[t.icon],
        tint: t.tint,
        ext: t.ext.length > 5 ? t.ext.slice(0, 4) : t.ext,
        meta: attachMeta(t, info),
        playing: this.tilePlay?.path === p && !!this.tilePlay.handle,
      };
    });
    syncRows(this.tileModel, tiles, (x, y) => x.thumb === y.thumb && sameRow({ ...x, thumb: 0 }, { ...y, thumb: 0 }));
  }

  /** An audio tile's play / pause: played here, from where it was paused (one at a time: a bubble's audio pauses). */
  private playAttached(i: number): void {
    const f = this.curFiles[i];
    if (f === undefined) return;
    const cur = this.tilePlay;
    if (cur?.path === f && cur.handle) {
      cur.handle.stop();
      cur.handle = null;
      cur.pos += (Date.now() - cur.since) / 1000;
      this.render();
      return;
    }
    if (this.audioSt?.playing) void this.audioCall("pause");
    cur?.handle?.stop();
    const st: TilePlay = { path: f, handle: null, pos: cur?.path === f ? cur.pos : 0, since: Date.now() };
    st.handle = osAudio.play(f, st.pos, 1, (error) => {
      if (this.tilePlay !== st) return;
      this.tilePlay = null;
      if (error) this.setToast(`Couldn't play it: ${error}`);
      this.render();
    });
    if (!st.handle) {
      this.setToast("No audio player on this PC (install ffmpeg, or mpv)");
      return;
    }
    this.tilePlay = st;
    this.render();
  }

  private stopTileAudio(): void {
    this.tilePlay?.handle?.stop();
    this.tilePlay = null;
  }

  private attachPaths = new Map<string, string | null>();
  /** Video posters by their route (null: asked for, or none). */
  private posters = new Map<string, string | null>();
  /** Videos being downloaded for the viewer (their tiles spin), by file route. */
  private videoLoading = new Set<string>();
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
    this.draftsChanged();
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
    this.draftsChanged();
    if (ai) this.typingAt = 0;
    this.focusField();
    this.render();
  }

  private emojiTab = 0;
  private emojiRecent: string[] = [];

  /** The smiley button: the picker opens over it (Recent first, or the tab left last), or closes back to the field. */
  private emojiToggle(x: number, y: number): void {
    const b = this.bus;
    if (b.emoji_open) {
      b.emoji_open = false;
      this.focusField();
      return;
    }
    b.emoji_x = x;
    b.emoji_y = y;
    b.emoji_query = "";
    this.emojiGrid();
    b.emoji_open = true;
  }

  /** A tab's emoji (0: Recent, then Unicode's groups). */
  private emojiList(tab: number): EmojiEntry[] {
    if (tab > 0) return emojiCategories()[tab - 1]?.items ?? [];
    const names = new Map(emojiCategories().flatMap((c) => c.items.map((x) => [x.e, x.name] as const)));
    const list = [...this.emojiRecent, ...RECENT_START.filter((e) => !this.emojiRecent.includes(e))].slice(0, 4 * EMOJI_COLS);
    return list.map((e) => ({ e, name: names.get(e) ?? "" }));
  }

  /** The grid: what the search finds, else the tab's emoji. */
  private emojiGrid(q = ""): void {
    const b = this.bus;
    const found = q.trim() ? searchEmoji(q) : null;
    b.emoji_cat = found ? -1 : this.emojiTab;
    b.emoji_rows = emojiRows(found ?? this.emojiList(this.emojiTab), EMOJI_COLS).map((cells) => ({ cells }));
    b.emoji_empty = found ? "No emoji found" : "";
    b.emoji_rev = (Number(b.emoji_rev) || 0) + 1;
  }

  /** An emoji into the draft where the field's cursor is (over its selection); the picker closes, the field has the
   *  focus with the cursor after the emoji. */
  private emojiPick(e: string): void {
    const b = this.bus;
    const r = insertAt(String(b.draft ?? ""), Number(b.draft_anchor) || 0, Number(b.draft_cursor) || 0, e);
    b.draft = r.text;
    b.draft_cursor = r.cursor;
    b.draft_anchor = r.cursor;
    b.cursor_to = r.cursor;
    b.cursor_rev = (Number(b.cursor_rev) || 0) + 1;
    this.emojiRecent = [e, ...this.emojiRecent.filter((x) => x !== e)].slice(0, 4 * EMOJI_COLS);
    b.emoji_open = false;
    b.emoji_query = "";
  }

  /** A picture from the web (a Discord emoji), through the engine's picture cache; null until it's here. */
  private urlPic(url: string, cap: number): Pixels | null {
    const f = this.attachPaths.get(url);
    if (f === undefined) {
      this.attachPaths.set(url, null);
      void this.ctx.call("GET", "v1/persons/img/url", { u: url, path: "1" }).then((r) => {
        const path = r.status === 200 ? (r.body as { path?: string }).path ?? null : null;
        this.attachPaths.set(url, path);
        if (path) this.render();
      }, () => {});
    }
    return f ? this.pics.get(f, cap) : null;
  }

  /** A message's text as drawn: Discord's custom emoji as pictures in it, or 1-3 emoji alone drawn big. */
  private emojiJs(r: MsgRow): { text: string; emojis: Record<string, unknown>[]; jumbo: Record<string, unknown>[] } {
    if ((r.kind !== "msg" && r.kind !== "out") || r.toAi || !r.text) return { text: r.text, emojis: [], jumbo: [] };
    const big = jumboEmoji(r.text);
    if (big) {
      const jumbo = big.map((j) => {
        if (j.kind === "unicode") return { image: NO_PX, has_image: false, custom: false, text: j.text, name: "", from: 0, to: 0 };
        const px = this.urlPic(customEmojiUrl(j, 96), 96);
        return { image: px ?? NO_PX, has_image: !!px, custom: true, text: "", name: j.name, from: 0, to: 0 };
      });
      return { text: r.text, emojis: [], jumbo };
    }
    const lay = inlineLayout(r.text);
    const emojis = lay.emojis.map((e) => {
      const px = this.urlPic(customEmojiUrl(e), 48);
      return { image: px ?? NO_PX, has_image: !!px, custom: true, text: "", name: e.name, from: e.from, to: e.to };
    });
    return { text: lay.text, emojis, jumbo: [] };
  }

  /** The composer's field takes the focus (Person Hub's switchTo / startReply). */
  private focusField(): void {
    this.bus.focus_rev = (Number(this.bus.focus_rev) || 0) + 1;
  }

  private msgJs(r: MsgRow): Record<string, unknown> {
    const images = r.images.map((t) => {
      if (t.video) {
        const poster = this.posterPath(t);
        const px = poster ? this.pics.get(poster, 640) : null;
        return { image: px ?? NO_PX, x: t.x, y: t.y, w: t.w, h: t.h, video: true, dur: t.dur ?? "", loading: this.videoLoading.has(t.url) };
      }
      const known = this.localPath(t.url);
      const px = known ? this.pics.get(known, 640) : null;
      return { image: px ?? NO_PX, x: t.x, y: t.y, w: t.w, h: t.h, video: false, dur: "", loading: false };
    });
    const em = this.emojiJs(r);
    const ln = this.linksOf(r.kind === "ai" ? "" : em.text);
    return {
      kind: r.kind,
      id: r.id,
      mine: r.mine,
      text: em.text,
      time: r.time,
      meta: r.meta,
      reply: r.reply,
      has_reply: r.reply !== "",
      emojis: em.emojis,
      jumbo: em.jumbo,
      reply_id: r.replyId,
      images,
      has_image: images.length > 0,
      img_w: r.imgW,
      img_h: r.imgH,
      files: r.files,
      first: r.first,
      failed: r.failed,
      in_discord: r.inDiscord,
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
      day: r.day,
      has_audio: !!r.audio,
      a_key: r.audio?.key ?? "",
      a_dur: r.audio?.duration ?? 0,
      a_bars: r.audio?.bars ?? [],
      a_played: r.audio ? r.audio.played || (this.audioSt?.key === r.audio.key && this.audioSt.playing) : true,
      a_voice: !!r.audio?.voice,
      a_transcript: r.audio?.transcript ?? "",
      a_transcribing: !!r.audio && (r.audio.transcribing || this.transcribing.has(r.audio.key)),
      a_hidden: !!r.audio && !this.shownTranscripts.has(r.audio.key),
      links: ln.links,
      styled: ln.styled,
    };
  }

  /** Messages' web addresses as their bubbles draw them, by text (a redraw doesn't parse them again). */
  private links = new Map<string, { links: ReturnType<typeof messageLinks>["links"]; styled: slint.StyledText }>();
  private static readonly NO_LINKS = { links: [], styled: slint.StyledText.fromPlainText("") };

  private linksOf(text: string): { links: ReturnType<typeof messageLinks>["links"]; styled: slint.StyledText } {
    if (!/https?:\/\//i.test(text)) return PersonsTab.NO_LINKS;
    const had = this.links.get(text);
    if (had) return had;
    const m = messageLinks(text);
    let styled: slint.StyledText;
    try {
      styled = slint.StyledText.fromMarkdown(m.markdown);
    } catch {
      styled = slint.StyledText.fromPlainText(text);
    }
    const out = m.links.length > 0 ? { links: m.links, styled } : PersonsTab.NO_LINKS;
    if (this.links.size >= 500) this.links.clear();
    this.links.set(text, out);
    return out;
  }

  /** A video tile's poster here (null until it is): asked for once, which downloads the video into the engine's
   *  cache, so only for videos up to POSTER_AUTO bytes (or of unknown size); a larger one gets its poster once it was
   *  opened. */
  private posterPath(t: ImgTile, force = false): string | null {
    const route = t.poster;
    if (!route) return null;
    const known = this.posters.get(route);
    if (known !== undefined) return known;
    if (!force && t.size != null && t.size > POSTER_AUTO) return null;
    this.posters.set(route, null);
    const u = new URL(route, "http://hub");
    const q: Record<string, string> = { path: "1" };
    for (const [k, v] of u.searchParams) q[k] = v;
    void this.ctx
      .call("GET", u.pathname.replace(/^\//, ""), q)
      .catch(() => null)
      .then((r) => {
        const b = r && r.status === 200 ? (r.body as { path?: string; video?: string }) : null;
        this.posters.set(route, b?.path ?? null);
        if (b?.video) this.attachPaths.set(t.url, b.video);
        if (b?.path) this.render();
      });
    return null;
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
    this.keepPlace();
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
    this.shownRows = CHAT_PAGE;
    this.bus.c_open_rev = (Number(this.bus.c_open_rev) || 0) + 1;
    this.bus.c_arrived = 0;
    this.arrivedOf = { key: k, ids: null };
    this.aiMode = this.toAi.get(k) ?? false;
    this.bus.draft = this.drafts.get(`${k}:${this.aiMode ? "ai" : "person"}`) ?? "";
    this.bus.subject = "";
    this.render();
    this.draftsChanged();
    this.ctx.saveSoon?.();
    await Promise.all([this.loadChat(true), this.panelOpen ? this.loadPanel() : Promise.resolve()]);
  }

  private account: string | null = null;

  /** Where each chat was left (this run): at its end, or the row at the top and how far above the view's top it
   *  started (WhatsApp's: opened again, it's back there). */
  private places = new Map<string, { end: boolean; id: string; off: number }>();
  /** The open chat's message ids drawn so far (null: not drawn yet), to count theirs that come in (`c_arrived`). */
  private arrivedOf: { key: string; ids: Set<string> | null } = { key: "", ids: null };

  /** The chat on screen is left: its place is kept. */
  private keepPlace(): void {
    const k = this.chatKey();
    if (!k || !this.chat) return;
    const b = this.bus;
    const end = b.c_at_bottom !== false;
    const id = String(b.c_top_id ?? "");
    if (!end && !id) return;
    this.places.set(k, { end, id, off: Number(b.c_top_off) || 0 });
  }

  /** A chat's first draw: back where it was left; else at its unread line ("N unread messages") near the top; else
   *  its end (where ChatPane starts it). Rows exist once Slint has laid them out: placed on its next frames. */
  private placeOpened(c: ChatJson): void {
    const k = this.chatKey();
    const was = this.places.get(k);
    const rows = this.msgModel;
    const has = (id: string): boolean => {
      for (let i = 0; i < rows.length; i++) if (rows.rowData(i)?.id === id) return true;
      return false;
    };
    let target: { id: string; off: number } | null = null;
    if (c.unreadFrom && (!was || was.end)) target = { id: `u${c.unreadFrom}`, off: 24 };
    else if (was && !was.end && chatRows(c).some((r) => r.id === was.id)) target = { id: was.id, off: was.off };
    if (target && c === this.chat) this.reveal(target.id);
    if (!target || !has(target.id)) return;
    const t = target;
    const put = (): void => {
      if (this.chatKey() !== k) return;
      this.bus.place_id = t.id;
      this.bus.place_off = t.off;
      this.bus.place_rev = (Number(this.bus.place_rev) || 0) + 1;
    };
    put();
    setTimeout(put, 16);
    setTimeout(put, 60);
  }

  /** Their messages new in the open chat since it was drawn: `c_arrived` goes up by them (ChatPane's "↓" badge). */
  private countArrived(c: ChatJson): void {
    const k = this.chatKey();
    if (this.arrivedOf.key !== k) this.arrivedOf = { key: k, ids: null };
    const ids = new Set(c.messages.map((m) => m.id));
    const before = this.arrivedOf.ids;
    this.arrivedOf.ids = ids;
    if (!before) return;
    const last = c.messages.findLastIndex((m) => before.has(m.id));
    const n = c.messages.slice(last + 1).filter((m) => !m.fromMe && !before.has(m.id)).length;
    if (n > 0) this.bus.c_arrived = (Number(this.bus.c_arrived) || 0) + n;
  }

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
    if (first) this.placeOpened(c);
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

  /** Scrolled to the top: older rows already read are drawn (a page more), else the engine's next older page. */
  private async older(): Promise<void> {
    const c = this.chat;
    if (c && chatRows(c).length > this.shownRows) {
      this.shownRows += CHAT_PAGE;
      this.render();
      return;
    }
    await this.fetchOlder();
  }

  /** The engine's next older page of the open chat, drawn as it comes (the rows drawn grow by its rows). */
  private async fetchOlder(): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    const first = c?.messages[0];
    if (!open || !c || !first || !c.more) return;
    this.bus.c_loading = true;
    const r = await this.ctx.call("GET", `v1/persons/chat/${encodeURIComponent(open.id)}`, { section: open.section, before: first.id, ...(c.account ? { account: c.account.id } : {}) }).catch(() => null);
    this.bus.c_loading = false;
    if (!r || r.status !== 200 || this.chat !== c) return;
    const page = r.body as { messages: ChatJson["messages"]; more: boolean };
    const before = chatRows(c).length;
    c.messages = [...page.messages, ...c.messages.filter((m) => !page.messages.some((x) => x.id === m.id))];
    c.more = page.more && page.messages.length > 0;
    this.shownRows = Math.max(this.shownRows, before) + Math.max(0, chatRows(c).length - before);
    this.render();
  }

  /** The row `id` (a reply's original, where the chat was left) is drawn, with a few above it: now, so it can be
   *  scrolled to on the next frames. */
  private reveal(id: string): void {
    const c = this.chat;
    if (!c) return;
    const need = shownFor(chatRows(c), id, this.shownRows);
    if (need === this.shownRows) return;
    this.shownRows = need;
    this.draw();
  }

  /** The tab left the screen: a chat scrolled far up goes back to its newest rows, so coming back (Slint builds the
   *  whole page again) is quick. */
  private trim(): void {
    if (this.shownRows <= CHAT_PAGE) return;
    this.keepPlace();
    this.shownRows = CHAT_PAGE;
    this.render();
  }

  /** Older pages read at most while looking for a replied-to message (Discord's are 50 messages each). */
  private static readonly JUMP_PAGES = 40;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A click on a reply's quote: the chat scrolls to the message it replies to and flashes it (WhatsApp's). One not
   * loaded yet is looked for in older pages; one that isn't there (deleted, too old) says so in a toast.
   */
  private async jumpReply(rowId: string): Promise<void> {
    const target = this.chat?.messages.find((m) => m.id === rowId)?.reply?.id;
    const key = this.chatKey();
    if (!target) return;
    const has = (): boolean => !!this.chat?.messages.some((m) => m.id === target);
    let loaded = false;
    for (let page = 0; !has() && page < PersonsTab.JUMP_PAGES; page++) {
      const c = this.chat;
      if (!c?.more || this.chatKey() !== key) break;
      const n = c.messages.length;
      await this.fetchOlder();
      loaded = true;
      // a live refresh may swap the chat meanwhile: go on with the new one; a page that brought nothing ends it
      if (this.chat === c && c.messages.length === n) break;
    }
    if (this.chatKey() !== key) return;
    if (!has()) return this.setToast("Original message not available");
    // read before but not drawn yet (older than the rows drawn): drawn now, jumped to on the next frames
    const drawn = this.shownRows;
    this.reveal(target);
    if (this.shownRows !== drawn) loaded = true;
    // rows of a page just read exist once Slint has laid them out: jump on its next frames
    if (loaded) setTimeout(() => this.chatKey() === key && this.flash(target), 80);
    else this.flash(target);
  }

  /** Scrolls the chat to a message and tints its row, fading out over ~1.5 s. */
  private flash(id: string): void {
    const b = this.bus;
    b.flash_id = id;
    b.jump_id = id;
    b.jump_rev = (Number(b.jump_rev) || 0) + 1;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    // the tint holds a moment, then fades as the row's flash goes off (persons.slint MsgRow)
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      if (b.flash_id === id) b.flash_id = "";
    }, 400);
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
      this.draftsChanged();
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
    this.draftsChanged();
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

  /**
   * The header's Add friend (Discord): a friend request to the person; the click is the user's go-ahead. When Discord
   * wants a captcha, Hub shows none and doesn't retry: their profile opens in Discord's app, where the person adds them.
   */
  private async addFriend(): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    if (!open || !c || this.friending || !["add", "accept"].includes(friendButton(c.relation ?? null, false))) return;
    this.friending = open.id;
    this.render();
    const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/friend`, { section: open.section, account: c.account?.id });
    this.friending = null;
    const where = typeof r.body.open === "string" && r.body.open.startsWith("/") ? r.body.open : "";
    if (where) {
      this.setToast(String(r.body.error ?? "Discord wants a captcha: finish adding them in the Discord app."));
      this.openInDiscord(where, false);
    } else if (r.status !== 200 || r.body.ok === false) this.setToast(String(r.body.error ?? "The friend request didn't go"));
    else this.setToast(r.body.relation === "friend" ? "You're friends on Discord now" : "Friend request sent");
    void this.loadChat(false);
  }

  /** Opens a Discord path in Discord's app (the browser's discord.com without it); `say`: a toast tells which. */
  private openInDiscord(path: string, say = true): void {
    const l = discordLinks(path);
    void osDesktop.openApp(l.app, l.web).then((how) => {
      if (say) this.setToast(how === "app" ? "Opened in Discord" : "Opened discord.com in the browser");
    });
  }

  /** The file picker, its failure (no picker on this PC…) said in a toast: media's own toast is shown nowhere here. */
  private async pickFiles(o: picker.Opts): Promise<string[]> {
    const before = picker.toast()?.msg;
    const got = await picker.pick(o).catch(() => [] as string[]);
    const err = picker.toast()?.msg;
    if (!got.length && err && err !== before) this.setToast(err);
    return got;
  }

  /** A picture on the clipboard (Ctrl+V in the composer) joins the next message, as in Projects' composer: saved
   * under Hub's pastes folder, then attached like a picked file (to the AI, to the person, or a site request's reply). */
  private async pasteImage(): Promise<void> {
    if (!this.ui.open && !this.sr) return;
    const clip = await clipboard.read().catch(() => null);
    if (clip?.type !== "image" || this.noFiles()) return;
    const png = clip.bytes[0] === 0x89 && clip.bytes[1] === 0x50;
    const dir = join(dataDir(), "pastes");
    const path = join(dir, `pasted-${Date.now()}.${png ? "png" : "jpg"}`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, clip.bytes);
    } catch {
      return this.setToast("Couldn't keep the pasted picture");
    }
    if (this.aiMode) this.aiFiles = [...this.aiFiles, path].slice(0, 10);
    else if (this.sr) {
      if (this.srFiles.length >= 5) return this.setToast("SpokPay takes up to 5 pictures a message");
      if (clip.bytes.length > 10 << 20) return this.setToast("The picture is over 10 MB");
      this.srFiles = [...this.srFiles, path];
    } else {
      if (clip.bytes.length > 25 << 20) return this.setToast("The picture is over 25 MB");
      this.files = [...this.files, path].slice(0, 10);
    }
    this.render();
  }

  /** The chat the composer sends on takes no files (Instagram's connector sends text only): said, true. */
  private noFiles(): boolean {
    if (this.aiMode || this.sr || this.chat?.account?.kind !== "instagram") return false;
    this.setToast("Pictures and files can't be sent to Instagram from here yet: send the text alone");
    return true;
  }

  private async attach(): Promise<void> {
    if (this.noFiles()) return;
    const got = await this.pickFiles({ title: "Attach files", multiple: true });
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
    this.draftsChanged();
    this.ctx.saveSoon?.();
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
    const f = m?.files.find((x) => !x.image && !x.video);
    if (!f) {
      if (m?.files.some((x) => x.image || x.video)) await this.openImage(id, 0);
      return;
    }
    const path = await this.fetchPath(f.url);
    if (path) this.ctx.openExternal(path);
    else this.setToast("Couldn't download that file");
  }

  /** A picture or video in a bubble was clicked: Hub's lightbox (videos play there, natively), browsing every picture
   *  and video of that message. A video downloads first (once, into the engine's cache): its tile spins meanwhile. */
  private async openImage(id: string, i: number): Promise<void> {
    const m = this.chat?.messages.find((x) => x.id === id);
    const imgs = m?.files.filter((x) => x.image || x.video) ?? [];
    if (!imgs.length) return;
    const at = Math.min(Math.max(i, 0), imgs.length - 1);
    const clicked = imgs[at]!;
    if (clicked.video && this.videoLoading.has(clicked.url)) return;
    const slow = imgs.filter((f) => f.video && !this.attachPaths.get(f.url));
    for (const f of slow) this.videoLoading.add(f.url);
    if (slow.length) this.render();
    const paths = await Promise.all(
      imgs.map(async (f) => {
        const known = this.attachPaths.get(f.url);
        if (known) return known;
        const p = await this.fetchPath(f.url);
        if (p) this.attachPaths.set(f.url, p);
        return p;
      }),
    ).finally(() => {
      for (const f of slow) this.videoLoading.delete(f.url);
      if (slow.length) this.render();
    });
    const path = paths[at];
    if (!path) {
      this.setToast(clicked.video ? "Couldn't download that video" : "Couldn't download that picture");
      return;
    }
    // a large video's poster, now that it's here
    if (clicked.video && clicked.poster && !this.posters.get(clicked.poster)) {
      this.posters.delete(clicked.poster);
      this.posterPath({ url: clicked.url, poster: clicked.poster, x: 0, y: 0, w: 0, h: 0, video: true }, true);
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
    if (this.tilePlay?.handle) {
      this.stopTileAudio();
      this.render();
    }
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
    const mine = s.connections.filter((c) => servesSection(c, sec));
    const status = (c: (typeof mine)[number]): string => (c.status === "connected" ? (c.gateway === "up" || c.kind !== "discord" ? "Connected" : "Reconnecting…") : c.status === "connecting" || c.status === "starting" ? "Connecting…" : c.status === "signing-in" ? "Signing in…" : "Signed out");
    // Personal: the Stores Discord and WhatsApp (shared: managed in Stores) and its own Instagram (a pasted session)
    const personal = sec === "personal";
    const connKinds = personal ? ["discord", "whatsapp", "instagram"].filter((k) => !mine.some((c) => c.kind === k)) : ["discord", "gmail", "whatsapp"];
    const run = (c: (typeof mine)[number]): void => {
      // Neobux writes through Creators' logins until it has its own: connecting one here takes that kind over
      if (c.section !== sec) return this.setToast(sec === "neobux" ? `${SECTION_LABEL[c.section] ?? c.section}'s ${KIND_LABEL[c.kind] ?? c.kind}: connect Neobux's own below to use it instead` : `Shared with ${SECTION_LABEL[c.section] ?? c.section}: connect or disconnect it there`);
      if (c.status === "connected") return this.confirm(`Disconnect ${KIND_LABEL[c.kind]}${c.who ? ` (${c.who})` : ""}?`, "It leaves this section and signs out. Connect it again to use it.", "Disconnect", async () => void (await this.api(c.kind === "instagram" ? "POST" : "DELETE", c.kind === "instagram" ? `connections/${encodeURIComponent(c.id)}/disconnect` : `connections/${encodeURIComponent(c.id)}`)));
      if (c.kind === "instagram") return this.sessionDialog(c.id);
      void this.api("POST", `connections/${encodeURIComponent(c.id)}/connect`);
    };
    const order = this.sections();
    const at = order.indexOf(sec);
    const moves = [
      ...(at > 0 ? [{ label: "Move up", run: () => this.moveSectionTo(sec, order[at - 1]!) }] : []),
      ...(at >= 0 && at < order.length - 1 ? [{ label: "Move down", run: () => this.moveSectionTo(sec, order[at + 1]!) }] : []),
    ];
    this.showMenu(x, y, [
      sec === "stores" ? { label: "New store", icon: "", run: () => this.storeDialog(null) } : personal ? { label: "Add contact", run: () => this.contactDialog() } : { label: `Add to ${SECTION_LABEL[sec]}`, run: () => this.personDialog(null, sec) },
      ...(sec === "stores" ? [{ label: "Add person", run: () => this.personDialog(null, sec) }] : []),
      { sep: true, label: "" },
      { header: true, label: "CONNECTIONS" },
      ...(mine.length ? [] : [{ label: "None yet.", disabled: true }]),
      ...mine.map((c) => ({
        label: c.who || KIND_LABEL[c.kind] || c.kind,
        icon: c.kind,
        sub: `${KIND_LABEL[c.kind]} · ${status(c)}${c.section !== sec ? ` · from ${SECTION_LABEL[c.section] ?? c.section}` : ""}${c.error ? ` · ${c.error}` : ""}`,
        run: () => run(c),
      })),
      ...(connKinds.length ? [{ sep: true, label: "" }] : []),
      ...connKinds.map((k) => ({
        label: `Connect ${KIND_LABEL[k]}`,
        icon: k,
        run: () => void (async () => {
          const r = await this.api("POST", "connections", { section: sec, kind: k });
          const id = String(r.body.id ?? "");
          if (k === "instagram" && id) this.sessionDialog(id);
        })(),
      })),
      ...(moves.length ? [{ sep: true, label: "" }, ...moves] : []),
    ]);
  }

  // ---------- Personal ----------

  private contactKind = "discord";
  /** A conflict the form showed (the fields it was for): OK with the same fields confirms it. */
  private contactPending: { kind: string; handle: string; name: string } | null = null;

  /** Add contact's platform chips, `kind` picked; the field's label and hint follow it. */
  private renderContactKind(kind: string): void {
    const b = this.bus;
    this.contactKind = CONTACT_FIELD[kind] ? kind : "discord";
    b.f_chips = ["discord", "whatsapp", "instagram"].map((k) => ({ id: k, label: KIND_LABEL[k]!, on: k === this.contactKind, color: "#64748b" }));
    b.f_handle_label = CONTACT_FIELD[this.contactKind]!.label;
    b.f_handle_hint = CONTACT_FIELD[this.contactKind]!.hint;
    b.d_error = "";
    b.d_ok = "Add";
    this.contactPending = null;
  }

  /**
   * Personal › Add contact: the platform, their number or username, a name if wanted. The engine finds them on that
   * platform first; when it can't, the reason shows in the form and nothing is saved. Their chat opens once added.
   */
  private contactDialog(): void {
    const b = this.bus;
    b.f_name = "";
    b.f_discord = "";
    b.f_lists = [];
    this.renderContactKind(this.contactKind);
    this.openDialog("contact", "Add contact", "Their WhatsApp number, or their Discord or Instagram username: their conversation shows here.", "Add", async () => {
      const fields = { kind: this.contactKind, handle: String(b.f_discord ?? "").trim(), name: String(b.f_name ?? "").trim() };
      const p0 = this.contactPending;
      const confirm = !!p0 && p0.kind === fields.kind && p0.handle === fields.handle && p0.name === fields.name;
      const r = await this.api("POST", "contacts", { ...fields, ...(confirm ? { confirm: true } : {}) });
      const conflict = r.body.conflict as { confirm?: string } | undefined;
      if (r.status === 200 && r.body.ok === false && conflict) {
        // already someone else, or WhatsApp names the number otherwise: said in the form; the button confirms it
        this.contactPending = fields;
        b.d_ok = String(conflict.confirm || "Add anyway");
        throw new Error(String(r.body.error ?? "Check the number"));
      }
      this.contactPending = null;
      b.d_ok = "Add";
      if (r.status !== 200 || r.body.ok === false) throw new Error(String(r.body.error ?? "Not added"));
      const np = r.body.person as { id?: string; name?: string } | undefined;
      await this.refresh();
      // already in Persons (the same number or account): said, with the name they have now; their chat opens
      if (r.body.existed) this.setToast(String(r.body.message || "Already in Persons"));
      if (np?.id) void this.openPerson(np.id, "personal", "");
    });
  }

  /** Personal's Instagram: the session from a browser signed in to Instagram (its cookies), checked before it's kept. */
  private sessionDialog(connId: string): void {
    this.bus.f_socials = "";
    this.openDialog("session", "Connect Instagram", "In a browser signed in to your Instagram: DevTools (F12) › Application › Cookies › instagram.com, copy sessionid and ds_user_id, and paste them here as sessionid=…; ds_user_id=…. It stays on this PC and is never shown again.", "Connect", async () => {
      const r = await this.api("POST", `connections/${encodeURIComponent(connId)}/session`, { cookie: String(this.bus.f_socials ?? "").trim() });
      if (r.status !== 200 || r.body.ok === false) throw new Error(String(r.body.error ?? "Not connected"));
      this.setToast("Instagram connected");
    });
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
    return [...new Set([...p.storeIds, ...owned])].map((s) => `store:${s}`).concat(p.listIds.filter((l) => LIST_SECTIONS.includes(l)));
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
  private sr: { ref: string; pane: SrPaneJson | null; loading: boolean; error: string; sending: boolean; moving: boolean; aiUntil?: number } | null = null;
  /** Pictures going with the next reply (paths on this PC); the drafts are the composer's (`sr:<ref>:person|ai`). */
  private srFiles: string[] = [];
  private srTimer: ReturnType<typeof setInterval> | null = null;
  private srSeq = 0;

  /** A request's row: its pane opens in the main area (read now, and every 30 s while it shows). */
  private openSiteRequest(ref: string): void {
    if (this.sr?.ref === ref && this.ui.srOpen === ref) return;
    const was = this.chatKey();
    if (was) this.drafts.set(`${was}:${this.aiMode ? "ai" : "person"}`, String(this.bus.draft ?? ""));
    this.keepPlace();
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
    if (this.srAiTimer) clearTimeout(this.srAiTimer);
    this.srAiTimer = null;
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
      if (srAiBusy(sr.pane.ai ?? [])) this.srAiFollow(sr, 0);
    } else sr.error = String(r.body.error ?? `SpokPay answered ${r.status}`);
    this.render();
  }

  private srAiTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Follows the open request's turns with the AI (GET site-request/{ref}/ai, no SpokPay read) every 1.5 s while one is
   * queued or being written, and until `until` while the newest note has no answer yet.
   */
  private srAiFollow(sr: NonNullable<typeof this.sr>, until: number): void {
    sr.aiUntil = Math.max(sr.aiUntil ?? 0, until);
    if (this.srAiTimer) return;
    const tick = async (): Promise<void> => {
      this.srAiTimer = null;
      if (this.sr !== sr || !this.alive) return;
      const r = await this.api("GET", `site-request/${encodeURIComponent(sr.ref)}/ai`).catch(() => null);
      if (this.sr !== sr) return;
      if (r?.status === 200 && sr.pane && Array.isArray(r.body.ai)) {
        const ai = r.body.ai as AiJson[];
        if (JSON.stringify(ai) !== JSON.stringify(sr.pane.ai ?? [])) {
          sr.pane.ai = ai;
          if (r.body.aiChat != null) sr.pane.aiChat = String(r.body.aiChat);
          this.render();
        }
      }
      const ai = sr.pane?.ai ?? [];
      if (srAiBusy(ai) || (Date.now() < (sr.aiUntil ?? 0) && ai.at(-1)?.role !== "assistant")) this.srAiTimer = setTimeout(() => void tick(), 1500);
    };
    this.srAiTimer = setTimeout(() => void tick(), 1500);
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
    this.paintAttached(b);
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
    // the request's lines with its own turns with the Person AI, each where it was sent (person chats' AI card)
    const lines = srTimeline(p.items, p.ai ?? [], this.aiFold);
    const aiRows = lines.flatMap((l) => (l.kind === "ai" ? [l.row] : []));
    this.foldedNow = new Set(aiRows.filter((r) => r.folded).map((r) => r.id));
    this.keepParts(aiRows);
    const none = this.msgJs(blankRow("msg", ""));
    b.sr_items = lines.map((l) => {
      if (l.kind === "ai") return { kind: "ai", id: l.row.id, mine: l.row.mine, head: "", text: "", avatar: false, joins_prev: false, joins_next: false, images: [], files: [], ai: this.msgJs(l.row) };
      const it = l.item;
      return it.kind === "event"
        ? { kind: "event", id: it.id, mine: false, head: "", text: it.text, avatar: false, joins_prev: false, joins_next: false, images: [], files: [], ai: none }
        : { kind: "msg", id: it.id, mine: it.mine, head: it.joinsPrev ? "" : it.head, text: it.text, avatar: !it.joinsNext, joins_prev: it.joinsPrev, joins_next: it.joinsNext, images: this.srImgs(it.files), files: it.files.filter((f) => !f.image).map((f) => f.name), ai: none };
    });
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
        // the note and the AI's answer show in the timeline (its AI card), followed while the AI works
        if (sr.pane) {
          sr.pane.aiChat = String(r.body.chat);
          if (Array.isArray(r.body.ai)) sr.pane.ai = r.body.ai as AiJson[];
        }
        this.drafts.delete(key);
        if (this.sr === sr) this.bus.sr_rev = (Number(this.bus.sr_rev) || 0) + 1;
        this.srAiFollow(sr, Date.now() + 180_000);
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
    const got = await this.pickFiles({ title: "Add pictures", multiple: true, filter: ["Images", ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"]] });
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
      // Discord asked for a captcha: Hub never shows it; the DM opens in Discord's app, where the person sends it
      const where = c.outgoing.find((o) => o.key === key)?.open;
      this.showEntries(x, y, [
        ...(where ? [{ label: "Open in Discord", icon: "EXTERNAL" as const, run: () => this.openInDiscord(where) }] : []),
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
        this.replyTo = { id: m.id, name: who, text: plainEmoji(m.text).slice(0, 160) || (m.files.length ? "📎 attachment" : "") };
        this.focusField();
        this.render();
      },
      forward: () => {
        // Person Hub's Forward to AI: the AI composer, with this message quoted, ready for a question
        this.forwarded = { id: m.id, name: who, text: plainEmoji(m.text).slice(0, 160) || (m.files[0] ? (m.voice ? "Voice message" : m.files[0].image ? "Photo" : m.files[0].name) : "Message") };
        this.setTo(true);
        this.focusField();
        this.render();
      },
      project: () =>
        this.forwardToProject({
          author: m.fromMe ? "You" : c.person.name,
          at: m.at,
          section: SECTION_LABEL[open.section] ?? open.section,
          text: m.text || this.filesLine(m.files.map((f) => f.name), m.voice),
          send: (project, prompt) => this.api("POST", `chat/${encodeURIComponent(open.id)}/to-project`, { section: open.section, account: c.account?.id, messageId: m.id, project, prompt }),
        }),
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
    if (p && id.startsWith("ai")) {
      // an AI card: the person chats' AI menu (Use as reply into the composer to the store, Copy text)
      const a = (p.ai ?? []).find((x) => `ai${x.id}` === id);
      if (!a) return;
      const drafts = a.role === "user" ? [] : (a.parts ?? []).flatMap((q) => (q.type === "draft" ? [q.text] : []));
      const entries = aiMenu({ drafts, text: a.text, canSend: !p.finished && !p.writeBlocked && a.role !== "user" });
      this.showEntries(x, y, entries.map((e) => ({ ...e, ...(e.use !== undefined ? { run: () => this.useDraft(e.use!) } : e.action === "copy" ? { run: () => this.copy(a.text) } : {}) })));
      return;
    }
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
      project: () =>
        this.forwardToProject({
          author: it.author,
          at: new Date(it.at).toISOString(),
          section: `SpokPay · ${p.ref}`,
          text: it.text || this.filesLine(it.files.map((f) => f.name), false),
          send: (project, prompt) => this.api("POST", `site-request/${encodeURIComponent(p.ref)}/to-project`, { messageId: it.id, project, prompt }),
        }),
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

  // ---------- Forward to Projects ----------

  /** The open Forward to Projects dialog: how it sends, Hub's projects, the one picked, the picker's search and keyboard row. */
  private fwd: { send: (project: string, prompt: string) => Promise<{ status: number; body: Record<string, unknown> }>; projects: FwdProject[]; selected: string | null; query: string; hi: string; loaded: boolean } | null = null;

  /** A message with no words: its files, as the quote shows it. */
  private filesLine(names: string[], voice: boolean): string {
    if (voice) return "Voice message";
    return names.length ? `📎 ${names.join(", ")}` : "Message";
  }

  /** Forward to Projects: the dialog (the message quoted, a prompt, the project), Hub's projects read meanwhile. */
  private forwardToProject(o: { author: string; at: string; section: string; text: string; send: (project: string, prompt: string) => Promise<{ status: number; body: Record<string, unknown> }> }): void {
    const b = this.bus;
    const meta = quoteMeta({ author: o.author, time: o.at ? hhmm(o.at) : "", section: o.section });
    const t = o.text.trim();
    b.fp_author = meta.author;
    b.fp_meta = meta.rest;
    b.fp_text = t.length > 600 ? `${t.slice(0, 600).trimEnd()}…` : t;
    b.fp_prompt = "";
    b.fp_can_send = false;
    b.fp_open = false;
    b.fp_query = "";
    this.fwd = { send: o.send, projects: [], selected: null, query: "", hi: "", loaded: false };
    this.renderFwd();
    this.openDialog("fwd-project", "Forward to Projects", fwdSubtitle(""), "Send", async () => {
      const f = this.fwd;
      if (!f) return;
      const prompt = String(b.fp_prompt ?? "").trim();
      if (!prompt) throw new Error("Write a prompt: what should change?");
      if (!f.selected) throw new Error(f.loaded ? "Pick a project" : "Still reading Hub's projects…");
      b.fp_open = false;
      const r = await f.send(f.selected, prompt);
      const chat = r.body.chat;
      if (r.status !== 200 || chat == null) throw new Error(String(r.body.error ?? "The chat didn't start"));
      // Projects, on the new chat
      this.ctx.openChat?.(String(chat));
    });
    this.dialogCancel = () => {
      this.fwd = null;
      b.fp_open = false;
    };
    b.d_text = fwdSubtitle(this.fwdProject()?.name ?? "");
    void this.loadFwdProjects();
  }

  private fwdProject(): FwdProject | null {
    const f = this.fwd;
    return f?.projects.find((p) => p.id === f.selected) ?? null;
  }

  private async loadFwdProjects(): Promise<void> {
    const f = this.fwd;
    if (!f) return;
    const r = await this.api("GET", "projects").catch((e: unknown) => ({ status: 500, body: { error: e instanceof Error ? e.message : String(e) } as Record<string, unknown> }));
    if (this.fwd !== f) return;
    f.loaded = true;
    if (r.status !== 200) {
      this.bus.d_error = String(r.body.error ?? "Couldn't read Hub's projects");
    } else {
      f.projects = (Array.isArray(r.body.projects) ? r.body.projects : []) as FwdProject[];
      f.selected = typeof r.body.selected === "string" ? r.body.selected : (f.projects[0]?.id ?? null);
    }
    this.renderFwd();
  }

  private renderFwd(): void {
    const f = this.fwd;
    const b = this.bus;
    if (!f) return;
    const p = this.fwdProject();
    b.fp_name = p ? p.name : f.loaded ? "Pick a project" : "Reading Hub's projects…";
    b.fp_path = p?.short ?? "";
    if (b.dialog === "fwd-project") b.d_text = fwdSubtitle(p?.name ?? "");
    const rows = pickerRows(f.projects, f.query, f.selected);
    b.fp_rows = rows.map((r) => ({ ...r, name: r.kind === "head" ? r.name.toUpperCase() : r.name, hi: r.kind === "item" && r.id === f.hi }));
    // the list's height: every row, at most ~9 projects (it scrolls past that)
    const h = rows.reduce((n, r) => n + (r.kind === "head" ? 26 : 32), 8);
    b.fp_list_h = Math.min(h, 304);
  }

  private fwdToggle(): void {
    const f = this.fwd;
    if (!f) return;
    if (this.bus.fp_open) return this.fwdClosePicker();
    f.query = "";
    f.hi = f.selected ?? "";
    this.bus.fp_query = "";
    this.renderFwd();
    this.bus.fp_open = true;
  }

  private fwdClosePicker(): void {
    this.bus.fp_open = false;
    this.bus.fp_focus_rev = (Number(this.bus.fp_focus_rev) || 0) + 1;
  }

  private fwdPick(id: string): void {
    const f = this.fwd;
    if (!f || !f.projects.some((p) => p.id === id)) return;
    f.selected = id;
    this.bus.d_error = "";
    this.renderFwd();
    this.fwdClosePicker();
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
    this.saveFolds();
  }

  /** The sidebar's folds as last left on this PC (the engine's folds.json): sections, stores, Settled, Site requests. */
  private async loadFolds(): Promise<void> {
    const r = await this.ctx.call("GET", "v1/persons/folds").catch(() => null);
    if (!r || r.status !== 200) return;
    const f = foldsOf(r.body);
    this.ui.closed = new Set(f.closed);
    this.ui.stores = new Set(f.stores);
    this.ui.settledOpen = new Set(f.settledOpen);
    this.ui.order = f.order;
  }

  /** The sidebar's sections top first, as shown (Stores and the engine's lists, in the order the user dragged them). */
  private sections(): string[] {
    return sectionOrder(["stores", ...(this.state?.lists ?? []).map((l) => l.id)], this.ui.order);
  }

  /** Section `from` takes section `to`'s place in the sidebar (a drag, or the section menu's Move up / Move down). */
  private moveSectionTo(from: string, to: string): void {
    const next = moveSection(this.sections(), from, to);
    if (!next) return this.render();
    this.ui.order = next;
    this.render();
    this.saveFolds();
  }

  private saveFolds(): void {
    const body = { closed: [...this.ui.closed], stores: [...this.ui.stores], settledOpen: [...this.ui.settledOpen], order: this.ui.order ?? [] };
    void this.ctx.call("POST", "v1/persons/folds", undefined, body).catch(() => {});
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
    this.stopTileAudio();
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
    else tab?.["trim"]();
  },
  snapshot: () => tab?.snapshot() ?? null,
  restore: (s) => tab?.restore(s),
};

/** A request's turn with the AI is on its way: a note queued, or an answer being written. */
function srAiBusy(ai: readonly AiJson[]): boolean {
  return ai.some((a) => a.streaming || a.queued);
}

/** The engine's folds reply (GET v1/persons/folds), anything odd left out. */
export function foldsOf(v: unknown): { closed: string[]; stores: string[]; settledOpen: string[]; order: string[] } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []);
  return { closed: ids(o.closed), stores: ids(o.stores), settledOpen: ids(o.settledOpen), order: ids(o.order) };
}
