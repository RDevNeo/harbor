import { mdBlocks } from "./cards.ts";
import { detailAct, detailActOf, type DetailView, detailView } from "./logic/issuesdetail.ts";
import { issueGaps, type IssuesHost, IssuesPage, type ListItem, type MenuEntry, type MenuView, NO_PIXELS, type Pixels } from "./logic/issues.ts";
import type { Keys } from "./logic/keys.ts";
import type { Key, TabAct } from "./logic/listdetail.ts";
import type { MdBlockData } from "./window.ts";

interface SubData {
  open: boolean;
  width: number;
  head: MenuEntry[];
  list: MenuEntry[];
  foot: MenuEntry[];
  top: number;
}

interface MenuData {
  name: string;
  width: number;
  rows: MenuEntry[];
  sub: SubData;
}

interface DetailData extends Omit<DetailView, "body" | "comments" | "agents"> {
  body: MdBlockData[];
  comments: { author: string; letter: string; what: string; blocks: MdBlockData[]; avatar: Pixels; has_avatar: boolean }[];
}

type SlintTabAct = "activate" | "close" | "close-others" | "close-right" | "close-all" | "toggle" | "maximize";

/** The page's properties and callbacks (issues.slint `IssuesWindow` / `IssuesPage`). */
export interface IssuesView {
  items: ListItem[];
  notes: string;
  body_kind: string;
  body_title: string;
  body_desc: string;
  body_icon: string;
  active: number;
  loading: boolean;
  github: Pixels;
  fix_label: string;
  menu: MenuData;
  tabs: { icon: string; text: string }[];
  tab: number;
  showing: boolean;
  maxed: boolean;
  frac: number;
  detail: DetailData;
  agents: { id: string; label: string; current: boolean }[];
  search: string;
  search_edited: (t: string) => void;
  tool: (k: string) => void;
  open: (url: string) => void;
  row_act: (url: string, act: string) => void;
  close_page: () => void;
  tab_act: (k: SlintTabAct, i: number) => void;
  divider: (x: number, w: number) => void;
  detail_act: (a: string) => void;
  menu_pick: (sub: boolean, i: number) => void;
  menu_hover: (i: number) => void;
  menu_close: () => void;
  menu_key: (k: string) => boolean;
  shortcut: (text: string, ctrl: boolean, shift: boolean, alt: boolean) => boolean;
  esc_page: (typing: boolean) => void;
  link: (u: string) => void;
  copy_text: (t: string) => void;
  focus_search: () => void;
}

const emptyDetail = (): DetailData => ({
  repo_line: "",
  title: "",
  state: "open",
  state_text: "",
  author: { login: "", letter: "", avatar: NO_PIXELS, has_avatar: false },
  opened: "",
  updated: "",
  error: "",
  loading: false,
  has_full: false,
  assignees: [],
  labels: [],
  milestone: "",
  has_milestone: false,
  body: [],
  desc_open: true,
  comments_open: true,
  comments_title: "",
  comments: [],
  busy: false,
  is_open: true,
  act_tip: "",
  fix_label: "",
  fix_enabled: false,
  fix_tip: "",
});

const emptyMenu = (): MenuData => ({ name: "", width: 0, rows: [], sub: { open: false, width: 0, head: [], list: [], foot: [], top: 0 } });

const menuData = (m: MenuView): MenuData => ({
  name: m.name,
  width: m.width,
  rows: m.rows,
  sub: m.sub === null ? emptyMenu().sub : { open: true, ...m.sub },
});

const SLINT_KEYS: Record<string, Key> = { up: "up", down: "down", home: "home", end: "end", enter: "enter", space: "space", right: "right", left: "left", esc: "esc" };

/** A Ctrl+letter's text: Slint may hand over the control character instead of the letter. */
export function keyName(text: string): string {
  const code = text.length === 1 ? text.charCodeAt(0) : 0;
  return code >= 1 && code <= 26 ? String.fromCharCode(code + 96) : text.toLowerCase();
}

export function tabAct(k: SlintTabAct, i: number): TabAct {
  switch (k) {
    case "activate":
    case "close":
      return { kind: k, i };
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
  }
}

/**
 * Drives the Issues page in `view`: `host` is what the page reaches for (fetching, projects, agents), `close` leaves the page,
 * `keys` are the user's bindings (the list shortcuts). Returns the page for the shell.
 */
export function attachIssues(view: IssuesView, host: IssuesHost, hooks: { close(): void; keys: Keys; github: Pixels; schedule?: (f: () => void) => void }): IssuesPage {
  const md = new Map<string, MdBlockData[]>();
  const blocks = (text: string): MdBlockData[] => {
    let b = md.get(text);
    if (b === undefined) {
      b = issueGaps(mdBlocks(text));
      md.set(text, b);
    }
    return b;
  };
  let queued = false;
  const page: IssuesPage = new IssuesPage(host, () => {
    if (queued) return;
    queued = true;
    (hooks.schedule ?? queueMicrotask)(() => {
      queued = false;
      try {
        render();
      } catch (e) {
        console.error("issues render failed:", e);
      }
    });
  });

  const current = (): string | null => page.split.current();

  function render(): void {
    page.refetchIfStateChanged();
    page.prune();
    const items = page.items();
    const body = page.body(items);
    view.items = items;
    view.notes = page.notes();
    view.body_kind = body.kind;
    view.body_title = body.title;
    view.body_desc = body.desc;
    view.body_icon = body.icon;
    view.active = page.activeFilters();
    view.loading = page.loading;
    view.fix_label = `Fix with ${host.agentLabel()}`;
    view.menu = menuData(page.menuView());
    view.tabs = page.tabs();
    view.tab = page.split.active;
    view.showing = page.split.showing();
    view.maxed = page.split.max;
    view.frac = page.split.frac;
    const url = current();
    if (url === null) {
      view.detail = emptyDetail();
    } else {
      const d = detailView(page, url);
      view.agents = d.agents;
      view.detail = { ...d, body: blocks(d.body), comments: d.comments.map((c) => ({ ...c, blocks: blocks(c.body) })) };
    }
  }

  view.github = hooks.github;
  view.search_edited = (t) => {
    page.search = t;
    page.changed();
  };
  view.tool = (k) => {
    if (k === "refresh") page.load();
    else if (k === "sort" || k === "filters" || k === "provider") page.toggleMenu(k);
  };
  view.open = (url) => page.open(url);
  view.row_act = (url, a) => {
    const issue = page.listed(url);
    switch (a) {
      case "open":
        return page.open(url);
      case "browse":
        return host.browse(url);
      case "github":
        return host.openUrl(url);
      case "copy":
        return host.copy(url);
      case "fix":
      case "fix-ask": {
        if (issue === undefined) return;
        const project = host.projects().find((p) => p.repo.toLowerCase() === issue.repo.toLowerCase());
        host.fix(project?.id ?? 0, issue, a === "fix-ask");
      }
    }
  };
  view.close_page = hooks.close;
  view.tab_act = (k, i) => {
    page.split.apply(tabAct(k, i));
    page.changed();
  };
  view.divider = (x, w) => {
    page.split.drag(x, w);
    page.changed();
  };
  view.detail_act = (a) => {
    const url = current();
    const act = detailActOf(a);
    if (url !== null && act !== null) detailAct(page, url, act);
  };
  view.menu_pick = (sub, i) => (sub ? page.pickSub(i) : page.pickMain(i));
  view.menu_hover = (i) => page.hoverMain(i);
  view.menu_close = () => page.closeMenus();
  view.menu_key = (k) => {
    const key = SLINT_KEYS[k];
    return key !== undefined && page.menuKey(key);
  };
  view.shortcut = (text, ctrl, shift, alt) => {
    const p = { key: keyName(text), ctrl, shift, alt };
    if (hooks.keys.matches("list_close_tab", p) && page.split.showing()) {
      page.split.apply({ kind: "close", i: page.split.active });
    } else if (hooks.keys.matches("list_toggle_panel", p)) {
      page.split.apply({ kind: "toggle" });
    } else if (hooks.keys.matches("list_search", p)) {
      view.focus_search();
    } else return false;
    page.changed();
    return true;
  };
  view.esc_page = (typing) => {
    if (!typing) hooks.close();
  };
  view.link = (u) => host.openUrl(u);
  view.copy_text = (t) => host.copy(t);

  page.load();
  render();
  return page;
}
