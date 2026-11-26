// Collector tab, window side: drives CollectorBus (slint/collector.slint) from the engine's view (GET v1/collector, the
// same routes Hub for Android calls) and sends every change back. Pictures are files the engine cached, decoded here.
// While a run or the daily update is going it re-reads every second; otherwise on the tabs' change events.
// Send message is a real send: it only goes out from the dialog's second step ("Send now").
import * as slint from "slint-ui";
import { readFileSync, statSync } from "node:fs";
import { clipboard, images } from "@harbor/media";
import type { TabCtx, TabUi } from "../api.ts";

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
  sub: string;
  stats: string;
  meta: string;
  url: string;
  avatarPath: string | null;
  discord: boolean;
  platform: string;
  email: string;
  emailSource: string;
  updated: string;
  changed: string;
  contacted: string;
}
export interface CollectorView {
  rev: number;
  settings: { platform: string; query: string; gapDays: number; target: number; daily: boolean; lastTemplate: string };
  sources: Source[];
  sessions: { platform: string; label: string; connected: boolean; account: string | null; savedAt: number; help: string }[];
  canSend: boolean;
  gaps: { value: number; label: string }[];
  run: { running: boolean; label: string; platform: string; query: string; status: string; found: number; target: number; considered: number; dropped: number; known: number; elapsed: number } | null;
  refresh: { running: boolean; done: number; total: number; changed: number; failed: number; status: string; due: number; daily: boolean; last: string; next: string; lastFullAt: number };
  log: { at: number; text: string; tone: string }[];
  counts: { creators: number; emails: number; contacted: number; remembered: number };
  creators: Row[];
}
interface Detail extends Row {
  handle: string;
  country: string;
  description: string;
  stats: never;
  links: { label: string; url: string; kind: string; kindLabel: string; source: string; short: string }[];
  emailManual: boolean;
  whatsapp: string;
  updateError: string;
  history: { when: string; changes: string[] }[];
  recent: { title: string; url: string; when: string; views: string }[];
  found: string;
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

type Bus = Record<string, unknown> & { query: string; target: string; session_cookie: string; d_email_edit: string; s_to: string; s_subject: string; s_text: string };

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
export const clock = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export const FILTERS: { id: string; label: string; glyph: string; test: (r: Row) => boolean }[] = [
  { id: "all", label: "All creators", glyph: "\u{e1a4}", test: () => true },
  { id: "email", label: "With email", glyph: "\u{e04e}", test: (r) => !!r.email },
  { id: "noemail", label: "No email yet", glyph: "\u{e367}", test: (r) => !r.email },
  { id: "changed", label: "Changed today", glyph: "\u{e145}", test: (r) => !!r.changed },
  { id: "contacted", label: "Contacted", glyph: "\u{e152}", test: (r) => !!r.contacted },
];

/** What the form shows, from the view (pure: tested). */
export function formOf(v: CollectorView): { unavailable: string; note: string; session: boolean } {
  const src = v.sources.find((x) => x.value === v.settings.platform);
  return { unavailable: src && !src.available ? src.why : "", note: src?.note ?? "", session: v.settings.platform === "instagram" };
}

/** The run card's lines (pure: tested). */
export function runOf(v: CollectorView): { title: string; status: string; clock: string; frac: number; meta: string } | null {
  const r = v.run;
  if (!r) return null;
  const frac = r.target > 0 ? r.found / r.target : r.running ? 0 : 1;
  return {
    title: `${r.label} · “${r.query.length > 48 ? `${r.query.slice(0, 47)}…` : r.query}”`,
    status: r.running ? (r.target > 0 ? `${r.found} of ${r.target} new creators` : `${r.found} new creators`) : r.status,
    clock: clock(r.elapsed),
    frac,
    meta: [r.considered ? `${r.considered} checked` : "", r.dropped ? `${r.dropped} dropped` : "", r.known ? `${r.known} already known` : ""].filter(Boolean).join(" · "),
  };
}

/** The daily update card's lines (pure: tested). */
export function dailyOf(v: CollectorView): { status: string; meta: string; frac: number } {
  const r = v.refresh;
  if (r.running) return { status: r.status, meta: `${r.done} of ${r.total} read · ${r.changed} changed${r.failed ? ` · ${r.failed} couldn't be read` : ""}`, frac: r.total ? r.done / r.total : 0 };
  const parts = [r.last ? `Last full update ${r.last}` : "", r.daily ? (r.next ? `next ${r.next}` : "first one within minutes") : "Off: turn it on to update everyone once a day", r.due ? `${r.due} due` : ""].filter(Boolean);
  return { status: r.status || (r.daily ? "Once a day, every creator is read again: stats, last upload, bio, links, email." : "Daily update is off."), meta: parts.join(" · "), frac: 0 };
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

export function createCollectorUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let view: CollectorView | null = null;
  let logOpen = process.env.HUB_COLLECTOR_LOG === "1";
  let confirmClear = false;
  let copied = 0;
  let fast: ReturnType<typeof setInterval> | null = null;
  let editing = 0;
  let filter = "all";
  let page: "list" | "creator" = "list";
  let detail: Detail | null = null;
  let detailId = "";
  let emailEditFor = "";
  let refreshing = false;
  let sessionBusy = false;
  // Send message
  let compose: Compose | null = null;
  let sendOpen = false;
  let sendConfirm = false;
  let sendBusy = false;
  let sendError = "";
  let saved = "";
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
    set("loading", false);
    render();
    const going = !!v.run?.running || v.refresh.running;
    if (going && !fast) fast = setInterval(() => void load(), 1000);
    if (!going && fast) {
      clearInterval(fast);
      fast = null;
    }
  };

  const loadDetail = async (): Promise<void> => {
    if (!detailId) return;
    try {
      detail = (await call("GET", `v1/collector/creator?id=${encodeURIComponent(detailId)}`)) as Detail;
      render();
    } catch {
      // removed meanwhile: back to the list
      page = "list";
      detail = null;
      render();
    }
  };

  // The screenshot rig opens a creator (and the Send menu) or a filter straight away, once the first view is in.
  let shot = !!(process.env.HUB_COLLECTOR_SHOT_CREATOR || process.env.HUB_COLLECTOR_SHOT_FILTER);
  const shotOpen = async (): Promise<void> => {
    shot = false;
    if (process.env.HUB_COLLECTOR_SHOT_FILTER) filter = process.env.HUB_COLLECTOR_SHOT_FILTER;
    const want = process.env.HUB_COLLECTOR_SHOT_CREATOR;
    const id = want === "first" ? (view?.creators[0]?.id ?? "") : (want ?? "");
    if (id) {
      detailId = id;
      page = "creator";
      if (process.env.HUB_COLLECTOR_SHOT_SEND === "1") await openCompose(view?.settings.lastTemplate ?? "", "");
    }
    render();
  };

  const load = async (): Promise<void> => {
    try {
      take((await call("GET", "v1/collector")) as CollectorView);
      if (shot) await shotOpen();
      if (page === "creator") await loadDetail();
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

  function renderDetail(): void {
    const d = detail;
    if (!d || !bus) return;
    set("d_id", d.id);
    set("d_name", d.name);
    set("d_sub", [d.handle, d.country, d.found].filter(Boolean).join(" · "));
    set("d_platform", d.platform);
    const px = pics.get(d.avatarPath);
    set("d_avatar", px ?? NO_PX);
    set("d_has_avatar", !!px);
    set("d_initials", initials(d.name));
    set("d_color", colorOf(d.id));
    set("d_url", d.url);
    set("d_stats", new slint.ArrayModel((d.stats as unknown as { label: string; value: string }[]).map((s) => ({ label: s.label, value: s.value }))));
    set("d_desc", d.description);
    set("d_email", d.email);
    set("d_email_source", d.emailSource);
    set("d_email_manual", d.emailManual);
    if (emailEditFor !== d.id) {
      emailEditFor = d.id;
      bus.d_email_edit = d.email;
    }
    set("d_whatsapp", d.whatsapp);
    set("d_links", new slint.ArrayModel(d.links.map((l) => ({ label: l.label, url: l.url, kind: l.kind, source: l.source, short: l.short }))));
    set("d_updated", d.updated || "Not updated yet.");
    set("d_update_error", d.updateError ? `Last update failed: ${d.updateError}` : "");
    set("d_history", new slint.ArrayModel(d.history.map((h) => ({ when: h.when, changes: h.changes.join("\n") }))));
    set("d_recent", new slint.ArrayModel(d.recent.map((v) => ({ title: v.title, url: v.url, when: v.when, views: v.views }))));
    set("d_contacted", d.contacted);
    set("d_found", d.found);
    set("d_refreshing", refreshing);
    set("d_discord", d.discord);
  }

  function render(): void {
    const b = bus;
    const v = view;
    if (!b || !v) return;
    const s = v.settings;
    set("view", page);
    set("n_creators", v.counts.creators);
    set("filters", new slint.ArrayModel(FILTERS.map((f) => ({ id: f.id, label: f.label, glyph: f.glyph, on: f.id === filter, count: f.id === "all" ? v.counts.creators : v.creators.filter(f.test).length }))));
    set("sources", new slint.ArrayModel(v.sources.map((x) => ({ value: x.value, label: x.label, on: x.value === s.platform, available: x.available, tip: x.available ? x.note : x.why }))));
    set("gaps", new slint.ArrayModel(v.gaps.map((g) => ({ value: String(g.value), label: g.label, on: g.value === s.gapDays, available: true, tip: g.value ? `Drop creators with no upload or post in the last ${g.value} days` : "Keep creators whenever they last posted" }))));
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
    const r = runOf(v);
    set("has_run", r !== null);
    if (r) {
      set("run_title", r.title);
      set("run_status", r.status);
      set("run_clock", r.clock);
      set("run_frac", r.frac);
      set("run_meta", r.meta);
    }
    set("log_open", logOpen);
    if (logOpen) set("logs", new slint.ArrayModel(v.log.slice(-40).map((l) => ({ text: l.text, tone: l.tone }))));
    const dl = dailyOf(v);
    set("daily_on", v.refresh.daily);
    set("daily_running", v.refresh.running);
    set("daily_status", dl.status);
    set("daily_meta", dl.meta);
    set("daily_frac", dl.frac);
    set("confirm_clear", confirmClear);
    set("copy_label", Date.now() - copied < 2500 ? "Copied" : "Copy JSONL");
    const test = FILTERS.find((x) => x.id === filter)?.test ?? (() => true);
    const rows = v.creators.filter(test).map((x) => {
      const px = pics.get(x.avatarPath);
      return {
        id: x.id,
        name: x.name,
        sub: x.sub,
        stats: x.stats,
        meta: x.meta,
        url: x.url,
        avatar: px ?? NO_PX,
        has_avatar: !!px,
        initials: initials(x.name),
        color: colorOf(x.id),
        discord: x.discord,
        platform: x.platform,
        email: x.email,
        email_source: x.emailSource,
        updated: x.updated,
        changed: x.changed,
        contacted: x.contacted,
      };
    });
    set(
      "list_empty",
      v.counts.creators === 0
        ? "Pick a source, search a term (e.g. blox fruits brasil) and press Start. Each live creator is kept with their stats, every link and an email when one can be found; nobody is ever collected twice."
        : "No creator matches this filter.",
    );
    sync(rows);
    if (b.rows !== rowModel) b.rows = rowModel;
    renderDetail();
    renderSend();
  }

  /** The rows in place (a run adds one at a time: no full redraw of the list). */
  function sync(rows: Record<string, unknown>[]): void {
    const keys = ["avatar", "id", "stats", "meta", "name", "sub", "email", "email_source", "updated", "changed", "contacted"];
    const same = (x: Record<string, unknown>, y: Record<string, unknown>): boolean => keys.every((k) => x[k] === y[k]);
    const n = rowModel.rowCount();
    if (n > rows.length) rowModel.remove(rows.length, n - rows.length);
    for (let i = 0; i < rows.length; i++) {
      if (i < rowModel.rowCount()) {
        if (!same(rowModel.rowData(i) as Record<string, unknown>, rows[i]!)) rowModel.setRowData(i, rows[i]!);
      } else rowModel.push(rows[i]!);
    }
  }

  const openCompose = async (template = "", channel = ""): Promise<void> => {
    if (!detailId || !bus) return;
    try {
      const c = (await call("GET", `v1/collector/compose?id=${encodeURIComponent(detailId)}&template=${encodeURIComponent(template)}&channel=${encodeURIComponent(channel)}`)) as Compose;
      const keepTo = compose && compose.channel === c.channel ? bus.s_to : null;
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
    on("pick_filter", (id: string) => {
      filter = id;
      page = "list";
      confirmClear = false;
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
      void post("start", { query: b.query.trim(), target: b.target });
    });
    on("stop", () => void post("stop"));
    on("copy", () => {
      void call("GET", "v1/collector/export")
        .then(async (r) => {
          const { text, count } = r as { text: string; count: number };
          await clipboard.copyText(text);
          copied = Date.now();
          render();
          ctx?.toast(`Copied ${count} creator(s). Paste into SpokPayCRM → Creators → Import.`);
          setTimeout(render, 2600);
        })
        .catch((e: unknown) => ctx?.toast(errText(e)));
    });
    on("clear_ask", (yes: boolean) => {
      confirmClear = yes;
      render();
    });
    on("clear", () => {
      confirmClear = false;
      void post("clear");
      ctx?.toast("Cleared. They stay remembered: no run collects them again.");
    });
    on("toggle_log", () => {
      logOpen = !logOpen;
      render();
    });
    on("clear_log", () => void post("clear-log"));
    on("open", (url: string) => {
      if (url) ctx?.openExternal(url);
    });
    on("remove", (id: string) => void post("remove", { id }));
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
    on("daily_toggle", (v: boolean) => void post("settings", { daily: v }));
    on("daily_now", () => void post("refresh", {}));
    on("daily_stop", () => void post("refresh", { stop: true }));
    on("open_creator", (id: string) => {
      detailId = id;
      emailEditFor = "";
      page = "creator";
      detail = null;
      confirmClear = false;
      void loadDetail();
    });
    on("back", () => {
      page = "list";
      sendOpen = false;
      render();
    });
    on("email_save", () => {
      const id = detailId;
      void call("POST", "v1/collector/email", { id, email: b.d_email_edit })
        .then((d) => {
          detail = d as Detail;
          emailEditFor = "";
          render();
          ctx?.toast(b.d_email_edit.trim() ? "Email saved." : "Email cleared: the daily update looks for one again.");
          void load();
        })
        .catch((e: unknown) => ctx?.toast(errText(e)));
    });
    on("refresh_one", () => {
      if (refreshing) return;
      refreshing = true;
      render();
      void call("POST", "v1/collector/refresh", { id: detailId })
        .then((d) => {
          detail = d as Detail;
          emailEditFor = "";
          ctx?.toast("Updated.");
        })
        .catch((e: unknown) => ctx?.toast(errText(e)))
        .finally(() => {
          refreshing = false;
          void load();
        });
    });
    on("send_show", () => {
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
