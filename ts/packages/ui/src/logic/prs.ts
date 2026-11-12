import { type ghapi, prs } from "@harbor/mcp";
import { ICONS } from "../icons.ts";
import { type Key, type MenuKey, MenuKeys } from "./listdetail.ts";

type Pr = ghapi.Pr;
type PrFetched = ghapi.PrFetched;
type PrFilters = ghapi.PrFilters;
type PrSort = ghapi.PrSort;
type Group = ghapi.Group<Pr>;

/** Names a tone: the Slint side maps each to a theme colour. */
export type Tone = "fg" | "subtle" | "gray-700" | "gray-800" | "green" | "red" | "amber" | "blue" | "merged";

export type Tool = "sort" | "filters" | "provider";
export type Sub = "state" | "involvement" | "author" | "labels" | "draft" | "review" | "checks" | "project";

export interface Project {
  id: number;
  name: string;
  repo: string;
}

export interface Chip {
  name: string;
  color: string;
}

export type RowKind = "gap" | "section" | "row";

export interface PrRowData {
  kind: RowKind;
  url: string;
  height: number;
  section_icon: string;
  label: string;
  count: string;
  state_icon: string;
  state_tone: Tone;
  state_tip: string;
  number: string;
  title: string;
  checks_icon: string;
  checks_tone: Tone;
  checks_tip: string;
  review_icon: string;
  review_tone: Tone;
  review_tip: string;
  adds: string;
  dels: string;
  age: string;
  author: string;
  letter: string;
  repo: string;
  chips: Chip[];
  more: string;
  selected: boolean;
}

export const SECTION_H = 34;
export const ROW_H = 62;
export const GAP_FIRST = 6;
export const GAP_AFTER = 14;

const blank: PrRowData = {
  kind: "gap", url: "", height: 0, section_icon: "", label: "", count: "", state_icon: "", state_tone: "subtle", state_tip: "", number: "", title: "",
  checks_icon: "", checks_tone: "subtle", checks_tip: "", review_icon: "", review_tone: "subtle", review_tip: "", adds: "", dels: "", age: "", author: "",
  letter: "", repo: "", chips: [], more: "", selected: false,
};

const SECTION_ICONS: Record<string, string> = { authored: ICONS.PEN_LINE, reviewRequested: ICONS.EYE, others: ICONS.USERS };

export const { ago, thousands } = prs;

export const hexColor = ([r, g, b]: ghapi.Rgb): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export const letterOf = (login: string): string => Array.from(login)[0]?.toUpperCase() ?? "";

/** Geist's advance widths are close to these classes; only where a chip row is cut depends on it. */
export function textWidth(s: string, size: number): number {
  let em = 0;
  for (const c of s) {
    if ("il.,:;'|!".includes(c)) em += 0.27;
    else if ("ftrj1()[]{}/ ".includes(c)) em += 0.36;
    else if ("mwMW@".includes(c)) em += 0.86;
    else if (/[A-Z0-9]/.test(c)) em += 0.64;
    else em += 0.55;
  }
  return em * size;
}

/** The chips that fit before `limit` (from `x`), and the "+N" for the rest (prs.rs `row_meta`). */
export function fitChips(labels: readonly [string, ghapi.Rgb][], x: number, limit: number): { chips: Chip[]; more: string } {
  const chips: Chip[] = [];
  let at = x;
  for (const [i, [name, rgb]] of labels.entries()) {
    const w = textWidth(name, 12) + 22;
    if (at + w > limit) return { chips, more: `+${labels.length - i}` };
    chips.push({ name, color: hexColor(rgb) });
    at += w + 4;
  }
  return { chips, more: "" };
}

function stateOf(p: Pr): [string, Tone, string] {
  if (p.state === "merged") return [ICONS.GIT_MERGE, "merged", "Merged"];
  if (p.state === "closed") return [ICONS.PR_CLOSED, "red", "Closed"];
  if (p.conflicting) return [ICONS.ALERT, "amber", "Has conflicts"];
  if (p.draft) return [ICONS.PR_DRAFT, "gray-800", "Draft"];
  return [ICONS.PR_OPEN, "subtle", "Open"];
}

const CHECKS: Record<ghapi.Checks, [string, Tone, string] | null> = {
  passing: [ICONS.CIRCLE_CHECK, "green", "Checks passing"],
  failing: [ICONS.CIRCLE_X, "red", "Checks failing"],
  pending: [ICONS.CIRCLE_DASHED, "amber", "Checks running"],
  none: null,
};

const REVIEWS: Record<ghapi.Review, [string, Tone, string] | null> = {
  approved: [ICONS.CIRCLE_CHECK, "blue", "Approved"],
  changes: [ICONS.CIRCLE_SLASH, "amber", "Changes requested"],
  required: null,
  none: null,
};

/** The width the second line may use: the row minus its right column (prs.rs `row`). */
export function metaLimit(rowWidth: number): number {
  return rowWidth - 12 - 90 - 44;
}

export function rowData(p: Pr, selected: boolean, now: number, rowWidth: number): PrRowData {
  const [state_icon, state_tone, state_tip] = stateOf(p);
  const [checks_icon, checks_tone, checks_tip] = CHECKS[p.checks] ?? ["", "subtle", ""];
  const [review_icon, review_tone, review_tip] = REVIEWS[p.review] ?? ["", "subtle", ""];
  const repo = p.repo.toLowerCase();
  const start = 19 + textWidth(p.author, 13) + 8 + textWidth(repo, 13) + 10;
  const { chips, more } = fitChips(p.labels, start, metaLimit(rowWidth));
  return {
    ...blank, kind: "row", url: p.url, height: ROW_H, state_icon, state_tone, state_tip, number: `#${p.number}`, title: p.title, checks_icon, checks_tone, checks_tip,
    review_icon, review_tone, review_tip, adds: `+${thousands(p.adds)}`, dels: `-${thousands(p.dels)}`, age: ago(p.updated, now), author: p.author, letter: letterOf(p.author), repo,
    chips, more, selected,
  };
}

/** The list's rows in order: a section header per labelled group, a gap before/after each group (prs.rs `prs_list`). */
export function listRows(groups: readonly Group[], selected: string | null, now: number, rowWidth: number): PrRowData[] {
  const out: PrRowData[] = [];
  for (const g of groups) {
    if (g.label !== "") out.push({ ...blank, kind: "section", height: SECTION_H, section_icon: SECTION_ICONS[g.key] ?? "", label: g.label, count: String(g.items.length) });
    else out.push({ ...blank, kind: "gap", height: GAP_FIRST });
    for (const p of g.items) out.push(rowData(p, p.url === selected, now, rowWidth));
    out.push({ ...blank, kind: "gap", height: GAP_AFTER });
  }
  return out;
}

export type ListState = "loading" | "error" | "empty" | "list";

export interface Empty {
  icon: string;
  title: string;
  desc: string;
}

export function emptyFor(error: string | null, filtered: boolean): Empty {
  if (error !== null) return { icon: ICONS.ALERT, title: "Couldn't load pull requests", desc: error };
  if (filtered) return { icon: ICONS.PR_OPEN, title: "No pull requests match", desc: "Try another search or clear some filters." };
  return { icon: ICONS.PR_OPEN, title: "No pull requests", desc: "PRs you open, are asked to review, or that are in your projects' GitHub repos show up here." };
}


export interface MenuRowData {
  kind: "row" | "sep" | "note";
  icon: string;
  label: string;
  value: string;
  chevron: boolean;
  checked: boolean;
  active: boolean;
  dot: string;
  letter: string;
  mark: string;
  y: number;
  height: number;
}

const ROW = 32;
const SEP = 9;
const NOTE = 26;
const LIST_MAX = 320;

const NO_DOT = "rgba(0,0,0,0)";

const menuRow = (o: Partial<MenuRowData>): MenuRowData => ({ kind: "row", icon: "", label: "", value: "", chevron: false, checked: false, active: false, dot: NO_DOT, letter: "", mark: "", y: 0, height: ROW, ...o });

/** Stacks rows from `y0`, each at the height of its kind. */
function stack(rows: MenuRowData[], y0 = 0): MenuRowData[] {
  let y = y0;
  return rows.map((r) => {
    const at = { ...r, y, height: r.kind === "sep" ? SEP : r.kind === "note" ? NOTE : ROW };
    y += at.height;
    return at;
  });
}

type Opt<T> = [T, string, string];

const STATES: Opt<PrFilters["state"]>[] = [["all", "All", ICONS.LAYERS], ["open", "Open", ICONS.PR_OPEN], ["closed", "Closed", ICONS.PR_CLOSED], ["merged", "Merged", ICONS.GIT_MERGE]];
const INVOLVEMENTS: Opt<PrFilters["involvement"]>[] = [["all", "All", ICONS.LAYERS], ["reviewing", "Reviewing", ICONS.EYE], ["authored", "Authored", ICONS.PEN_LINE]];
const DRAFTS: Opt<boolean | undefined>[] = [[undefined, "All", ICONS.LAYERS], [true, "Drafts only", ICONS.PR_DRAFT], [false, "Hide drafts", ICONS.EYE_OFF]];
const REVIEW_OPTS: Opt<ghapi.Review | undefined>[] = [
  [undefined, "All", ICONS.LAYERS], ["approved", "Approved", ICONS.CIRCLE_CHECK], ["changes", "Changes requested", ICONS.CIRCLE_X], ["required", "Review required", ICONS.CIRCLE_DASHED], ["none", "No reviews", ICONS.CIRCLE_SLASH],
];
const CHECK_OPTS: Opt<ghapi.Checks | undefined>[] = [[undefined, "All", ICONS.LAYERS], ["passing", "Passing", ICONS.CIRCLE_CHECK], ["failing", "Failing", ICONS.CIRCLE_X]];

const nameOf = <T>(opts: readonly Opt<T>[], v: T): string => opts.find((o) => o[0] === v)?.[1] ?? "All";

export const SORT_ICONS: Record<PrSort, string> = {
  ready: ICONS.LIST_CHECKS, blocked: ICONS.USER_LOCK, updated: ICONS.CLOCK, newest: ICONS.CALENDAR_DOWN, oldest: ICONS.CALENDAR_UP, largest: ICONS.MAXIMIZE, smallest: ICONS.MINIMIZE,
};

export const SORT_ORDER: readonly PrSort[] = ["ready", "blocked", "updated", "newest", "oldest", "largest", "smallest"];

/** Width of each menu (prs.rs `pr_menus`, `pr_submenu`). */
export const MENU_W: Record<Tool, number> = { sort: 210, filters: 250, provider: 180 };
export const SUB_W: Record<Sub, number> = { state: 190, involvement: 190, draft: 190, checks: 190, review: 210, author: 220, labels: 230, project: 230 };

/** A menu's rows and, for lists that scroll, where that part starts and how tall it may grow. */
export interface MenuView {
  rows: MenuRowData[];
  scroll_from: number;
  scroll_h: number;
  height: number;
}

function view(rows: MenuRowData[], scrollFrom = -1): MenuView {
  const all = stack(rows);
  const last = all.at(-1);
  const end = last ? last.y + last.height : 0;
  if (scrollFrom < 0 || scrollFrom >= all.length) return { rows: all, scroll_from: -1, scroll_h: 0, height: end };
  const top = all[scrollFrom]?.y ?? 0;
  const body = Math.min(end - top, LIST_MAX);
  return { rows: all, scroll_from: scrollFrom, scroll_h: body, height: top + body };
}

export interface MenuCtx {
  filters: PrFilters;
  sort: PrSort;
  githubOnly: boolean;
  project: Project | undefined;
  projects: readonly Project[];
  authors: readonly [string, number][];
  labels: readonly [string, ghapi.Rgb, number][];
  sortLabel: (s: PrSort) => string;
}

export function sortMenu(c: MenuCtx): MenuView {
  return view(SORT_ORDER.map((s) => menuRow({ icon: SORT_ICONS[s], label: c.sortLabel(s), active: s === c.sort })));
}

export function providerMenu(c: MenuCtx): MenuView {
  return view([menuRow({ icon: ICONS.LAYERS, label: "All", checked: !c.githubOnly }), menuRow({ mark: "github", label: "GitHub", checked: c.githubOnly })]);
}

const SUB_ORDER: { sub: Sub | null; icon: string; label: string }[] = [
  { sub: "state", icon: ICONS.PR_OPEN, label: "State" },
  { sub: "involvement", icon: ICONS.LAYERS, label: "Involvement" },
  { sub: null, icon: "", label: "" },
  { sub: "author", icon: ICONS.USER_ROUND, label: "Author" },
  { sub: "labels", icon: ICONS.TAG, label: "Labels" },
  { sub: "draft", icon: ICONS.LAYERS, label: "Draft" },
  { sub: "review", icon: ICONS.LAYERS, label: "Review" },
  { sub: "checks", icon: ICONS.LAYERS, label: "Checks" },
  { sub: null, icon: "", label: "" },
  { sub: "project", icon: ICONS.LAYERS, label: "Project" },
];

/** The sub a Filters row opens (null for a separator), by row index. */
export const subAt = (i: number): Sub | null => SUB_ORDER[i]?.sub ?? null;

/** The main Filters rows the keyboard walks (separators don't count). */
export const FILTER_ROWS = SUB_ORDER.filter((r) => r.sub !== null).length;

export function filtersMenu(c: MenuCtx, open: Sub | null, hl: number | null): MenuView {
  const f = c.filters;
  const value: Record<Sub, string> = {
    state: nameOf(STATES, f.state), involvement: nameOf(INVOLVEMENTS, f.involvement), author: f.author ?? "Anyone", labels: f.labels.length === 0 ? "Any" : `${f.labels.length} selected`,
    draft: nameOf(DRAFTS, f.draft), review: nameOf(REVIEW_OPTS, f.review), checks: nameOf(CHECK_OPTS, f.checks), project: c.project?.name ?? "All projects",
  };
  let n = -1;
  return view(
    SUB_ORDER.map((r) => {
      if (r.sub === null) return menuRow({ kind: "sep" });
      n += 1;
      return menuRow({ icon: r.icon, label: r.label, value: value[r.sub], chevron: true, active: open === r.sub || hl === n });
    }),
  );
}

function radio<T>(opts: readonly Opt<T>[], cur: T): MenuRowData[] {
  return opts.map(([v, label, icon]) => menuRow({ icon, label, checked: v === cur }));
}

export function subMenu(sub: Sub, c: MenuCtx): MenuView {
  const f = c.filters;
  switch (sub) {
    case "state":
      return view(radio(STATES, f.state));
    case "involvement":
      return view(radio(INVOLVEMENTS, f.involvement));
    case "draft":
      return view(radio(DRAFTS, f.draft));
    case "review":
      return view(radio(REVIEW_OPTS, f.review));
    case "checks":
      return view(radio(CHECK_OPTS, f.checks));
    case "author": {
      const head = [menuRow({ icon: ICONS.USERS, label: "Anyone", checked: f.author === undefined })];
      if (c.authors.length > 0) head.push(menuRow({ kind: "sep" }));
      const body = c.authors.map(([login, n]) => menuRow({ label: login, value: String(n), letter: letterOf(login), checked: f.author?.toLowerCase() === login.toLowerCase() }));
      return view([...head, ...body], c.authors.length > 0 ? head.length : -1);
    }
    case "labels": {
      const head = [menuRow({ icon: ICONS.TAG, label: "Any", checked: f.labels.length === 0 }), menuRow({ kind: "sep" })];
      if (c.labels.length === 0) return view([...head, menuRow({ kind: "note", label: "No labels in these pull requests." })]);
      const body = c.labels.map(([name, rgb, n]) => menuRow({ label: name, value: String(n), dot: hexColor(rgb), checked: f.labels.some((l) => l.toLowerCase() === name.toLowerCase()) }));
      return view([...head, ...body], head.length);
    }
    case "project": {
      const head = [menuRow({ icon: ICONS.LAYERS, label: "All projects", checked: c.project === undefined })];
      const body = c.projects.map((p) => menuRow({ icon: ICONS.FOLDER_GIT, label: p.name, checked: c.project?.id === p.id }));
      if (c.projects.length === 0) return view([...head, menuRow({ kind: "note", label: "No projects with a GitHub remote." })]);
      return view([...head, ...body], head.length);
    }
  }
}

/** What picking row `i` of `sub` does to the filters; true when the menus close after it. */
export function pickSub(sub: Sub, i: number, c: MenuCtx, set: { filters(f: PrFilters): void; project(id: number | undefined): void }): boolean {
  const f: PrFilters = { ...c.filters, labels: [...c.filters.labels] };
  switch (sub) {
    case "state":
      f.state = STATES[i]?.[0] ?? f.state;
      break;
    case "involvement":
      f.involvement = INVOLVEMENTS[i]?.[0] ?? f.involvement;
      break;
    case "draft": {
      const v = DRAFTS[i]?.[0];
      if (v === undefined) delete f.draft;
      else f.draft = v;
      break;
    }
    case "review": {
      const v = REVIEW_OPTS[i]?.[0];
      if (v === undefined) delete f.review;
      else f.review = v;
      break;
    }
    case "checks": {
      const v = CHECK_OPTS[i]?.[0];
      if (v === undefined) delete f.checks;
      else f.checks = v;
      break;
    }
    case "author": {
      const login = i === 0 ? undefined : c.authors[i - 2]?.[0];
      if (login === undefined) delete f.author;
      else f.author = login;
      break;
    }
    case "labels": {
      if (i === 0) {
        f.labels = [];
        break;
      }
      const name = c.labels[i - 2]?.[0];
      if (name === undefined) return false;
      const at = f.labels.findIndex((l) => l.toLowerCase() === name.toLowerCase());
      if (at >= 0) f.labels.splice(at, 1);
      else f.labels.push(name);
      set.filters(f);
      return false;
    }
    case "project":
      set.project(i === 0 ? undefined : c.projects[i - 1]?.id);
      return true;
  }
  set.filters(f);
  return true;
}

/** Where a submenu of the row at (`right`, `top`) opens: right of it, or left when the page has no room (prs.rs `sub_pos`). */
export function subPos(left: number, right: number, top: number, width: number, pageRight: number): [number, number] {
  const outer = width + 14;
  const x = right + 10 + outer > pageRight ? left - 10 - outer : right + 10;
  return [x, top - 6];
}


export interface MenuEffect {
  /** A row of the open menu was picked (the main one, or the sub's when `sub` is set). */
  pick?: number;
  close?: boolean;
  leave?: boolean;
  enterSub?: boolean;
}

/** The open menu (and its submenu) with their keyboard highlights (listdetail.rs `menu_keys`). */
export class OpenMenu {
  tool: Tool | null = null;
  sub: Sub | null = null;
  keys = new MenuKeys();
  subKeys: MenuKeys | null = null;

  toggle(t: Tool): void {
    const same = this.tool === t;
    this.reset();
    this.tool = same ? null : t;
  }

  reset(): void {
    this.tool = null;
    this.sub = null;
    this.keys = new MenuKeys();
    this.subKeys = null;
  }

  openSub(s: Sub): void {
    if (this.sub !== s) this.subKeys = null;
    this.sub = s;
  }

  /** `rows`/`subRows`: how many rows the main menu and the open submenu have. */
  key(k: Key, rows: number, subRows: number): MenuEffect & { in: "main" | "sub" } {
    const hasSubs = this.tool === "filters";
    if (this.sub !== null && this.subKeys !== null) {
      const r = this.subKeys.input(k, subRows);
      if (r?.kind === "leave") {
        this.sub = null;
        this.subKeys = null;
        return { in: "sub", leave: true };
      }
      if (r?.kind === "close") return { in: "sub", close: true };
      return r?.kind === "pick" ? { in: "sub", pick: r.i } : { in: "sub" };
    }
    const r: MenuKey | null = this.keys.input(k, rows);
    if (r?.kind === "close") return { in: "main", close: true };
    if (r?.kind === "pick" || (r?.kind === "enter" && hasSubs)) return { in: "main", pick: r.i, ...(hasSubs ? { enterSub: true } : {}) };
    return { in: "main" };
  }

  /** After a main pick on a Filters row that opened `s`: the keyboard moves into it. */
  enterSub(s: Sub): void {
    this.sub = s;
    this.subKeys = new MenuKeys();
    this.subKeys.hl = 0;
  }
}


export interface RowAction {
  id: string;
  icon: string;
  label: string;
  enabled: boolean;
  tip: string;
  sep: boolean;
}

/** The right-click menu of a row (prs.rs `prs_list`). */
export function rowActions(p: Pr, inProject: boolean, agent: string, notProject: string): RowAction[] {
  const a = (id: RowAction["id"], icon: string, label: string, o: Partial<RowAction> = {}): RowAction => ({ id, icon, label, enabled: true, tip: "", sep: false, ...o });
  const out = [
    a("panel", ICONS.PANEL_RIGHT, "Open in side panel"),
    a("github", ICONS.EXTERNAL, "Open on GitHub"),
    a("copy", ICONS.COPY, "Copy link"),
  ];
  if (inProject) out.push(a("checkout", ICONS.BRANCH, "Check out", { sep: true }), a("review", ICONS.SPARKLES, "Review with an agent"));
  if (p.state === "open") {
    out.push(
      a("merge", ICONS.SPARKLES, `Merge with ${agent}`, { sep: !inProject, enabled: inProject, tip: inProject ? "" : notProject }),
      a("merge_ask", ICONS.PEN_LINE, "Merge with instructions…", { enabled: inProject, tip: inProject ? "" : notProject }),
    );
  }
  return out;
}

export const reviewPrompt = (number: number, title: string): string =>
  `Review PR #${number} (${title}). Read it with \`gh pr view ${number}\` and \`gh pr diff ${number}\`, then list concrete problems by severity.`;

/** The panel's tab label for a PR URL (`#128`). */
export const tabLabel = (url: string): string => `#${url.split("/").at(-1) ?? ""}`;

export const SEARCH_HINT = "Search pull requests, or label:bug";

/** The toolbar's search width and whether its buttons wrap under it (prs.rs `toolbar`). */
export function toolbarWidths(avail: number, active: number): { search: number; wrap: boolean } {
  const sort = 12 + 16 + 8 + 34 + 14;
  const filters = 12 + 16 + 8 + 46 + (active > 0 ? 30 : 0) + 14;
  const rest = sort + filters + 36 * 2 + 8 * 4 + 2;
  const room = avail - rest;
  return room < 240 ? { search: avail - 2, wrap: true } : { search: room, wrap: false };
}

/** `centered(ui, 1180, ..)`: the content column's left edge and width. */
export function centered(avail: number, max = 1180): { x: number; w: number } {
  const gutter = avail < 520 ? 12 : 24;
  const side = Math.max((avail - max) / 2, gutter);
  return { x: side, w: Math.max(0, avail - side * 2) };
}
