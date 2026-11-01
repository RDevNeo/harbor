import type { Checks, Group, Pr, PrFetched, PrFilters, PrSort, PrsPort, Review, Rgb } from "../ghapi.ts";
import { type GhOut, type GhRun, GhSpawnError, ghRun, spawnText } from "./gh.ts";
import { asArr, asStr, asUint, at, parseBody } from "./read.ts";

export { GH_TIMEOUT } from "./gh.ts";

export type StateF = PrFilters["state"];
export type Involvement = PrFilters["involvement"];

export const defaultFilters = (): PrFilters => ({ state: "open", involvement: "all", labels: [] });

const SORT_LABELS: Record<PrSort, string> = {
  ready: "Merge readiness",
  blocked: "Blocked on me",
  updated: "Recently updated",
  newest: "Newest shown",
  oldest: "Oldest shown",
  largest: "Largest shown",
  smallest: "Smallest shown",
};

export const sortLabel = (sort: PrSort): string => SORT_LABELS[sort];

export function activeFilters(f: PrFilters, project: boolean): number {
  const on = [f.state !== "open", f.involvement !== "all", project, f.draft !== undefined, f.review !== undefined, f.checks !== undefined, f.author !== undefined];
  return on.filter(Boolean).length + f.labels.length;
}

const size = (p: Pr): number => p.adds + p.dels;

const eqi = (a: string, b: string): boolean => a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const FIELDS =
  "... on PullRequest { number title url state isDraft additions deletions createdAt updatedAt headRefName headRefOid reviewDecision mergeable " +
  "repository { nameWithOwner } author { login avatarUrl(size: 40) } labels(first: 10) { nodes { name color } } " +
  "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }";

function stateQualifier(s: StateF): string {
  switch (s) {
    case "all":
      return "";
    case "open":
      return " is:open";
    case "closed":
      return " is:closed is:unmerged";
    case "merged":
      return " is:merged";
  }
}

/** PRs you authored, PRs awaiting your review and PRs in the given repos (chunked: search caps a query's length). */
export function query(state: StateF, repos: string[]): string {
  const st = stateQualifier(state);
  let q = "query { viewer { login } ";
  const search = (alias: string, s: string, n: number): void => {
    const clean = s.replaceAll("\\", "").replaceAll('"', "");
    q += `${alias}: search(query: "${clean}", type: ISSUE, first: ${n}) { nodes { ${FIELDS} } } `;
  };
  search("authored", `is:pr author:@me archived:false sort:updated-desc${st}`, 50);
  search("reviewing", `is:pr review-requested:@me archived:false sort:updated-desc${st}`, 50);
  for (let i = 0; i * 5 < repos.length; i++) {
    const rs = repos.slice(i * 5, i * 5 + 5).map((r) => `repo:${r}`);
    search(`p${i}`, `is:pr sort:updated-desc${st} ${rs.join(" ")}`, 100);
  }
  return `${q}}`;
}

export async function fetch(state: StateF, repos: string[], run: GhRun = ghRun): Promise<PrFetched> {
  return parse(await graphql(query(state, repos), "pull requests", run));
}

/** Partial answers (some searches failed) still count; `what` names the list in the "install gh" hint. */
export async function graphql(q: string, what: string, run: GhRun = ghRun): Promise<unknown> {
  let out: GhOut;
  try {
    out = await run(["api", "graphql", "-f", `query=${q}`]);
  } catch (e) {
    if (e instanceof GhSpawnError && e.kind === "missing") {
      throw new Error(`The GitHub CLI (gh) isn't installed. Install it and run \`gh auth login\` to see your ${what}.`);
    }
    throw new Error(`gh: ${spawnText(e)}`);
  }
  const v = parseBody(out.stdout) ?? null;
  if (out.code !== 0 && (at(v, "data") ?? null) === null) {
    const err = out.stderr.trim();
    throw new Error(err.includes("auth login") || err.includes("not logged") ? "Not signed in to GitHub. Run `gh auth login`." : err);
  }
  return v;
}

export function hexRgb(c: string): Rgb {
  const h = (i: number): number => {
    const x = c.slice(i, i + 2);
    return x.length === 2 && /^[0-9a-fA-F]{2}$/.test(x) ? Number.parseInt(x, 16) : 128;
  };
  return [h(0), h(2), h(4)];
}

export function parse(v: unknown): PrFetched {
  const d = at(v, "data");
  const viewer = asStr(at(d, "viewer", "login")) ?? "";
  const reviewing = new Set(asArr(at(d, "reviewing", "nodes")).flatMap((n) => asStr(at(n, "url")) ?? []));
  const seen = new Set<string>();
  const items: Pr[] = [];
  const aliases = typeof d === "object" && d !== null && !Array.isArray(d) ? Object.keys(d).filter((k) => k !== "viewer") : [];
  aliases.sort();
  for (const a of aliases) {
    for (const n of asArr(at(d, a, "nodes"))) {
      const pr = node(n);
      if (pr === undefined || seen.has(pr.url)) continue;
      seen.add(pr.url);
      items.push({ ...pr, review_requested: reviewing.has(pr.url) });
    }
  }
  items.sort((a, b) => b.updated - a.updated);
  return { viewer, items };
}

export function node(n: unknown): Pr | undefined {
  const s = (k: string): string => asStr(at(n, k)) ?? "";
  const url = asStr(at(n, "url"));
  const number = asUint(at(n, "number"));
  if (url === undefined || number === undefined) return undefined;
  const state = at(n, "state");
  const decision = at(n, "reviewDecision");
  const rollup = at(n, "commits", "nodes", 0, "commit", "statusCheckRollup", "state");
  return {
    number,
    title: s("title"),
    url,
    repo: asStr(at(n, "repository", "nameWithOwner")) ?? "",
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    draft: at(n, "isDraft") === true,
    adds: asUint(at(n, "additions")) ?? 0,
    dels: asUint(at(n, "deletions")) ?? 0,
    created: isoSecs(s("createdAt")) ?? 0,
    updated: isoSecs(s("updatedAt")) ?? 0,
    branch: s("headRefName"),
    head: s("headRefOid"),
    review: decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes" : decision === "REVIEW_REQUIRED" ? "required" : "none",
    checks: rollup === "SUCCESS" ? "passing" : rollup === "FAILURE" || rollup === "ERROR" ? "failing" : rollup === "PENDING" || rollup === "EXPECTED" ? "pending" : "none",
    conflicting: at(n, "mergeable") === "CONFLICTING",
    author: asStr(at(n, "author", "login")) ?? "ghost",
    avatar: asStr(at(n, "author", "avatarUrl")) ?? "",
    labels: asArr(at(n, "labels", "nodes")).flatMap((l): [string, Rgb][] => {
      const name = asStr(at(l, "name"));
      return name === undefined ? [] : [[name, hexRgb(asStr(at(l, "color")) ?? "")]];
    }),
    review_requested: false,
  };
}

export function isoSecs(s: string): number | undefined {
  const n = (from: number, to: number): number | undefined => {
    const x = s.slice(from, to);
    return s.length >= to && /^[+-]?[0-9]+$/.test(x) ? Number.parseInt(x, 10) : undefined;
  };
  const y0 = n(0, 4);
  const m = n(5, 7);
  const d = n(8, 10);
  if (y0 === undefined || m === undefined || d === undefined) return undefined;
  const [hh, mm, ss] = [n(11, 13) ?? 0, n(14, 16) ?? 0, n(17, 19) ?? 0];
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.trunc((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return (era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss;
}

export function ago(ts: number, now: number = Math.floor(Date.now() / 1000)): string {
  const d = Math.max(0, now - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 31_536_000) return `${Math.floor(d / 86400)}d ago`;
  return `${Math.floor(d / 31_536_000)}y ago`;
}

export function thousands(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

/** What the search box understands besides free text: `label:a,b`, `-label:x`, `author:`, `draft:`, `review:`, `checks:`, and any `key:value` as the label `key:value`. */
export interface Query {
  text: string;
  labels: string[][];
  excluded: string[];
  author?: string;
  draft?: boolean;
  review?: Review;
  checks?: Checks;
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

export function values(raw: string): string[] {
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

export function parseQuery(s: string): Query {
  const q: Query = { text: "", labels: [], excluded: [] };
  const text: string[] = [];
  for (const tok of tokens(s)) {
    const neg = tok.startsWith("-");
    const body = neg ? tok.slice(1) : tok;
    const colon = body.indexOf(":");
    const key = colon < 0 ? "" : body.slice(0, colon);
    const raw = colon < 0 ? "" : body.slice(colon + 1);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      text.push(tok);
      continue;
    }
    const val = raw.replaceAll('"', "").trim();
    if (val === "") {
      text.push(tok);
      continue;
    }
    const lower = val.toLowerCase();
    const add = (v: string[]): boolean => {
      if (v.length === 0) return false;
      if (neg) q.excluded.push(...v);
      else q.labels.push(v);
      return true;
    };
    const k = key.toLowerCase();
    let handled: boolean;
    if (k === "label") {
      handled = add(values(raw));
    } else if (k === "author" && !neg) {
      q.author = val;
      handled = true;
    } else if (k === "draft" && !neg && (lower === "true" || lower === "false")) {
      q.draft = lower === "true";
      handled = true;
    } else if (k === "review" && !neg) {
      const r = REVIEWS[lower];
      if (r !== undefined) q.review = r;
      handled = r !== undefined;
    } else if ((k === "checks" || k === "status") && !neg) {
      const c = CHECKS[lower];
      if (c !== undefined) q.checks = c;
      handled = c !== undefined;
    } else if (k === "author" || k === "draft" || k === "review" || k === "checks" || k === "status") {
      handled = false;
    } else if (!val.startsWith("/")) {
      handled = add(values(raw).map((x) => (x.includes(":") ? x : `${key}:${x}`)));
    } else {
      handled = false;
    }
    if (!handled) text.push(tok);
  }
  q.text = text.join(" ");
  return q;
}

const authored = (p: Pr, viewer: string): boolean => viewer !== "" && eqi(p.author, viewer);

function passes(p: Pr, f: PrFilters, q: Query): boolean {
  const has = (l: string): boolean => p.labels.some(([n]) => eqi(n.trim(), l.trim()));
  const draft = q.draft ?? f.draft;
  const review = q.review ?? f.review;
  const checks = q.checks ?? f.checks;
  const author = q.author ?? f.author;
  return (
    (f.state === "all" || f.state === p.state) &&
    (f.project === undefined || eqi(p.repo, f.project)) &&
    (draft === undefined || p.draft === draft) &&
    (review === undefined || p.review === review) &&
    (checks === undefined || p.checks === checks) &&
    (author === undefined || eqi(p.author, author.replace(/^@+/, ""))) &&
    f.labels.every(has) &&
    q.labels.every((any) => any.some(has)) &&
    !q.excluded.some(has)
  );
}

function matchesText(p: Pr, text: string): boolean {
  const n = text.trim().toLowerCase();
  return n === "" || `#${p.number} ${p.title} ${p.repo} ${p.branch} ${p.author}`.toLowerCase().includes(n);
}

/** How well a PR matches the free text (T3 Code's ranking). */
function relevance(p: Pr, text: string): number {
  const n = text.trim().toLowerCase();
  if (n === "") return 0;
  const num = n.replace(/^#+/, "");
  if (/^[0-9]+$/.test(num)) return String(p.number) === num ? 100 : 0;
  const title = p.title.toLowerCase();
  const words = n.split(/\s+/).filter((w) => w !== "");
  if (title === n) return 90;
  if (title.includes(n)) return 80;
  if (words.length > 1 && words.every((w) => title.includes(w))) return 70;
  if (p.branch.toLowerCase().includes(n)) return 60;
  if (p.author.toLowerCase().includes(n)) return 50;
  if (p.repo.toLowerCase().includes(n)) return 40;
  if (words.some((w) => title.includes(w))) return 30;
  return 10;
}

const hasStats = (p: Pr): number => (size(p) > 0 ? 1 : 0);

function readyRank(p: Pr): number {
  if (p.conflicting) return 4;
  if (p.state !== "open") return 3;
  if (p.draft) return 2;
  if (p.checks === "passing" && p.review === "approved") return 0;
  return p.checks === "passing" ? 1 : 2;
}

function authoredRank(p: Pr): number {
  if (p.state !== "open") return 6;
  if (p.conflicting) return 0;
  if (p.review === "changes") return 1;
  if (p.checks === "failing") return 2;
  if (p.draft) return 3;
  return p.checks === "passing" && p.review === "approved" ? 5 : 4;
}

export function sortGroup(items: Pr[], key: string, sort: PrSort, text: string, involvement: Involvement): void {
  const t = text.trim();
  if (t !== "" && (sort === "ready" || sort === "blocked" || sort === "updated")) {
    items.sort((a, b) => relevance(b, t) - relevance(a, t) || b.updated - a.updated);
    return;
  }
  switch (sort) {
    case "ready":
      items.sort((a, b) => readyRank(a) - readyRank(b) || hasStats(b) - hasStats(a) || size(a) - size(b) || b.updated - a.updated);
      return;
    case "blocked": {
      const whose = key === "authored" ? "authored" : key === "reviewRequested" ? "reviewing" : involvement;
      if (whose === "all") return;
      const rank = whose === "authored" ? authoredRank : (p: Pr): number => (p.state === "open" ? 0 : 1);
      items.sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
      return;
    }
    case "updated":
      items.sort((a, b) => b.updated - a.updated);
      return;
    case "newest":
      items.sort((a, b) => b.created - a.created || b.updated - a.updated);
      return;
    case "oldest":
      items.sort((a, b) => a.created - b.created || b.updated - a.updated);
      return;
    case "largest":
    case "smallest":
      items.sort((a, b) => hasStats(b) - hasStats(a) || (sort === "largest" ? size(b) - size(a) : size(a) - size(b)) || b.updated - a.updated);
  }
}

export function groups(data: PrFetched, f: PrFilters, search: string, sort: PrSort): Group<Pr>[] {
  const q = parseQuery(search);
  const viewer = data.viewer;
  const items = data.items.filter((p) => (f.involvement === "all" ? true : f.involvement === "reviewing" ? p.review_requested : authored(p, viewer))).filter((p) => passes(p, f, q) && matchesText(p, q.text));
  let out: Group<Pr>[];
  if (f.involvement !== "all") {
    out = [{ key: "others", label: "", items }];
  } else {
    const mine: Pr[] = [];
    const asked: Pr[] = [];
    const others: Pr[] = [];
    for (const p of items) (authored(p, viewer) ? mine : p.review_requested ? asked : others).push(p);
    out = [
      { key: "authored", label: "Authored", items: mine },
      { key: "reviewRequested", label: "Review requested", items: asked },
      { key: "others", label: "Others", items: others },
    ];
  }
  out = out.filter((g) => g.items.length > 0);
  for (const g of out) {
    g.items.sort((a, b) => b.updated - a.updated);
    sortGroup(g.items, g.key, sort, q.text, f.involvement);
  }
  return out;
}

export function authors(data: PrFetched): [string, number][] {
  const m = new Map<string, number>();
  for (const p of data.items) m.set(p.author, (m.get(p.author) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || cmp(a[0].toLowerCase(), b[0].toLowerCase()));
}

export function labels(data: PrFetched): [string, Rgb, number][] {
  const m = new Map<string, [Rgb, number]>();
  for (const p of data.items) {
    for (const [n, c] of p.labels) {
      const hit = m.get(n);
      if (hit) hit[1] += 1;
      else m.set(n, [c, 1]);
    }
  }
  return [...m].map(([n, [c, k]]): [string, Rgb, number] => [n, c, k]).sort((a, b) => b[2] - a[2] || cmp(a[0], b[0]));
}

const REMOTES = ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/", "ssh://git@github.com:22/", "git://github.com/"];

export function githubRepo(remote: string): string | undefined {
  const r = remote.trim();
  let rest: string | undefined;
  const prefix = REMOTES.find((p) => r.startsWith(p));
  if (prefix !== undefined) {
    rest = r.slice(prefix.length);
  } else if (r.startsWith("https://")) {
    const after = r.slice("https://".length);
    const sep = after.indexOf("@");
    const host = sep < 0 ? undefined : after.slice(sep + 1);
    if (host?.startsWith("github.com/")) rest = host.slice("github.com/".length);
  }
  if (rest === undefined) return undefined;
  const [o, n0] = rest.replace(/\/+$/, "").split("/");
  if (o === undefined || n0 === undefined) return undefined;
  const n = n0.endsWith(".git") ? n0.slice(0, -4) : n0;
  return o !== "" && n !== "" ? `${o}/${n}` : undefined;
}

export function makePrsPort(run: GhRun): PrsPort {
  return { fetch: (state, repos) => fetch(state, repos, run), groups, authors, labels, sortLabel };
}

export const prsPort: PrsPort = makePrsPort(ghRun);
