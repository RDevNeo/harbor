// Collector tab, window side: drives CollectorBus (slint/collector.slint) from the engine's view (GET v1/collector, the
// same routes Hub for Android calls) and sends every change back. Three views (Collector, Available, Restricted), picked
// in the sidebar; one filter box on the lists. Pictures and video thumbnails are files the engine cached, decoded here.
// While a run is going it re-reads every second; otherwise on the tabs' change events.
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
  handle: string;
  platform: string;
  url: string;
  short: string;
  avatarPath: string | null;
  email: string;
  emailSource: string;
  videos: { url: string; title: string; thumbPath: string | null }[];
  restricted: boolean;
}
export interface CollectorView {
  rev: number;
  settings: { platform: string; query: string; gapDays: number; target: number; lastTemplate: string };
  sources: Source[];
  sessions: { platform: string; label: string; connected: boolean; account: string | null; savedAt: number; help: string }[];
  canSend: boolean;
  gaps: { value: number; label: string }[];
  run: { running: boolean; label: string; platform: string; query: string; found: number; target: number; known: number; line: string; status: string; ids: string[]; elapsed: number } | null;
  counts: { available: number; restricted: number };
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

export type Page = "collector" | "available" | "restricted";
type Bus = Record<string, unknown> & { query: string; target: string; filter: string; email_text: string; session_cookie: string; s_to: string; s_subject: string; s_text: string };

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
      .filter((c): c is Row => !!c && !c.restricted)
      .reverse();
    if (!r) return { rows, head: "", emptyTitle: "No search yet", emptyDesc: "Type a term and press Collect. Collector searches it for videos, as the platform shows them, and keeps each active creator once: picture, link, email when there is one, and their 3 newest videos." };
    return { rows, head: rows.length ? `FOUND FOR “${r.query.toUpperCase()}”` : "", emptyTitle: r.running ? "" : "Nothing new this time", emptyDesc: r.running ? "" : "Everyone it found was collected before, or hasn't posted inside Last upload. Try another term." };
  }
  const want = page === "restricted";
  const q = filter.trim().toLowerCase();
  const all = v.creators.filter((c) => c.restricted === want);
  const rows = q ? all.filter((c) => [c.name, c.handle, c.email, c.platform, c.short].some((x) => x.toLowerCase().includes(q))) : all;
  const emptyTitle = all.length === 0 ? (want ? "Nobody restricted" : "No leads yet") : "No match";
  const emptyDesc = all.length === 0 ? (want ? "Restrict a lead to keep it out of Available. It stays remembered, so no run collects it again." : "Collect some from the Collector page.") : `Nobody matches “${filter.trim()}”.`;
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
  { id: "restricted", label: "Restricted" },
];

export function createCollectorUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let view: CollectorView | null = null;
  let copied = 0;
  let fast: ReturnType<typeof setInterval> | null = null;
  let editing = 0;
  let page: Page = (["collector", "available", "restricted"] as const).find((p) => p === process.env.HUB_COLLECTOR_SHOT_PAGE) ?? "collector";
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
    const going = !!v.run?.running;
    if (going && !fast) fast = setInterval(() => void load(), 1000);
    if (!going && fast) {
      clearInterval(fast);
      fast = null;
    }
  };

  // The screenshot rig opens the Send dialog for the first lead straight away, once the first view is in.
  let shot = process.env.HUB_COLLECTOR_SHOT_SEND === "1";
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
    set("nav", new slint.ArrayModel(PAGES.map((p) => ({ id: p.id, label: p.label, on: p.id === page, count: p.id === "available" ? v.counts.available : p.id === "restricted" ? v.counts.restricted : 0 }))));
    set("n_available", v.counts.available);
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
          videos: new slint.ArrayModel(
            x.videos.map((vd) => {
              const t = pics.get(vd.thumbPath);
              return { url: vd.url, title: vd.title, thumb: t ?? NO_PX, has_thumb: !!t };
            }),
          ),
          sig: `${x.id}|${x.email}|${x.emailSource}|${x.restricted}|${!!px}|${x.videos.map((vd) => `${vd.url}${pics.get(vd.thumbPath) ? 1 : 0}`).join(",")}`,
        };
      }),
    );
    if (b.rows !== rowModel) b.rows = rowModel;
    renderSend();
  }

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

  const openCompose = async (template = "", channel = ""): Promise<void> => {
    if (!sendId || !bus) return;
    try {
      const c = (await call("GET", `v1/collector/compose?id=${encodeURIComponent(sendId)}&template=${encodeURIComponent(template)}&channel=${encodeURIComponent(channel)}`)) as Compose;
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
      void call("GET", "v1/collector/export")
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
