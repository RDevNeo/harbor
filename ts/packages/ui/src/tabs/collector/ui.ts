// Collector tab, window side: drives CollectorBus (slint/collector.slint) from the engine's view (GET v1/collector, the
// same routes Hub for Android calls) and sends every change back. Four views (Collector, Available, Approved, Restricted),
// picked in the sidebar; one filter box on the lists. A lead's detail has the review bar (Reject / Skip / Approve, R S A
// or ← ↓ →; Approve puts them in the Approved list): each goes on to the next lead of the list the detail was opened from. Pictures and video thumbnails are files the engine cached, decoded here.
// While a run is going it re-reads every second; otherwise on the tabs' change events.
// Send message is a real send: it only goes out from the dialog's second step ("Send now").
import * as slint from "slint-ui";
import { readFileSync, statSync } from "node:fs";
import { clipboard, images } from "@harbor/media";
import type { TabCtx, TabUi } from "../api.ts";
import { REACH_META, reachError, reachHref } from "../../../../../tabs/collector/lib/reach.ts";
import { REACH_KINDS, type ReachKind } from "../../../../../tabs/collector/lib/types.ts";
import type { DetailView } from "../../../../../tabs/collector/view.ts";

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
  /** "youtube", "tiktok", "instagram". */
  platformKey?: string;
  /** Followers (YouTube subscribers count as followers; null unknown). */
  subs?: number | null;
  /** The Reach picked in the detail ("" none) and its value. */
  reach?: string;
  reachValue?: string;
}
export interface CollectorView {
  rev: number;
  settings: { platform: string; query: string; gapDays: number; target: number; lastTemplate: string; approveTo?: string; sort?: string; platforms?: string[] };
  sources: Source[];
  sessions: { platform: string; label: string; connected: boolean; account: string | null; savedAt: number; help: string }[];
  canSend: boolean;
  gaps: { value: number; label: string }[];
  run: { running: boolean; label: string; platform: string; query: string; found: number; target: number; known: number; line: string; status: string; ids: string[]; elapsed: number } | null;
  counts: { available: number; approved?: number; restricted: number };
  /** The review bar's "Approve to" choices. */
  approveTo?: { value: string; label: string; tip: string }[];
  /** The lists' Sort menu. */
  sorts?: { value: string; label: string; group: number }[];
  /** Finished runs not looked at yet: the tab's count (TabsBus.collector-unread). */
  unseen?: number;
  creators: Row[];
}
interface Compose {
  id: string;
  name: string;
  templates: { id: string; name: string; description: string; builtin: boolean }[];
  template: string;
  channels: { id: string; kind: string; label: string; account: string | null; connected: boolean; to: string; why: string }[];
  channel: string;
  kind: string;
  to: string;
  subject: string;
  text: string;
  guard: { sentToday: number; limit: number; already: string | null; justSent: boolean } | null;
}

export type Page = "collector" | "available" | "approved" | "restricted";
type Bus = Record<string, unknown> & { query: string; target: string; filter: string; email_text: string; session_cookie: string; s_to: string; s_subject: string; s_text: string; d_reach_text: string; e_name: string; e_handle: string; e_bio: string; e_links: string };

/** The lead the review bar goes on to: the first one after `current` in the list the detail was opened from that is
 *  still in that list now (pure: tested). Null at the end. */
export function nextLead(queue: string[], current: string, live: Iterable<string>): string | null {
  const now = new Set(live);
  const at = queue.indexOf(current);
  if (at < 0) return null;
  for (let i = at + 1; i < queue.length; i++) if (queue[i] !== current && now.has(queue[i]!)) return queue[i]!;
  return null;
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

const listOfRow = (c: Row): Page => (c.restricted ? "restricted" : c.approved ? "approved" : "available");

/** The podium's render order (the CRM's 2-1-3): the newest in the middle, featured; a missing one leaves its place
 *  empty (pure: tested). */
export function podium<T>(videos: T[]): { v: T | null; featured: boolean }[] {
  if (!videos.length) return [];
  return [1, 0, 2].map((i) => ({ v: videos[i] ?? null, featured: i === 0 }));
}

/** What the Reach row shows for the kind picked and the text typed (pure: tested). */
export function reachState(d: DetailView, kind: ReachKind, text: string): { error: string; canSave: boolean; help: string; hint: string } {
  const t = text.trim();
  const error = t ? (reachError(kind, t) ?? "") : "";
  const help = kind === "whatsapp" ? "Country code first, like +55 21 97570-9440 (a Brazilian number without it gets +55)." : kind === "discord" ? "Enable Developer Mode, right-click a user › Copy User ID." : "";
  const same = !!d.reach && d.reach === kind && d.reachValue === t;
  return { error, canSave: !!t && !error && !same, help, hint: REACH_META[kind].placeholder };
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

/** The leads one view shows, and its heading and empty state (pure: tested). */
export function leadsOf(v: CollectorView, page: Page, filter: string): { rows: Row[]; head: string; emptyTitle: string; emptyDesc: string } {
  if (page === "collector") {
    const r = v.run;
    const byId = new Map(v.creators.map((c) => [c.id, c]));
    const rows = (r?.ids ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is Row => !!c && !c.restricted && !c.approved)
      .reverse();
    if (!r) return { rows, head: "", emptyTitle: "No search yet", emptyDesc: "Type a term and press Collect. Collector searches it for videos, as the platform shows them, and keeps each active creator once: picture, link, email when there is one, and their 3 newest videos." };
    return { rows, head: rows.length ? `FOUND FOR “${r.query.toUpperCase()}”` : "", emptyTitle: r.running ? "" : "Nothing new this time", emptyDesc: r.running ? "" : "Everyone it found was collected before, or hasn't posted inside Last upload. Try another term." };
  }
  const q = filter.trim().toLowerCase();
  const all = v.creators.filter((c) => listOfRow(c) === page);
  const only = v.settings.platforms ?? [];
  const shown = only.length ? all.filter((c) => only.includes(c.platformKey ?? "")) : all;
  const rows = sortRows(q ? shown.filter((c) => [c.name, c.handle, c.email, c.platform, c.short].some((x) => x.toLowerCase().includes(q))) : shown, v.settings.sort ?? "followers-desc");
  const none: [string, string] = ({ restricted: ["Nobody restricted", "Restrict a lead (or Reject it in its detail) to keep it out of Available. It stays remembered, so no run collects it again."], approved: ["Nobody approved", "Open a lead and press Approve (A or →). Approved leads leave Available and stay remembered, so no run collects them again."], available: ["No leads yet", "Collect some from the Collector page."] } as Record<"available" | "approved" | "restricted", [string, string]>)[page];
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
  { id: "restricted", label: "Restricted" },
];

export function createCollectorUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let view: CollectorView | null = null;
  let copied = 0;
  let fast: ReturnType<typeof setInterval> | null = null;
  let editing = 0;
  let page: Page = (["collector", "available", "approved", "restricted"] as const).find((p) => p === process.env.HUB_COLLECTOR_SHOT_PAGE) ?? "collector";
  let emailFor = "";
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
  let drafts: Record<ReachKind, string> = { email: "", discord: "", whatsapp: "", instagram: "" };
  let reachBusy = false;
  let reachErr = "";
  let editOpen = false;
  let editErr = "";
  // The review bar: the list the detail was opened from (its ids in its filter and order).
  let queue: string[] = [];
  let reviewBusy = false;
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
  let shot = process.env.HUB_COLLECTOR_SHOT_SEND === "1";
  let shotDetail = process.env.HUB_COLLECTOR_SHOT_DETAIL === "1";
  const load = async (): Promise<void> => {
    try {
      take((await call("GET", "v1/collector")) as CollectorView);
      if (shot) {
        shot = false;
        const first = view?.creators.find((c) => !c.restricted);
        if (first) {
          sendId = first.id;
          await openCompose(view?.settings.lastTemplate ?? "", "");
        }
      }
      if (shotDetail) {
        shotDetail = false;
        const first = view?.creators.find((c) => !c.restricted);
        if (first) await showDetail(first.id);
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
    set("s_channels", new slint.ArrayModel(c.channels.map((x) => ({ value: x.id, label: x.kind === "gmail" ? `Email${x.account ? ` · ${x.account}` : ""}` : `WhatsApp${x.account ? ` · ${x.account}` : ""}`, on: x.id === c.channel, available: x.connected, tip: x.why }))));
    set("s_channel_why", !c.channels.length ? "Persons › Creators has no Gmail or WhatsApp: add one there (Creators › Connections)." : (ch?.why ?? ""));
    set("s_is_email", (ch?.kind ?? c.kind) !== "whatsapp");
    const g = c.guard;
    set("s_guard", g && g.limit ? `${g.sentToday}/${g.limit} new emails sent in the last 24 h from this account.` : "");
    set("s_already", g?.already ?? "");
    set("s_error", sendError);
    set("s_busy", sendBusy);
    set("s_confirm", sendConfirm);
    const isEmail = (ch?.kind ?? c.kind) !== "whatsapp";
    set("s_confirm_text", `A real ${isEmail ? "email" : "WhatsApp message"} goes to ${bus.s_to.trim()}${ch?.account ? ` from ${ch.account}` : ""}. ${c.name} becomes a person in Persons › Creators, and the message shows in that chat.`);
    set("s_can_send", !!ch?.connected && bus.s_to.trim() !== "" && bus.s_text.trim() !== "" && (!isEmail || bus.s_subject.trim() !== ""));
    set("s_saved", saved);
  }

  function render(): void {
    const b = bus;
    const v = view;
    if (!b || !v) return;
    const s = v.settings;
    set("page", page);
    set("nav", new slint.ArrayModel(PAGES.map((p) => ({ id: p.id, label: p.label, on: p.id === page, count: p.id === "available" ? v.counts.available : p.id === "approved" ? (v.counts.approved ?? 0) : p.id === "restricted" ? v.counts.restricted : 0 }))));
    set("n_available", v.counts.available);
    set("n_approved", v.counts.approved ?? 0);
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
    set("email_for", emailFor);
    const l = leadsOf(v, page, b.filter);
    set("rows_head", l.head);
    renderListMenus(v);
    set("empty_title", l.emptyTitle);
    set("empty_desc", l.emptyDesc);
    sync(
      l.rows.map((x) => {
        const px = pics.get(x.avatarPath);
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
          email_source: x.emailSource,
          restricted: x.restricted,
          approved: !!x.approved,
          reach: x.reach ?? "",
          reach_value: x.reachValue ?? "",
          reach_color: x.reach && (REACH_KINDS as readonly string[]).includes(x.reach) ? REACH_META[x.reach as ReachKind].color : "#9aa4b2",
          videos: new slint.ArrayModel(
            x.videos.map((vd) => {
              const t = pics.get(vd.thumbPath);
              return { url: vd.url, title: vd.title, thumb: t ?? NO_PX, has_thumb: !!t };
            }),
          ),
          sig: `${x.id}|${x.name}|${x.handle}|${x.email}|${x.emailSource}|${x.restricted}|${!!x.approved}|${x.reach ?? ""}${x.reachValue ?? ""}|${!!px}|${x.videos.map((vd) => `${vd.url}${pics.get(vd.thumbPath) ? 1 : 0}`).join(",")}`,
        };
      }),
    );
    if (b.rows !== rowModel) b.rows = rowModel;
    renderSend();
    renderDetail();
  }

  function renderListMenus(v: CollectorView): void {
    const b = bus;
    if (!b) return;
    const sort = v.settings.sort ?? "followers-desc";
    const only = v.settings.platforms ?? [];
    const sorts = v.sorts ?? [];
    set("sort_label", sortShort(sorts.find((x) => x.value === sort)?.label ?? "Sort"));
    set("sort_tip", `Sort: ${sorts.find((x) => x.value === sort)?.label ?? ""}`);
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
    set("d_contacted", d.contacted);
    const reachSig = `${reachKind}`;
    if (sigs.d_reaches !== reachSig) {
      b.d_reaches = new slint.ArrayModel(REACH_KINDS.map((k) => ({ kind: k, label: REACH_META[k].label, color: REACH_META[k].color, on: k === reachKind })));
      sigs.d_reaches = reachSig;
    }
    const st = reachState(d, reachKind, b.d_reach_text);
    set("d_reach_hint", st.hint);
    set("d_reach_help", st.help);
    set("d_reach_error", reachErr || st.error);
    set("d_reach_can_save", st.canSave);
    set("d_reach_saved", !!d.reach);
    set("d_reach_busy", reachBusy);
    set("d_reach_send", d.reachSend);
    set("d_reach_send_kind", d.reach);
    set("d_url", d.url);
    set("d_open_label", d.openLabel);
    set("d_filling", filling);
    set("e_error", editErr);
    set("d_approved_note", d.approvedNote ?? "");
    set("d_restricted", d.restricted);
    set("d_approved", !!d.approved);
    const pos = queue.indexOf(d.id);
    set("d_position", pos >= 0 && queue.length > 1 ? `${pos + 1} of ${queue.length}` : "");
    set("review_busy", reviewBusy);
  }

  /** Takes a fresh detail; the Reach field keeps what the user typed unless it was the old value. */
  const takeDetail = (d: DetailView, resetReach: boolean): void => {
    const prev = detail;
    detail = d;
    if (resetReach || !prev || prev.id !== d.id) {
      reachKind = d.reachKind;
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
    render();
  };

  /** The review bar: Reject (to Restricted), Skip (as it is), Approve (to the Approved list); then the next lead of the list
   *  the detail was opened from, or "All reviewed" at its end. */
  const review = async (what: "reject" | "skip" | "approve"): Promise<void> => {
    const d = detail;
    if (!d || !detailOpen || reviewBusy || editOpen || sendOpen) return;
    reviewBusy = true;
    render();
    try {
      if (what === "reject") take((await call("POST", "v1/collector/restrict", { id: d.id, restricted: true })) as CollectorView);
      if (what === "approve") {
        take((await call("POST", "v1/collector/approve", { id: d.id, approved: true, to: "list" })) as CollectorView);
        ctx?.toast(`${d.name} approved.`);
      }
      const v = view;
      const next = v ? nextLead(queue, d.id, leadsOf(v, page, bus?.filter ?? "").rows.map((r) => r.id)) : null;
      if (next) await showDetail(next, false);
      else {
        closeDetail();
        ctx?.toast("All reviewed.");
      }
    } catch (e) {
      ctx?.toast(errText(e));
    } finally {
      reviewBusy = false;
      render();
    }
  };

  const showDetail = async (id: string, fromList = true): Promise<void> => {
    try {
      // Opened from a card: the review bar goes through that list, in its filter and order.
      if (fromList && view && bus) queue = leadsOf(view, page, bus.filter).rows.map((r) => r.id);
      const d = (await call("GET", `v1/collector/creator?id=${encodeURIComponent(id)}`)) as DetailView;
      detailOpen = true;
      editOpen = false;
      takeDetail(d, true);
      // An older lead misses some of this: one read of its profile fills it (the engine decides if it's due).
      filling = true;
      render();
      const f = (await call("POST", "v1/collector/fill", { id }).catch(() => null)) as DetailView | null;
      filling = false;
      if (f && detail?.id === id) takeDetail(f, false);
      else render();
    } catch (e) {
      filling = false;
      ctx?.toast(errText(e));
    }
  };

  /** A saved Reach's action: Send message for email and WhatsApp, their profile for Discord and Instagram. */
  const reachGo = (id: string, kind: string, value: string): void => {
    if (kind === "email" || kind === "whatsapp") {
      sendId = id;
      sendConfirm = false;
      compose = null;
      void openCompose(view?.settings.lastTemplate ?? "", "", kind);
      return;
    }
    const href = (REACH_KINDS as readonly string[]).includes(kind) ? reachHref({ kind: kind as ReachKind, value }) : null;
    if (href) ctx?.openExternal(href);
    else ctx?.toast("Nothing to open for that Reach.");
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

  const openCompose = async (template = "", channel = "", kind = ""): Promise<void> => {
    if (!sendId || !bus) return;
    try {
      const c = (await call("GET", `v1/collector/compose?id=${encodeURIComponent(sendId)}&template=${encodeURIComponent(template)}&channel=${encodeURIComponent(channel)}&kind=${encodeURIComponent(kind)}`)) as Compose;
      const keepTo = compose && compose.id === c.id && compose.channel === c.channel ? bus.s_to : null;
      compose = c;
      bus.s_to = keepTo ?? c.to;
      bus.s_subject = c.subject;
      bus.s_text = c.text;
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
      listMenu = "";
      emailFor = "";
      render();
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
    on("restrict", (id: string, yes: boolean) => {
      const name = view?.creators.find((c) => c.id === id)?.name ?? "Lead";
      void post("restrict", { id, restricted: yes }).then(() => ctx?.toast(yes ? `${name} moved to Restricted.` : `${name} is back in Available.`));
    });
    on("filter_edited", () => render());
    on("email_edit", (id: string) => {
      emailFor = id;
      b.email_text = view?.creators.find((c) => c.id === id)?.email ?? "";
      render();
    });
    on("email_cancel", () => {
      emailFor = "";
      render();
    });
    on("email_save", () => {
      const id = emailFor;
      const email = b.email_text.trim();
      void call("POST", "v1/collector/email", { id, email })
        .then(() => {
          emailFor = "";
          ctx?.toast(email ? "Email saved." : "Email cleared.");
          void load();
        })
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
      void openCompose(view?.settings.lastTemplate ?? "", "");
    });
    on("send_close", () => {
      if (sendBusy) return;
      sendOpen = false;
      sendConfirm = false;
      render();
    });
    on("pick_template", (id: string) => void openCompose(id, compose?.channel ?? ""));
    on("pick_channel", (id: string) => void openCompose(compose?.template ?? "", id));
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
      void call("POST", "v1/collector/send", { id: c.id, channel: c.channel, to: b.s_to.trim(), subject: b.s_subject.trim(), text: b.s_text, template: c.template })
        .then(() => {
          sendOpen = false;
          sendConfirm = false;
          ctx?.toast(`Sent to ${c.name}. They're in Persons › Creators.`);
          void load();
          if (detailOpen && detail?.id === c.id) void call("GET", `v1/collector/creator?id=${encodeURIComponent(c.id)}`).then((d) => takeDetail(d as DetailView, false), () => {});
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
    on("detail_close", () => closeDetail());
    on("review", (what: string) => {
      if (what === "reject" || what === "skip" || what === "approve") void review(what);
    });
    on("list_menu_show", (which: string) => {
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
    on("approve_set", (id: string, yes: boolean) => {
      const name = view?.creators.find((c) => c.id === id)?.name ?? "Lead";
      void post("approve", { id, approved: yes }).then(() => ctx?.toast(yes ? `${name} approved.` : `${name} is back in Available.`));
    });
    on("reach_pick", (k: string) => {
      if (!(REACH_KINDS as readonly string[]).includes(k) || k === reachKind) return;
      drafts[reachKind] = b.d_reach_text;
      reachKind = k as ReachKind;
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
    on("reach_send", () => {
      const d = detail;
      if (d?.reach) reachGo(d.id, d.reach, d.reachValue);
    });
    on("reach_go", (id: string) => {
      const r = view?.creators.find((c) => c.id === id);
      if (r?.reach) reachGo(id, r.reach, r.reachValue ?? "");
    });
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
      const body = { ...(t && t.id !== "blank" ? { id: t.id, name: t.name, description: t.description } : { name: `Template ${new Date().toLocaleDateString("en-GB")}`, description: "" }), subject: b.s_subject, body: b.s_text.split(c.name).join("{name}") };
      void call("POST", "v1/collector/template", body)
        .then((r) => {
          const id = (r as { template: { id: string } }).template.id;
          if (compose) {
            compose.templates = ((r as { templates: Compose["templates"] }).templates ?? compose.templates).map((x) => ({ id: x.id, name: x.name, description: x.description, builtin: x.builtin }));
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
  };
}

export const collectorUi = createCollectorUi();
