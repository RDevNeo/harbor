// Collector tab, window side: drives CollectorBus (slint/collector.slint) from the engine's view (GET v1/collector, the
// same routes Hub for Android calls) and sends every change back. Pictures are files the engine cached, decoded here.
// While a run is going it re-reads every second; otherwise on the tabs' 3 s tick.
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
}
interface Row {
  id: string;
  name: string;
  sub: string;
  stats: string;
  meta: string;
  url: string;
  avatarPath: string | null;
  discord: boolean;
  platform: string;
}
export interface CollectorView {
  rev: number;
  settings: { tab: "creators" | "servers"; platform: string; query: string; gapDays: number; serverMode: string; serverQuery: string; channel: string; targets: { creators: number; servers: number } };
  sources: Source[];
  modes: Source[];
  gaps: { value: number; label: string }[];
  discord: { connected: boolean; account: string | null };
  run: { running: boolean; tab: string; label: string; query: string; status: string; found: number; target: number; considered: number; dropped: number; elapsed: number } | null;
  log: { at: number; text: string; tone: string }[];
  counts: { creators: number; servers: number };
  creators: Row[];
  servers: Row[];
}

type Bus = Record<string, unknown> & { query: string; target: string };

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

/** What the form shows, from the view (pure: tested). */
export function formOf(v: CollectorView): { label: string; hint: string; query: string; unavailable: string; accountNote: string; accountOk: boolean } {
  const s = v.settings;
  if (s.tab === "creators") {
    const src = v.sources.find((x) => x.value === s.platform);
    return { label: "Search term", hint: "e.g. blox fruits brasil", query: s.query, unavailable: src && !src.available ? src.why : "", accountNote: "", accountOk: true };
  }
  const mode = v.modes.find((x) => x.value === s.serverMode);
  const reader = s.serverMode === "reader";
  return {
    label: reader ? "Channel link" : "Search Discover",
    hint: reader ? "https://discord.com/channels/…/…" : "e.g. vendo robux",
    query: reader ? s.channel : s.serverQuery,
    unavailable: mode && !mode.available ? mode.why : "",
    accountOk: v.discord.connected,
    accountNote: v.discord.connected
      ? `Reads through ${v.discord.account ?? "the Stores Discord account"} (Persons). Read-only: nothing is joined or sent.${reader ? "" : " Only servers with a public widget give an invite."}`
      : "Servers needs Discord: sign in to the Stores Discord account in Persons first.",
  };
}

/** The run card's lines (pure: tested). */
export function runOf(v: CollectorView): { title: string; status: string; clock: string; frac: number; meta: string } | null {
  const r = v.run;
  if (!r || r.tab !== v.settings.tab) return null;
  const what = r.tab === "creators" ? "creators" : "invites";
  const frac = r.target > 0 ? r.found / r.target : r.running ? 0 : 1;
  return {
    title: `${r.label} · “${r.query.length > 48 ? `${r.query.slice(0, 47)}…` : r.query}”`,
    status: r.running ? (r.target > 0 ? `${r.found} of ${r.target} ${what}` : `${r.found} ${what}`) : r.status,
    clock: clock(r.elapsed),
    frac,
    meta: [r.considered ? `${r.considered} checked` : "", r.dropped ? `${r.dropped} ${r.tab === "creators" ? "dropped" : "skipped"}` : ""].filter(Boolean).join(" · "),
  };
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
        .decodeBytes(new Uint8Array(readFileSync(path)), 96)
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

export function createCollectorUi(): TabUi {
  let ctx: TabCtx | null = null;
  let bus: Bus | null = null;
  let view: CollectorView | null = null;
  let logOpen = process.env.HUB_COLLECTOR_LOG === "1";
  let confirmClear = false;
  let copied = 0;
  let fast: ReturnType<typeof setInterval> | null = null;
  let editing = 0;
  const rowModel = new slint.ArrayModel<Record<string, unknown>>([]);
  const pics = new Pictures(() => render());

  const set = (k: string, v: unknown): void => {
    if (bus && bus[k] !== v) bus[k] = v;
  };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!ctx) throw new Error("not mounted");
    const r = await ctx.call(method, path, undefined, body);
    if (r.status >= 300) throw new Error((r.body as { error?: string } | null)?.error ?? `Hub answered ${r.status}`);
    return r.body;
  };

  const take = (v: CollectorView): void => {
    view = v;
    set("loading", false);
    render();
    const going = !!v.run?.running;
    if (going && !fast) fast = setInterval(() => void load(), 1000);
    if (!going && fast) {
      clearInterval(fast);
      fast = null;
    }
  };

  const load = async (): Promise<void> => {
    try {
      take((await call("GET", "v1/collector")) as CollectorView);
    } catch (e) {
      set("error", e instanceof Error ? e.message : String(e));
    }
  };

  const post = async (path: string, body?: unknown): Promise<void> => {
    try {
      take((await call("POST", `v1/collector/${path}`, body ?? {})) as CollectorView);
    } catch (e) {
      ctx?.toast(e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  function render(): void {
    const b = bus;
    const v = view;
    if (!b || !v) return;
    const s = v.settings;
    const tab = s.tab;
    set("tab", tab);
    set("n_creators", v.counts.creators);
    set("n_servers", v.counts.servers);
    const list = tab === "creators" ? v.sources : v.modes;
    const picked = tab === "creators" ? s.platform : s.serverMode;
    set("sources", new slint.ArrayModel(list.map((x) => ({ value: x.value, label: x.label, on: x.value === picked, available: x.available, tip: x.why }))));
    set("gaps", new slint.ArrayModel(v.gaps.map((g) => ({ value: String(g.value), label: g.label, on: g.value === s.gapDays, available: true, tip: g.value ? `Drop channels with no upload in the last ${g.value} days` : "Keep channels whatever they last uploaded" }))));
    const f = formOf(v);
    set("query_label", f.label);
    set("query_hint", f.hint);
    set("unavailable", f.unavailable);
    set("account_note", f.accountNote);
    set("account_ok", f.accountOk);
    // Don't fight the user's typing: the fields follow the engine only while they aren't being edited.
    if (Date.now() - editing > 1500) {
      if (b.query !== f.query) b.query = f.query;
      const t = s.targets[tab];
      const ts = t > 0 ? String(t) : "";
      if (b.target !== ts) b.target = ts;
    }
    const running = !!v.run?.running;
    set("running", running);
    set("run_here", running && v.run?.tab === tab);
    set("run_tab", v.run?.tab ?? "");
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
    set("confirm_clear", confirmClear);
    set("copy_label", Date.now() - copied < 2500 ? "Copied" : tab === "creators" ? "Copy JSONL" : "Copy URLs");
    const rows = (tab === "creators" ? v.creators : v.servers).map((x) => {
      const px = pics.get(x.avatarPath);
      return { id: x.id, name: x.name, sub: x.sub, stats: x.stats, meta: x.meta, url: x.url, avatar: px ?? NO_PX, has_avatar: !!px, initials: initials(x.name), color: colorOf(x.id), discord: x.discord, platform: x.platform };
    });
    sync(rows);
    if (b.rows !== rowModel) b.rows = rowModel;
  }

  /** The rows in place (a run adds one at a time: no full redraw of the list). */
  function sync(rows: Record<string, unknown>[]): void {
    const same = (x: Record<string, unknown>, y: Record<string, unknown>): boolean => x.avatar === y.avatar && x.id === y.id && x.stats === y.stats && x.meta === y.meta && x.name === y.name && x.sub === y.sub;
    const n = rowModel.rowCount();
    if (n > rows.length) rowModel.remove(rows.length, n - rows.length);
    for (let i = 0; i < rows.length; i++) {
      if (i < rowModel.rowCount()) {
        if (!same(rowModel.rowData(i) as Record<string, unknown>, rows[i]!)) rowModel.setRowData(i, rows[i]!);
      } else rowModel.push(rows[i]!);
    }
  }

  function bind(b: Bus): void {
    const on = (name: string, f: (...a: never[]) => void): void => {
      b[name] = f;
    };
    on("pick_tab", (t: string) => {
      confirmClear = false;
      void post("settings", { tab: t });
    });
    on("pick_source", (v: string) => view?.run?.running ? undefined : void post("settings", view?.settings.tab === "servers" ? { serverMode: v } : { platform: v }));
    on("pick_gap", (v: string) => view?.run?.running ? undefined : void post("settings", { gapDays: Number(v) }));
    on("query_edited", (t: string) => {
      editing = Date.now();
      const key = view?.settings.tab === "servers" ? (view.settings.serverMode === "reader" ? "channel" : "serverQuery") : "query";
      void call("POST", "v1/collector/settings", { [key]: t }).catch(() => {});
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
      const s = view?.settings;
      const q = b.query.trim();
      const key = s?.tab === "servers" ? (s.serverMode === "reader" ? "channel" : "serverQuery") : "query";
      void post("start", { [key]: q, target: b.target });
    });
    on("stop", () => void post("stop"));
    on("copy", () => {
      const tab = view?.settings.tab ?? "creators";
      void call("GET", `v1/collector/export?tab=${tab}`)
        .then(async (r) => {
          const { text, count } = r as { text: string; count: number };
          await clipboard.copyText(text);
          copied = Date.now();
          render();
          ctx?.toast(tab === "creators" ? `Copied ${count} creator(s). Paste into SpokPayCRM → Creators → Import.` : `Copied ${count} invite URL(s).`);
          setTimeout(render, 2600);
        })
        .catch((e: unknown) => ctx?.toast(e instanceof Error ? e.message : String(e)));
    });
    on("clear_ask", (yes: boolean) => {
      confirmClear = yes;
      render();
    });
    on("clear", () => {
      confirmClear = false;
      void post("clear", { tab: view?.settings.tab ?? "creators" });
    });
    on("toggle_log", () => {
      logOpen = !logOpen;
      render();
    });
    on("clear_log", () => void post("clear-log"));
    on("open", (url: string) => {
      if (url) ctx?.openExternal(url);
    });
    on("remove", (id: string) => void post("remove", { tab: view?.settings.tab ?? "creators", id }));
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
