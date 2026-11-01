import type { Assignee, Checks, Group, Issue, IssueFetched, IssueFilters, IssueSort, IssueState, IssuesPort, Review, Rgb, Source } from "../ghapi.ts";
import { hexRgb } from "../ghapi.ts";
import { type GhRun, ghRun } from "./gh.ts";
import { stateOf } from "./issuedetail.ts";
import { graphql, isoSecs } from "./prs.ts";

type Obj = Record<string, unknown>;
const get = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj)[k] : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const lc = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const eqi = (a: string, b: string): boolean => lc(a) === lc(b);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function trusted(association: string): boolean {
  return association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
}


const FIELDS =
  "... on Issue { number title url state stateReason createdAt updatedAt repository { nameWithOwner } " +
  "author { login avatarUrl(size: 40) } authorAssociation labels(first: 10) { nodes { name color } } assignees(first: 10) { nodes { login } } " +
  "milestone { title } comments { totalCount } closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { state } } }";

function stateQualifier(s: IssueFilters["state"]): string {
  return s === "all" ? "" : s === "open" ? " is:open" : " is:closed";
}

/** Issues assigned to you, that you opened, that mention you, and the ones in the given repos (chunked: search caps a query's length). */
export function query(state: IssueFilters["state"], repos: string[]): string {
  const st = stateQualifier(state);
  let q = "query { viewer { login } ";
  const search = (alias: string, s: string, n: number): void => {
    q += `${alias}: search(query: "${s.replaceAll("\\", "").replaceAll('"', "")}", type: ISSUE, first: ${n}) { nodes { ${FIELDS} } } `;
  };
  search("assigned", `is:issue assignee:@me archived:false sort:updated-desc${st}`, 50);
  search("authored", `is:issue author:@me archived:false sort:updated-desc${st}`, 50);
  search("mentioned", `is:issue mentions:@me archived:false sort:updated-desc${st}`, 50);
  for (let i = 0; i * 5 < repos.length; i++) {
    const rs = repos.slice(i * 5, i * 5 + 5).map((r) => `repo:${r}`);
    search(`p${i}`, `is:issue sort:updated-desc${st} ${rs.join(" ")}`, 100);
  }
  return `${q}}`;
}

export async function fetchIssues(state: IssueFilters["state"], repos: string[], run: GhRun = ghRun): Promise<IssueFetched> {
  return parse(await graphql(query(state, repos), "issues", run));
}

export function parse(v: unknown): IssueFetched {
  const d = get(v, "data");
  const viewer = text(get(get(d, "viewer"), "login")) ?? "";
  const mentioned = new Set(list(get(get(d, "mentioned"), "nodes")).flatMap((n) => text(get(n, "url")) ?? []));
  const seen = new Set<string>();
  const items: Issue[] = [];
  const aliases = typeof d === "object" && d !== null ? Object.keys(d).filter((k) => k !== "viewer").sort(cmp) : [];
  for (const a of aliases) {
    for (const n of list(get(get(d, a), "nodes"))) {
      const i = node(n);
      if (i === undefined || seen.has(i.url)) continue;
      seen.add(i.url);
      items.push({ ...i, mentions: mentioned.has(i.url) && viewer !== "" ? [viewer] : [], accounts: viewer === "" ? [] : [viewer] });
    }
  }
  items.sort((a, b) => b.updated - a.updated);
  return { viewer, items, sources: [] };
}

function node(n: unknown): Issue | undefined {
  const s = (k: string): string => text(get(n, k)) ?? "";
  const url = text(get(n, "url"));
  const number = get(n, "number");
  if (url === undefined || typeof number !== "number" || !Number.isInteger(number) || number < 0) return undefined;
  const count = get(get(n, "comments"), "totalCount");
  return {
    number,
    title: s("title"),
    url,
    repo: text(get(get(n, "repository"), "nameWithOwner")) ?? "",
    state: stateOf(s("state"), s("stateReason")),
    created: isoSecs(s("createdAt")) ?? 0,
    updated: isoSecs(s("updatedAt")) ?? 0,
    comments: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0,
    author: text(get(get(n, "author"), "login")) ?? "ghost",
    avatar: text(get(get(n, "author"), "avatarUrl")) ?? "",
    labels: list(get(get(n, "labels"), "nodes")).flatMap((l): [string, Rgb][] => {
      const name = text(get(l, "name"));
      return name === undefined ? [] : [[name, hexRgb(text(get(l, "color")) ?? "")]];
    }),
    assignees: list(get(get(n, "assignees"), "nodes")).flatMap((a) => text(get(a, "login")) ?? []),
    milestone: text(get(get(n, "milestone"), "title")) ?? null,
    mentions: [],
    accounts: [],
    linked_pr: list(get(get(n, "closedByPullRequestsReferences"), "nodes")).some((p) => get(p, "state") === "OPEN"),
    author_trusted: trusted(text(get(n, "authorAssociation")) ?? ""),
  };
}



export interface BaseQuery {
  text: string;
  labels: string[][];
  excluded: string[];
  author?: string;
  draft?: boolean;
  review?: Review;
  checks?: Checks;
}

export interface Query {
  base: BaseQuery;
  assignee?: Assignee;
  /** null: no milestone. */
  milestone?: string | null;
}

function tokens(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of s) {
    if (c === '"') {
      quoted = !quoted;
      cur += c;
    } else if (/\s/.test(c) && !quoted) {
      if (cur !== "") out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

function values(raw: string): string[] {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"') && !v.slice(1, -1).includes('"')) {
    const x = v.replaceAll('"', "").trim();
    return x === "" ? [] : [x];
  }
  return v
    .split(",")
    .map((x) => x.replaceAll('"', "").trim())
    .filter((x) => x !== "")
    .slice(0, 10);
}

const REVIEWS: Record<string, Review> = { approved: "approved", changes_requested: "changes", "changes-requested": "changes", required: "required", "review-required": "required", none: "none" };
const CHECKS: Record<string, Checks> = { success: "passing", passing: "passing", failure: "failing", failing: "failing" };

/** The pull request page's search syntax: `label:`, `-label:`, `author:`, free text; any other `key:value` is a label `key:value`. */
export function parseBaseQuery(s: string): BaseQuery {
  const q: BaseQuery = { text: "", labels: [], excluded: [] };
  const free: string[] = [];
  for (const tok of tokens(s)) {
    const neg = tok.startsWith("-");
    const body = neg ? tok.slice(1) : tok;
    const at = body.indexOf(":");
    const key = at < 0 ? "" : body.slice(0, at);
    const raw = at < 0 ? "" : body.slice(at + 1);
    if (at < 0 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      free.push(tok);
      continue;
    }
    const val = raw.replaceAll('"', "").trim();
    if (val === "") {
      free.push(tok);
      continue;
    }
    const lower = val.toLowerCase();
    const label = (v: string[]): boolean => {
      if (v.length === 0) return false;
      if (neg) q.excluded.push(...v);
      else q.labels.push(v);
      return true;
    };
    let handled: boolean;
    switch (key.toLowerCase()) {
      case "label":
        handled = label(values(raw));
        break;
      case "author":
        handled = !neg;
        if (handled) q.author = val;
        break;
      case "draft":
        handled = !neg && (lower === "true" || lower === "false");
        if (handled) q.draft = lower === "true";
        break;
      case "review": {
        const r = neg ? undefined : REVIEWS[lower];
        handled = r !== undefined;
        if (r !== undefined) q.review = r;
        break;
      }
      case "checks":
      case "status": {
        const c = neg ? undefined : CHECKS[lower];
        handled = c !== undefined;
        if (c !== undefined) q.checks = c;
        break;
      }
      default:
        handled = !val.startsWith("/") && label(values(raw).map((x) => (x.includes(":") ? x : `${key}:${x}`)));
    }
    if (!handled) free.push(tok);
  }
  q.text = free.join(" ");
  return q;
}

/** The base syntax plus `assignee:` (`assignee:none` or `no:assignee` for unassigned) and `milestone:` (`no:milestone`). */
export function parseQuery(s: string): Query {
  const q: Query = { base: { text: "", labels: [], excluded: [] } };
  const rest: string[] = [];
  for (const tok of s.split(/\s+/).filter((t) => t !== "")) {
    const lower = tok.toLowerCase();
    if (lower === "no:assignee") {
      q.assignee = { kind: "nobody" };
    } else if (lower === "no:milestone") {
      q.milestone = null;
    } else if (lower.startsWith("assignee:") && lower.length > 9) {
      q.assignee = lower.slice(9) === "none" ? { kind: "nobody" } : { kind: "login", login: tok.slice(9).replace(/^@+/, "") };
    } else if (lower.startsWith("milestone:") && tok.length > 10) {
      const v = tok.slice(10).replace(/^"+/, "").replace(/"+$/, "");
      q.milestone = v.toLowerCase() === "none" ? null : v;
    } else {
      rest.push(tok);
    }
  }
  q.base = parseBaseQuery(rest.join(" "));
  return q;
}

export function defaultFilters(): IssueFilters {
  return { state: "open", involvement: "all", labels: [] };
}

/** The count on the Filters button: everything not at its default. */
export function activeFilters(f: IssueFilters): number {
  const flags = [f.state !== "open", f.involvement !== "all", f.account !== undefined, f.project !== undefined, f.author !== undefined, f.assignee !== undefined, f.milestone !== undefined];
  return flags.filter(Boolean).length + f.labels.length;
}

const isMe = (login: string, me: string[]): boolean => me.some((m) => m !== "" && eqi(login, m));
const assigned = (i: Issue, me: string[]): boolean => i.assignees.some((a) => isMe(a, me));
const mentioned = (i: Issue, me: string[]): boolean => i.mentions.some((m) => isMe(m, me));

/** The logins Involvement and the sections are about: the picked account, else every account of the list (the viewer alone for a single PC's list). */
export function mine(data: IssueFetched, f: IssueFilters): string[] {
  if (f.account !== undefined) return [f.account];
  const v: string[] = [];
  for (const s of data.sources) {
    if (s.login !== "" && !isMe(s.login, v)) v.push(s.login);
  }
  if (v.length === 0 && data.viewer !== "") v.push(data.viewer);
  return v;
}

function passes(i: Issue, f: IssueFilters, q: Query): boolean {
  const has = (l: string): boolean => i.labels.some(([n]) => eqi(n.trim(), l.trim()));
  const state = f.state === "all" || (f.state === "open" ? i.state === "open" : i.state !== "open");
  const author = q.base.author ?? f.author;
  const assignee = q.assignee ?? f.assignee;
  const milestone = q.milestone !== undefined ? q.milestone : f.milestone;
  return (
    state &&
    (f.account === undefined || i.accounts.some((x) => eqi(x, f.account ?? ""))) &&
    (f.project === undefined || eqi(i.repo, f.project)) &&
    (author === undefined || eqi(i.author, author.replace(/^@+/, ""))) &&
    (assignee === undefined || (assignee.kind === "nobody" ? i.assignees.length === 0 : i.assignees.some((x) => eqi(x, assignee.login)))) &&
    (milestone === undefined || (milestone === null ? i.milestone === null : i.milestone !== null && eqi(milestone, i.milestone))) &&
    f.labels.every(has) &&
    q.base.labels.every((any) => any.some(has)) &&
    !q.base.excluded.some(has)
  );
}

function matchesText(i: Issue, t: string): boolean {
  const n = t.trim().toLowerCase();
  return n === "" || `#${i.number} ${i.title} ${i.repo} ${i.author}`.toLowerCase().includes(n);
}

/** How well an issue matches the free text (the PR page's ranking, without branches). */
function relevance(i: Issue, t: string): number {
  const n = t.trim().toLowerCase();
  const num = n.replace(/^#+/, "");
  if (num !== "" && /^[0-9]+$/.test(num)) return String(i.number) === num ? 100 : 0;
  const title = i.title.toLowerCase();
  const words = n.split(/\s+/).filter((w) => w !== "");
  if (title === n) return 90;
  if (title.includes(n)) return 80;
  if (words.length > 1 && words.every((w) => title.includes(w))) return 70;
  if (i.author.toLowerCase().includes(n)) return 50;
  if (i.repo.toLowerCase().includes(n)) return 40;
  if (words.some((w) => title.includes(w))) return 30;
  return 10;
}

export function sortGroup(items: Issue[], sort: IssueSort, search: string): void {
  const t = search.trim();
  const recent = (a: Issue, b: Issue): number => b.updated - a.updated;
  if (t !== "" && sort === "updated") {
    items.sort((a, b) => relevance(b, t) - relevance(a, t) || recent(a, b));
    return;
  }
  switch (sort) {
    case "updated":
      items.sort(recent);
      break;
    case "stale":
      items.sort((a, b) => a.updated - b.updated);
      break;
    case "newest":
      items.sort((a, b) => b.created - a.created || recent(a, b));
      break;
    case "oldest":
      items.sort((a, b) => a.created - b.created || recent(a, b));
      break;
    case "most_commented":
      items.sort((a, b) => b.comments - a.comments || recent(a, b));
      break;
    case "least_commented":
      items.sort((a, b) => a.comments - b.comments || recent(a, b));
      break;
  }
}

/** The page's sections, filtered and sorted. An issue sits in the first section it fits: Assigned, Authored, Mentioned, then Others. */
export function groups(data: IssueFetched, f: IssueFilters, search: string, sort: IssueSort): Group<Issue>[] {
  const q = parseQuery(search);
  const me = mine(data, f);
  const items = data.items
    .filter((i) => {
      switch (f.involvement) {
        case "all":
          return true;
        case "assigned":
          return assigned(i, me);
        case "authored":
          return isMe(i.author, me);
        case "mentioned":
          return mentioned(i, me);
      }
    })
    .filter((i) => passes(i, f, q) && matchesText(i, q.base.text));
  let out: Group<Issue>[];
  if (f.involvement !== "all") {
    out = [{ key: "others", label: "", items }];
  } else {
    const a: Issue[] = [];
    const b: Issue[] = [];
    const m: Issue[] = [];
    const o: Issue[] = [];
    for (const i of items) (assigned(i, me) ? a : isMe(i.author, me) ? b : mentioned(i, me) ? m : o).push(i);
    out = [
      { key: "assigned", label: "Assigned", items: a },
      { key: "authored", label: "Authored", items: b },
      { key: "mentioned", label: "Mentioned", items: m },
      { key: "others", label: "Others", items: o },
    ];
  }
  out = out.filter((g) => g.items.length > 0);
  for (const g of out) sortGroup(g.items, sort, q.base.text);
  return out;
}

/** Each value in the list with how many issues have it, most first. */
function tally(it: Iterable<string>): [string, number][] {
  const m = new Map<string, number>();
  for (const v of it) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || cmp(a[0].toLowerCase(), b[0].toLowerCase()));
}

/** The Account filter's choices: each GitHub login of the list, the PCs signed in with it (", "-joined) and how many issues it sees. */
export function accounts(data: IssueFetched): [string, string, number][] {
  const v: [string, string[]][] = [];
  for (const s of data.sources) {
    if (s.login === "") continue;
    const x = v.find((e) => eqi(e[0], s.login));
    if (x) x[1].push(s.name);
    else v.push([s.login, [s.name]]);
  }
  return v.map(([l, pcs]) => [l, pcs.join(", "), data.items.filter((i) => i.accounts.some((a) => eqi(a, l))).length]);
}

/** What the page says about PCs whose part is missing ("laptop: unreachable"). */
export function notes(data: IssueFetched): string[] {
  return data.sources.flatMap((s) => (s.error === undefined ? [] : [`${s.name}: ${s.error}`]));
}

/** A PC's `gh` error as the page's note says it. */
export function shortError(e: string): string {
  if (e.includes("auth login") || e.includes("isn't installed")) return "GitHub not connected";
  const first = (e.split("\n")[0] ?? "").trim();
  const chars = Array.from(first);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : first;
}

/** The lists of this PC and the mesh's PCs as one (this PC's part first): an issue several accounts see is there once, with all of them, as its most recently updated copy says. */
export function merge(parts: [Source, IssueFetched | undefined][]): IssueFetched {
  const out: IssueFetched = { viewer: "", items: [], sources: [] };
  const at = new Map<string, number>();
  for (const [source, part] of parts) {
    const src: Source = { ...source };
    if (part) {
      if (src.login === "") src.login = part.viewer;
      if (out.viewer === "") out.viewer = part.viewer;
      for (const i of part.items) {
        const k = at.get(i.url);
        const have = k === undefined ? undefined : out.items[k];
        if (k === undefined || have === undefined) {
          at.set(i.url, out.items.length);
          out.items.push({ ...i, accounts: [...i.accounts], mentions: [...i.mentions] });
          continue;
        }
        const accs = [...have.accounts];
        const ments = [...have.mentions];
        for (const a of i.accounts) if (!isMe(a, accs)) accs.push(a);
        for (const m of i.mentions) if (!isMe(m, ments)) ments.push(m);
        out.items[k] = { ...(i.updated > have.updated ? i : have), accounts: accs, mentions: ments };
      }
    }
    out.sources.push(src);
  }
  out.items.sort((a, b) => b.updated - a.updated);
  return out;
}

/**
 * The PC an action on `i` runs on: one whose account fetched it (the picked account's first, then this PC), or with
 * `project`, one that has its repo as a project (one whose account fetched it first). Undefined: nobody fits, this PC tries.
 */
export function owner(data: IssueFetched, i: Issue, prefer: string | undefined, project: boolean): Source | undefined {
  const sees = (s: Source): boolean => s.login !== "" && isMe(s.login, i.accounts);
  const rank = (s: Source): number => (sees(s) ? 0 : 4) + (prefer !== undefined && eqi(s.login, prefer) ? 0 : 2) + (s.pc !== "" ? 1 : 0);
  return data.sources
    .filter((s) => s.error === undefined)
    .filter((s) => (project ? s.projects.some((r) => eqi(r, i.repo)) : sees(s)))
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The Project filter's choices beyond this PC's projects (`local`: their repos): the other PCs' projects, one per repo with the
 * PCs that have it, then the other repos in the list (an issue that's yours in a repo no PC has as a project). (name, owner/name, PCs).
 */
export function otherProjects(data: IssueFetched, local: string[]): [string, string, string][] {
  const has = (v: string[], r: string): boolean => v.some((x) => eqi(x, r));
  const peers: [string, string[]][] = [];
  for (const s of data.sources) {
    if (s.pc === "") continue;
    for (const r of s.projects) {
      if (has(local, r)) continue;
      const x = peers.find((e) => eqi(e[0], r));
      if (x) x[1].push(s.name);
      else peers.push([r, [s.name]]);
    }
  }
  const short = (r: string): string => r.split("/").pop() ?? r;
  peers.sort((a, b) => cmp(short(a[0]).toLowerCase(), short(b[0]).toLowerCase()));
  const out: [string, string, string][] = peers.map(([r, pcs]) => [short(r), r, pcs.join(", ")]);
  const rest: string[] = [];
  for (const i of data.items) {
    if (!has(local, i.repo) && !out.some((o) => eqi(o[1], i.repo)) && !has(rest, i.repo)) rest.push(i.repo);
  }
  rest.sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()));
  return [...out, ...rest.map((r): [string, string, string] => [r, r, ""])];
}

export const authors = (data: IssueFetched): [string, number][] => tally(data.items.map((i) => i.author));
export const assignees = (data: IssueFetched): [string, number][] => tally(data.items.flatMap((i) => i.assignees));
export const milestones = (data: IssueFetched): [string, number][] => tally(data.items.flatMap((i) => (i.milestone === null ? [] : [i.milestone])));

export function labels(data: IssueFetched): [string, Rgb, number][] {
  const m = new Map<string, [Rgb, number]>();
  for (const i of data.items) {
    for (const [n, c] of i.labels) {
      const e = m.get(n);
      if (e) e[1]++;
      else m.set(n, [c, 1]);
    }
  }
  return [...m].map(([n, [c, k]]): [string, Rgb, number] => [n, c, k]).sort((a, b) => b[2] - a[2] || cmp(a[0], b[0]));
}

const SORT_LABELS: Record<IssueSort, string> = {
  updated: "Recently updated",
  stale: "Least recently updated",
  newest: "Newest",
  oldest: "Oldest",
  most_commented: "Most commented",
  least_commented: "Least commented",
};

export const sortLabel = (sort: IssueSort): string => SORT_LABELS[sort];

export function createIssuesPort(run: GhRun = ghRun): IssuesPort {
  return { fetch: (state, repos) => fetchIssues(state, repos, run), groups, mine, accounts, notes, authors, assignees, milestones, labels, otherProjects, owner, merge, shortError, sortLabel };
}

export const issuesPort: IssuesPort = createIssuesPort();
