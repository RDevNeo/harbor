// Pure parts of the Persons tab: the v1/persons JSON (API.md) turned into the sidebar's, the list's and the chat's
// rows (Sidebar.tsx, App.tsx, Chat.tsx in Person Hub). No Slint here, so it is unit tested.

import { plainEmoji } from "./emoji.ts";
import { attachTypeOf } from "./attachkind.ts";

export type SectionId = "stores" | "creators" | "spokpay" | "neobux" | "personal";

export interface RowJson {
  lastAt: string | null;
  /** Unread messages plus the Person AI's answers not seen yet (`aiUnread` of them). */
  unread: number;
  aiUnread?: number;
  presence: string | null;
  status: { text: string; tone: string } | null;
  channel: string | null;
  typing: string | null;
}
export interface PersonJson {
  id: string;
  name: string;
  initials: string;
  color: string;
  avatar: string | null;
  avatarPath: string | null;
  storeIds: string[];
  listIds: string[];
  settled: Record<string, boolean>;
  rows: Record<string, RowJson>;
  search: string;
  /** People linked into them (Link with…). */
  linked?: { id: string; name: string }[];
}
export interface StoreJson { id: string; name: string; color: string; image: string | null; imagePath: string | null; ownerId: string | null; count: number }
export interface ListJson { id: string; name: string; accountId: string }
export interface ConnJson { id: string; kind: string; section: string; also?: string[]; status: string; gateway: string; label: string; who: string; error: string | null; qr: string | null; contacts: boolean | null }
/** The PC's audio player (the engine plays voice messages): `pos` at `at` (ms), moving `speed` s/s while playing. */
export interface AudioStateJson { key: string | null; playing: boolean; pos: number; speed: number; duration: number | null; at: number; error: string | null }
/** A SpokPay site request in the SpokPay section's list (the engine's routes.ts siteRequestsJson). */
export interface SrRowJson {
  ref: string;
  subject: string;
  store: string;
  storeSlug: string | null;
  initials: string;
  line: string;
  waiting: boolean;
  unread: boolean;
  at: number;
  side: { text: string; tone: "info" | "warning" } | null;
  iconPath: string | null;
  icon: string | null;
  url: string;
}
/** A site request's pane (the engine's GET v1/persons/site-request/{ref}: srpane.ts PaneView and the store's face). */
export interface SrFileJson { url: string; name: string; image: boolean; src: string | null }
export interface SrFactJson { label: string; text: string; full: boolean }
export type SrItemJson =
  | { kind: "event"; id: string; text: string; at: number }
  | { kind: "msg"; id: string; mine: boolean; side: string; author: string; head: string; text: string; files: SrFileJson[]; joinsPrev: boolean; joinsNext: boolean; at: number };
export interface SrPaneJson {
  ref: string;
  subject: string;
  status: string;
  statusLabel: string;
  tone: string;
  store: string;
  storeSlug: string | null;
  initials: string;
  iconPath: string | null;
  icon: string | null;
  url: string;
  brief: { title: string; sub: string; summary: string; facts: SrFactJson[]; files: SrFileJson[] };
  factRows: [SrFactJson, SrFactJson | null][];
  /** The confirm dialog before a final move. */
  confirms: Record<"completed" | "closed", { title: string; text: string; ok: string }>;
  items: SrItemJson[];
  statuses: { status: string; label: string; current: boolean }[];
  finished: boolean;
  finishedNote: string;
  /** Who the composer writes to (the store owner) and its "Message <owner> on SpokPay". */
  owner: string;
  placeholder: string;
  /** The person linked to the store ("To <avatar> <name>"; their Person AI hears the notes), else null. */
  person: { id: string; section: string; name: string; initials: string; color: string; avatarPath: string | null; avatar: string | null } | null;
  /** The Person AI chat its notes go to, once there is one. */
  aiChat: string | null;
  /** Its own turns with the Person AI (the notes sent from this pane and the answers to them), in time order. */
  ai?: AiJson[];
  hasMore: boolean;
  writeBlocked: string | null;
  statusBlocked: string | null;
  lastActivityAt: number;
  note: string | null;
}

/** A picture's drawn size in the pane: its own shape inside 240 × 180 (a placeholder's until it's decoded). */
export function srImageSize(w: number, h: number, maxW = 240, maxH = 180): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 160, h: 120 };
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(24, Math.round(w * k)), h: Math.max(24, Math.round(h * k)) };
}

export interface SrListJson { waits: boolean; notices: { title: string; text: string }[]; rows: SrRowJson[] }
export interface StateJson { rev: number; unread: number; connections: ConnJson[]; stores: StoreJson[]; lists: ListJson[]; people: PersonJson[]; loading?: boolean; audio?: AudioStateJson | null; siteRequests?: SrListJson | null }

/** One sidebar / list row, as PRow in persons.slint (images filled in by the driver). */
export interface Row {
  /** sr-*: the SpokPay section's Site requests (Headquarters' Home list): its heading, a notice, "none open", a request, the gap after. */
  kind: "all" | "section" | "store" | "person" | "settled" | "empty" | "sr-head" | "sr-notice" | "sr-empty" | "sr" | "sr-gap";
  id: string;
  section: string;
  store: string;
  name: string;
  initials: string;
  color: string;
  avatarPath: string;
  presence: string;
  status: string;
  tone: string;
  channel: string;
  time: string;
  unread: number;
  typing: string;
  owner: boolean;
  active: boolean;
  expanded: boolean;
  count: number;
  depth: number;
  dim: boolean;
  /** A row's tooltip (a site request: who spoke last). */
  tip: string;
}

export interface UiState {
  /** Sections folded shut, store ids unfolded, sections whose Settled fold is open. */
  closed: Set<string>;
  stores: Set<string>;
  settledOpen: Set<string>;
  /** The open person and the row they were opened from. */
  open: { id: string; section: string; store: string } | null;
  allActive: boolean;
  /** The site request last opened from the list (its row shows as current); "sr" in `closed` folds the list. */
  srOpen?: string | null;
  /** The sections top first as last dragged (`sectionOrder`); [] = Stores, then the lists as the engine has them. */
  order?: string[];
}

/** The sections in the order the user dragged them: those in `order` first, as there, then the rest as they come. */
export function sectionOrder(ids: readonly string[], order: readonly string[] = []): string[] {
  const known = new Set(ids);
  const first = [...new Set(order)].filter((id) => known.has(id));
  return [...first, ...ids.filter((id) => !first.includes(id))];
}

/** Section `from` dropped on section `to` (shown in the order `ids`): it takes `to`'s place (dragged up it goes above
 *  `to`, dragged down below it). The whole new order, or null when nothing moves. */
export function moveSection(ids: readonly string[], from: string, to: string): string[] | null {
  const i = ids.indexOf(from);
  const j = ids.indexOf(to);
  if (i < 0 || j < 0 || i === j) return null;
  const out = ids.filter((id) => id !== from);
  out.splice(j, 0, from);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "now", "5m ago", "1h ago", "3d ago", then "Nov 3" (conversation.ts shortAgo). */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const t = new Date(iso);
  return `${MONTHS[t.getMonth()]} ${t.getDate()}`;
}

const at = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Newest message first (over all their channels); no messages: last, by name (calm.ts byRecent). */
export function byRecent(a: PersonJson, b: PersonJson): number {
  const x = at(a.rows[""]?.lastAt), y = at(b.rows[""]?.lastAt);
  if (x !== y) return x && y ? y - x : x ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** The sections that are lists (a person joins them, not a store), in sidebar order. */
export const LIST_SECTIONS: readonly string[] = ["creators", "spokpay", "neobux", "personal"];

const SECTION_NAMES: Record<string, string> = { stores: "STORES", creators: "CREATORS", spokpay: "SPOKPAY", neobux: "NEOBUX", personal: "PERSONAL" };

function base(kind: Row["kind"]): Row {
  return { kind, id: "", section: "", store: "", name: "", initials: "", color: "#64748b", avatarPath: "", presence: "", status: "", tone: "", channel: "", time: "", unread: 0, typing: "", owner: false, active: false, expanded: false, count: 0, depth: 0, dim: false, tip: "" };
}

/**
 * Headquarters' Home › Site requests (chat-list/Section.tsx FoldingSection, chat-list/Row.tsx, spokpay/home/row.ts), at
 * the top of the SpokPay section: the heading ("Site requests", amber dot while one waits on SpokPay, the count, the
 * chevron), its notices, "No site request is open at SpokPay." or one row per request (the store's square icon, the
 * subject, the store's side or "Nothing new", the ref on the right), newest activity first.
 */
export function siteRequestRows(sr: SrListJson, ui: UiState): Row[] {
  const open = !ui.closed.has("sr");
  const out: Row[] = [{ ...base("sr-head"), id: "sr", section: "spokpay", name: "Site requests", count: sr.rows.length, expanded: open, tone: sr.waits ? "needs" : "" }];
  if (open) {
    for (const n of sr.notices) out.push({ ...base("sr-notice"), section: "spokpay", name: n.title, status: n.text });
    if (!sr.rows.length) out.push({ ...base("sr-empty"), section: "spokpay", name: "No site request is open at SpokPay." });
    for (const r of sr.rows)
      out.push({
        ...base("sr"),
        id: r.ref,
        section: "spokpay",
        name: r.subject || r.ref,
        initials: r.initials,
        avatarPath: r.iconPath ?? "",
        status: r.side?.text ?? "Nothing new",
        tone: r.side?.tone ?? "",
        time: r.ref,
        active: !!ui.srOpen && ui.srOpen === r.ref,
        tip: r.line,
      });
  }
  out.push({ ...base("sr-gap"), section: "spokpay" });
  return out;
}

export function personRow(p: PersonJson, section: string, store = "", depth = 0, open: UiState["open"] = null): Row {
  const r = p.rows[section] ?? p.rows[""];
  return {
    ...base("person"),
    id: p.id,
    section,
    store,
    name: p.name,
    initials: p.initials,
    color: p.color,
    avatarPath: p.avatarPath ?? "",
    presence: r?.presence ?? "",
    status: r?.status?.text ?? "",
    tone: r?.status?.tone ?? "",
    channel: r?.channel ?? "",
    time: shortAgo(r?.lastAt),
    unread: r?.unread ?? 0,
    typing: r?.typing ?? "",
    depth,
    active: !!open && open.id === p.id && open.section === section && open.store === store,
  };
}

/** Whether a connection serves a section: its own, or one it's shared with (Personal uses the Stores Discord and WhatsApp,
 *  Neobux the Creators ones until it has its own). */
export const servesSection = (c: Pick<ConnJson, "section" | "also">, section: string): boolean => c.section === section || !!c.also?.includes(section);

/** A section's connections as one status dot: red when one is signed out, yellow while one connects. */
function connDot(conns: ConnJson[], section: string): { status: string; tone: string } {
  const mine = conns.filter((c) => servesSection(c, section));
  if (!mine.length) return { status: "", tone: "" };
  const off = mine.filter((c) => c.status === "signed-out" || c.status === "signing-in");
  if (off.length) return { status: `${off.map((c) => c.label).join(", ")}: signed out`, tone: "red" };
  const busy = mine.filter((c) => c.status !== "connected" || c.gateway === "down");
  if (busy.length) return { status: "Connecting…", tone: "yellow" };
  return { status: "", tone: "" };
}

/** The sidebar (Sidebar.tsx): All people, Stores (each store folds open: owner, then members), then each list. */
export function sideRows(s: StateJson, ui: UiState): Row[] {
  const out: Row[] = [];
  out.push({ ...base("all"), name: "All people", count: s.people.length, active: ui.allActive && !ui.open });
  const byId = new Map(s.people.map((p) => [p.id, p]));
  const settledIn = (p: PersonJson, sec: string): boolean => !!p.settled[sec];
  const sectionRows = (sec: SectionId, name: string, all: PersonJson[], body: () => void, settled: PersonJson[], storeOf?: (p: PersonJson) => string): void => {
    const unread = all.filter((p) => !settledIn(p, sec)).reduce((n, p) => n + (p.rows[sec]?.unread ?? 0), 0);
    const dot = connDot(s.connections, sec);
    const open = !ui.closed.has(sec);
    out.push({ ...base("section"), id: sec, section: sec, name, unread, expanded: open, status: dot.status, tone: dot.tone });
    if (!open) return;
    body();
    if (settled.length) {
      const so = ui.settledOpen.has(sec);
      out.push({ ...base("settled"), section: sec, count: settled.length, expanded: so });
      if (so) for (const p of [...settled].sort((a, b) => a.name.localeCompare(b.name))) out.push({ ...personRow(p, sec, storeOf?.(p) ?? "", 0, ui.open), dim: true });
    }
  };
  // each section's rows, written in the order the user dragged them (sectionOrder)
  const emit = new Map<string, () => void>();
  const storePeople = s.people.filter((p) => p.storeIds.length > 0 || s.stores.some((st) => st.ownerId === p.id));
  emit.set("stores", () => sectionRows("stores", SECTION_NAMES.stores!, storePeople, () => {
    if (!s.stores.length) out.push({ ...base("empty"), name: "No stores yet." });
    for (const st of [...s.stores].sort((a, b) => a.name.localeCompare(b.name))) {
      const owner = st.ownerId ? byId.get(st.ownerId) : undefined;
      const shownOwner = owner && !settledIn(owner, "stores") ? owner : undefined;
      const members = s.people.filter((p) => p.storeIds.includes(st.id) && p.id !== owner?.id && !settledIn(p, "stores")).sort(byRecent);
      const expanded = ui.stores.has(st.id);
      const unread = [shownOwner, ...members].reduce((n, p) => n + (p?.rows.stores?.unread ?? 0), 0);
      out.push({ ...base("store"), id: st.id, section: "stores", store: st.id, name: st.name, initials: st.name.trim().charAt(0).toUpperCase(), color: st.color, avatarPath: st.imagePath ?? (owner?.avatarPath ?? ""), count: st.count, expanded, unread: expanded ? 0 : unread });
      if (!expanded) continue;
      if (!shownOwner && !members.length) out.push({ ...base("empty"), name: "No one yet.", depth: 1 });
      if (shownOwner) out.push({ ...personRow(shownOwner, "stores", st.id, 1, ui.open), owner: true });
      for (const p of members) out.push(personRow(p, "stores", st.id, 1, ui.open));
    }
  }, storePeople.filter((p) => settledIn(p, "stores")), (p) => p.storeIds[0] ?? s.stores.find((st) => st.ownerId === p.id)?.id ?? ""));
  for (const l of s.lists) {
    if (emit.has(l.id)) continue;
    emit.set(l.id, () => {
      const sec = l.id as SectionId;
      const all = s.people.filter((p) => p.listIds.includes(l.id)).sort(byRecent);
      const settled = all.filter((p) => settledIn(p, sec));
      const members = all.filter((p) => !settledIn(p, sec));
      sectionRows(sec, l.name.toUpperCase(), all, () => {
        if (sec === "spokpay" && s.siteRequests) out.push(...siteRequestRows(s.siteRequests, ui));
        if (!all.length) out.push({ ...base("empty"), name: "No one yet." });
        for (const p of members) out.push(personRow(p, sec, "", 0, ui.open));
      }, settled);
    });
  }
  for (const id of sectionOrder([...emit.keys()], ui.order)) emit.get(id)!();
  return out;
}

export function matches(p: PersonJson, q: string): boolean {
  const n = q.trim().toLowerCase().replace(/^@/, "");
  if (!n) return true;
  const hay = `${p.name.toLowerCase()} ${p.search}`;
  return n.split(/\s+/).every((w) => hay.includes(w));
}

export function listRows(s: StateJson, q: string, open: UiState["open"]): Row[] {
  return s.people.filter((p) => matches(p, q)).sort(byRecent).map((p) => personRow(p, "", "", 0, open && open.section === "" ? open : null));
}

// ---------- chat ----------

/** An attachment; audio ones carry their key (play, transcribe), bars 0..1, whether it was played and its transcript. */
export interface FileJson { name: string; url: string; raw: string; type: string | null; size: number | null; width: number | null; height: number | null; kind: string; image: boolean; video?: boolean; poster?: string; duration: number | null; audio?: string; bars?: number[] | null; played?: boolean; transcript?: string | null; transcribing?: boolean; transcriptFailed?: boolean }
/** The chat a message is in (a person's page shows every chat of theirs in one timeline). */
export interface ChannelJson { key: string; kind: string; label: string }
export interface MsgJson { id: string; fromMe: boolean; text: string; at: string; edited: boolean; subject: string | null; threadId: string | null; status: string | null; voice: boolean; embed: boolean; forwarded?: boolean; reply: { id: string; text: string; fromMe: boolean } | null; files: FileJson[]; channel?: ChannelJson }
export interface OutJson { key: string; text: string; status: string; error: string | null; open?: string | null; at: string; subject: string | null; files: { name: string; type: string; size: number }[]; channel?: ChannelJson }
/** An answer's pieces (the engine's persons aiparts.ts): markdown, and the messages it drafted for the person (```reply). */
export type AiPartJson = { type: "text"; text: string } | { type: "draft"; text: string };
export interface AiJson { id: string; role: "user" | "assistant"; text: string; at: string; streaming?: boolean; queued?: boolean; parts?: AiPartJson[]; forwarded?: { from: string; text: string } }
export type ProposalStateJson = { kind: "waiting" } | { kind: "opening"; startedAt: number } | { kind: "opened"; at: number; ref: string } | { kind: "failed"; at: number; reason: string; fix: string } | { kind: "discarded"; at: number };
/** A SpokPay site request proposed from a message (the engine's routes.ts proposalJson). */
export interface ProposalJson { id: string; at: string; messageId: string | null; store: { slug: string; name: string } | null; category: string; subject: string; details: string; brief: Record<string, string>; why: string; from: string; chat: string | null; images: number; state: ProposalStateJson }
export interface ProposingJson { personId: string; messageId: string; at: string; chat: string | null; error: string | null }
/**
 * The chat header's friend button from the Discord relationship: "add" (Add friend), "accept" (they asked), "sent"
 * (disabled Request sent), "sending" (the click is on its way), "" hidden (friends, blocked, not Discord).
 */
export function friendButton(relation: string | null, sending: boolean): string {
  if (relation === null || relation === "friend" || relation === "blocked") return "";
  if (relation === "sent") return "sent";
  if (sending) return "sending";
  return relation === "incoming" ? "accept" : "add";
}

/** A path in Discord ("/users/<id>", "/channels/@me/<id>") as the app's link and the web's, for `desktop.openApp`. */
export function discordLinks(path: string): { app: string; web: string } {
  return { app: `discord://-${path}`, web: `https://discord.com${path}` };
}

export interface ChatJson {
  person: { id: string; name: string; initials: string; color: string; avatar: string | null; avatarPath: string | null; presence: string | null; status: { text: string; tone: string } | null };
  /** The chat the composer sends on: `id` is its key ("<connection>:<who>", what `account` takes back). */
  account: { id: string; conn?: string; kind: string; section: string; label: string; to?: string; connected: boolean } | null;
  accounts: { id: string; conn?: string; kind: string; label: string; to?: string; connected?: boolean }[];
  peer: string | null;
  /** Discord: friend | sent | incoming | blocked | none; null on the other channels (or signed out). */
  relation?: string | null;
  typing: string | null;
  more: boolean;
  unreadFrom: string | null;
  messages: MsgJson[];
  outgoing: OutJson[];
  ai: AiJson[];
  /** The person's AI is there: the composer's AI switch, Forward to AI. */
  aiOn?: boolean;
  /** The AI's Hub chat (the composer's "Open in Projects"). */
  aiChat?: string | null;
  /** Open Site Request in the message menu (SpokPay people and store owners, SpokPay connected). */
  siteRequests?: boolean;
  proposals?: ProposalJson[];
  proposing?: ProposingJson[];
  /** People linked into this one (Unlink). */
  linked?: { id: string; name: string }[];
}

/** An audio attachment in a bubble: play / pause, bars with seek, its length, speed, played, Transcribe. */
export interface AudioRow {
  key: string;
  /** The file route (play, transcribe): account, raw url, name. */
  account: string;
  raw: string;
  name: string;
  duration: number;
  bars: number[];
  played: boolean;
  transcript: string;
  /** Being transcribed now (in the background or on a click); the background one failed. */
  transcribing: boolean;
  failed: boolean;
  voice: boolean;
}

/** A picture in a message's bubble: its file route (the driver decodes it) and its place in the bubble's image box.
 * A video's tile draws its poster (`poster`, a route) with ▶ and its length (`dur`); `size` its bytes when known. */
export interface ImgTile {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  video?: boolean;
  poster?: string;
  dur?: string;
  size?: number | null;
  /** A picture the image decoder can't read (HEIC, BMP…): drawn from an ffmpeg still of it. */
  still?: boolean;
}

/** Pictures sharp doesn't decode (iPhones' HEIC, BMP, TIFF from some scanners…): their bubble draws an ffmpeg still. */
export function needsStill(name: string, type?: string | null): boolean {
  const t = attachTypeOf(name, type);
  return t.kind === "image" && !t.direct;
}

/** A file below a bubble's text (not a picture, video or the bubble's audio): its file route ("" for one still being
 *  sent), name, MIME type and size; the tab draws it with its preview (a PDF's first page) or its type's icon. */
export interface FileRow {
  url: string;
  name: string;
  type: string | null;
  size: number | null;
}

/** A message's files drawn as file cards below its bubble (index = PersonsBus.open-file's): every file that isn't a
 *  picture, a video or the one audio the bubble plays. */
export function restFiles(m: Pick<MsgJson, "files" | "voice">): FileJson[] {
  const sound = m.files.find((f) => !f.image && !f.video && (f.kind === "audio" || m.voice));
  return m.files.filter((f) => !f.image && !f.video && f !== sound);
}

/** One chat row (PMsg); `images`: every picture of the message, tiled in a box of `imgW` × `imgH`. */
export interface MsgRow {
  kind: "msg" | "day" | "unread" | "subject" | "ai" | "out" | "proposal" | "proposing";
  id: string;
  mine: boolean;
  text: string;
  time: string;
  meta: string;
  reply: string;
  /** The id of the message it replies to ("" none, or only forwarded): a click on the quote jumps there. */
  replyId: string;
  images: ImgTile[];
  imgW: number;
  imgH: number;
  files: FileRow[];
  first: boolean;
  failed: boolean;
  /** Failed on Discord's captcha: the click's menu opens it in Discord's app. */
  inDiscord: boolean;
  sending: boolean;
  streaming: boolean;
  /** The user's question to the Person AI (kind "out"). */
  toAi: boolean;
  /** The AI's answer in pieces (kind "ai"); a whole answer as markdown when the engine sent none. */
  parts: AiPartJson[];
  /** A site request card (kind "proposal" / "proposing"): its title, the line under it, its state, a note. */
  card: { title: string; sub: string; state: string; note: string; why: string; chat: boolean };
  /** An AI answer folded to its header, a short preview and its first draft (`aiFolds`). */
  folded: boolean;
  /** A folded answer's text as one plain paragraph (markdown marks dropped), for its first lines. */
  preview: string;
  /** Its first ```reply draft ("" none): the folded bubble keeps "Use as reply" on one line. */
  draft: string;
  /** The channel it came or went on ("whatsapp"…) and its label, shown when the person has more than one chat. */
  chan: string;
  chanLabel: string;
  /** Its voice message or audio file, drawn as a player. */
  audio: AudioRow | null;
  /** The day it's on, as its day line says ("Today"…): the floating day pill while the chat scrolls. */
  day: string;
}

/** Bars of an audio without a waveform: a flat line (the player still seeks on it). */
export const FLAT_BARS: number[] = Array.from({ length: 40 }, () => 0.18);

export const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const n = new Date(now);
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10 << 20 ? 1 : 0)} MB`);
const duration = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const TICKS: Record<string, string> = { pending: "🕓", sent: "✓", delivered: "✓✓", read: "✓✓ read", error: "!" };

/** The image size in the bubble: at most 280 × 320, keeping the ratio. */
export function fitImage(w: number | null, h: number | null, maxW = 280, maxH = 320): [number, number] {
  if (!w || !h) return [maxW, Math.round(maxW * 0.66)];
  const k = Math.min(1, maxW / w, maxH / h);
  return [Math.max(40, Math.round(w * k)), Math.max(40, Math.round(h * k))];
}

/** A message's pictures in its bubble: one keeps its ratio (`fitImage`); more go two by two in cropped cells (an
 * odd last one takes the whole width). Returns the tiles and the box they fill. */
export function imageTiles(imgs: readonly { url: string; name?: string; type?: string | null; width: number | null; height: number | null; video?: boolean; poster?: string; duration?: number | null; size?: number | null }[], maxW = 280, cellH = 180, gap = 6): { tiles: ImgTile[]; w: number; h: number } {
  if (!imgs.length) return { tiles: [], w: 0, h: 0 };
  const extra = (f: (typeof imgs)[number]): Partial<ImgTile> => (f.video ? { video: true, poster: f.poster ?? "", dur: f.duration ? duration(f.duration) : "", size: f.size ?? null } : needsStill(f.name ?? "", f.type) ? { still: true } : {});
  if (imgs.length === 1) {
    const f = imgs[0]!;
    // a video of unknown size is drawn 16:9 (WhatsApp's and Discord's usually say theirs)
    const [w, h] = f.video && (!f.width || !f.height) ? [maxW, Math.round((maxW * 9) / 16)] : fitImage(f.width, f.height, maxW);
    return { tiles: [{ url: f.url, x: 0, y: 0, w, h, ...extra(f) }], w, h };
  }
  const half = Math.floor((maxW - gap) / 2);
  const tiles = imgs.map((f, i) => {
    const row = Math.floor(i / 2);
    const alone = i === imgs.length - 1 && i % 2 === 0;
    return { url: f.url, x: alone || i % 2 === 0 ? 0 : half + gap, y: row * (cellH + gap), w: alone ? maxW : half, h: cellH, ...extra(f) };
  });
  const rows = Math.ceil(imgs.length / 2);
  return { tiles, w: maxW, h: rows * cellH + (rows - 1) * gap };
}

/** An empty chat row of a kind (the fields every PMsg carries). */
export const blankRow = (kind: MsgRow["kind"], id: string): MsgRow => ({ kind, id, mine: false, text: "", time: "", meta: "", reply: "", replyId: "", images: [], imgW: 0, imgH: 0, files: [], first: true, failed: false, inDiscord: false, sending: false, streaming: false, toAi: false, parts: [], card: { title: "", sub: "", state: "", note: "", why: "", chat: false }, folded: false, preview: "", draft: "", chan: "", chanLabel: "", audio: null, day: "" });

/** A turn with the Person AI as its bubble: the user's note ("out", to the AI) or the AI's answer in parts. */
export function aiRow(a: AiJson): MsgRow {
  const r = blankRow("ai", `ai${a.id}`);
  if (a.role === "user") {
    r.kind = "out";
    r.mine = true;
    r.toAi = true;
  }
  r.text = a.text || (a.streaming ? "…" : "");
  // Forward to AI: the forwarded message quoted over the question (empty: the default one)
  if (a.forwarded) {
    r.reply = `${a.forwarded.from}: ${a.forwarded.text || "…"}`;
    r.text = a.text || "What should I reply to this?";
  }
  if (a.role !== "user") {
    r.parts = a.parts ?? (r.text ? [{ type: "text", text: r.text }] : []);
    r.preview = aiPreview(r.parts);
    r.draft = r.parts.find((p) => p.type === "draft")?.text ?? "";
  }
  r.time = hhmm(a.at);
  r.streaming = !!a.streaming;
  return r;
}

/** A site request pane's timeline: its events and messages with its own AI turns, each where it was sent (by time; a
 *  request's line first when they tie). The AI's answers fold as in person chats (`aiFolds`). */
export type SrLineRow = { kind: "sr"; item: SrItemJson } | { kind: "ai"; row: MsgRow };
export function srTimeline(items: readonly SrItemJson[], ai: readonly AiJson[], toggled: ReadonlyMap<string, boolean>): SrLineRow[] {
  const all: { at: number; order: number; line: SrLineRow }[] = [
    ...items.map((item, i) => ({ at: item.at, order: i, line: { kind: "sr" as const, item } })),
    ...ai.map((a, i) => ({ at: Date.parse(a.at) || 0, order: items.length + i, line: { kind: "ai" as const, row: aiRow(a) } })),
  ];
  all.sort((a, b) => a.at - b.at || a.order - b.order);
  const lines = all.map((x) => x.line);
  aiFolds(lines.flatMap((l) => (l.kind === "ai" ? [l.row] : [])), toggled);
  return lines;
}

/** Messages, AI bubbles and what's being sent, by time, with day separators, the unread line and email subjects. */
/** The unread line (WhatsApp's): "3 unread messages", theirs from `unreadFrom` on. */
export function unreadLabel(c: ChatJson): string {
  const i = c.messages.findIndex((m) => m.id === c.unreadFrom);
  const n = i < 0 ? 0 : c.messages.slice(i).filter((m) => !m.fromMe).length;
  return n <= 1 ? "1 unread message" : `${n} unread messages`;
}

/**
 * The rows an open chat draws at first, and how many more each scroll to its top adds. Slint builds every drawn row
 * (a bubble, its text measured twice), and opening a chat cost more than linearly in them: 400 rows froze the window
 * for seconds, on every chat switch and every return to the tab (rig/personsbench.ts). Older ones come in as it
 * scrolls up, from memory first, then from the engine.
 */
export const CHAT_PAGE = 40;

/** How many of the chat's newest rows to draw so the row `id` is drawn, a few rows below the top (`shown` if it already
 *  is, or when there's no such row). */
export function shownFor(rows: readonly { id: string }[], id: string, shown: number): number {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return shown;
  return Math.max(shown, Math.min(rows.length, rows.length - i + 8));
}

export function chatRows(c: ChatJson, now = Date.now()): MsgRow[] {
  type Item = { at: string; row: MsgRow };
  const items: Item[] = [];
  const blank = blankRow;
  // every message marked with its channel once the page shows more than one chat
  const marks = c.accounts.length > 1;
  let lastThread: string | null = null;
  for (const m of c.messages) {
    const r = blank("msg", m.id);
    r.mine = m.fromMe;
    r.text = m.text || (m.embed ? "(embed)" : "");
    r.time = hhmm(m.at);
    r.meta = [m.edited ? "edited" : "", m.fromMe && m.status ? TICKS[m.status] ?? "" : ""].filter(Boolean).join(" · ");
    if (m.reply) {
      r.reply = `${m.reply.fromMe ? "You" : c.person.name}: ${plainEmoji(m.reply.text) || "…"}`;
      r.replyId = m.reply.id;
    } else if (m.forwarded) r.reply = "Forwarded";
    // every picture and video shown in the bubble (none of them again as a file below it)
    const imgs = m.files.filter((f) => f.image || f.video);
    const box = imageTiles(imgs);
    r.images = box.tiles;
    r.imgW = box.w;
    r.imgH = box.h;
    const sound = m.files.find((f) => !f.image && !f.video && (f.kind === "audio" || m.voice));
    if (sound) r.audio = audioRow(sound, m.voice, c.account?.conn ?? c.account?.id ?? "");
    r.files = restFiles(m).map((f) => ({ url: f.url, name: f.name, type: f.type, size: f.size }));
    if (marks && m.channel) {
      r.chan = m.channel.kind;
      r.chanLabel = m.channel.label;
    }
    if (m.subject && m.threadId !== lastThread) items.push({ at: m.at, row: { ...blank("subject", `s${m.id}`), text: m.subject } });
    if (m.threadId) lastThread = m.threadId;
    if (c.unreadFrom === m.id) items.push({ at: m.at, row: { ...blank("unread", `u${m.id}`), text: unreadLabel(c) } });
    items.push({ at: m.at, row: r });
  }
  for (const a of c.ai) items.push({ at: a.at, row: aiRow(a) });
  for (const o of c.outgoing) {
    const r = blank("out", `o${o.key}`);
    r.mine = true;
    r.text = o.text;
    r.time = hhmm(o.at);
    r.failed = o.status === "failed";
    r.sending = o.status === "sending";
    // being sent: pictures and the rest alike as file cards (no route yet)
    r.files = o.files.map((f) => ({ url: "", name: f.name, type: f.type || null, size: f.size }));
    if (o.error) r.meta = o.error;
    r.inDiscord = r.failed && !!o.open;
    if (marks && o.channel) {
      r.chan = o.channel.kind;
      r.chanLabel = o.channel.label;
    }
    items.push({ at: o.at, row: r });
  }
  for (const p of c.proposals ?? []) {
    const r = blank("proposal", `p${p.id}`);
    r.time = hhmm(p.at);
    r.text = p.details;
    r.card = proposalCard(p);
    items.push({ at: p.at, row: r });
  }
  for (const p of c.proposing ?? []) {
    const r = blank("proposing", `q${p.messageId}`);
    r.time = hhmm(p.at);
    r.card = { title: p.error ? "The SpokPay agent couldn’t draft it" : "The SpokPay agent is drafting a site request… (about 10–20 s)", sub: "", state: p.error ? "failed" : "drafting", note: p.error ?? "", why: "", chat: !!p.chat };
    items.push({ at: p.at, row: r });
  }
  items.sort((a, b) => at(a.at) - at(b.at));
  const out: MsgRow[] = [];
  let day = "";
  let dayText = "";
  let prev: MsgRow | null = null;
  let prevAt = 0;
  for (const it of items) {
    const k = dayKey(it.at);
    if (k !== day) {
      day = k;
      dayText = dayLabel(it.at, now);
      out.push({ ...blank("day", `d${k}`), text: dayText, day: dayText });
      prev = null;
    }
    it.row.day = dayText;
    const t = at(it.at);
    if (it.row.kind === "msg" || it.row.kind === "out" || it.row.kind === "ai") {
      it.row.first = !(prev && prev.kind === it.row.kind && prev.mine === it.row.mine && t - prevAt < 7 * 60_000);
      prev = it.row;
      prevAt = t;
    } else prev = null;
    out.push(it.row);
  }
  return out;
}

/** An audio attachment as the bubble's player: its account comes from its file route (the chat it is in). */
export function audioRow(f: FileJson, voice: boolean, fallbackAccount: string): AudioRow {
  let account = fallbackAccount;
  try {
    account = new URL(f.url, "http://hub").searchParams.get("account") ?? fallbackAccount;
  } catch {
    // keep the chat's
  }
  return {
    key: f.audio ?? `${account}:${f.name}:0`,
    account,
    raw: f.raw,
    name: f.name,
    duration: f.duration ?? 0,
    bars: f.bars?.length ? f.bars : FLAT_BARS,
    played: f.played !== false,
    transcript: f.transcript ?? "",
    transcribing: !!f.transcribing,
    failed: !!f.transcriptFailed,
    voice,
  };
}

/** "0:08", "1:23" (an audio's length or position). */
export const clock = (s: number): string => duration(Math.max(0, s));

/** The next playback speed: 1x → 1.5x → 2x → 1x. */
export const nextSpeed = (s: number): number => (s < 1.25 ? 1.5 : s < 1.75 ? 2 : 1);

/** An answer's text parts as one plain paragraph for a folded bubble's first lines: markdown marks, links' urls,
 *  code fences and line breaks dropped (the bubble elides it after two lines). */
export function aiPreview(parts: readonly AiPartJson[], max = 400): string {
  const text = parts
    .filter((p) => p.type !== "draft")
    .map((p) => p.text)
    .join("\n")
    .replace(/^```.*$/gm, "")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Folds the AI's answers: the newest one stays open, older ones fold, and the user's own toggle (by row id, kept for
 *  the session) wins. One still being written never folds. Returns the rows, changed in place. */
export function aiFolds(rows: MsgRow[], toggled: ReadonlyMap<string, boolean>): MsgRow[] {
  let newest = "";
  for (const r of rows) if (r.kind === "ai") newest = r.id;
  for (const r of rows) {
    if (r.kind !== "ai") continue;
    r.folded = !r.streaming && (toggled.get(r.id) ?? r.id !== newest);
  }
  return rows;
}

const CATEGORY: Record<string, string> = { website: "Website", catalog: "Catalog", delivery: "Delivery", dashboard: "Dashboard", other: "Other" };

/** A proposal's card: subject, "store · category · N images", its state and the line that goes with it. */
export function proposalCard(p: ProposalJson): MsgRow["card"] {
  const sub = [p.store ? p.store.name || p.store.slug : "No store picked", CATEGORY[p.category] ?? p.category, p.images ? `${p.images} ${p.images === 1 ? "image" : "images"}` : ""].filter(Boolean).join(" · ");
  const st = p.state;
  const note = st.kind === "opened" ? `Opened as ${st.ref}` : st.kind === "failed" ? `Not opened: ${st.reason}` : st.kind === "opening" ? "Opening…" : !p.store ? "Pick the store (Edit) before opening it." : "";
  return { title: p.subject || "(no subject)", sub, state: st.kind, note, why: p.why ? `${p.from}: ${p.why}` : p.from, chat: !!p.chat };
}

/** The sections a person is in (for Settle in the All people menu): Stores when in a store, and their lists that are sections. */
export function personSections(p: Pick<PersonJson, "storeIds" | "listIds">): string[] {
  return [...(p.storeIds.length ? ["stores"] : []), ...p.listIds.filter((x) => LIST_SECTIONS.includes(x))];
}
