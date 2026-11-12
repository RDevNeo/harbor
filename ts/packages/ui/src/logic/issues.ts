import { ghapi, issues as list } from "@harbor/mcp";
import { ICONS } from "../icons.ts";
import { type Key, Memo, MenuKeys, Split } from "./listdetail.ts";

export type Issue = ghapi.Issue;
export type IssueFetched = ghapi.IssueFetched;
export type IssueFilters = ghapi.IssueFilters;
export type IssueSort = ghapi.IssueSort;
export type StateF = IssueFilters["state"];

/** Why the agent actions are off for a repo that isn't a Harbor project. */
export const NOT_PROJECT = "Add this repo as a Harbor project to let an agent work on it";

export const SORTS: readonly IssueSort[] = ghapi.ISSUE_SORTS;

const SORT_ICONS: Record<IssueSort, string> = {
  updated: ICONS.CLOCK,
  stale: ICONS.CLOCK,
  newest: ICONS.CALENDAR_DOWN,
  oldest: ICONS.CALENDAR_UP,
  most_commented: ICONS.MESSAGE,
  least_commented: ICONS.MESSAGE,
};

export type Involvement = IssueFilters["involvement"];

export const STATES: readonly [StateF, string, string][] = [
  ["all", "All", ICONS.LAYERS],
  ["open", "Open", ICONS.CIRCLE_DOT],
  ["closed", "Closed", ICONS.CIRCLE_CHECK],
];

export const INVOLVEMENTS: readonly [Involvement, string, string][] = [
  ["all", "All", ICONS.LAYERS],
  ["assigned", "Assigned", ICONS.USER_CHECK],
  ["authored", "Authored", ICONS.PEN_LINE],
  ["mentioned", "Mentioned", ICONS.AT_SIGN],
];

const GROUP_ICONS: Record<string, string> = { assigned: ICONS.USER_CHECK, authored: ICONS.PEN_LINE, mentioned: ICONS.AT_SIGN, others: ICONS.USERS };

export type MenuName = "sort" | "filters" | "provider";
export type SubName = "account" | "state" | "involvement" | "author" | "assignee" | "labels" | "milestone" | "project";

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** unix seconds → "2h ago" (prs.rs `ago`). */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 31_536_000) return `${Math.floor(d / 86400)}d ago`;
  return `${Math.floor(d / 31_536_000)}y ago`;
}

export const letterOf = (login: string): string => Array.from(login)[0]?.toUpperCase() ?? "";

export const hex = (c: ghapi.Rgb): string => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

export interface Chip {
  name: string;
  color: string;
}

export interface ListItem {
  kind: "section" | "gap" | "issue";
  icon: string;
  label: string;
  count: string;
  url: string;
  number: string;
  title: string;
  state: ghapi.IssueState;
  state_tip: string;
  comments: string;
  age: string;
  author: string;
  letter: string;
  repo: string;
  labels: Chip[];
  accounts: string;
  selected: boolean;
  fix_enabled: boolean;
  avatar: Pixels;
  has_avatar: boolean;
  h: number;
}

export const NO_PIXELS: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };

export const STATE_TIPS: Record<ghapi.IssueState, string> = { open: "Open", done: "Closed as completed", not_planned: "Closed as not planned" };

export interface MenuEntry {
  kind: "row" | "sep" | "note";
  icon: string;
  label: string;
  value: string;
  chevron: boolean;
  checked: boolean;
  current: boolean;
  kb: boolean;
  dot: string;
  has_dot: boolean;
  avatar: Pixels;
  has_avatar: boolean;
  /** The row draws an avatar (or its letter) in the icon's place. */
  person: string;
  letter: string;
  logo: boolean;
  tip: string;
  /** The row's number for picks (-1 for separators and notes). */
  pick: number;
}

const entry = (e: Partial<MenuEntry>): MenuEntry => ({ kind: "row", icon: "", label: "", value: "", chevron: false, checked: false, current: false, kb: false, dot: "#000000", has_dot: false, avatar: NO_PIXELS, has_avatar: false, person: "", letter: "", logo: false, tip: "", pick: -1, ...e });

export interface SubView {
  width: number;
  /** Rows above the scrolling part. */
  head: MenuEntry[];
  list: MenuEntry[];
  foot: MenuEntry[];
  /** The opening row's top, from the main menu's top. */
  top: number;
}

export interface MenuView {
  name: MenuName | "";
  width: number;
  rows: MenuEntry[];
  sub: SubView | null;
}

export type Loaded = { ok: IssueFetched } | { err: string };

/** What the page reaches for outside itself (the lead wires these to the app). */
export interface IssuesHost {
  fetch(state: StateF): Promise<IssueFetched>;
  /** Harbor projects with a GitHub remote. */
  projects(): { id: number; name: string; repo: string }[];
  /** The PC of the mesh an action on `issue` goes to, when it isn't this one. */
  peer(issue: Issue, project: boolean): { name: string; dest: ghapi.Dest } | undefined;
  details: Pick<ghapi.DetailsPort, "fetchIssue" | "fetchIssueOn" | "setIssueOpenOn" | "gh">;
  agentLabel(): string;
  agents(): { id: string; label: string; current: boolean }[];
  pickAgent(id: string): void;
  /** `project` 0: the thread starts on `peer`'s PC. */
  fix(project: number, issue: Issue, ask: boolean): void;
  openUrl(url: string): void;
  copy(text: string): void;
  avatar(login: string, url: string): Promise<Pixels | null>;
  now(): number;
}

export interface Detail {
  full: { ok: ghapi.IssueFull } | { err: string } | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  via: ghapi.Dest | null;
  descOpen: boolean;
  commentsOpen: boolean;
}

export const newDetail = (): Detail => ({ full: null, loading: false, busy: false, error: null, via: null, descOpen: true, commentsOpen: true });

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The Filters button's value text for each row (issues.rs `issue_menus`). */
export function filterValues(f: IssueFilters, projectName: string | null): Record<SubName, string> {
  const nameOf = <T,>(opts: readonly [T, string, string][], v: T): string => opts.find((o) => o[0] === v)?.[1] ?? "All";
  return {
    account: f.account ?? "All",
    state: nameOf(STATES, f.state),
    involvement: nameOf(INVOLVEMENTS, f.involvement),
    author: f.author ?? "Anyone",
    assignee: f.assignee === undefined ? "Anyone" : f.assignee.kind === "nobody" ? "Nobody" : f.assignee.login,
    labels: f.labels.length === 0 ? "Any" : `${f.labels.length} selected`,
    milestone: f.milestone === undefined ? "Any" : f.milestone === null ? "None" : f.milestone,
    project: projectName ?? "All projects",
  };
}

const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class IssuesPage {
  data: Loaded | null = null;
  loading = false;
  private generation = 0;
  private fetched: StateF | null = null;
  search = "";
  sort: IssueSort = "updated";
  filters: IssueFilters = list.defaultFilters();
  project: number | null = null;
  elsewhere: string | null = null;
  githubOnly = false;
  menu: MenuName | null = null;
  sub: SubName | null = null;
  keys = new MenuKeys();
  subKeys: MenuKeys | null = null;
  split = new Split();
  details = new Map<string, Detail>();
  avatars = new Map<string, Pixels | null>();
  private memo = new Memo<ghapi.Group<Issue>[]>();

  constructor(
    readonly host: IssuesHost,
    readonly changed: () => void,
  ) {}

  fetchedList(): IssueFetched {
    return this.data !== null && "ok" in this.data ? this.data.ok : { viewer: "", items: [], sources: [] };
  }


  load(): void {
    const generation = ++this.generation;
    const state = this.filters.state;
    this.loading = true;
    this.host.fetch(state).then(
      (f) => this.loaded(generation, state, { ok: f }),
      (e: unknown) => this.loaded(generation, state, { err: errorText(e) }),
    );
    this.changed();
  }

  loaded(generation: number, state: StateF, r: Loaded): void {
    if (generation !== this.generation) return;
    this.loading = false;
    const same = this.fetched === state;
    this.fetched = state;
    if ("err" in r && same && this.data !== null && "ok" in this.data) return this.changed();
    if ("ok" in r) this.fetchAvatars(r.ok.items.map((i) => [i.author, i.avatar]));
    this.data = r;
    const a = this.filters.account;
    if (a !== undefined && "ok" in r && !r.ok.sources.some((s) => eqi(s.login, a))) delete this.filters.account;
    this.changed();
  }

  /** Picking another State refetches: GitHub applies that filter. */
  refetchIfStateChanged(): void {
    if (!this.loading && this.fetched !== null && this.fetched !== this.filters.state) this.load();
  }

  fetchAvatars(people: [string, string][]): void {
    const want = [...new Map(people.filter(([login, url]) => url !== "" && !this.avatars.has(login))).entries()].slice(0, 40);
    for (const [login] of want) this.avatars.set(login, null);
    for (const [login, url] of want) {
      void this.host.avatar(login, url).then((p) => {
        this.avatars.set(login, p);
        this.changed();
      });
    }
  }


  private projectRepo(): string | undefined {
    const p = this.project === null ? undefined : this.host.projects().find((x) => x.id === this.project);
    return p?.repo ?? this.elsewhere ?? undefined;
  }

  groups(): ghapi.Group<Issue>[] {
    const fetched = this.fetchedList();
    const repo = this.projectRepo();
    if (repo === undefined) delete this.filters.project;
    else this.filters.project = repo;
    return this.memo.get([fetched, JSON.stringify(this.filters), this.search, this.sort], () => list.groups(fetched, this.filters, this.search, this.sort));
  }

  activeFilters(): number {
    return list.activeFilters(this.filters);
  }

  items(): ListItem[] {
    const out: ListItem[] = [];
    const fetched = this.fetchedList();
    const several = list.accounts(fetched).length > 1;
    const now = this.host.now();
    const projects = this.host.projects();
    const current = this.split.current();
    for (const g of this.groups()) {
      if (g.label !== "") out.push(blank({ kind: "section", icon: GROUP_ICONS[g.key] ?? "", label: g.label, count: String(g.items.length), h: 34 }));
      else out.push(blank({ kind: "gap", h: 6 }));
      for (const i of g.items) {
        const px = this.avatars.get(i.author) ?? null;
        const proj = projects.some((p) => eqi(p.repo, i.repo)) || this.host.peer(i, true) !== undefined;
        out.push(
          blank({
            kind: "issue",
            url: i.url,
            number: `#${i.number}`,
            title: i.title,
            state: i.state,
            state_tip: STATE_TIPS[i.state],
            comments: i.comments > 0 ? String(i.comments) : "",
            age: ago(i.updated, now),
            author: i.author,
            letter: letterOf(i.author),
            repo: i.repo.toLowerCase(),
            labels: i.labels.map(([name, c]) => ({ name, color: hex(c) })),
            accounts: several ? accountsChip(i.accounts) : "",
            selected: current === i.url,
            fix_enabled: proj && i.state === "open",
            avatar: px ?? NO_PIXELS,
            has_avatar: px !== null,
            h: 62,
          }),
        );
      }
      out.push(blank({ kind: "gap", h: 14 }));
    }
    return out;
  }

  /** The note above the list about PCs whose part is missing. */
  notes(): string {
    if (this.data === null || !("ok" in this.data)) return "";
    const n = list.notes(this.data.ok);
    return n.length === 0 ? "" : `${ICONS.ALERT}  ${n.join("  ·  ")}`;
  }

  /** What shows instead of rows: loading, an error, or an empty list. */
  body(items: ListItem[]): { kind: "loading" | "error" | "empty" | "rows"; title: string; desc: string; icon: string } {
    const d = this.data;
    if (d === null) return { kind: "loading", title: "", desc: "", icon: "" };
    if ("err" in d) return { kind: "error", title: "Couldn't load issues", desc: d.err, icon: ICONS.ALERT };
    if (items.length === 0) {
      if (this.search.trim() !== "" || this.activeFilters() > 0) return { kind: "empty", title: "No issues match", desc: "Try another search or clear some filters.", icon: ICONS.CIRCLE_DOT };
      return { kind: "empty", title: "No issues", desc: "Issues assigned to you, that you open or that mention you, and those in your projects' GitHub repos show up here.", icon: ICONS.CIRCLE_DOT };
    }
    return { kind: "rows", title: "", desc: "", icon: "" };
  }

  listed(url: string): Issue | undefined {
    return this.fetchedList().items.find((i) => i.url === url);
  }


  toggleMenu(m: MenuName): void {
    this.sub = null;
    this.keys = new MenuKeys();
    this.subKeys = null;
    this.menu = this.menu === m ? null : m;
    this.changed();
  }

  closeMenus(): void {
    this.menu = null;
    this.sub = null;
    this.keys = new MenuKeys();
    this.subKeys = null;
    this.changed();
  }

  private projectName(): string | null {
    const p = this.project === null ? undefined : this.host.projects().find((x) => x.id === this.project);
    return p?.name ?? this.elsewhere;
  }

  private showsAccount(): boolean {
    return list.accounts(this.fetchedList()).length > 1 || this.filters.account !== undefined;
  }

  /** The Filters menu's rows with the submenu each opens (None for separators). */
  private filterRows(): { e: MenuEntry; sub?: SubName }[] {
    const v = filterValues(this.filters, this.projectName());
    const row = (sub: SubName, icon: string, label: string): { e: MenuEntry; sub: SubName } => ({ e: entry({ icon, label, value: v[sub], chevron: true }), sub });
    const sep = { e: entry({ kind: "sep" }) };
    return [
      ...(this.showsAccount() ? [row("account", ICONS.USER_ROUND, "Account")] : []),
      row("state", ICONS.CIRCLE_DOT, "State"),
      row("involvement", ICONS.LAYERS, "Involvement"),
      sep,
      row("author", ICONS.USER_ROUND, "Author"),
      row("assignee", ICONS.USER_CHECK, "Assignee"),
      row("labels", ICONS.TAG, "Labels"),
      row("milestone", ICONS.MILESTONE, "Milestone"),
      sep,
      row("project", ICONS.FOLDER_GIT, "Project"),
    ];
  }

  private subOf(i: number): SubName | undefined {
    return this.filterRows().filter((r) => r.e.kind === "row")[i]?.sub;
  }

  private person(login: string, n: string, checked: boolean, tip = ""): MenuEntry {
    const px = this.avatars.get(login) ?? null;
    return entry({ label: login, value: n, checked, person: login, letter: letterOf(login), avatar: px ?? NO_PIXELS, has_avatar: px !== null, tip });
  }

  /** One Filters submenu; `act(i)` of a row acts on its `pick`. */
  private subView(s: SubName): { view: Omit<SubView, "top">; act: (pick: number) => boolean } {
    const f = this.filters;
    const data = this.fetchedList();
    const rows = (es: MenuEntry[], from: number): MenuEntry[] => {
      let n = from;
      return es.map((e) => (e.kind === "row" ? { ...e, pick: n++ } : e));
    };
    const noteOf = (label: string): MenuEntry => entry({ kind: "note", label });
    const sep = entry({ kind: "sep" });
    const radio = <T,>(opts: readonly [T, string, string][], cur: T, set: (v: T) => void) => ({
      view: { width: 190, head: rows(opts.map(([v, label, icon]) => entry({ icon, label, checked: v === cur })), 0), list: [], foot: [] },
      act: (p: number) => {
        const o = opts[p];
        if (o === undefined) return false;
        set(o[0]);
        return true;
      },
    });
    const people = (found: [string, number][], cur: string | undefined, nobody: boolean | undefined, width: number, set: (v: string | null | "nobody") => void) => {
      const head = [entry({ icon: ICONS.USERS, label: "Anyone", checked: cur === undefined && nobody !== true }), ...(nobody === undefined ? [] : [entry({ icon: ICONS.CIRCLE_SLASH, label: "Nobody", checked: nobody })]), ...(found.length > 0 ? [sep] : [])];
      const hr = rows(head, 0);
      const first = hr.filter((e) => e.kind === "row").length;
      const lr = rows(found.map(([login, n]) => this.person(login, String(n), cur !== undefined && eqi(cur, login))), first);
      return {
        view: { width, head: hr, list: lr, foot: [] },
        act: (p: number) => {
          if (p === 0) set(null);
          else if (nobody !== undefined && p === 1) set("nobody");
          else {
            const e = lr.find((x) => x.pick === p);
            if (e === undefined) return false;
            set(e.label);
          }
          return true;
        },
      };
    };
    switch (s) {
      case "account": {
        const found = list.accounts(data);
        const lr = rows(
          found.map(([login, pcs, n]) => {
            const e = this.person(login, `${pcs} · ${n}`, f.account !== undefined && eqi(f.account, login), `Signed in on ${pcs}; sees ${n}`);
            return e;
          }),
          1,
        );
        return {
          view: { width: 240, head: rows([entry({ icon: ICONS.USERS, label: "All", checked: f.account === undefined }), sep], 0), list: lr, foot: [] },
          act: (p) => {
            if (p === 0) delete f.account;
            else {
              const e = lr.find((x) => x.pick === p);
              if (e === undefined) return false;
              f.account = e.label;
            }
            return true;
          },
        };
      }
      case "state":
        return radio(STATES, f.state, (v) => {
          f.state = v;
        });
      case "involvement":
        return radio(INVOLVEMENTS, f.involvement, (v) => {
          f.involvement = v;
        });
      case "author":
        return people(list.authors(data), f.author, undefined, 220, (v) => {
          if (v === null || v === "nobody") delete f.author;
          else f.author = v;
        });
      case "assignee":
        return people(list.assignees(data), f.assignee?.kind === "login" ? f.assignee.login : undefined, f.assignee?.kind === "nobody", 220, (v) => {
          if (v === null) delete f.assignee;
          else f.assignee = v === "nobody" ? { kind: "nobody" } : { kind: "login", login: v };
        });
      case "labels": {
        const found = list.labels(data);
        const lr = rows(
          found.map(([name, c, n]) => entry({ label: name, value: String(n), checked: f.labels.some((l) => eqi(l, name)), person: "", dot: hex(c), has_dot: true })),
          1,
        );
        return {
          view: { width: 230, head: rows([entry({ icon: ICONS.TAG, label: "Any", checked: f.labels.length === 0 }), sep, ...(found.length === 0 ? [noteOf("No labels in these issues.")] : [])], 0), list: lr, foot: [] },
          act: (p) => {
            if (p === 0) f.labels = [];
            else {
              const e = lr.find((x) => x.pick === p);
              if (e === undefined) return false;
              const at = f.labels.findIndex((l) => eqi(l, e.label));
              if (at >= 0) f.labels.splice(at, 1);
              else f.labels.push(e.label);
            }
            return false;
          },
        };
      }
      case "milestone": {
        const found = list.milestones(data);
        const cur = f.milestone;
        const lr = rows(
          found.map(([m, n]) => entry({ icon: ICONS.MILESTONE, label: m, value: String(n), checked: typeof cur === "string" && eqi(cur, m) })),
          2,
        );
        return {
          view: {
            width: 230,
            head: rows([entry({ icon: ICONS.LAYERS, label: "Any", checked: cur === undefined }), entry({ icon: ICONS.CIRCLE_SLASH, label: "No milestone", checked: cur === null }), sep, ...(found.length === 0 ? [noteOf("No milestones in these issues.")] : [])], 0),
            list: lr,
            foot: [],
          },
          act: (p) => {
            if (p === 0) delete f.milestone;
            else if (p === 1) f.milestone = null;
            else {
              const e = lr.find((x) => x.pick === p);
              if (e === undefined) return false;
              f.milestone = e.label;
            }
            return true;
          },
        };
      }
      case "project": {
        const projects = this.host.projects();
        const others = list.otherProjects(
          data,
          projects.map((p) => p.repo),
        );
        const mine = projects.map((p) => entry({ icon: ICONS.FOLDER_GIT, label: p.name, checked: this.project === p.id, tip: p.repo }));
        const theirs = others.map(([name, repo, pcs]) =>
          entry({
            icon: pcs === "" ? ICONS.GLOBE : ICONS.FOLDER_GIT,
            label: name,
            value: pcs,
            checked: this.elsewhere !== null && eqi(this.elsewhere, repo),
            tip: pcs === "" ? repo : `${repo}, a project on ${pcs}`,
          }),
        );
        const lr = rows([...mine, ...(theirs.length > 0 ? [sep] : []), ...theirs], 1);
        return {
          view: {
            width: 250,
            head: rows([entry({ icon: ICONS.LAYERS, label: "All projects", checked: this.project === null && this.elsewhere === null })], 0),
            list: lr,
            foot: projects.length === 0 && others.length === 0 ? [noteOf("No projects with a GitHub remote.")] : [],
          },
          act: (p) => {
            if (p === 0) {
              this.project = null;
              this.elsewhere = null;
            } else if (p <= projects.length) {
              this.project = projects[p - 1]?.id ?? null;
              this.elsewhere = null;
            } else {
              this.project = null;
              this.elsewhere = others[p - 1 - projects.length]?.[1] ?? null;
            }
            return true;
          },
        };
      }
    }
  }

  menuView(): MenuView {
    const none: MenuView = { name: "", width: 0, rows: [], sub: null };
    if (this.menu === null) return none;
    const hl = this.keys.hl;
    const mark = (es: MenuEntry[], at: number | null): MenuEntry[] => {
      let n = 0;
      return es.map((e) => (e.kind === "row" ? { ...e, kb: at === n++ } : e));
    };
    if (this.menu === "sort") {
      const rows = SORTS.map((s) => entry({ icon: SORT_ICONS[s], label: list.sortLabel(s), current: s === this.sort }));
      return { name: "sort", width: 220, rows: mark(rows, hl).map((e, i) => ({ ...e, pick: i })), sub: null };
    }
    if (this.menu === "provider") {
      const rows = [entry({ icon: ICONS.LAYERS, label: "All", checked: !this.githubOnly }), entry({ icon: " ", label: "GitHub", checked: this.githubOnly, logo: true })];
      return { name: "provider", width: 180, rows: mark(rows, hl).map((e, i) => ({ ...e, pick: i })), sub: null };
    }
    const fr = this.filterRows();
    let n = 0;
    const rows = fr.map((r) => (r.e.kind === "row" ? { ...r.e, pick: n++, kb: this.subKeys === null && hl === n - 1 } : r.e));
    let sub: SubView | null = null;
    if (this.sub !== null) {
      const at = fr.findIndex((r) => r.sub === this.sub);
      const top = fr.slice(0, Math.max(0, at)).reduce((h, r) => h + (r.e.kind === "sep" ? 9 : 32), 4);
      const { view } = this.subView(this.sub);
      const shl = this.subKeys?.hl ?? null;
      const mk = (es: MenuEntry[]): MenuEntry[] => es.map((e) => (e.kind === "row" ? { ...e, kb: shl === e.pick } : e));
      sub = { ...view, head: mk(view.head), list: mk(view.list), top };
    }
    return { name: "filters", width: 250, rows: rows.map((r, i) => ({ ...r, current: r.kind === "row" && fr[i]?.sub === this.sub })), sub };
  }

  private subCount(): number {
    if (this.sub === null) return 0;
    const v = this.subView(this.sub).view;
    return [...v.head, ...v.list].filter((e) => e.kind === "row").length;
  }

  private mainCount(): number {
    if (this.menu === "sort") return SORTS.length;
    if (this.menu === "provider") return 2;
    return this.filterRows().filter((r) => r.e.kind === "row").length;
  }

  /** Hover or click on a Filters row opens its submenu. */
  hoverMain(pick: number): void {
    if (this.menu !== "filters") return;
    const s = this.subOf(pick);
    if (s === undefined) return;
    if (this.sub !== s) this.subKeys = null;
    this.sub = s;
    this.changed();
  }

  /** A click on a main-menu row. */
  pickMain(pick: number): void {
    if (this.menu === "sort") {
      const s = SORTS[pick];
      if (s !== undefined) this.sort = s;
      return this.closeMenus();
    }
    if (this.menu === "provider") {
      this.githubOnly = pick === 1;
      return this.closeMenus();
    }
    this.hoverMain(pick);
  }

  pickSub(pick: number): void {
    if (this.sub === null) return;
    const close = this.subView(this.sub).act(pick);
    if (close) this.closeMenus();
    else this.changed();
    this.refetchIfStateChanged();
  }

  /** The menu's keyboard (listdetail.rs `menu_keys`); false when no menu is open. */
  menuKey(key: Key): boolean {
    if (this.menu === null) return false;
    const hasSubs = this.menu === "filters";
    if (this.sub !== null && this.subKeys !== null) {
      const k = this.subKeys.input(key, this.subCount());
      if (k?.kind === "pick") this.pickSub(k.i);
      else if (k?.kind === "leave") {
        this.sub = null;
        this.subKeys = null;
      } else if (k?.kind === "close") {
        this.closeMenus();
        return true;
      }
      this.changed();
      return true;
    }
    const k = this.keys.input(key, this.mainCount());
    if (k?.kind === "pick" || (k?.kind === "enter" && hasSubs)) {
      const i = k.i;
      if (hasSubs) {
        this.hoverMain(i);
        if (this.sub !== null) this.subKeys = Object.assign(new MenuKeys(), { hl: 0 });
      } else this.pickMain(i);
    } else if (k?.kind === "close") {
      this.closeMenus();
      return true;
    }
    this.changed();
    return true;
  }


  detailOf(url: string): Detail {
    let d = this.details.get(url);
    if (d === undefined) {
      d = newDetail();
      this.details.set(url, d);
    }
    return d;
  }

  /** The tab labels of the open issues. */
  tabs(): { icon: string; text: string }[] {
    return this.split.tabs.map((url) => ({ icon: ICONS.CIRCLE_DOT, text: `#${url.slice(url.lastIndexOf("/") + 1)}` }));
  }

  open(url: string): void {
    this.split.select(url);
    this.changed();
  }

  /** Drops the details of closed tabs. */
  prune(): void {
    for (const k of [...this.details.keys()]) if (!this.split.tabs.includes(k)) this.details.delete(k);
  }
}

function accountsChip(a: string[]): string {
  if (a.length === 0) return "";
  const first = a[0] ?? "";
  return a.length > 2 ? `${first} +${a.length - 1}` : a.join(", ");
}

function blank(p: Partial<ListItem>): ListItem {
  return { kind: "gap", icon: "", label: "", count: "", url: "", number: "", title: "", state: "open", state_tip: "", comments: "", age: "", author: "", letter: "", repo: "", labels: [], accounts: "", selected: false, fix_enabled: false, avatar: NO_PIXELS, has_avatar: false, h: 0, ...p };
}

/** Space between an issue's markdown blocks as egui_commonmark lays them out in the panel (pixels, by block kinds). */
export function issueGaps<B extends { kind: string; gap: number }>(bs: B[]): B[] {
  return bs.map((b, i) => {
    const prev = bs[i - 1];
    let gap = b.gap;
    if (prev === undefined) gap = b.kind === "h" ? 21 : 0;
    else if (b.kind === "li" && prev.kind === "li") gap = 13;
    else if (b.kind === "li" && prev.kind === "p") gap = 24;
    else if (prev.kind === "h") gap = 19;
    else if (b.kind === "code" && prev.kind === "li") gap = 25;
    return { ...b, gap };
  });
}
