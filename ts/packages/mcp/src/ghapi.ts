export type Rgb = [number, number, number];
export type Json = unknown;

export interface Reply {
  status: number;
  body: Json;
}

export const ok = (body: Json): Reply => ({ status: 200, body });
export const err = (status: number, msg: string): Reply => ({ status, body: { error: msg } });

export interface Call {
  method: string;
  path: string[];
  query: [string, string][];
  body: Json;
  token: string;
  device: string;
  global: boolean;
}

export type PrState = "open" | "closed" | "merged";
export type Review = "approved" | "changes" | "required" | "none";
export type Checks = "passing" | "failing" | "pending" | "none";
export type PrSort = "ready" | "blocked" | "updated" | "newest" | "oldest" | "largest" | "smallest";
export type IssueSort = "updated" | "stale" | "newest" | "oldest" | "most_commented" | "least_commented";
export type IssueState = "open" | "done" | "not_planned";

export interface Pr {
  number: number;
  title: string;
  url: string;
  repo: string;
  state: PrState;
  draft: boolean;
  adds: number;
  dels: number;
  created: number;
  updated: number;
  branch: string;
  head: string;
  review: Review;
  checks: Checks;
  conflicting: boolean;
  author: string;
  avatar: string;
  labels: [string, Rgb][];
  review_requested: boolean;
}

export interface PrFetched {
  viewer: string;
  items: Pr[];
}

export interface PrFilters {
  state: "all" | "open" | "closed" | "merged";
  involvement: "all" | "reviewing" | "authored";
  author?: string;
  labels: string[];
  draft?: boolean;
  review?: Review;
  checks?: Checks;
  project?: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  repo: string;
  state: IssueState;
  created: number;
  updated: number;
  comments: number;
  author: string;
  avatar: string;
  labels: [string, Rgb][];
  assignees: string[];
  milestone: string | null;
  mentions: string[];
  accounts: string[];
  linked_pr: boolean;
  author_trusted: boolean;
}

export interface Source {
  pc: string;
  name: string;
  login: string;
  projects: string[];
  error?: string;
}

export interface IssueFetched {
  viewer: string;
  items: Issue[];
  sources: Source[];
}

export type Assignee = { kind: "nobody" } | { kind: "login"; login: string };

export interface IssueFilters {
  account?: string;
  state: "all" | "open" | "closed";
  involvement: "all" | "assigned" | "authored" | "mentioned";
  author?: string;
  assignee?: Assignee;
  labels: string[];
  /** null: issues without a milestone; undefined: any. */
  milestone?: string | null;
  project?: string;
}

export interface Note {
  author: string;
  at: number;
  body: string;
}

export interface PrFull {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  author: string;
  created: number;
  updated: number;
  base: string;
  head: string;
  adds: number;
  dels: number;
  files: number;
  labels: [string, Rgb][];
  reviewers: [string, string][];
  body: string;
  checks: { name: string; state: "pass" | "fail" | "pending" | "skipped"; url: string }[];
  comments: Note[];
  timeline: [number, string, PrEvent][];
  conflicting: boolean;
}

export type PrEvent =
  | { kind: "opened" }
  | { kind: "commit"; sha: string; headline: string }
  | { kind: "review"; state: string; body: string }
  | { kind: "comment"; body: string };

export interface IssueFull {
  number: number;
  title: string;
  url: string;
  state: IssueState;
  author: string;
  created: number;
  updated: number;
  labels: [string, Rgb][];
  assignees: string[];
  milestone: string | null;
  body: string;
  comments: Note[];
}

export type DiffLine =
  | { t: "file"; path: string; adds: number; dels: number }
  | { t: "hunk" | "add" | "del" | "ctx"; text: string };

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

export interface Dest {
  readonly [key: string]: unknown;
}

export interface Peer {
  id: string;
  name: string;
  online: boolean;
  dest: Dest;
}

export interface PrsPort {
  fetch(state: PrFilters["state"], repos: string[]): Promise<PrFetched>;
  groups(d: PrFetched, f: PrFilters, search: string, sort: PrSort): Group<Pr>[];
  authors(d: PrFetched): [string, number][];
  labels(d: PrFetched): [string, Rgb, number][];
  sortLabel(sort: PrSort): string;
}

export interface IssuesPort {
  fetch(state: IssueFilters["state"], repos: string[]): Promise<IssueFetched>;
  groups(d: IssueFetched, f: IssueFilters, search: string, sort: IssueSort): Group<Issue>[];
  mine(d: IssueFetched, f: IssueFilters): string[];
  accounts(d: IssueFetched): [login: string, pcs: string, n: number][];
  notes(d: IssueFetched): string[];
  authors(d: IssueFetched): [string, number][];
  assignees(d: IssueFetched): [string, number][];
  milestones(d: IssueFetched): [string, number][];
  labels(d: IssueFetched): [string, Rgb, number][];
  otherProjects(d: IssueFetched, local: string[]): [name: string, repo: string, pcs: string][];
  owner(d: IssueFetched, i: Issue, prefer: string | undefined, project: boolean): Source | undefined;
  merge(parts: [Source, IssueFetched | undefined][]): IssueFetched;
  shortError(e: string): string;
  sortLabel(sort: IssueSort): string;
}

export interface DetailsPort {
  fetchPr(url: string): Promise<PrFull>;
  fetchIssue(url: string): Promise<IssueFull>;
  fetchIssueRaw(url: string): Promise<Json>;
  fetchIssueOn(dest: Dest, url: string): Promise<IssueFull>;
  setIssueOpenOn(dest: Dest, url: string, open: boolean): Promise<void>;
  gh(args: string[]): Promise<string>;
  parseDiff(diff: string): DiffLine[];
}

export interface MeshPort {
  enabled(): boolean;
  me(): { name: string };
  peers(): Peer[];
  peer(id: string): Peer | undefined;
  http(dest: Dest, method: string, path: string, body: Json, waitMs: number): Promise<[status: number, body: Json]>;
  forward(peer: Peer, req: { method: string; path: string[]; body: Json; sender: [name: string, device: string]; ctx: Json }): Promise<Reply>;
  mapNew(home: string, reply: Reply, global: boolean): Reply | Promise<Reply>;
}

export interface HostPort {
  repos(): Promise<string[]>;
  projects(global: boolean): Promise<Json[]>;
  projectOf(repo: string): number | undefined;
  agentLabel(): string;
  ctx(): Json;
  agentThread(global: boolean, start: { kind: "merge"; project: number; pr: Pr; extra: string } | { kind: "fix"; project: number; issue: Issue; extra: string }): Promise<Reply>;
}

export interface GhDeps {
  prs: PrsPort;
  issues: IssuesPort;
  details: DetailsPort;
  mesh: MeshPort;
  host: HostPort;
  blocks(md: string): Json;
  deviceId(token: string): string;
  clock?: () => number;
}

export const FRESH_MS = 60_000;
export const PEER_WAIT_MS = 35_000;
export const MAX_DIFF = 5000;
export const NOT_PROJECT = "Add this repo as a Harbor project to let an agent work on it";

export const PR_SORTS: PrSort[] = ["ready", "blocked", "updated", "newest", "oldest", "largest", "smallest"];
export const ISSUE_SORTS: IssueSort[] = ["updated", "stale", "newest", "oldest", "most_commented", "least_commented"];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function param(call: Call, k: string): string | undefined {
  const hit = call.query.find(([q]) => q === k);
  return hit && hit[1].trim() !== "" ? hit[1] : undefined;
}

export function params(call: Call, k: string): string[] {
  return call.query.filter(([q, v]) => q === k && v.trim() !== "").map(([, v]) => v.trim());
}

export function hex(c: Rgb): string {
  return c.map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexRgb(c: string): Rgb {
  const h = (i: number): number => {
    const x = c.slice(i, i + 2);
    return x.length === 2 && /^[0-9a-fA-F]{2}$/.test(x) ? Number.parseInt(x, 16) : 128;
  };
  return [h(0), h(2), h(4)];
}

const labelsJson = (l: [string, Rgb][]): Json[] => l.map(([name, c]) => ({ name, color: hex(c) }));

/** A pull request or issue page on GitHub, as `gh` may be handed it: nothing but `https://github.com/<owner>/<repo>/<kind>/<number>`. */
export function ghUrl(s: string, kind: string): string | undefined {
  const t = s.trim();
  if (!t.startsWith("https://github.com/")) return undefined;
  const parts = t.slice("https://github.com/".length).split("/");
  const name = (p: string): boolean => p !== "" && !p.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(p);
  const [owner, repo, k, n] = parts;
  const good = parts.length === 4 && name(owner ?? "") && name(repo ?? "") && k === kind && /^[0-9]+$/.test(n ?? "");
  return good ? t : undefined;
}

export function repoOf(url: string): string {
  const rest = url.startsWith("https://github.com/") ? url.slice("https://github.com/".length) : url;
  return rest.split("/").slice(0, 2).join("/");
}

export function prFilters(call: Call): { filters: PrFilters; sort: PrSort; search: string } {
  const p = (k: string): string | undefined => param(call, k);
  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => allowed.find((a) => a === p(k));
  const f: PrFilters = {
    state: pick("state", ["all", "closed", "merged"]) ?? "open",
    involvement: pick("involvement", ["reviewing", "authored"]) ?? "all",
    labels: params(call, "label"),
  };
  const author = p("author");
  if (author !== undefined) f.author = author;
  const draft = p("draft");
  if (draft === "only") f.draft = true;
  else if (draft === "hide") f.draft = false;
  const review = pick("review", ["approved", "changes", "required", "none"]);
  if (review !== undefined) f.review = review;
  const checks = pick("checks", ["passing", "failing", "pending"]);
  if (checks !== undefined) f.checks = checks;
  const project = p("project");
  if (project !== undefined) f.project = project;
  return { filters: f, sort: PR_SORTS.find((s) => s === p("sort")) ?? "ready", search: p("q") ?? "" };
}

export function prJson(p: Pr): Json {
  return {
    number: p.number, title: p.title, url: p.url, repo: p.repo, state: p.state, draft: p.draft,
    adds: p.adds, dels: p.dels, created_ms: p.created * 1000, updated_ms: p.updated * 1000, branch: p.branch,
    review: p.review, checks: p.checks, conflicting: p.conflicting, author: p.author, labels: labelsJson(p.labels), review_requested: p.review_requested,
  };
}

export function prsPage(prs: PrsPort, d: PrFetched, f: PrFilters, search: string, sort: PrSort): Obj {
  return {
    viewer: d.viewer,
    total: d.items.length,
    groups: prs.groups(d, f, search, sort).map((g) => ({ key: g.key, label: g.label, items: g.items.map(prJson) })),
    authors: prs.authors(d).map(([login, n]) => ({ login, n })),
    labels: prs.labels(d).map(([name, c, n]) => ({ name, color: hex(c), n })),
    sorts: PR_SORTS.map((id) => ({ id, label: prs.sortLabel(id) })),
  };
}

function prFullJson(blocks: GhDeps["blocks"], f: PrFull): Json {
  const timeline = f.timeline.map(([at, who, e]) => {
    const v: Obj = { at_ms: at * 1000, who };
    v.kind = e.kind;
    if (e.kind === "commit") Object.assign(v, { sha: e.sha, headline: e.headline });
    else if (e.kind === "review") Object.assign(v, { state: e.state, body: e.body, blocks: blocks(e.body) });
    else if (e.kind === "comment") Object.assign(v, { body: e.body, blocks: blocks(e.body) });
    return v;
  });
  return {
    number: f.number, title: f.title, url: f.url, repo: repoOf(f.url), state: f.state.toLowerCase(), draft: f.draft,
    author: f.author, created_ms: f.created * 1000, updated_ms: f.updated * 1000, base: f.base, head: f.head,
    adds: f.adds, dels: f.dels, files: f.files, labels: labelsJson(f.labels), conflicting: f.conflicting,
    reviewers: f.reviewers.map(([login, state]) => ({ login, state })),
    body: f.body, blocks: blocks(f.body), checks: f.checks.map((c) => ({ name: c.name, state: c.state, url: c.url })),
    comments: f.comments.map((c) => ({ author: c.author, at_ms: c.at * 1000, body: c.body, blocks: blocks(c.body) })),
    timeline,
  };
}

export function diffJson(parseDiff: DetailsPort["parseDiff"], diff: string): Json {
  const lines = parseDiff(diff);
  const shown = lines.slice(0, MAX_DIFF).map((l) => (l.t === "file" ? { t: "file", text: l.path, adds: l.adds, dels: l.dels } : { t: l.t, text: l.text }));
  return { lines: shown, clipped: lines.length > MAX_DIFF };
}

export function issueFilters(call: Call): { filters: IssueFilters; sort: IssueSort; search: string } {
  const p = (k: string): string | undefined => param(call, k);
  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => allowed.find((a) => a === p(k));
  const f: IssueFilters = {
    state: pick("state", ["all", "closed"]) ?? "open",
    involvement: pick("involvement", ["assigned", "authored", "mentioned"]) ?? "all",
    labels: params(call, "label"),
  };
  const set = <K extends "account" | "author" | "project">(k: K): void => {
    const v = p(k);
    if (v !== undefined) f[k] = v;
  };
  set("account");
  set("author");
  set("project");
  const assignee = p("assignee");
  if (assignee !== undefined) f.assignee = assignee === "none" ? { kind: "nobody" } : { kind: "login", login: assignee };
  const milestone = p("milestone");
  if (milestone !== undefined) f.milestone = milestone === "none" ? null : milestone;
  return { filters: f, sort: ISSUE_SORTS.find((s) => s === p("sort")) ?? "updated", search: p("q") ?? "" };
}

export function issueJson(i: Issue, me: string[]): Obj {
  const mentioned = i.mentions.some((m) => me.some((x) => x.toLowerCase() === m.toLowerCase()));
  return {
    number: i.number, title: i.title, url: i.url, repo: i.repo, state: i.state,
    created_ms: i.created * 1000, updated_ms: i.updated * 1000, comments: i.comments, author: i.author,
    labels: labelsJson(i.labels), assignees: i.assignees, milestone: i.milestone, mentioned, linked_pr: i.linked_pr,
    accounts: i.accounts,
  };
}

export function issueMeshJson(i: Issue): Json {
  return { ...issueJson(i, i.mentions), avatar: i.avatar, trusted: i.author_trusted };
}

export function issueOfJson(v: Json, login: string): Issue | undefined {
  const o = obj(v);
  const s = (k: string): string => str(o[k]) ?? "";
  const strs = (k: string): string[] => arr(o[k]).flatMap((x) => str(x) ?? []);
  const me = login === "" ? [] : [login];
  const number = o.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) return undefined;
  const url = ghUrl(str(o.url) ?? "", "issues");
  if (url === undefined) return undefined;
  const ms = (k: string): number => (typeof o[k] === "number" ? Math.trunc((o[k] as number) / 1000) : 0);
  const state = o.state === "done" ? "done" : o.state === "not_planned" ? "not_planned" : "open";
  const comments = o.comments;
  return {
    number, title: s("title"), url, repo: s("repo"), state,
    created: ms("created_ms"), updated: ms("updated_ms"),
    comments: typeof comments === "number" && Number.isInteger(comments) && comments >= 0 ? comments : 0,
    author: s("author"), avatar: s("avatar"),
    labels: arr(o.labels).flatMap((l): [string, Rgb][] => {
      const name = str(obj(l).name);
      return name === undefined ? [] : [[name, hexRgb(str(obj(l).color) ?? "")]];
    }),
    assignees: strs("assignees"),
    milestone: str(o.milestone) ?? null,
    mentions: o.mentioned === true ? [...me] : [],
    accounts: me,
    linked_pr: o.linked_pr === true,
    author_trusted: o.trusted === true,
  };
}

export function issueFull(blocks: GhDeps["blocks"], f: IssueFull): Json {
  return {
    number: f.number, title: f.title, url: f.url, repo: repoOf(f.url), state: f.state,
    author: f.author, created_ms: f.created * 1000, updated_ms: f.updated * 1000, labels: labelsJson(f.labels),
    assignees: f.assignees, milestone: f.milestone, body: f.body, blocks: blocks(f.body),
    comments: f.comments.map((c) => ({ author: c.author, at_ms: c.at * 1000, body: c.body, blocks: blocks(c.body) })),
  };
}

export function issuesPage(issues: IssuesPort, d: IssueFetched, f: IssueFilters, search: string, sort: IssueSort): Obj {
  const me = issues.mine(d, f);
  const tally = (v: [string, number][]): Json[] => v.map(([name, n]) => ({ name, n }));
  return {
    viewer: f.account ?? d.viewer,
    accounts: issues.accounts(d).map(([login, pc, n]) => ({ login, pc, n })),
    notes: issues.notes(d),
    total: d.items.length,
    groups: issues.groups(d, f, search, sort).map((g) => ({ key: g.key, label: g.label, items: g.items.map((i) => withFixOn(issues, issueJson(i, me), d, i, f)) })),
    authors: issues.authors(d).map(([login, n]) => ({ login, n })),
    assignees: tally(issues.assignees(d)),
    milestones: tally(issues.milestones(d)),
    labels: issues.labels(d).map(([name, c, n]) => ({ name, color: hex(c), n })),
    sorts: ISSUE_SORTS.map((id) => ({ id, label: issues.sortLabel(id) })),
  };
}

function withFixOn(issues: IssuesPort, v: Obj, d: IssueFetched, i: Issue, f: IssueFilters): Obj {
  const here = d.sources.find((s) => s.pc === "")?.projects.some((r) => r.toLowerCase() === i.repo.toLowerCase()) ?? false;
  const owner = issues.owner(d, i, f.account, true);
  if (owner && !here && owner.pc !== "") v.fix_on = owner.name;
  return v;
}

export function allProjects(issues: Pick<IssuesPort, "otherProjects">, local: Json[], d: IssueFetched): Json[] {
  const repos: string[] = [];
  const list = local.map((p) => {
    const o = { ...obj(p) };
    const repo = str(o.repo) ?? "";
    const pcs = d.sources.filter((s) => s.projects.some((r) => r.toLowerCase() === repo.toLowerCase())).map((s) => s.name);
    if (pcs.length > 0) o.pc = pcs.join(", ");
    repos.push(repo);
    return o;
  });
  for (const [name, repo, pcs] of issues.otherProjects(d, repos)) list.push(pcs === "" ? { name, repo } : { name, repo, pc: pcs });
  return list;
}

type Res<T> = { ok: true; value: T } | { ok: false; error: string };

async function peerPart(deps: GhDeps, p: Peer, state: IssueFilters["state"], refresh: boolean): Promise<[Source, IssueFetched | undefined]> {
  const src: Source = { pc: p.id, name: p.name, login: "", projects: [] };
  const fail = (e: string): [Source, undefined] => [{ ...src, error: e }, undefined];
  if (!p.online) return fail("unreachable");
  const path = `/mesh/v1/issues?state=${state}${refresh ? "&refresh=1" : ""}`;
  let status: number;
  let body: Json;
  try {
    [status, body] = await deps.mesh.http(p.dest, "GET", path, undefined, PEER_WAIT_MS);
  } catch {
    return fail("unreachable");
  }
  const v = obj(body);
  if (status === 200) {
    const login = str(v.login) ?? "";
    const e = str(v.error);
    if (e !== undefined) return [{ ...src, login, error: deps.issues.shortError(e) }, undefined];
    const items = arr(v.items).flatMap((i) => issueOfJson(i, login) ?? []);
    const projects = arr(v.projects).flatMap((r) => str(r) ?? []);
    return [{ ...src, login, projects }, { viewer: login, items, sources: [] }];
  }
  if (status === 404) return fail("runs an older Harbor");
  return fail(deps.issues.shortError(str(v.error) ?? "didn't answer"));
}

export async function fetchMerged(
  deps: GhDeps,
  state: IssueFilters["state"],
  refresh: boolean,
  me: string,
  peers: Peer[],
  local: () => Promise<{ result: Res<IssueFetched>; projects: string[] }>,
): Promise<IssueFetched> {
  const asks = peers.map((p) => peerPart(deps, p, state, refresh));
  const { result, projects } = await local();
  const here: Source = { pc: "", name: me, login: "", projects };
  let localError: string | undefined;
  const parts: [Source, IssueFetched | undefined][] = [];
  if (result.ok) {
    parts.push([{ ...here, login: result.value.viewer }, result.value]);
  } else {
    localError = result.error;
    parts.push([{ ...here, error: deps.issues.shortError(result.error) }, undefined]);
  }
  parts.push(...(await Promise.all(asks)));
  if (localError !== undefined && parts.every((p) => p[1] === undefined)) throw new Error(localError);
  return deps.issues.merge(parts);
}

interface Entry<S, T> {
  state: S;
  at: number;
  data: T;
}

export class Lists<S, T> {
  private list: Entry<S, T>[] = [];

  constructor(private readonly clock: () => number) {}

  get(state: S, refresh: boolean): T | undefined {
    return this.list.find((x) => x.state === state && !refresh && this.clock() - x.at < FRESH_MS)?.data;
  }

  keep(state: S, data: T): void {
    this.list = this.list.filter((x) => x.state !== state);
    this.list.push({ state, at: this.clock(), data });
  }

  /** After a change on GitHub the lists are fetched anew, but stay known: Merge with… and Fix with… find their item in them. */
  expire(): void {
    for (const x of this.list) x.at = this.clock() - FRESH_MS;
  }

  find<R>(f: (data: T) => R | undefined): R | undefined {
    for (const x of this.list) {
      const r = f(x.data);
      if (r !== undefined) return r;
    }
    return undefined;
  }
}

export class GhApi {
  readonly prs: Lists<PrFilters["state"], PrFetched>;
  readonly issues: Lists<IssueFilters["state"], IssueFetched>;
  readonly ownIssues: Lists<IssueFilters["state"], IssueFetched>;

  constructor(private readonly deps: GhDeps) {
    const clock = deps.clock ?? Date.now;
    this.prs = new Lists(clock);
    this.issues = new Lists(clock);
    this.ownIssues = new Lists(clock);
  }

  async handle(call: Call): Promise<Reply> {
    try {
      return await this.route(call);
    } catch (e) {
      return err(502, text(e));
    }
  }

  private async route(call: Call): Promise<Reply> {
    const key = `${call.method} /${call.path.join("/")}`;
    const urlOf = (kind: string): string | undefined => ghUrl(param(call, "url") ?? str(obj(call.body).url) ?? "", kind);
    const bad = (what: string): Reply => err(400, `url must be a GitHub ${what}`);
    const refresh = param(call, "refresh") === "1";
    const { details, host } = this.deps;
    switch (key) {
      case "GET /v1/prs":
        return this.prList(call, refresh);
      case "GET /v1/issues":
        return this.issueList(call, refresh);
      case "GET /mesh/v1/issues": {
        const state = issueFilters(call).filters.state;
        const own = await this.ownList(state, refresh);
        return own.result.ok
          ? ok({ login: own.result.value.viewer, projects: own.projects, items: own.result.value.items.map(issueMeshJson) })
          : ok({ login: "", projects: own.projects, error: own.result.error });
      }
      case "GET /mesh/v1/issues/view": {
        const url = urlOf("issues");
        return url === undefined ? bad("issue") : ok(await details.fetchIssueRaw(url));
      }
      case "POST /mesh/v1/issues/close":
      case "POST /mesh/v1/issues/reopen": {
        const url = urlOf("issues");
        if (url === undefined) return bad("issue");
        await details.gh(["issue", call.path[3] ?? "", url]);
        this.issues.expire();
        this.ownIssues.expire();
        return ok({ ok: true });
      }
      case "GET /v1/prs/view": {
        const url = urlOf("pull");
        if (url === undefined) return bad("pull request");
        return ok({ ...obj(prFullJson(this.deps.blocks, await details.fetchPr(url))), agent: host.agentLabel() });
      }
      case "GET /v1/prs/diff": {
        const url = urlOf("pull");
        return url === undefined ? bad("pull request") : ok(diffJson(details.parseDiff, await details.gh(["pr", "diff", url])));
      }
      case "GET /v1/issues/view": {
        const url = urlOf("issues");
        if (url === undefined) return bad("issue");
        const via = this.issuePeer(url, param(call, "account"), false);
        const f = via ? await details.fetchIssueOn(via.dest, url) : await details.fetchIssue(url);
        return ok({ ...obj(issueFull(this.deps.blocks, f)), agent: host.agentLabel() });
      }
      case "POST /v1/prs/ready": {
        const url = urlOf("pull");
        if (url === undefined) return bad("pull request");
        await details.gh(["pr", "ready", url]);
        this.prs.expire();
        return ok({ ok: true });
      }
      case "POST /v1/issues/close":
      case "POST /v1/issues/reopen": {
        const url = urlOf("issues");
        if (url === undefined) return bad("issue");
        const action = call.path[2] ?? "";
        const via = this.issuePeer(url, param(call, "account") ?? str(obj(call.body).account), false);
        if (via) await details.setIssueOpenOn(via.dest, url, action === "reopen");
        else await details.gh(["issue", action, url]);
        this.issues.expire();
        this.ownIssues.expire();
        return ok({ ok: true });
      }
      case "POST /v1/prs/merge":
        return this.merge(call, urlOf("pull"));
      case "POST /v1/issues/fix":
        return this.fix(call, urlOf("issues"));
      default:
        return err(404, "unknown call");
    }
  }

  private async prList(call: Call, refresh: boolean): Promise<Reply> {
    const { filters: f, sort, search } = prFilters(call);
    let d = this.prs.get(f.state, refresh);
    const repos = await this.deps.host.repos();
    if (d === undefined) {
      d = await this.deps.prs.fetch(f.state, repos);
      this.prs.keep(f.state, d);
    }
    const v = prsPage(this.deps.prs, d, f, search, sort);
    v.projects = await this.deps.host.projects(call.global);
    return ok(v);
  }

  private async issueList(call: Call, refresh: boolean): Promise<Reply> {
    const { filters: f, sort, search } = issueFilters(call);
    let d = this.issues.get(f.state, refresh);
    if (d === undefined) {
      const mesh = this.deps.mesh;
      const peers = mesh.enabled() ? mesh.peers() : [];
      const name = mesh.me().name;
      d = await fetchMerged(this.deps, f.state, refresh, name === "" ? "This PC" : name, peers, () => this.ownList(f.state, refresh));
      this.issues.keep(f.state, d);
    }
    const v = issuesPage(this.deps.issues, d, f, search, sort);
    v.projects = allProjects(this.deps.issues, await this.deps.host.projects(call.global), d);
    return ok(v);
  }

  private async ownList(state: IssueFilters["state"], refresh: boolean): Promise<{ result: Res<IssueFetched>; projects: string[] }> {
    const projects = await this.deps.host.repos();
    const hit = this.ownIssues.get(state, refresh);
    if (hit) return { result: { ok: true, value: structuredClone(hit) }, projects };
    try {
      const value = await this.deps.issues.fetch(state, projects);
      this.ownIssues.keep(state, structuredClone(value));
      return { result: { ok: true, value }, projects };
    } catch (e) {
      return { result: { ok: false, error: text(e) }, projects };
    }
  }

  private issuePeer(url: string, prefer: string | undefined, project: boolean): Peer | undefined {
    const found = this.issues.find((d) => {
      const i = d.items.find((x) => x.url === url);
      return i ? { d, i } : undefined;
    });
    if (!found) return undefined;
    const pc = this.deps.issues.owner(found.d, found.i, prefer, project)?.pc ?? "";
    const peer = pc === "" ? undefined : this.deps.mesh.peer(pc);
    return peer?.online ? peer : undefined;
  }

  private async merge(call: Call, url: string | undefined): Promise<Reply> {
    if (url === undefined) return err(400, "url must be a GitHub pull request");
    const pr = this.prs.find((d) => d.items.find((p) => p.url === url));
    if (!pr) return err(409, "refresh the list first");
    const project = this.deps.host.projectOf(pr.repo);
    if (project === undefined) return err(409, NOT_PROJECT);
    return this.deps.host.agentThread(call.global, { kind: "merge", project, pr, extra: str(obj(call.body).extra) ?? "" });
  }

  private async fix(call: Call, url: string | undefined): Promise<Reply> {
    if (url === undefined) return err(400, "url must be a GitHub issue");
    const issue = this.issues.find((d) => d.items.find((i) => i.url === url)) ?? this.ownIssues.find((d) => d.items.find((i) => i.url === url));
    if (!issue) return err(409, "refresh the list first");
    const extra = str(obj(call.body).extra) ?? "";
    const project = this.deps.host.projectOf(issue.repo);
    if (project !== undefined) return this.deps.host.agentThread(call.global, { kind: "fix", project, issue, extra });
    const peer = this.issuePeer(url, str(obj(call.body).account), true);
    if (!peer) return err(409, NOT_PROJECT);
    const { mesh, host } = this.deps;
    const sender: [string, string] = [`${call.device === "" ? "Phone" : call.device} via ${mesh.me().name}`, this.deps.deviceId(call.token)];
    const reply = await mesh.forward(peer, { method: "POST", path: ["v1", "issues", "fix"], body: { url, extra }, sender, ctx: host.ctx() });
    return await mesh.mapNew(peer.id, reply, call.global);
  }
}
