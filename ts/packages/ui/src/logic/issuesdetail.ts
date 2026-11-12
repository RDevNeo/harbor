import { type ghapi, issuedetail } from "@harbor/mcp";
import { ago, type Chip, type Detail, errorText, hex, type Issue, letterOf, type IssuesPage, NO_PIXELS, NOT_PROJECT, type Pixels, STATE_TIPS } from "./issues.ts";

export interface Person {
  login: string;
  letter: string;
  avatar: Pixels;
  has_avatar: boolean;
}

export interface NoteView {
  author: string;
  letter: string;
  what: string;
  body: string;
  avatar: Pixels;
  has_avatar: boolean;
}

export interface AgentRow {
  id: string;
  label: string;
  current: boolean;
}

/** The panel body for one issue (issuedetail.rs `issue_detail` and `issue_summary`), as Slint draws it. */
export interface DetailView {
  repo_line: string;
  title: string;
  state: ghapi.IssueState;
  state_text: string;
  author: Person;
  opened: string;
  updated: string;
  error: string;
  loading: boolean;
  has_full: boolean;
  assignees: Person[];
  labels: Chip[];
  milestone: string;
  has_milestone: boolean;
  body: string;
  desc_open: boolean;
  comments_open: boolean;
  comments_title: string;
  comments: NoteView[];
  busy: boolean;
  is_open: boolean;
  act_tip: string;
  fix_label: string;
  fix_enabled: boolean;
  fix_tip: string;
  agents: AgentRow[];
}

export type DetailAct = "open-web" | "copy-link" | "copy-number" | "refresh" | "close" | "reopen" | "fix" | "fix-ask" | "toggle-desc" | "toggle-comments" | `agent:${string}`;

const DETAIL_ACTS = ["open-web", "copy-link", "copy-number", "refresh", "close", "reopen", "fix", "fix-ask", "toggle-desc", "toggle-comments"] as const satisfies readonly DetailAct[];

/** The panel's action named by the view, or null for a name it doesn't have. */
export function detailActOf(s: string): DetailAct | null {
  if (s.startsWith("agent:")) return `agent:${s.slice(6)}`;
  return DETAIL_ACTS.find((a) => a === s) ?? null;
}

const person = (page: IssuesPage, login: string): Person => {
  const px = page.avatars.get(login) ?? null;
  return { login, letter: letterOf(login), avatar: px ?? NO_PIXELS, has_avatar: px !== null };
};

const avatarUrl = (login: string): string => `https://github.com/${login}.png?size=40`;

/** Starts the fetch of an issue shown for the first time (and keeps `via` current). */
export function ensureDetail(page: IssuesPage, url: string): Detail {
  const d = page.detailOf(url);
  const listed = page.listed(url);
  d.via = (listed === undefined ? undefined : page.host.peer(listed, false))?.dest ?? null;
  if (d.full === null && !d.loading) loadDetail(page, url);
  return d;
}

export function loadDetail(page: IssuesPage, url: string): void {
  const d = page.detailOf(url);
  d.loading = true;
  const via = d.via;
  const run = via === null ? page.host.details.fetchIssue(url) : page.host.details.fetchIssueOn(via, url);
  run.then(
    (f) => {
      d.loading = false;
      d.full = { ok: f };
      page.fetchAvatars([...f.comments.map((c) => c.author), ...f.assignees].map((p) => [p, avatarUrl(p)]));
      page.changed();
    },
    (e: unknown) => {
      d.loading = false;
      // A failed refresh keeps what it had.
      if (d.full === null || !("ok" in d.full)) d.full = { err: errorText(e) };
      page.changed();
    },
  );
  page.changed();
}

function setOpen(page: IssuesPage, url: string, open: boolean): void {
  const d = page.detailOf(url);
  d.busy = true;
  const run = d.via === null ? page.host.details.gh(["issue", open ? "reopen" : "close", url]).then(() => undefined) : page.host.details.setIssueOpenOn(d.via, url, open);
  run.then(
    () => {
      d.busy = false;
      d.error = null;
      loadDetail(page, url);
      page.load();
    },
    (e: unknown) => {
      d.busy = false;
      d.error = errorText(e);
      loadDetail(page, url);
      page.load();
    },
  );
  page.changed();
}

export function detailView(page: IssuesPage, url: string): DetailView {
  const d = ensureDetail(page, url);
  const listed = page.listed(url);
  const full = d.full !== null && "ok" in d.full ? d.full.ok : undefined;
  const err = d.full !== null && "err" in d.full ? d.full.err : (d.error ?? "");
  const now = page.host.now();
  const number = full?.number ?? listed?.number ?? 0;
  const repo = listed?.repo ?? issuedetail.repoOf(url);
  const author = full?.author ?? listed?.author ?? "";
  const updated = full?.updated ?? listed?.updated ?? 0;
  const state = full?.state ?? listed?.state ?? "open";
  const projects = page.host.projects();
  const project = projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase())?.id;
  const elsewhere = project === undefined && listed !== undefined ? page.host.peer(listed, true)?.name : undefined;
  const fixTip =
    project !== undefined
      ? "Start a thread where an agent fixes it on a branch and opens a PR"
      : elsewhere !== undefined
        ? `Start a thread on ${elsewhere}, which has this project, where an agent fixes it and opens a PR`
        : NOT_PROJECT;
  const label = page.host.agentLabel();
  return {
    repo_line: `${repo.toLowerCase()} #${number}`,
    title: full?.title ?? listed?.title ?? "",
    state,
    state_text: STATE_TIPS[state],
    author: person(page, author),
    opened: full !== undefined && full.created > 0 ? `opened ${ago(full.created, now)}` : "",
    updated: updated > 0 ? `· updated ${ago(updated, now)}` : "",
    error: err,
    loading: d.loading,
    has_full: full !== undefined,
    assignees: (full?.assignees ?? []).map((a) => person(page, a)),
    labels: (full?.labels ?? []).map(([name, c]) => ({ name, color: hex(c) })),
    milestone: full?.milestone ?? "",
    has_milestone: full?.milestone != null,
    body: full?.body ?? "",
    desc_open: d.descOpen,
    comments_open: d.commentsOpen,
    comments_title: `Comments (${full?.comments.length ?? 0})`,
    comments: (full?.comments ?? []).map((c) => {
      const p = person(page, c.author);
      return { author: c.author, letter: letterOf(c.author), what: `commented · ${ago(c.at, now)}`, body: c.body, avatar: p.avatar, has_avatar: p.has_avatar };
    }),
    busy: d.busy,
    is_open: state === "open",
    act_tip: state === "open" ? "Close as completed (gh issue close)" : "Reopen the issue (gh issue reopen)",
    fix_label: `Fix with ${label}`,
    fix_enabled: project !== undefined || elsewhere !== undefined,
    fix_tip: fixTip,
    agents: page.host.agents(),
  };
}

/** The issue as the list would have it, for Fix on one that only the panel has. */
function fromFull(f: ghapi.IssueFull, url: string, repo: string): Issue {
  return {
    number: f.number,
    title: f.title,
    url,
    repo,
    state: f.state,
    created: f.created,
    updated: f.updated,
    comments: f.comments.length,
    author: f.author,
    avatar: "",
    labels: f.labels,
    assignees: f.assignees,
    milestone: f.milestone,
    mentions: [],
    accounts: [],
    linked_pr: false,
    // Started by the user here, not unattended.
    author_trusted: false,
  };
}

export function detailAct(page: IssuesPage, url: string, act: DetailAct): void {
  const d = page.detailOf(url);
  const full = d.full !== null && "ok" in d.full ? d.full.ok : undefined;
  const listed = page.listed(url);
  if (act.startsWith("agent:")) {
    page.host.pickAgent(act.slice("agent:".length));
    return page.changed();
  }
  switch (act) {
    case "open-web":
      return page.host.openUrl(url);
    case "copy-link":
      return page.host.copy(full?.url ?? url);
    case "copy-number":
      return page.host.copy(String(full?.number ?? listed?.number ?? 0));
    case "refresh":
      return loadDetail(page, url);
    case "close":
      return setOpen(page, url, false);
    case "reopen":
      return setOpen(page, url, true);
    case "toggle-desc":
      d.descOpen = !d.descOpen;
      return page.changed();
    case "toggle-comments":
      d.commentsOpen = !d.commentsOpen;
      return page.changed();
    case "fix":
    case "fix-ask": {
      const ask = act === "fix-ask";
      const repo = listed?.repo ?? issuedetail.repoOf(url);
      const project = page.host.projects().find((p) => p.repo.toLowerCase() === repo.toLowerCase())?.id;
      const item = listed ?? (full === undefined ? undefined : fromFull(full, url, repo));
      if (item === undefined) return;
      if (project === undefined && page.host.peer(item, true) !== undefined) page.host.fix(0, item, ask);
      else if (project !== undefined) page.host.fix(project, item, ask);
    }
  }
}
