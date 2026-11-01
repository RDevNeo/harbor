import { type ghapi, prdetail as prdetailApi } from "@harbor/mcp";
import { mdBlocks } from "./cards.ts";
import { escLeaves, type Key, Memo, Split, type TabAct } from "./logic/listdetail.ts";
import {
  centered, emptyFor, filtersMenu, FILTER_ROWS, listRows, type MenuCtx, type MenuRowData, type MenuView, OpenMenu, pickSub, providerMenu, reviewPrompt, rowActions,
  SEARCH_HINT, sortMenu, SORT_ORDER, subAt, subMenu, subPos, SUB_W, MENU_W, tabLabel, toolbarWidths, type PrRowData, type Project, type RowAction, type Sub, type Tool,
} from "./logic/prs.ts";
import {
  type CodeLine, codeState, type DetailAct, detailActOf, type DetailState, header, type Header, LINK_MENU, moreMenu, newDetail, type NoteData, summary, type Summary, timeline, type TimelineItem,
} from "./logic/prdetail.ts";
import type { MdBlockData } from "./window.ts";
import type { Pixels } from "./logos.ts";

type Pr = ghapi.Pr;
type PrFetched = ghapi.PrFetched;
type PrFilters = ghapi.PrFilters;
type PrSort = ghapi.PrSort;

export interface PrsHost {
  projects(): Project[];
  repos(): Promise<string[]>;
  agentLabel(): string;
  accounts(): { id: string; label: string; current: boolean }[];
  pickAccount(id: string): void;
  openUrl(url: string): void;
  openBrowser(url: string): void;
  copy(text: string): void;
  checkout(project: number, number: number): void;
  review(project: number, prompt: string): void;
  merge(project: number, pr: Pr, ask: boolean): void;
  close(): void;
  now(): number;
  notProject: string;
}

export interface PrsPorts {
  prs: ghapi.PrsPort;
  details: ghapi.DetailsPort;
}

interface TabItem {
  icon: string;
  text: string;
}

interface SlintNote {
  who: string;
  letter: string;
  what: string;
  blocks: MdBlockData[];
}

interface SlintEvent {
  kind: string;
  icon: string;
  tone: string;
  text: string;
  mono: boolean;
  age: string;
  note: SlintNote;
}

type SlintSummary = Omit<Summary, "body" | "comments"> & { body: MdBlockData[]; comments: SlintNote[] };

/** The window's properties and callbacks (prs.slint `PrsPage`) as slint-ui exposes them. */
export interface PrsView {
  page_title: string;
  docked: boolean;
  list_w: number;
  panel_w: number;
  wrap: boolean;
  search_w: number;
  search: string;
  hint: string;
  active_filters: number;
  loading: boolean;
  github: Pixels;
  list_state: string;
  rows: PrRowData[];
  empty_icon: string;
  empty_title: string;
  empty_desc: string;
  has_tabs: boolean;
  menu: string;
  menu_rows: MenuRowData[];
  menu_w: number;
  menu_h: number;
  menu_hl: number;
  sub: string;
  sub_rows: MenuRowData[];
  sub_w: number;
  sub_h: number;
  sub_row_y: number;
  sub_scroll_from: number;
  sub_scroll_h: number;
  sub_hl: number;
  popup_items: RowAction[];
  popup_w: number;
  popup_h: number;
  popup_kind: string;
  tabs: TabItem[];
  active_tab: number;
  maxed: boolean;
  head: Header;
  tab: string;
  summary: SlintSummary;
  events: SlintEvent[];
  code_state: string;
  code_error: string;
  lines: CodeLine[];
  agent: string;
  resized: (w: number) => void;
  edited: (t: string) => void;
  tool: (t: string) => void;
  row_open: (url: string) => void;
  row_menu: (url: string) => void;
  close_page: () => void;
  tab_act: (kind: string | number, i: number) => void;
  toggle_panel: () => void;
  drag: (x: number) => void;
  menu_key: (k: string) => void;
  menu_hover: (i: number) => void;
  menu_pick: (i: number) => void;
  sub_hover: (i: number) => void;
  sub_pick: (i: number) => void;
  menu_close: () => void;
  popup_open: (kind: string) => void;
  popup_pick: (i: number) => void;
  detail_act: (a: string) => void;
  pick_tab: (t: string) => void;
  detail_toggle: (k: string) => void;
  link: (u: string) => void;
  copy: (t: string) => void;
  open_check: (u: string) => void;
}

const codeStateLines = (s: ReturnType<typeof codeState>): CodeLine[] => (s.kind === "lines" ? s.lines : []);

const TAB_KINDS = ["activate", "close", "close-others", "close-right", "close-all", "toggle", "maximize"] as const;

/** A Slint `TabActKind` (it arrives as its name or its index) as the Split's action. */
export function tabAct(kind: string | number, i: number): TabAct | null {
  const k = typeof kind === "number" ? TAB_KINDS[kind] : kind;
  switch (k) {
    case "activate":
      return { kind: "activate", i };
    case "close":
      return { kind: "close", i };
    case "close-others":
      return { kind: "close_others", i };
    case "close-right":
      return { kind: "close_right", i };
    case "close-all":
      return { kind: "close_all" };
    case "toggle":
      return { kind: "toggle" };
    case "maximize":
      return { kind: "maximize" };
    default:
      return null;
  }
}

const KEYS: Record<string, Key> = { up: "up", down: "down", home: "home", end: "end", enter: "enter", space: "space", right: "right", left: "left", esc: "esc" };

export interface PrsHandle {
  /** Fetches the list again (the refresh button). */
  load(): Promise<void>;
  /** A page shortcut by action id: `list_close_tab`, `list_toggle_panel`, `pr_copy_link`, `pr_copy_number`. */
  shortcut(id: string): void;
  /** Esc on the page; `typing`: a text field had focus. */
  esc(typing: boolean): void;
  /** Resolves when nothing is loading. */
  idle(): Promise<void>;
  open(url: string): void;
  /** The page's width, until the view reports it itself. */
  resize(w: number): void;
  /** Narrows the list to one project (a project menu's Pull requests). */
  select(project: number): void;
}

/** Wires the Pull requests page (prs.rs `Prs`) to its Slint view. */
export function attachPrs(view: PrsView, ports: PrsPorts, host: PrsHost, opts: { docked?: boolean; sort?: PrSort } = {}): PrsHandle {
  const split = new Split();
  const menu = new OpenMenu();
  const memo = new Memo<ghapi.Group<Pr>[]>();
  const details = new Map<string, DetailState>();
  const blocksCache = new Map<string, MdBlockData[]>();
  let data: { ok: PrFetched } | { err: string } | null = null;
  let fetched: PrFilters["state"] | null = null;
  let generation = 0;
  let loading = false;
  let search = "";
  let sort: PrSort = opts.sort ?? "ready";
  let githubOnly = false;
  let project: number | undefined;
  let filters: PrFilters = { state: "open", involvement: "all", labels: [] };
  let width = 0;
  let rowUrl: string | null = null;
  let popup: { kind: string; items: RowAction[] } | null = null;
  let subRowY = 0;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };

  const blocks = (md: string): MdBlockData[] => {
    let b = blocksCache.get(md);
    if (b === undefined) {
      b = mdBlocks(md);
      blocksCache.set(md, b);
    }
    return b;
  };
  const slintNote = (n: NoteData): SlintNote => ({ who: n.who, letter: n.letter, what: n.what, blocks: blocks(n.body) });

  const projects = (): Project[] => host.projects();
  const picked = (): Project | undefined => projects().find((p) => p.id === project);
  const current = (): PrFetched => (data !== null && "ok" in data ? data.ok : { viewer: "", items: [] });
  const active = (): number => {
    const f = filters;
    const on = [f.state !== "open", f.involvement !== "all", picked() !== undefined, f.draft !== undefined, f.review !== undefined, f.checks !== undefined, f.author !== undefined];
    return on.filter(Boolean).length + f.labels.length;
  };
  const effective = (): PrFilters => {
    const p = picked();
    const f: PrFilters = { ...filters };
    if (p !== undefined) f.project = p.repo;
    else delete f.project;
    return f;
  };
  const groups = (): ghapi.Group<Pr>[] => {
    const f = effective();
    return memo.get([current(), JSON.stringify(f), search, sort], () => ports.prs.groups(current(), f, search, sort));
  };
  const menuCtx = (): MenuCtx => {
    const d = current();
    return { filters, sort, githubOnly, project: picked(), projects: projects(), authors: ports.prs.authors(d), labels: ports.prs.labels(d), sortLabel: ports.prs.sortLabel };
  };


  async function load(): Promise<void> {
    generation += 1;
    const gen = generation;
    loading = true;
    const state = filters.state;
    renderList();
    let r: { ok: PrFetched } | { err: string };
    try {
      r = { ok: await ports.prs.fetch(state, await host.repos()) };
    } catch (e) {
      r = { err: e instanceof Error ? e.message : String(e) };
    }
    if (gen !== generation) return;
    loading = false;
    const same = fetched === state;
    fetched = state;
    // A failed refresh keeps the list it had.
    if (!("ok" in r) && same && data !== null && "ok" in data) {
      renderList();
      return;
    }
    data = r;
    renderAll();
  }

  const reload = (): void => void track(load());


  const detailOf = (url: string): DetailState => {
    let d = details.get(url);
    if (d === undefined) {
      d = newDetail();
      details.set(url, d);
    }
    return d;
  };

  function loadFull(url: string): void {
    const d = detailOf(url);
    d.loading = true;
    renderPanel();
    void track(
      ports.details
        .fetchPr(url)
        .then(
          (full) => {
            d.full = full;
            d.fullError = null;
          },
          (e: unknown) => {
            // A failed refresh keeps what it had.
            if (d.full === null) d.fullError = e instanceof Error ? e.message : String(e);
          },
        )
        .finally(() => {
          d.loading = false;
          if (split.current() === url) renderPanel();
        }),
    );
  }

  function loadDiff(url: string): void {
    const d = detailOf(url);
    d.diffLoading = true;
    void track(
      ports.details
        .gh(["pr", "diff", url])
        .then(
          (text) => {
            d.diff = ports.details.parseDiff(text);
            d.diffError = null;
          },
          (e: unknown) => {
            d.diffError = e instanceof Error ? e.message : String(e);
          },
        )
        .finally(() => {
          d.diffLoading = false;
          if (split.current() === url) renderPanel();
        }),
    );
  }

  function ready(url: string): void {
    const d = detailOf(url);
    d.busy = true;
    renderPanel();
    void track(
      ports.details
        .gh(["pr", "ready", url])
        .then(
          () => {
            d.error = null;
          },
          (e: unknown) => {
            d.error = e instanceof Error ? e.message : String(e);
          },
        )
        .finally(() => {
          d.busy = false;
          loadFull(url);
          reload();
        }),
    );
  }

  const listPr = (url: string): Pr | undefined => current().items.find((p) => p.url === url);
  const projectOf = (repo: string): number | undefined => projects().find((p) => p.repo.toLowerCase() === repo.toLowerCase())?.id;

  function detailAct(url: string, a: DetailAct): void {
    const d = detailOf(url);
    const l = listPr(url);
    const number = d.full?.number ?? l?.number ?? 0;
    const repo = l?.repo ?? prdetailApi.repoOf(d.full?.url ?? url);
    const proj = projectOf(repo);
    switch (a) {
      case "web":
        host.openUrl(url);
        break;
      case "pane":
        host.openBrowser(url);
        break;
      case "copy_link":
        host.copy(url);
        break;
      case "copy_number":
        host.copy(String(number));
        break;
      case "copy_checkout":
        host.copy(`gh pr checkout ${number}`);
        break;
      case "copy_branch":
        if (d.full) host.copy(d.full.head);
        break;
      case "refresh":
        loadFull(url);
        d.diff = null;
        d.diffError = null;
        break;
      case "ready":
        ready(url);
        break;
      case "checkout":
        if (proj !== undefined) host.checkout(proj, number);
        break;
      case "merge":
      case "merge_ask":
        if (proj !== undefined && l !== undefined) host.merge(proj, l, a === "merge_ask");
        break;
      case "review":
        if (proj !== undefined) host.review(proj, reviewPrompt(number, d.full?.title ?? l?.title ?? ""));
        break;
    }
  }


  const layout = (): { listW: number; panelW: number } => {
    const [l, p] = split.areas(width);
    return { listW: l ?? 0, panelW: p ?? 0 };
  };

  function renderLayout(): void {
    const { listW, panelW } = layout();
    view.list_w = listW;
    view.panel_w = panelW;
    const col = centered(listW).w;
    const { search: sw, wrap } = toolbarWidths(col, active());
    view.search_w = sw;
    view.wrap = wrap;
    view.maxed = split.max;
    view.has_tabs = split.tabs.length > 0;
    view.active_filters = active();
    renderList();
  }

  function renderList(): void {
    view.loading = loading;
    view.active_filters = active();
    const col = centered(layout().listW).w;
    if (data === null) {
      view.list_state = "loading";
      return;
    }
    if ("err" in data) {
      const e = emptyFor(data.err, false);
      Object.assign(view, { list_state: "error", empty_icon: e.icon, empty_title: e.title, empty_desc: e.desc });
      return;
    }
    const gs = groups();
    if (gs.length === 0) {
      const e = emptyFor(null, search.trim() !== "" || active() > 0);
      Object.assign(view, { list_state: "empty", empty_icon: e.icon, empty_title: e.title, empty_desc: e.desc });
      return;
    }
    view.list_state = "list";
    view.rows = listRows(gs, split.current(), host.now(), col);
  }

  function renderMenus(): void {
    const t = menu.tool;
    view.menu = t ?? "";
    if (t === null) {
      view.sub = "";
      return;
    }
    const ctx = menuCtx();
    const v: MenuView = t === "sort" ? sortMenu(ctx) : t === "provider" ? providerMenu(ctx) : filtersMenu(ctx, menu.sub, menu.keys.hl === null ? null : menu.keys.hl);
    view.menu_rows = v.rows;
    view.menu_w = MENU_W[t];
    view.menu_h = v.height;
    view.menu_hl = t === "filters" ? -1 : (menu.keys.hl ?? -1);
    const s = menu.sub;
    if (t !== "filters" || s === null) {
      view.sub = "";
      return;
    }
    const sv = subMenu(s, ctx);
    view.sub = s;
    view.sub_rows = sv.rows;
    view.sub_w = SUB_W[s];
    view.sub_h = sv.height;
    view.sub_row_y = subRowY;
    view.sub_scroll_from = sv.scroll_from;
    view.sub_scroll_h = sv.scroll_h;
    view.sub_hl = menu.subKeys?.hl ?? -1;
  }

  function renderPopup(): void {
    view.popup_kind = popup?.kind ?? "";
    if (popup === null) return;
    view.popup_items = popup.items;
    view.popup_h = 2 + popup.items.length * 40 + popup.items.filter((i) => i.sep).length * 14;
  }

  function renderPanel(): void {
    const url = split.current();
    view.tabs = split.tabs.map((u): TabItem => ({ icon: "\u{e555}", text: tabLabel(u) }));
    view.active_tab = split.active;
    view.agent = host.agentLabel();
    if (url === null) return;
    const d = detailOf(url);
    if (d.full === null && d.fullError === null && !d.loading) {
      loadFull(url);
      return;
    }
    const now = host.now();
    const h = header(d, { url, list: listPr(url), project: projectOf(listPr(url)?.repo ?? prdetailApi.repoOf(url)), now, notProject: host.notProject });
    view.head = h;
    view.tab = d.tab;
    if (d.full === null) return;
    const s = summary(d, d.full, now);
    view.summary = { ...s, body: blocks(s.body), comments: s.comments.map(slintNote) };
    view.events = timeline(d.full, now).map((e: TimelineItem): SlintEvent => (e.kind === "note" ? { kind: "note", icon: "", tone: "", text: "", mono: false, age: "", note: slintNote(e.note) } : { kind: "event", ...e.event, note: { who: "", letter: "", what: "", blocks: [] } }));
    if (d.tab === "code" && d.diff === null && d.diffError === null && !d.diffLoading) loadDiff(url);
    const c = codeState(d);
    view.code_state = c.kind;
    view.code_error = c.kind === "error" ? c.text : "";
    view.lines = codeStateLines(c);
  }

  function renderAll(): void {
    renderLayout();
    renderMenus();
    renderPopup();
    renderPanel();
  }


  function applySplit(a: TabAct): void {
    split.apply(a);
    for (const k of [...details.keys()]) if (!split.tabs.includes(k)) details.delete(k);
    renderAll();
  }

  function open(url: string): void {
    split.select(url);
    renderAll();
  }


  function closeMenus(): void {
    menu.reset();
    popup = null;
    renderMenus();
    renderPopup();
  }

  const rowCount = (rows: readonly MenuRowData[]): number => rows.filter((r) => r.kind === "row").length;
  const rowIndexOf = (rows: readonly MenuRowData[], i: number): number => rows.slice(0, i).filter((r) => r.kind === "row").length;
  const subIndex = (rows: readonly MenuRowData[], k: number): number => {
    let seen = -1;
    for (const [i, r] of rows.entries()) {
      if (r.kind === "row") seen += 1;
      if (seen === k) return i;
    }
    return -1;
  };

  function setFilters(f: PrFilters): void {
    filters = f;
    if (!loading && fetched !== null && fetched !== f.state) reload();
    renderList();
  }

  function pickMain(i: number): void {
    const t = menu.tool;
    if (t === "sort") {
      sort = SORT_ORDER[i] ?? sort;
      closeMenus();
      renderList();
    } else if (t === "provider") {
      githubOnly = i === 1;
      closeMenus();
    } else if (t === "filters") {
      const s = subAt(i);
      if (s === null) return;
      subRowY = menuCtxRowY(i);
      menu.openSub(s);
      renderMenus();
    }
  }

  const menuCtxRowY = (i: number): number => view.menu_rows[i]?.y ?? 0;

  function pickSubRow(i: number): void {
    const s = menu.sub;
    if (s === null) return;
    const done = pickSub(s, i, menuCtx(), {
      filters: setFilters,
      project: (id) => {
        project = id;
        renderList();
      },
    });
    if (done) closeMenus();
    else {
      renderMenus();
      renderList();
    }
  }

  function menuKey(name: string): void {
    const k = KEYS[name];
    const t = menu.tool;
    if (k === undefined || t === null) return;
    const ctx = menuCtx();
    const mainRows = t === "sort" ? SORT_ORDER.length : t === "provider" ? 2 : FILTER_ROWS;
    const subRows = menu.sub === null ? 0 : rowCount(subMenu(menu.sub, ctx).rows);
    const r = menu.key(k, mainRows, subRows);
    if (r.close) {
      closeMenus();
      return;
    }
    if (r.in === "sub") {
      if (r.pick !== undefined && menu.sub !== null) {
        const sub = menu.sub;
        const at = subMenu(sub, ctx).rows;
        pickSubRow(subIndex(at, r.pick));
        return;
      }
      renderMenus();
      return;
    }
    if (r.pick !== undefined) {
      if (t === "filters") {
        const rows = filtersMenu(ctx, null, null).rows;
        const at = subIndex(rows, r.pick);
        const s = subAt(at);
        if (s !== null) {
          subRowY = rows[at]?.y ?? 0;
          menu.enterSub(s);
        }
        renderMenus();
      } else {
        pickMain(r.pick);
      }
      return;
    }
    renderMenus();
  }

  function openRowMenu(url: string): void {
    const p = listPr(url);
    if (p === undefined) return;
    rowUrl = url;
    popup = { kind: "row", items: rowActions(p, projectOf(p.repo) !== undefined, host.agentLabel(), host.notProject) };
    view.popup_w = 196;
    renderPopup();
  }

  function openPanelPopup(kind: string): void {
    const url = split.current();
    if (url === null) return;
    const l = listPr(url);
    const d = detailOf(url);
    const repo = l?.repo ?? prdetailApi.repoOf(d.full?.url ?? url);
    const inProject = projectOf(repo) !== undefined;
    const mk = (id: string, icon: string, label: string, sep = false, enabled = true, tip = ""): RowAction => ({ id, icon, label, enabled, tip, sep });
    if (kind === "more") {
      popup = { kind, items: moreMenu(inProject).map((m) => mk(m.act, m.icon, m.label, m.sep)) };
      view.popup_w = 232;
    } else if (kind === "link") {
      popup = { kind, items: LINK_MENU.map((m) => mk(m.act, m.icon, m.label)) };
      view.popup_w = 150;
    } else {
      const accounts = host.accounts().map((a) => mk(`account:${a.id}`, a.current ? "\u{e06c}" : " ", a.label));
      popup = { kind, items: [...accounts, mk("merge_ask", "\u{e130}", "Merge with instructions…", accounts.length > 0, inProject && l !== undefined, host.notProject)] };
      view.popup_w = 210;
    }
    renderPopup();
  }

  function popupPick(i: number): void {
    const item = popup?.items[i];
    const kind = popup?.kind;
    popup = null;
    renderPopup();
    if (item === undefined || !item.enabled) return;
    if (kind === "row" && rowUrl !== null) {
      const p = listPr(rowUrl);
      if (p === undefined) return;
      const proj = projectOf(p.repo);
      switch (item.id) {
        case "panel":
          open(rowUrl);
          break;
        case "browser":
          host.openBrowser(p.url);
          break;
        case "github":
          host.openUrl(p.url);
          break;
        case "copy":
          host.copy(p.url);
          break;
        case "checkout":
          if (proj !== undefined) host.checkout(proj, p.number);
          break;
        case "review":
          if (proj !== undefined) host.review(proj, reviewPrompt(p.number, p.title));
          break;
        case "merge":
        case "merge_ask":
          if (proj !== undefined) host.merge(proj, p, item.id === "merge_ask");
          break;
      }
      return;
    }
    const url = split.current();
    if (url === null) return;
    if (item.id.startsWith("account:")) host.pickAccount(item.id.slice("account:".length));
    else {
      const a = detailActOf(item.id);
      if (a !== null) detailAct(url, a);
    }
    renderPanel();
  }


  view.page_title = "Pull Requests";
  view.docked = opts.docked ?? true;
  view.hint = SEARCH_HINT;
  view.resized = (w) => {
    width = w;
    renderLayout();
  };
  view.edited = (t) => {
    search = t;
    renderList();
  };
  view.tool = (t) => {
    if (t === "refresh") {
      reload();
      return;
    }
    popup = null;
    if (t === "sort" || t === "filters" || t === "provider") menu.toggle(t);
    renderPopup();
    renderMenus();
  };
  view.row_open = open;
  view.row_menu = openRowMenu;
  view.close_page = () => host.close();
  view.tab_act = (kind, i) => {
    const a = tabAct(kind, i);
    if (a !== null) applySplit(a);
  };
  view.toggle_panel = () => applySplit({ kind: "toggle" });
  view.drag = (x) => {
    split.drag(x, width);
    renderLayout();
    renderPanel();
  };
  view.menu_key = menuKey;
  view.menu_hover = (i) => {
    if (menu.tool !== "filters") return;
    const s = subAt(i);
    if (s === null) return;
    subRowY = menuCtxRowY(i);
    menu.openSub(s);
    renderMenus();
  };
  view.menu_pick = pickMain;
  view.sub_hover = () => {};
  view.sub_pick = pickSubRow;
  view.menu_close = closeMenus;
  view.popup_open = openPanelPopup;
  view.popup_pick = popupPick;
  view.detail_act = (a) => {
    const url = split.current();
    const act = detailActOf(a);
    if (url !== null && act !== null) detailAct(url, act);
  };
  view.pick_tab = (t) => {
    const url = split.current();
    if (url === null) return;
    const d = detailOf(url);
    if (t === "summary" || t === "timeline" || t === "code") d.tab = t;
    renderPanel();
  };
  view.detail_toggle = (k) => {
    const url = split.current();
    if (url === null) return;
    const d = detailOf(url);
    if (k === "checks") d.showChecks = !d.showChecks;
    if (k === "desc") d.descOpen = !d.descOpen;
    if (k === "comments") d.commentsOpen = !d.commentsOpen;
    renderPanel();
  };
  view.link = (u) => host.openUrl(u);
  view.copy = (t) => host.copy(t);
  view.open_check = (u) => host.openUrl(u);

  renderAll();
  reload();

  return {
    load,
    shortcut(id) {
      const url = split.current();
      if (id === "list_close_tab" && split.showing()) applySplit({ kind: "close", i: split.active });
      else if (id === "list_toggle_panel") applySplit({ kind: "toggle" });
      else if (url !== null && id === "pr_copy_link") detailAct(url, "copy_link");
      else if (url !== null && id === "pr_copy_number") detailAct(url, "copy_number");
    },
    esc(typing) {
      if (escLeaves(true, typing, menu.tool !== null || popup !== null)) host.close();
      else if (menu.tool !== null || popup !== null) closeMenus();
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    open,
    resize: view.resized,
    select(id) {
      project = id;
      renderAll();
    },
  };
}
