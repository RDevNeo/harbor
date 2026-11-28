// Collector tab, window side: drives CollectorBus (slint/collector.slint) from the engine's view (GET v1/collector, the
// same routes Hub for Android calls) and sends every change back. Five views (Collector, Available, Approved, Restricted,
// History), picked in the sidebar; one filter box on the lists. History is every search run by day (Headquarters'
// Timeline); a click on one shows the leads it found. A lead's detail has the review bar (Reject / Skip / Approve / Neobux,
// R S A N, ↓ Skip; Approve puts them in the Approved list and Persons › Creators, Neobux in Approved and Persons ›
// Neobux): each goes on to the next lead of the list the detail was opened from, as a send from its Send message does.
// ← and → go to the previous / next lead in every list. Pictures and video thumbnails are files the engine cached, decoded here.
// While a run is going it re-reads every second; otherwise on the tabs' change events.
// Send message is a real send: it only goes out from the dialog's second step ("Send now").
import * as slint from "slint-ui";
import { readFileSync, statSync } from "node:fs";
import { clipboard, images } from "@harbor/media";
import type { TabCtx, TabUi } from "../api.ts";
import { REACH_META, reachError } from "../../../../../tabs/collector/lib/reach.ts";
import { CONTACT_HINT, CONTACT_LABEL } from "../../../../../tabs/collector/lib/contacts.ts";
import { compactCount } from "../../../../../tabs/collector/lib/format.ts";
import { REACH_KINDS, type ReachKind } from "../../../../../tabs/collector/lib/types.ts";
import type { DetailView } from "../../../../../tabs/collector/view.ts";
import type { HistoryDay } from "../../../../../tabs/collector/lib/history.ts";

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
const NO_PX: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"];

interface Source {
  value: string;
  label: string;
  available: boolean;
  why: string;
  note: string;
}
export interface Row {
  id: string;
  name: string;
  handle: string;
  platform: string;
  url: string;
  short: string;
  avatarPath: string | null;
  email: string;
  emailSource: string;
  videos: { url: string; title: string; thumbPath: string | null }[];
  restricted: boolean;
  /** In Approved (not Available). */
  approved?: boolean;
  /** In Sent (a message reached them), when (ISO) and "Email · 27 Nov 2026". */
  sent?: boolean;
  sentAt?: string;
  sentLine?: string;
  /** Approved's "Neobux · 27 Nov 2026" (the Persons list Approve put them in, "Approved · …" the list alone). */
  approvedLine?: string;
  /** "youtube", "tiktok", "instagram". */
  platformKey?: string;
  /** Followers (YouTube subscribers count as followers; null unknown). */
  subs?: number | null;
  /** The Reach picked in the detail ("" none) and its value. */
  reach?: string;
  reachValue?: string;
  /** Every way to contact them, best first (view.ts ContactView). */
  contacts?: { kind: string; text: string; value: string; source: string; href: string; tip: string }[];
}
export interface CollectorView {
  rev: number;
  settings: { platform: string; query: string; gapDays: number; target: number; lastTemplate: string; approveTo?: string; sort?: string; platforms?: string[] };
  sources: Source[];
  sessions: { platform: string; label: string; connected: boolean; account: string | null; savedAt: number; help: string }[];
  canSend: boolean;
  gaps: { value: number; label: string }[];
  run: { running: boolean; label: string; platform: string; query: string; found: number; target: number; known: number; line: string; status: string; ids: string[]; elapsed: number } | null;
  counts: { available: number; approved?: number; restricted: number; sent?: number };
  /** The review bar's "Approve to" choices. */
  approveTo?: { value: string; label: string; tip: string }[];
  /** The lists' Sort menu. */
  sorts?: { value: string; label: string; group: number }[];
  /** Finished runs not looked at yet: the tab's count (TabsBus.collector-unread). */
  unseen?: number;
  /** Every search run by day, newest first. */
  history?: HistoryDay[];
  creators: Row[];
}
export interface Compose {
  id: string;
  name: string;
  templates: { id: string; name: string; description: string; builtin: boolean; place?: string }[];
  template: string;
  channels: { id: string; kind: string; label: string; account: string | null; connected: boolean; to: string; why: string; conn?: string }[];
  /** Where in Persons they go: Persons' places ("store:<id>", "creators"…) and the one picked. */
  places?: { value: string; label: string; section: string }[];
  place?: string;
  placeLabel?: string;
  channel: string;
  kind: string;
  to: string;
  subject: string;
  text: string;
  guard: { sentToday: number; limit: number; already: string | null; justSent: boolean } | null;
}

export type Page = "collector" | "available" | "approved" | "sent" | "restricted" | "history";
type Bus = Record<string, unknown> & { query: string; target: string; filter: string; contact_text: string; session_cookie: string; s_to: string; s_subject: string; s_text: string; d_reach_text: string; e_name: string; e_handle: string; e_bio: string; e_links: string };

/** Add contact's channels, in the order the composer has them. */
const CONTACT_KINDS: readonly ReachKind[] = ["email", "whatsapp", "discord", "instagram"];

/** A card's contact line (pure: tested): the best way to contact them, the next 3's marks, how many more. */
export function contactLine(list: NonNullable<Row["contacts"]>): { contact: { kind: string; color: string; text: string; tip: string; i: number }; has_contact: boolean; more: { kind: string; color: string; text: string; tip: string; i: number }[]; more_n: number } {
  const one = (c: NonNullable<Row["contacts"]>[number], i: number): { kind: string; color: string; text: string; tip: string; i: number } => {
    const color = REACH_META[c.kind as ReachKind]?.color ?? "#9aa4b2";
    return { kind: c.kind, color, text: c.text, tip: `${c.tip}${c.href ? " · click to open" : " · click to copy"}`, i };
  };
  const all = list.map(one);
  return { contact: all[0] ?? { kind: "", color: "#9aa4b2", text: "", tip: "", i: 0 }, has_contact: all.length > 0, more: all.slice(1, 4), more_n: Math.max(0, all.length - 4) };
}

/** The review bar's moves. */
export const REVIEW_MOVES = ["reject", "skip", "approve", "neobux"] as const;
export type ReviewMove = (typeof REVIEW_MOVES)[number];

/** The engine's `to` for an approving move: Approve → Persons › Creators ("persons"), Neobux → Persons › Neobux. */
export function approveTarget(what: "approve" | "neobux"): "persons" | "neobux" {
  return what === "neobux" ? "neobux" : "persons";
}

/** The review bar (Reject / Skip / Approve / Neobux) is for leads still under review: a run's, Available's, Restricted's (its
 *  Move to Available); not an Approved lead's, nor one opened from Sent (pure: tested). */
export function underReview(d: { approved?: boolean; sent?: boolean }, page: string): boolean {
  return !d.approved && !d.sent && page !== "approved" && page !== "sent";
}

/** The lead the review bar goes on to: the first one after `current` in the list the detail was opened from that is
 *  still in that list now (pure: tested). Null at the end. */
export function nextLead(queue: string[], current: string, live: Iterable<string>): string | null {
  const now = new Set(live);
  const at = queue.indexOf(current);
  if (at < 0) return null;
  for (let i = at + 1; i < queue.length; i++) if (queue[i] !== current && now.has(queue[i]!)) return queue[i]!;
  return null;
}

/** ← / →: the lead before (-1) or after (+1) `current` in the list the detail was opened from, as it was then (pure:
 *  tested). Leads that left the list since (approved, sent…) are still stepped through, so one reviewed by mistake can
 *  be opened again. Null at either end, or when the detail wasn't opened from a list. */
export function stepLead(queue: string[], current: string, dir: number): string | null {
  const at = queue.indexOf(current);
  if (at < 0 || !dir) return null;
  return queue[at + Math.sign(dir)] ?? null;
}

/** After a send from the detail (pure: tested): the next lead of its list that is still in it (the one right after the
 *  lead sent to, which may itself have just left the list for Sent), "" at the end of the list (the detail closes), or
 *  null when the detail wasn't opened from a list (it stays on the lead). */
export function leadAfterSend(queue: string[], current: string, live: Iterable<string>): string | null {
  if (!queue.includes(current)) return null;
  return nextLead(queue, current, live) ?? "";
}

export const LIST_PLATFORMS: { key: string; label: string; color: string }[] = [
  { key: "youtube", label: "YouTube", color: "#ff0000" },
  { key: "tiktok", label: "TikTok", color: "#fe2c55" },
  { key: "instagram", label: "Instagram", color: "#e1306c" },
];

/** The lists' order: followers high → low (the default) or low → high, as the CRM's subscriber sort; unknown counts
 *  go last either way, the view's order (newest collected first) breaks ties (pure: tested). */
export function sortRows(rows: Row[], mode: string): Row[] {
  const at = new Map(rows.map((r, i) => [r.id, i]));
  const dir = mode === "followers-asc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a.subs ?? null;
    const y = b.subs ?? null;
    if (x === null && y === null) return at.get(a.id)! - at.get(b.id)!;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir * (y - x) || at.get(a.id)! - at.get(b.id)!;
  });
}

/** The Sort button's compact label ("Followers ↓"). */
export const sortShort = (label: string): string => label.replace(" (high → low)", " ↓").replace(" (low → high)", " ↑");

/** How many leads of a list each platform has (the platform menu's counts; the text filter aside). */
export function platformCounts(v: CollectorView, page: Page): Record<string, number> {
  const n: Record<string, number> = { youtube: 0, tiktok: 0, instagram: 0 };
  for (const c of v.creators) if (listOfRow(c) === page && c.platformKey) n[c.platformKey] = (n[c.platformKey] ?? 0) + 1;
  return n;
}

const listOfRow = (c: Row): Page => (c.restricted ? "restricted" : c.sent ? "sent" : c.approved ? "approved" : "available");

/** The podium's render order (the CRM's 2-1-3): the newest in the middle, featured; a missing one leaves its place
 *  empty (pure: tested). */
/** The bio as one paragraph for the detail dialog's three clamped lines: each run of line breaks (blank lines
 *  too) becomes " · " and runs of spaces one space, so a bio that is a list (dates, links) can't outgrow the clamp. */
export function bioLine(bio: string): string {
  return bio
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export function podium<T>(videos: T[]): { v: T | null; featured: boolean }[] {
  if (!videos.length) return [];
  return [1, 0, 2].map((i) => ({ v: videos[i] ?? null, featured: i === 0 }));
}

/** What the Reach row shows for the kind picked and the text typed (pure: tested). */
export function reachState(d: DetailView, kind: ReachKind, text: string): { error: string; canSave: boolean; hint: string } {
  const t = text.trim();
  const error = t ? (reachError(kind, t) ?? "") : "";
  const same = !!d.reach && d.reach === kind && d.reachValue === t;
  return { error, canSave: !!t && !error && !same, hint: REACH_META[kind].placeholder };
}

/** Send message's destinations (the composer's To menu), from the compose answer (pure: tested): the brand for each
 *  Persons › Creators channel, who they are there, and the account it goes from or why it can't. */
export const DEST_META: Record<string, { glyph: string; color: string; app: string; hint: string }> = {
  gmail: { glyph: "email", color: "#9aa4b2", app: "Gmail", hint: "their@email.com" },
  whatsapp: { glyph: "whatsapp", color: "#25D366", app: "WhatsApp", hint: "+55 11 91234-5678" },
  discord: { glyph: "discord", color: "#5865F2", app: "Discord", hint: "Discord username or user ID" },
  instagram: { glyph: "instagram", color: "#E1306C", app: "Instagram", hint: "@handle" },
};
export function destRows(c: Compose): { value: string; kind: string; color: string; label: string; to: string; via: string; on: boolean; available: boolean }[] {
  return c.channels.map((x) => {
    const m = DEST_META[x.kind] ?? DEST_META.gmail!;
    const from = `${x.conn ?? `Creators ${m.app}`}${x.account ? ` · ${x.account}` : ""}`;
    return { value: x.id, kind: m.glyph, color: m.color, label: x.label, to: x.to, via: x.connected ? (x.to ? from : `${from} · none yet: type it in To`) : x.why, on: x.id === c.channel, available: x.connected };
  });
}

const initials = (name: string): string => {
  const w = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return w.length > 1 ? `${w[0]![0] ?? ""}${w.at(-1)![0] ?? ""}`.toUpperCase() : (w[0] ?? "?").slice(0, 2).toUpperCase();
};
const colorOf = (id: string): string => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
};

/** What the form shows, from the view (pure: tested). */
export function formOf(v: CollectorView): { unavailable: string; note: string; session: boolean } {
  const src = v.sources.find((x) => x.value === v.settings.platform);
  return { unavailable: src && !src.available ? src.why : "", note: src?.note ?? "", session: v.settings.platform === "instagram" };
}

/** The run's one line: what it does while it goes, how it ended after (pure: tested). */
export function runLine(v: CollectorView): string {
  const r = v.run;
  if (!r) return "";
  if (!r.running) return r.status;
  const n = r.target > 0 ? `${r.found} of ${r.target}` : `${r.found} found`;
  return `${n} · ${r.line || "Searching…"}`;
}

/** History as the timeline's lines: each day's head, then its runs (the day's last has no line under its dot) (pure:
 *  tested). */
export function historyItems(days: HistoryDay[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  days.forEach((d, di) => {
    out.push({ kind: "day", label: d.label, first: di === 0, id: `day-${d.key}`, time: "", query: "", platform: "", platform_key: "", line: "", note: "", tone: "", running: false, last: false });
    d.runs.forEach((r, i) => out.push({ kind: "run", label: "", first: false, id: r.id, time: r.time, query: r.query, platform: r.platform, platform_key: r.platformKey, line: r.line, note: r.note, tone: r.tone, running: r.running, last: i === d.runs.length - 1 }));
  });
  return out;
}

/** A run of History by its id, with the day it ran on. */
export function findRun(v: CollectorView, id: string): { day: HistoryDay; run: HistoryDay["runs"][number] } | null {
  for (const day of v.history ?? []) for (const run of day.runs) if (run.id === id) return { day, run };
  return null;
}

/** An opened run's head: the term, its platform, "YouTube · Today 08:26 · 20 new leads", why it stopped (pure: tested). */
export function runHead(v: CollectorView, id: string): { query: string; platformKey: string; sub: string; note: string; tone: string } | null {
  const f = findRun(v, id);
  if (!f) return null;
  const { day, run } = f;
  const when = run.running ? "running now" : `${day.label} ${run.time}`;
  return { query: run.query, platformKey: run.platformKey, sub: `${run.platform} · ${when} · ${run.line}`, note: run.note, tone: run.tone };
}

/** The leads one view shows, and its heading and empty state (pure: tested). On History, `run` is the run open: the
 *  leads it found, in the order found, whichever list they're in now. */
export function leadsOf(v: CollectorView, page: Page, filter: string, run = ""): { rows: Row[]; head: string; emptyTitle: string; emptyDesc: string } {
  if (page === "history") {
    const f = run ? findRun(v, run) : null;
    if (!f) return { rows: [], head: "", emptyTitle: "", emptyDesc: "" };
    const byId = new Map(v.creators.map((c) => [c.id, c]));
    const rows = f.run.ids.map((id) => byId.get(id)).filter((c): c is Row => !!c);
    if (rows.length) return { rows, head: "", emptyTitle: "", emptyDesc: "" };
    return f.run.ids.length
      ? { rows, head: "", emptyTitle: "Its leads are gone", emptyDesc: "The leads this search found were removed since. They stay remembered, so no run collects them again." }
      : { rows, head: "", emptyTitle: f.run.running ? "" : "Nothing new this time", emptyDesc: f.run.running ? "" : "Everyone it found was collected before, or hadn't posted inside Last upload." };
  }
  if (page === "collector") {
    const r = v.run;
    const byId = new Map(v.creators.map((c) => [c.id, c]));
    const rows = (r?.ids ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is Row => !!c && !c.restricted && !c.approved && !c.sent)
      .reverse();
    if (!r) return { rows, head: "", emptyTitle: "No search yet", emptyDesc: "Type a term and press Collect. Collector searches it for videos, as the platform shows them, and keeps each active creator once: picture, link, email when there is one, and their 3 newest videos." };
    return { rows, head: rows.length ? `FOUND FOR “${r.query.toUpperCase()}”` : "", emptyTitle: r.running ? "" : "Nothing new this time", emptyDesc: r.running ? "" : "Everyone it found was collected before, or hasn't posted inside Last upload. Try another term." };
  }
  const q = filter.trim().toLowerCase();
  const all = v.creators.filter((c) => listOfRow(c) === page);
  const only = v.settings.platforms ?? [];
  const shown = only.length ? all.filter((c) => only.includes(c.platformKey ?? "")) : all;
  const matched = q ? shown.filter((c) => [c.name, c.handle, c.email, c.platform, c.short, ...(c.contacts ?? []).map((x) => x.value)].some((x) => x.toLowerCase().includes(q))) : shown;
  // Sent: the newest sent first (Sort doesn't apply there)
  const rows = page === "sent" ? [...matched].sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? "")) : sortRows(matched, v.settings.sort ?? "followers-desc");
  const none: [string, string] = ({ restricted: ["Nobody restricted", "Restrict a lead (or Reject it in its detail) to keep it out of Available. It stays remembered, so no run collects it again."], approved: ["Nobody approved", "Open a lead and press Approve (A or →). Approved leads leave Available and stay remembered, so no run collects them again."], sent: ["Nobody written to yet", "Send a lead a message (Send message in its detail, or from Persons): once it goes out by email, WhatsApp, Discord or Instagram, the lead moves here. A failed send doesn't."], available: ["No leads yet", "Collect some from the Collector page."] } as Record<"available" | "approved" | "sent" | "restricted", [string, string]>)[page];
  const emptyTitle = all.length === 0 ? none[0] : "No match";
  const which = LIST_PLATFORMS.filter((p) => only.includes(p.key)).map((p) => p.label).join(" or ");
  const emptyDesc = all.length === 0 ? none[1] : q ? `Nobody matches “${filter.trim()}”${only.length ? ` on ${which}` : ""}.` : `Nobody here on ${which}.`;
  return { rows, head: "", emptyTitle, emptyDesc };
}

class Pictures {
  private done = new Map<string, { mtime: number; px: Pixels | null }>();
  private busy = new Set<string>();
  constructor(private readonly changed: () => void) {}
  get(path: string | null): Pixels | null {
    if (!path) return null;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.done.get(path);
    if (hit && hit.mtime === mtime) return hit.px;
    if (!this.busy.has(path)) {
      this.busy.add(path);
      void images
        .decodeBytes(new Uint8Array(readFileSync(path)), 112)
        .then(
          (r) => this.done.set(path, { mtime, px: r.image as Pixels }),
          () => this.done.set(path, { mtime, px: null }),
        )
        .finally(() => {
          this.busy.delete(path);
          this.changed();
        });
    }
    return hit?.px ?? null;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const PAGES: { id: Page; label: string }[] = [
  { id: "collector", label: "Collector" },
  { id: "available", label: "Available" },
  { id: "approved", label: "Approved" },
  { id: "sent", label: "Sent" },
  { id: "restricted", label: "Restricted" },
  { id: "history", label: "History" },
];

export function createCollectorUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let view: CollectorView | null = null;
  let copied = 0;
  let fast: ReturnType<typeof setInterval> | null = null;
  let editing = 0;
  let page: Page = (["collector", "available", "approved", "sent", "restricted", "history"] as const).find((p) => p === process.env.HUB_COLLECTOR_SHOT_PAGE) ?? "collector";
  /** History: the run open ("" the timeline). */
  let historyRun = "";
  /** Add contact: the card being edited and the channel picked. */
  let contactFor = "";
  let contactKind: ReachKind = "email";
  let sessionBusy = false;
  // Send message
  let sendId = "";
  let compose: Compose | null = null;
  let sendOpen = false;
  let sendConfirm = false;
  let sendBusy = false;
  let sendError = "";
  let saved = "";
  // A lead's detail
  let detail: DetailView | null = null;
  let detailOpen = false;
  let filling = false;
  let reachKind: ReachKind = "email";
  /** A Reach icon was clicked in this detail: Send message opens on its channel (else on the one picked last). */
  let reachPicked = false;
  let drafts: Record<ReachKind, string> = { email: "", discord: "", whatsapp: "", instagram: "" };
  let reachBusy = false;
  let reachErr = "";
  let editOpen = false;
  let editErr = "";
  // The review bar: the list the detail was opened from (its ids in its filter and order).
  let queue: string[] = [];
  let reviewBusy = false;
  /** The lead ← / → asked for, still being read ("" none), and the newest read's number (older ones are dropped). */
  let stepping = "";
  let detailSeq = 0;
  /** The open detail is being read again (its pictures came in). */
  let redetail = false;
  /** The lists' Sort or platform menu, open ("" none). */
  let listMenu = "";
  /** What the detail's lists were last drawn from (a model is only replaced when it changes). */
  const sigs: Record<string, string> = {};
  const rowModel = new slint.ArrayModel<Record<string, unknown>>([]);
  const pics = new Pictures(() => render());

  const set = (k: string, v: unknown): void => {
    if (bus && bus[k] !== v) bus[k] = v;
  };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!ctx) throw new Error("not mounted");
    // "path?a=b": the query goes apart (TabCtx.call takes it as a record).
    const [p, q] = path.split("?", 2) as [string, string | undefined];
    const query = q ? Object.fromEntries(new URLSearchParams(q)) : undefined;
    const r = await ctx.call(method, p, query, body);
    if (r.status >= 300) throw new Error((r.body as { error?: string } | null)?.error ?? `Hub answered ${r.status}`);
    return r.body;
  };

  const take = (v: CollectorView): void => {
    view = v;
    // A run that ended while this tab is on screen is seen: no count on the tab, here or on the phone.
    if ((v.unseen ?? 0) > 0 && ctx?.shown()) {
      const tabs = Reflect.get(ctx.win, "TabsBus") as { collector_unread: number } | undefined;
      if (tabs && tabs.collector_unread !== 0) tabs.collector_unread = 0;
      void call("POST", "v1/collector/seen").catch(() => null);
    }
    set("loading", false);
    render();
    // The open detail was read before its pictures were cached (they're fetched in the background): read it again
    // once the engine has more of them.
    const d = detail;
    if (detailOpen && d && !redetail && (d.recent.some((x) => x && x.thumbId && !x.thumbPath) || (d.avatarId && !d.avatarPath))) {
      redetail = true;
      void call("GET", `v1/collector/creator?id=${encodeURIComponent(d.id)}`)
        .then((f) => {
          if (detailOpen && detail?.id === d.id) takeDetail(f as DetailView, false);
        }, () => {})
        .finally(() => (redetail = false));
    }
    const going = !!v.run?.running;
    if (going && !fast) fast = setInterval(() => void load(), 1000);
    if (!going && fast) {
      clearInterval(fast);
      fast = null;
    }
  };

  // The screenshot rig opens the Send dialog for the first lead straight away, once the first view is in.
  let shot = !!process.env.HUB_COLLECTOR_SHOT_SEND;
  let shotDetail = Number(process.env.HUB_COLLECTOR_SHOT_DETAIL) > 0;
  // …or History's newest run that found someone (HUB_COLLECTOR_SHOT_RUN=1).
  let shotRun = process.env.HUB_COLLECTOR_SHOT_RUN === "1";
  const load = async (): Promise<void> => {
    try {
      take((await call("GET", "v1/collector")) as CollectorView);
      if (shot) {
        shot = false;
        // "1": the first lead; else the lead with that id or name
        const want = process.env.HUB_COLLECTOR_SHOT_SEND ?? "1";
        const first = view?.creators.find((c) => !c.restricted && (want === "1" || c.id === want || c.name === want));
        if (first) {
          sendId = first.id;
          await openCompose("", "");
        }
      }
      if (shotRun) {
        shotRun = false;
        const first = (view?.history ?? []).flatMap((d) => d.runs).find((r) => r.found > 0);
        if (first) {
          page = "history";
          historyRun = first.id;
          render();
        }
      }
      if (shotDetail) {
        shotDetail = false;
        // "1": the first lead; N: the Nth of the page's list (HUB_COLLECTOR_SHOT_PAGE)
        const n = Number(process.env.HUB_COLLECTOR_SHOT_DETAIL) || 1;
        const first = n > 1 && view ? leadsOf(view, page, bus?.filter ?? "", historyRun).rows[n - 1] : view?.creators.find((c) => !c.restricted);
        if (first) await showDetail(first.id);
        // HUB_COLLECTOR_SHOT_SENDS=S (only with the fake Persons, HUB_COLLECTOR_SEND=fake: nothing goes out): S s later
        // the detail's Send message opens, then (S s apart) the template HUB_COLLECTOR_SHOT_TEMPLATE is picked (when
        // set), "Send it?", Send now.
        const gap = Number(process.env.HUB_COLLECTOR_SHOT_SENDS) || 0;
        const b = bus;
        if (gap > 0 && b && process.env.HUB_COLLECTOR_SEND === "fake") {
          const fire = (name: string, ...a: string[]): void => (b[name] as (...x: string[]) => void)(...a);
          const tpl = process.env.HUB_COLLECTOR_SHOT_TEMPLATE ?? "";
          const steps: (() => void)[] = [() => fire("detail_send"), ...(tpl ? [() => fire("pick_template", tpl)] : []), () => fire("send_ask"), () => fire("send_confirm")];
          steps.forEach((f, i) => setTimeout(f, (i + 1) * gap * 1000));
        }
      }
    } catch (e) {
      set("error", errText(e));
    }
  };

  const post = async (path: string, body?: unknown): Promise<void> => {
    try {
      take((await call("POST", `v1/collector/${path}`, body ?? {})) as CollectorView);
    } catch (e) {
      ctx?.toast(errText(e));
      void load();
    }
  };

  function renderSend(): void {
    const c = compose;
    set("send_open", sendOpen && !!c);
    if (!c || !bus) return;
    set("s_title", `Send message to ${c.name}`);
    set("s_templates", new slint.ArrayModel(c.templates.map((t) => ({ id: t.id, name: t.name, description: t.description, on: t.id === c.template }))));
    const ch = c.channels.find((x) => x.id === c.channel);
    const kind = ch?.kind ?? c.kind;
    const meta = DEST_META[kind] ?? DEST_META.gmail!;
    const destSig = JSON.stringify([c.channels, c.channel]);
    if (sigs.s_dests !== destSig) {
      set("s_dests", new slint.ArrayModel(destRows(c)));
      sigs.s_dests = destSig;
    }
    set("s_dest_kind", meta.glyph);
    set("s_dest_color", meta.color);
    set("s_dest_label", ch?.label ?? "Pick where it goes");
    set("s_to_hint", meta.hint);
    // the account it goes from; a channel that can't send says why (an empty To only until something is typed)
    const why = !ch ? "Persons › Creators has no Gmail, WhatsApp, Discord or Instagram: add one there (Creators › Connections)." : !ch.connected ? ch.why : "";
    set("s_channel_why", why);
    set("s_from", why || `From ${ch?.account ? `${ch.account} · ` : ""}${ch?.conn ?? `Creators ${meta.app}`}`);
    const placeSig = JSON.stringify([c.places, c.place]);
    if (sigs.s_places !== placeSig) {
      set("s_places", new slint.ArrayModel((c.places ?? []).map((x) => ({ value: x.value, label: x.label, store: x.section === "stores", on: x.value === c.place }))));
      sigs.s_places = placeSig;
    }
    set("s_place_label", c.placeLabel ?? "Creators");
    set("s_is_email", kind === "gmail");
    const g = c.guard;
    // The daily limit shows only once it's reached (the user doesn't want the running count).
    set("s_guard", g && g.limit && g.sentToday >= g.limit ? `${g.limit} new emails in the last 24 h from this account already: try again later.` : "");
    set("s_already", g?.already ?? "");
    set("s_error", sendError);
    set("s_busy", sendBusy);
    set("s_confirm", sendConfirm);
    const isEmail = kind === "gmail";
    const what = isEmail ? "email" : `${meta.app} message`;
    set("s_confirm_text", `A real ${what} goes to ${bus.s_to.trim()}${ch?.account ? ` from ${ch.account}` : ""}. ${c.name} becomes a person in Persons › ${c.placeLabel ?? "Creators"}, and the message shows in that chat.`);
    set("s_can_send", !!ch?.connected && bus.s_to.trim() !== "" && bus.s_text.trim() !== "" && (!isEmail || bus.s_subject.trim() !== ""));
    set("s_saved", saved);
  }

  function render(): void {
    const b = bus;
    const v = view;
    if (!b || !v) return;
    const s = v.settings;
    set("page", page);
    set("nav", new slint.ArrayModel(PAGES.map((p) => ({ id: p.id, label: p.label, on: p.id === page, count: p.id === "available" ? v.counts.available : p.id === "approved" ? (v.counts.approved ?? 0) : p.id === "sent" ? (v.counts.sent ?? 0) : p.id === "restricted" ? v.counts.restricted : 0 }))));
    set("n_available", v.counts.available);
    set("n_approved", v.counts.approved ?? 0);
    set("n_sent", v.counts.sent ?? 0);
    set("n_restricted", v.counts.restricted);
    set("sources", new slint.ArrayModel(v.sources.map((x) => ({ value: x.value, label: x.label, on: x.value === s.platform, available: x.available, tip: x.available ? x.note : x.why }))));
    set("gaps", new slint.ArrayModel(v.gaps.map((g) => ({ value: String(g.value), label: g.label, on: g.value === s.gapDays, available: true, tip: g.value ? `Only creators who posted in the last ${g.value} days` : "Keep creators whenever they last posted" }))));
    const f = formOf(v);
    set("unavailable", f.unavailable);
    set("source_note", f.note);
    const ig = v.sessions.find((x) => x.platform === "instagram");
    set("show_session", f.session);
    set("session_on", !!ig?.connected);
    set("session_account", ig?.account ?? "");
    set("session_help", ig?.help ?? "");
    set("session_busy", sessionBusy);
    // Don't fight the user's typing: the fields follow the engine only while they aren't being edited.
    if (Date.now() - editing > 1500) {
      if (b.query !== s.query) b.query = s.query;
      const ts = s.target > 0 ? String(s.target) : "";
      if (b.target !== ts) b.target = ts;
    }
    set("running", !!v.run?.running);
    set("run_line", runLine(v));
    set("copy_label", Date.now() - copied < 2500 ? "Copied" : "Copy JSONL");
    set("contact_for", contactFor);
    set("contact_hint", CONTACT_HINT[contactKind]);
    if (sigs.contact_kinds !== contactKind) {
      b.contact_kinds = new slint.ArrayModel(CONTACT_KINDS.map((k) => ({ kind: k, label: CONTACT_LABEL[k], color: REACH_META[k].color, on: k === contactKind })));
      sigs.contact_kinds = contactKind;
    }
    renderHistory(v);
    const l = leadsOf(v, page, b.filter, historyRun);
    set("rows_head", l.head);
    renderListMenus(v);
    set("empty_title", l.emptyTitle);
    set("empty_desc", l.emptyDesc);
    sync(
      l.rows.map((x) => {
        const px = pics.get(x.avatarPath);
        const side = page === "sent" ? (x.sentLine ?? "") : page === "approved" ? (x.approvedLine ?? "") : "";
        return {
          id: x.id,
          name: x.name,
          handle: x.handle,
          platform: x.platform,
          url: x.url,
          short: x.short,
          avatar: px ?? NO_PX,
          has_avatar: !!px,
          initials: initials(x.name),
          color: colorOf(x.id),
          email: x.email,
          restricted: x.restricted,
          approved: !!x.approved,
          // Sent: the channel and the day on the right, in the followers' place; Approved: the Persons list and the day
          followers: side ? side : x.subs !== null && x.subs !== undefined ? `${compactCount(x.subs)} followers` : "",
          ...contactLine(x.contacts ?? []),
          sig: `${x.id}|${x.name}|${x.handle}|${x.email}|${x.restricted}|${!!x.approved}|${x.subs ?? ""}|${!!px}|${side}|${(x.contacts ?? []).map((c) => `${c.kind}:${c.value}:${c.source}`).join(",")}`,
        };
      }),
    );
    if (b.rows !== rowModel) b.rows = rowModel;
    renderSend();
    renderDetail();
  }

  function renderHistory(v: CollectorView): void {
    const b = bus;
    if (!b) return;
    // A run that's no longer there (it can't be, but a restore might ask for one): back to the timeline.
    if (historyRun && !findRun(v, historyRun)) historyRun = "";
    set("history_run", page === "history" ? historyRun : "");
    set("n_runs", (v.history ?? []).reduce((n, d) => n + d.runs.length, 0));
    const items = historyItems(v.history ?? []);
    const sig = JSON.stringify(items);
    if (sigs.history !== sig) {
      b.history = new slint.ArrayModel(items);
      sigs.history = sig;
    }
    const h = historyRun ? runHead(v, historyRun) : null;
    set("hr_query", h?.query ?? "");
    set("hr_platform_key", h?.platformKey ?? "");
    set("hr_sub", h?.sub ?? "");
    set("hr_note", h?.note ?? "");
    set("hr_tone", h?.tone ?? "");
  }

  function renderListMenus(v: CollectorView): void {
    const b = bus;
    if (!b) return;
    const sort = v.settings.sort ?? "followers-desc";
    const only = v.settings.platforms ?? [];
    const sorts = v.sorts ?? [];
    set("sort_label", page === "sent" ? "Newest sent" : sortShort(sorts.find((x) => x.value === sort)?.label ?? "Sort"));
    set("sort_tip", page === "sent" ? "Sent: the newest sent first" : `Sort: ${sorts.find((x) => x.value === sort)?.label ?? ""}`);
    const counts = platformCounts(v, page);
    set("plat_label", only.length === 0 ? "All platforms" : only.length === 1 ? (LIST_PLATFORMS.find((p) => p.key === only[0])?.label ?? "") : `${only.length} platforms`);
    set("plat_on", only.length > 0);
    set("list_menu", listMenu);
    const sortItems = sorts.map((x, i) => ({ value: x.value, label: x.label, on: x.value === sort, sep: i > 0 && sorts[i - 1]!.group !== x.group }));
    const plats = LIST_PLATFORMS.map((p) => ({ value: p.key, label: p.label, color: p.color, count: counts[p.key] ?? 0, on: only.includes(p.key) }));
    const sig = JSON.stringify([sortItems, plats]);
    if (sigs.list_menus !== sig) {
      b.sort_items = new slint.ArrayModel(sortItems);
      b.plat_items = new slint.ArrayModel(plats);
      sigs.list_menus = sig;
    }
  }

  function renderDetail(): void {
    const b = bus;
    const d = detail;
    set("detail_open", detailOpen && !!d);
    set("edit_open", editOpen && !!d);
    if (!b || !d) return;
    const px = pics.get(d.avatarPath);
    set("d_name", d.name);
    set("d_platform", d.platform.toUpperCase());
    set("d_handle", d.handle);
    set("d_avatar", px ?? NO_PX);
    set("d_has_avatar", !!px);
    set("d_initials", initials(d.name));
    set("d_color", colorOf(d.id));
    set("d_has_contact", d.hasContact);
    const statSig = JSON.stringify(d.stats);
    if (sigs.d_stats !== statSig) {
      b.d_stats = new slint.ArrayModel(d.stats.map((x) => ({ ...x, label: x.label.toUpperCase() })));
      sigs.d_stats = statSig;
    }
    const vids = podium(d.recent).map(({ v, featured }) => {
      const t = v ? pics.get(v.thumbPath) : null;
      return { url: v?.url ?? "", title: v?.title ?? "", meta: v?.meta ?? "", thumb: t ?? NO_PX, has_thumb: !!t, short: !!v?.short, featured, empty: !v };
    });
    const vidSig = vids.map((x) => `${x.url}|${x.title}|${x.meta}|${x.has_thumb}`).join(",");
    if (sigs.d_videos !== vidSig) {
      b.d_videos = new slint.ArrayModel(vids);
      sigs.d_videos = vidSig;
    }
    set("d_bio", d.bio);
    set("d_bio_line", bioLine(d.bio));
    const reachSig = `${reachKind}`;
    if (sigs.d_reaches !== reachSig) {
      b.d_reaches = new slint.ArrayModel(REACH_KINDS.map((k) => ({ kind: k, label: REACH_META[k].label, color: REACH_META[k].color, on: k === reachKind })));
      sigs.d_reaches = reachSig;
    }
    const st = reachState(d, reachKind, b.d_reach_text);
    set("d_reach_hint", st.hint);
    set("d_reach_error", reachErr || st.error);
    set("d_reach_can_save", st.canSave);
    set("d_reach_saved", !!d.reach);
    set("d_reach_busy", reachBusy);
    set("d_url", d.url);
    set("d_open_label", d.openLabel);
    set("d_filling", filling);
    set("e_error", editErr);
    set("d_approved_note", d.approvedNote ?? "");
    set("d_restricted", d.restricted);
    set("d_approved", !!d.approved);
    set("d_review", underReview(d, page));
    const pos = queue.indexOf(d.id);
    set("d_position", pos >= 0 && queue.length > 1 ? `${pos + 1} of ${queue.length}` : "");
    set("d_has_prev", !!stepLead(queue, d.id, -1));
    set("d_has_next", !!stepLead(queue, d.id, 1));
    set("review_busy", reviewBusy);
  }

  /** Takes a fresh detail; the Reach field keeps what the user typed unless it was the old value. */
  const takeDetail = (d: DetailView, resetReach: boolean): void => {
    const prev = detail;
    detail = d;
    if (resetReach || !prev || prev.id !== d.id) {
      reachKind = d.reachKind;
      reachPicked = false;
      drafts = { ...d.drafts };
      if (bus) bus.d_reach_text = drafts[reachKind];
      reachErr = "";
    } else {
      for (const k of REACH_KINDS) if (k !== reachKind && drafts[k] === prev.drafts[k]) drafts[k] = d.drafts[k];
      if (bus && bus.d_reach_text === prev.drafts[reachKind]) bus.d_reach_text = d.drafts[reachKind];
    }
    render();
  };

  const closeDetail = (): void => {
    detailOpen = false;
    editOpen = false;
    queue = [];
    // a lead still being read for ← / → doesn't open the detail again
    stepping = "";
    detailSeq++;
    render();
    ctx?.saveSoon?.();
  };

  /** The review bar: Reject (to Restricted), Skip (as it is), Approve (to the Approved list and Persons › Creators),
   *  Neobux (to the Approved list and Persons › Neobux); then the next lead of the list the detail was opened from, or
   *  back to the list at its end (no toast: the move is the feedback, errors still toast). */
  const review = async (what: ReviewMove): Promise<void> => {
    const d = detail;
    if (!d || !detailOpen || reviewBusy || editOpen || sendOpen) return;
    reviewBusy = true;
    render();
    try {
      // On a Restricted lead Reject is "Move to Available", on an Approved one Approve is.
      if (what === "reject" && d.restricted) {
        take((await call("POST", "v1/collector/restrict", { id: d.id, restricted: false })) as CollectorView);
      } else if (what === "approve" && d.approved) {
        take((await call("POST", "v1/collector/approve", { id: d.id, approved: false })) as CollectorView);
      } else if (what === "reject") take((await call("POST", "v1/collector/restrict", { id: d.id, restricted: true })) as CollectorView);
      else if (what === "approve" || what === "neobux") take((await call("POST", "v1/collector/approve", { id: d.id, approved: true, to: approveTarget(what) })) as CollectorView);
      const v = view;
      const next = v ? nextLead(queue, d.id, leadsOf(v, page, bus?.filter ?? "", historyRun).rows.map((r) => r.id)) : null;
      if (next) await showDetail(next, false);
      else closeDetail();
    } catch (e) {
      ctx?.toast(errText(e));
    } finally {
      reviewBusy = false;
      render();
    }
  };

  const showDetail = async (id: string, fromList = true): Promise<void> => {
    // the lead asked for last wins (← → pressed fast: each read that comes back late is dropped)
    const my = ++detailSeq;
    stepping = id;
    try {
      // Opened from a card: the review bar goes through that list, in its filter and order.
      if (fromList && view && bus) queue = leadsOf(view, page, bus.filter, historyRun).rows.map((r) => r.id);
      const d = (await call("GET", `v1/collector/creator?id=${encodeURIComponent(id)}`)) as DetailView;
      if (my !== detailSeq) return;
      stepping = "";
      detailOpen = true;
      editOpen = false;
      takeDetail(d, true);
      ctx?.saveSoon?.();
      // An older lead misses some of this: one read of its profile fills it (the engine decides if it's due).
      filling = true;
      render();
      const f = (await call("POST", "v1/collector/fill", { id }).catch(() => null)) as DetailView | null;
      filling = false;
      if (f && detail?.id === id) takeDetail(f, false);
      else render();
    } catch (e) {
      filling = false;
      if (my === detailSeq) stepping = "";
      ctx?.toast(errText(e));
    }
  };

  /** ← / → (and the header's caps): the previous or next lead of the list, in every list. Not while Edit or Send message
   *  is over the detail, nor during a review move. */
  const step = (dir: number): void => {
    const d = detail;
    if (!d || !detailOpen || editOpen || sendOpen || reviewBusy) return;
    const other = stepLead(queue, stepping || d.id, dir);
    if (other) void showDetail(other, false);
  };

  /** The rows in place (a run adds one at a time: no full redraw of the list). */
  function sync(rows: Record<string, unknown>[]): void {
    const n = rowModel.rowCount();
    if (n > rows.length) rowModel.remove(rows.length, n - rows.length);
    for (let i = 0; i < rows.length; i++) {
      if (i < rowModel.rowCount()) {
        if ((rowModel.rowData(i) as Record<string, unknown>).sig !== rows[i]!.sig) rowModel.setRowData(i, rows[i]!);
      } else rowModel.push(rows[i]!);
    }
  }

  const openCompose = async (template = "", channel = "", kind = "", to = "", remember = false, place = "", byTemplate = false): Promise<void> => {
    if (!sendId || !bus) return;
    try {
      const c = (await call("GET", `v1/collector/compose?id=${encodeURIComponent(sendId)}&template=${encodeURIComponent(template)}&channel=${encodeURIComponent(channel)}&kind=${encodeURIComponent(kind)}&place=${encodeURIComponent(place || compose?.place || "")}${remember ? "&remember=1" : ""}${byTemplate ? "&bytemplate=1" : ""}`)) as Compose;
      const keepTo = compose && compose.id === c.id && compose.channel === c.channel ? bus.s_to : null;
      // another destination keeps what was written (the same template); another template fills it again
      const keep = !!compose && compose.id === c.id && compose.template === c.template && (compose.channel !== c.channel || compose.place !== c.place);
      const keepSubject = keep && bus.s_subject.trim() ? bus.s_subject : null;
      const keepText = keep ? bus.s_text : null;
      compose = c;
      bus.s_to = keepTo ?? (to && (c.kind === kind || (kind === "email" && c.kind === "gmail")) ? to : c.to);
      bus.s_subject = keepSubject ?? c.subject;
      bus.s_text = keepText ?? c.text;
      sendError = "";
      saved = "";
      sendOpen = true;
      render();
    } catch (e) {
      ctx?.toast(errText(e));
    }
  };

  function bind(b: Bus): void {
    const on = (name: string, f: (...a: never[]) => void): void => {
      b[name] = f;
    };
    on("go", (id: string) => {
      page = (PAGES.find((p) => p.id === id)?.id ?? "collector") as Page;
      historyRun = "";
      listMenu = "";
      contactFor = "";
      render();
      ctx?.saveSoon?.();
    });
    on("pick_source", (v: string) => (view?.run?.running ? undefined : void post("settings", { platform: v })));
    on("pick_gap", (v: string) => (view?.run?.running ? undefined : void post("settings", { gapDays: Number(v) })));
    on("query_edited", (t: string) => {
      editing = Date.now();
      void call("POST", "v1/collector/settings", { query: t }).catch(() => {});
    });
    on("target_edited", (t: string) => {
      editing = Date.now();
      void call("POST", "v1/collector/settings", { target: t }).catch(() => {});
    });
    on("target_step", (d: number) => {
      const cur = Number(b.target) || 0;
      const next = Math.max(0, cur + d);
      b.target = next ? String(next) : "";
      editing = 0;
      void post("settings", { target: next });
    });
    on("start", () => {
      editing = 0;
      page = "collector";
      void post("start", { query: b.query.trim(), target: b.target });
    });
    on("stop", () => void post("stop"));
    on("copy", () => {
      void call("GET", `v1/collector/export?which=${page === "approved" ? "approved" : "available"}`)
        .then(async (r) => {
          const { text, count } = r as { text: string; count: number };
          await clipboard.copyText(text);
          copied = Date.now();
          render();
          ctx?.toast(`Copied ${count} lead(s). Paste into SpokPayCRM → Creators → Import.`);
          setTimeout(render, 2600);
        })
        .catch((e: unknown) => ctx?.toast(errText(e)));
    });
    on("open", (url: string) => {
      if (url) ctx?.openExternal(url);
    });
    on("restrict", (id: string, yes: boolean) => void post("restrict", { id, restricted: yes }));
    on("filter_edited", () => render());
    on("contact_edit", (id: string) => {
      contactFor = id;
      // the first channel they have nothing on yet
      const have = new Set((view?.creators.find((c) => c.id === id)?.contacts ?? []).map((c) => c.kind));
      contactKind = CONTACT_KINDS.find((k) => !have.has(k)) ?? "email";
      b.contact_text = "";
      render();
    });
    on("contact_pick", (k: string) => {
      if (!(CONTACT_KINDS as readonly string[]).includes(k)) return;
      contactKind = k as ReachKind;
      render();
    });
    on("contact_cancel", () => {
      contactFor = "";
      render();
    });
    on("contact_save", () => {
      const id = contactFor;
      const kind = contactKind;
      const value = b.contact_text.trim();
      if (!value) return;
      void call("POST", "v1/collector/contact", { id, kind, value })
        .then(() => {
          contactFor = "";
          ctx?.toast(`${CONTACT_LABEL[kind]} saved.`);
          void load();
        })
        .catch((e: unknown) => ctx?.toast(errText(e)));
    });
    on("contact_open", (id: string, i: number) => {
      const c = view?.creators.find((x) => x.id === id)?.contacts?.[i];
      if (!c) return;
      if (c.href) ctx?.openExternal(c.href);
      else
        void clipboard
          .copyText(c.value)
          .then(() => ctx?.toast(`Copied ${c.text}.`))
          .catch((e: unknown) => ctx?.toast(errText(e)));
    });
    on("session_save", () => {
      const cookie = b.session_cookie.trim();
      if (!cookie || sessionBusy) return;
      sessionBusy = true;
      render();
      void call("POST", "v1/collector/session", { platform: "instagram", cookie })
        .then((v) => {
          b.session_cookie = "";
          take(v as CollectorView);
          ctx?.toast("Instagram session saved on this PC.");
        })
        .catch((e: unknown) => ctx?.toast(errText(e)))
        .finally(() => {
          sessionBusy = false;
          render();
        });
    });
    on("session_remove", () => void post("session-clear", { platform: "instagram" }));
    on("send_show", (id: string) => {
      sendId = id;
      sendConfirm = false;
      compose = null;
      void openCompose("", "");
    });
    on("send_close", () => {
      if (sendBusy) return;
      sendOpen = false;
      sendConfirm = false;
      render();
    });
    // what the user picks is remembered (the next composer opens on that template and channel)
    // a template with a Persons place moves "Add to Persons ›" there (the user can still pick another after)
    on("pick_template", (id: string) => void openCompose(id, compose?.channel ?? "", "", "", true, "", true));
    on("pick_channel", (id: string) => void openCompose(compose?.template ?? "", id, "", "", true));
    // another place in Persons: its connections (the same kind of channel when it has one), what's written stays
    on("pick_place", (v: string) => {
      const cur = compose?.channels.find((x) => x.id === compose?.channel);
      void openCompose(compose?.template ?? "", "", cur?.kind === "gmail" ? "email" : (cur?.kind ?? ""), cur ? b.s_to : "", true, v);
    });
    on("send_ask", () => {
      sendError = "";
      sendConfirm = true;
      render();
    });
    on("send_back", () => {
      sendConfirm = false;
      render();
    });
    on("send_confirm", () => {
      const c = compose;
      if (!c || sendBusy) return;
      sendBusy = true;
      sendError = "";
      render();
      void call("POST", "v1/collector/send", { id: c.id, channel: c.channel, to: b.s_to.trim(), subject: b.s_subject.trim(), text: b.s_text, template: c.template, place: c.place ?? "creators" })
        .then(async () => {
          sendOpen = false;
          sendConfirm = false;
          ctx?.toast(`Sent to ${c.name}. They're in Persons › ${c.placeLabel ?? "Creators"}.`);
          await load();
          if (!detailOpen || detail?.id !== c.id) return;
          // Sent from the detail: on to the lead that was after this one in its list (this one may have just left it
          // for Sent), the list again at its end; a detail not opened from a list stays, up to date.
          const v = view;
          const next = v ? leadAfterSend(queue, c.id, leadsOf(v, page, b.filter ?? "", historyRun).rows.map((r) => r.id)) : null;
          if (next) void showDetail(next, false);
          else if (next === "") closeDetail();
          else void call("GET", `v1/collector/creator?id=${encodeURIComponent(c.id)}`).then((d) => takeDetail(d as DetailView, false), () => {});
        })
        .catch((e: unknown) => {
          sendError = errText(e);
          sendConfirm = false;
        })
        .finally(() => {
          sendBusy = false;
          render();
        });
    });
    on("detail_show", (id: string) => void showDetail(id));
    on("history_open", (id: string) => {
      historyRun = id;
      render();
      ctx?.saveSoon?.();
    });
    on("history_back", () => {
      historyRun = "";
      render();
      ctx?.saveSoon?.();
    });
    on("detail_close", () => closeDetail());
    on("detail_step", (dir: number) => step(dir));
    on("review", (what: string) => {
      if ((REVIEW_MOVES as readonly string[]).includes(what)) void review(what as ReviewMove);
    });
    on("list_menu_show", (which: string) => {
      // Sent has one order (the newest sent first)
      if (which === "sort" && page === "sent") return;
      listMenu = listMenu === which ? "" : which;
      render();
    });
    on("sort_pick", (value: string) => {
      listMenu = "";
      if (view) view.settings.sort = value;
      render();
      void post("settings", { sort: value });
    });
    // "Show only — platforms" (the CRM's): a multi-select that stays open; "" is All platforms.
    on("plat_pick", (key: string) => {
      if (!view) return;
      const cur = view.settings.platforms ?? [];
      const next = key === "" ? [] : cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
      view.settings.platforms = next.length === LIST_PLATFORMS.length ? [] : next;
      render();
      void post("settings", { platforms: view.settings.platforms });
    });
    on("approve_set", (id: string, yes: boolean) => void post("approve", { id, approved: yes }));
    on("reach_pick", (k: string) => {
      if (!(REACH_KINDS as readonly string[]).includes(k) || k === reachKind) return;
      drafts[reachKind] = b.d_reach_text;
      reachKind = k as ReachKind;
      reachPicked = true;
      b.d_reach_text = drafts[reachKind];
      reachErr = "";
      render();
    });
    on("reach_edited", () => {
      reachErr = "";
      render();
    });
    const saveReach = (value: string): void => {
      const d = detail;
      if (!d || reachBusy) return;
      reachBusy = true;
      reachErr = "";
      render();
      void call("POST", "v1/collector/reach", { id: d.id, kind: reachKind, value })
        .then((r) => {
          takeDetail(r as DetailView, true);
          ctx?.toast(value ? `Reach saved: ${REACH_META[reachKind].label}.` : "Reach cleared.");
          void load();
        })
        .catch((e: unknown) => {
          reachErr = errText(e);
        })
        .finally(() => {
          reachBusy = false;
          render();
        });
    };
    on("reach_save", () => {
      const t = b.d_reach_text.trim();
      if (!t || !detail || !reachState(detail, reachKind, t).canSave) return;
      saveReach(t);
    });
    on("reach_clear", () => saveReach(""));
    // the detail's Send message (the same for every Reach kind): the composer with the selected icon's channel picked,
    // To filled with what that field holds
    on("detail_send", () => {
      const d = detail;
      if (!d) return;
      sendId = d.id;
      sendConfirm = false;
      compose = null;
      const typed = b.d_reach_text.trim();
      // the template and channel picked last, unless a Reach icon was clicked here: then that icon's channel
      const kind = reachPicked ? reachKind : "";
      void openCompose("", "", kind, kind && typed && !reachError(reachKind, typed) ? typed : "");
    });
    on("to_edited", () => renderSend());
    on("edit_show", () => {
      const d = detail;
      if (!d) return;
      b.e_name = d.edit.name;
      b.e_handle = d.edit.handle;
      b.e_bio = d.edit.bio;
      b.e_links = d.edit.links;
      editErr = "";
      editOpen = true;
      render();
    });
    on("edit_close", () => {
      editOpen = false;
      render();
    });
    on("edit_save", () => {
      const d = detail;
      if (!d) return;
      void call("POST", "v1/collector/edit", { id: d.id, name: b.e_name, handle: b.e_handle, description: b.e_bio, links: b.e_links })
        .then((r) => {
          editOpen = false;
          editErr = "";
          takeDetail(r as DetailView, false);
          ctx?.toast("Saved.");
          void load();
        })
        .catch((e: unknown) => {
          editErr = errText(e);
          render();
        });
    });
    on("save_template", () => {
      const c = compose;
      if (!c) return;
      const t = c.templates.find((x) => x.id === c.template);
      // the place picked goes with it: picking it again sends them there
      const body = { ...(t && t.id !== "blank" ? { id: t.id, name: t.name, description: t.description } : { name: `Template ${new Date().toLocaleDateString("en-GB")}`, description: "" }), subject: b.s_subject, body: b.s_text.split(c.name).join("{name}"), place: c.place ?? "" };
      void call("POST", "v1/collector/template", body)
        .then((r) => {
          const id = (r as { template: { id: string } }).template.id;
          if (compose) {
            compose.templates = ((r as { templates: Compose["templates"] }).templates ?? compose.templates).map((x) => ({ id: x.id, name: x.name, description: x.description, builtin: x.builtin, place: x.place ?? "" }));
            compose.template = id;
          }
          saved = "Saved";
          render();
          setTimeout(() => {
            saved = "";
            render();
          }, 2000);
        })
        .catch((e: unknown) => ctx?.toast(errText(e)));
    });
  }

  return {
    id: "collector",
    mount: async (c) => {
      ctx = c;
      const b = Reflect.get(c.win, "CollectorBus") as Bus | undefined;
      if (!b) throw new Error("the window has no CollectorBus");
      bus = b;
      bind(b);
      c.onChanged(() => {
        if (c.shown() && !fast) void load();
      });
      await load();
    },
    shown: (on) => {
      if (on) void load();
      else if (fast) {
        clearInterval(fast);
        fast = null;
      }
    },
    // An update's restart (or a crash): the same view, its filter and each view's scroll, an open lead (with the
    // review's queue, so "3 of 12" and the next lead are the same) and what its Reach field held.
    snapshot: () => {
      const b = bus;
      if (!b) return null;
      const y = (k: string): number => Number(b[k]) || 0;
      return {
        page,
        run: historyRun,
        filter: String(b.filter ?? ""),
        y: { collector: y("y_collector"), available: y("y_available"), approved: y("y_approved"), sent: y("y_sent"), restricted: y("y_restricted"), history: y("y_history") },
        sideHidden: b.side_hidden === true,
        detail: detailOpen && detail ? detail.id : null,
        queue: detailOpen ? queue.slice(0, 2000) : [],
        reach: detailOpen && detail ? { kind: reachKind, text: String(b.d_reach_text ?? "") } : null,
      };
    },
    restore: async (v) => {
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      const b = bus;
      if (!b) return;
      const p = PAGES.find((x) => x.id === o.page)?.id;
      if (p) page = p as Page;
      if (typeof o.run === "string") historyRun = o.run;
      if (typeof o.filter === "string") b.filter = o.filter;
      const y = (o.y && typeof o.y === "object" ? o.y : {}) as Record<string, unknown>;
      for (const k of ["collector", "available", "approved", "sent", "restricted", "history"]) if (typeof y[k] === "number" && Number.isFinite(y[k])) b[`y_${k}`] = y[k];
      if (typeof o.sideHidden === "boolean") b.side_hidden = o.sideHidden;
      render();
      if (typeof o.detail !== "string" || o.detail === "") return;
      queue = Array.isArray(o.queue) ? o.queue.filter((x): x is string => typeof x === "string") : [];
      await showDetail(o.detail, false);
      const r = (o.reach && typeof o.reach === "object" ? o.reach : null) as { kind?: unknown; text?: unknown } | null;
      if (r && detail?.id === o.detail && (REACH_KINDS as readonly string[]).includes(String(r.kind)) && typeof r.text === "string") {
        reachKind = r.kind as ReachKind;
        drafts[reachKind] = r.text;
        b.d_reach_text = r.text;
        render();
      }
    },
  };
}

export const collectorUi = createCollectorUi();
