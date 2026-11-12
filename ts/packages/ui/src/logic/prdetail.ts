import { type ghapi, prdetail } from "@harbor/mcp";
import { ICONS } from "../icons.ts";
import { ago, type Chip, hexColor, letterOf, thousands, type Tone } from "./prs.ts";

type PrFull = ghapi.PrFull;
type Pr = ghapi.Pr;
type DiffLine = ghapi.DiffLine;

export type DetailTab = "summary" | "timeline" | "code";
export const TABS: readonly { tab: DetailTab; label: string }[] = [
  { tab: "summary", label: "Summary" },
  { tab: "timeline", label: "Timeline" },
  { tab: "code", label: "Code" },
];

/** One open tab's state (prdetail.rs `Detail`). */
export interface DetailState {
  tab: DetailTab;
  full: PrFull | null;
  fullError: string | null;
  loading: boolean;
  diff: DiffLine[] | null;
  diffError: string | null;
  diffLoading: boolean;
  busy: boolean;
  error: string | null;
  showChecks: boolean;
  descOpen: boolean;
  commentsOpen: boolean;
}

export const newDetail = (): DetailState => ({
  tab: "summary", full: null, fullError: null, loading: false, diff: null, diffError: null, diffLoading: false, busy: false, error: null, showChecks: false, descOpen: true, commentsOpen: true,
});

type Tone3 = [icon: string, tone: Tone, what: string];

export function reviewTone(state: string): Tone3 {
  switch (state) {
    case "APPROVED":
      return [ICONS.CIRCLE_CHECK, "green", "approved"];
    case "CHANGES_REQUESTED":
      return [ICONS.CIRCLE_X, "amber", "requested changes"];
    case "COMMENTED":
      return [ICONS.MESSAGE, "subtle", "commented"];
    case "DISMISSED":
      return [ICONS.CIRCLE_SLASH, "gray-800", "review dismissed"];
    default:
      return [ICONS.CIRCLE_DASHED, "gray-800", "review requested"];
  }
}

export function checkTone(state: PrFull["checks"][number]["state"]): [string, Tone] {
  switch (state) {
    case "pass":
      return [ICONS.CIRCLE_CHECK, "green"];
    case "fail":
      return [ICONS.CIRCLE_X, "red"];
    case "pending":
      return [ICONS.CIRCLE_DASHED, "amber"];
    case "skipped":
      return [ICONS.CIRCLE_SLASH, "gray-800"];
  }
}

/** "All checks passed" and friends, for the tab bar (prdetail.rs `checks_summary`). */
export function checksSummary(checks: PrFull["checks"]): Tone3 {
  const fail = checks.filter((c) => c.state === "fail").length;
  const pend = checks.filter((c) => c.state === "pending").length;
  if (checks.length === 0) return [ICONS.CIRCLE_DASHED, "subtle", "No checks reported"];
  if (fail > 0) return [ICONS.CIRCLE_X, "red", `${fail} of ${checks.length} checks failing`];
  if (pend > 0) return [ICONS.CIRCLE_DASHED, "amber", `${pend} checks running`];
  return [ICONS.CIRCLE_CHECK, "green", "All checks passed"];
}

export interface Reviewer {
  who: string;
  letter: string;
  icon: string;
  tone: Tone;
  tip: string;
}

export interface CheckRow {
  icon: string;
  tone: Tone;
  name: string;
  url: string;
}

export interface NoteData {
  who: string;
  letter: string;
  what: string;
  body: string;
}

export interface EventRow {
  icon: string;
  tone: Tone;
  text: string;
  mono: boolean;
  age: string;
}

export type TimelineItem = { kind: "note"; note: NoteData } | { kind: "event"; event: EventRow };

export interface CodeLine {
  t: "file" | "hunk" | "add" | "del" | "ctx";
  path: string;
  adds: string;
  dels: string;
  text: string;
}

export interface Header {
  repo: string;
  number: number;
  title: string;
  author: string;
  letter: string;
  updated: string;
  checkout: string;
  open: boolean;
  draft: boolean;
  busy: boolean;
  can_project: boolean;
  merge_enabled: boolean;
  merge_tip: string;
  checkout_tip: string;
  ready_label: string;
  base: string;
  head: string;
  conflicting: boolean;
  has_full: boolean;
  files: string;
  adds: string;
  dels: string;
  error: string;
  loading: boolean;
  checks_icon: string;
  checks_tone: Tone;
  checks_text: string;
}

export interface Facts {
  url: string;
  list: Pr | undefined;
  project: number | undefined;
  now: number;
  notProject: string;
}

const MERGE_TIP = "Start a thread where an agent rebases it, fixes checks and reviews, then merges it (gh pr merge)";

export function header(d: DetailState, f: Facts): Header {
  const full = d.full;
  const list = f.list;
  const number = full?.number ?? list?.number ?? 0;
  const author = full?.author ?? list?.author ?? "";
  const updated = full?.updated ?? list?.updated ?? 0;
  const open = full ? full.state === "OPEN" : list === undefined || list.state === "open";
  const none: [string, Tone, string] = ["", "subtle", ""];
  const [checks_icon, checks_tone, checks_text] = full ? checksSummary(full.checks) : none;
  const inProject = f.project !== undefined;
  return {
    repo: list?.repo ?? prdetail.repoOf(full?.url ?? f.url),
    number,
    title: full?.title ?? list?.title ?? "",
    author,
    letter: letterOf(author),
    updated: updated > 0 ? `· updated ${ago(updated, f.now)}` : "",
    checkout: `gh pr checkout ${number}`,
    open,
    draft: full?.draft ?? list?.draft ?? false,
    busy: d.busy,
    can_project: inProject,
    merge_enabled: inProject && list !== undefined,
    merge_tip: !inProject ? f.notProject : list === undefined ? "Refresh the list first" : MERGE_TIP,
    checkout_tip: inProject ? "Check out this branch in a terminal (gh pr checkout)" : "Add this repo as a project to check it out here",
    ready_label: d.busy ? "Marking ready…" : "Ready for review",
    base: full?.base ?? "",
    head: full?.head ?? "",
    conflicting: full?.conflicting ?? false,
    has_full: full !== null,
    files: full ? `${full.files} files` : "",
    adds: full ? `+${thousands(full.adds)}` : "",
    dels: full ? `-${thousands(full.dels)}` : "",
    error: d.fullError ?? d.error ?? "",
    loading: d.loading,
    checks_icon,
    checks_tone,
    checks_text,
  };
}

export interface Summary {
  reviewers: Reviewer[];
  labels: Chip[];
  desc_open: boolean;
  body: string;
  checks_open: boolean;
  checks_icon: string;
  checks_tone: Tone;
  checks_text: string;
  checks: CheckRow[];
  has_checks: boolean;
  comments_open: boolean;
  comments_title: string;
  comments: NoteData[];
}

const note = (who: string, at: number, what: string, body: string, now: number): NoteData => ({ who, letter: letterOf(who), what: `${what} · ${ago(at, now)}`, body });

export function summary(d: DetailState, full: PrFull, now: number): Summary {
  const [checks_icon, checks_tone, checks_text] = checksSummary(full.checks);
  return {
    reviewers: full.reviewers.map(([who, state]) => {
      const [icon, tone, tip] = reviewTone(state);
      return { who, letter: letterOf(who), icon, tone, tip };
    }),
    labels: full.labels.map(([name, rgb]) => ({ name, color: hexColor(rgb) })),
    desc_open: d.descOpen,
    body: full.body.trim() === "" ? "" : full.body,
    checks_open: d.showChecks,
    checks_icon,
    checks_tone,
    checks_text,
    checks: full.checks.map((c) => {
      const [icon, tone] = checkTone(c.state);
      return { icon, tone, name: c.name, url: c.url };
    }),
    has_checks: full.checks.length > 0,
    comments_open: d.commentsOpen,
    comments_title: `Comments (${full.comments.length})`,
    // Newest first, as T3 Code lists them.
    comments: [...full.comments].reverse().map((c) => note(c.author, c.at, "commented", c.body, now)),
  };
}

export function timeline(full: PrFull, now: number): TimelineItem[] {
  return full.timeline.map(([at, who, e]): TimelineItem => {
    const event = (icon: string, tone: Tone, text: string, mono = false): TimelineItem => ({ kind: "event", event: { icon, tone, text, mono, age: ago(at, now) } });
    switch (e.kind) {
      case "comment":
        return { kind: "note", note: note(who, at, "commented", e.body, now) };
      case "review": {
        const [icon, tone, what] = reviewTone(e.state);
        return e.body.trim() !== "" ? { kind: "note", note: note(who, at, what, e.body, now) } : event(icon, tone, `${who} ${what}`);
      }
      case "opened":
        return event(ICONS.PR_OPEN, "green", `${who} opened this pull request`);
      case "commit":
        return event(ICONS.BRANCH, "subtle", `${e.sha}  ${e.headline}`, true);
    }
  });
}

export function codeLines(lines: readonly DiffLine[]): CodeLine[] {
  return lines.map((l) =>
    l.t === "file"
      ? { t: "file", path: l.path, adds: `+${l.adds}`, dels: `-${l.dels}`, text: "" }
      : { t: l.t, path: "", adds: "", dels: "", text: l.text.replaceAll("\t", "    ") },
  );
}

export type CodeState = { kind: "loading" } | { kind: "error"; text: string } | { kind: "empty" } | { kind: "lines"; lines: CodeLine[] };

export function codeState(d: DetailState): CodeState {
  if (d.diffError !== null) return { kind: "error", text: d.diffError };
  if (d.diff === null) return { kind: "loading" };
  return d.diff.length === 0 ? { kind: "empty" } : { kind: "lines", lines: codeLines(d.diff) };
}

const DETAIL_ACTS = ["web", "copy_link", "copy_number", "copy_checkout", "refresh", "ready", "checkout", "merge", "merge_ask", "review", "copy_branch"] as const;
export type DetailAct = (typeof DETAIL_ACTS)[number];

export const detailActOf = (s: string): DetailAct | null => DETAIL_ACTS.find((a) => a === s) ?? null;

/** The ⋯ menu (prdetail.rs `pr_detail`). */
export function moreMenu(inProject: boolean): { act: DetailAct; icon: string; label: string; sep: boolean }[] {
  const out: { act: DetailAct; icon: string; label: string; sep: boolean }[] = [{ act: "refresh", icon: ICONS.REFRESH, label: "Refresh", sep: false }];
  if (inProject) out.push({ act: "review", icon: ICONS.SPARKLES, label: "Review with an agent", sep: false });
  out.push(
    { act: "web", icon: ICONS.EXTERNAL, label: "Open on GitHub", sep: true },
    { act: "copy_link", icon: ICONS.LINK, label: "Copy link   Ctrl+Shift+C", sep: false },
    { act: "copy_number", icon: ICONS.COPY, label: "Copy PR number   Ctrl+Shift+K", sep: false },
    { act: "copy_checkout", icon: ICONS.TERMINAL, label: "Copy checkout command", sep: false },
  );
  return out;
}

/** The context menu of the header's repo link. */
export const LINK_MENU: { act: DetailAct; icon: string; label: string }[] = [
  { act: "copy_link", icon: ICONS.COPY, label: "Copy link" },
  { act: "web", icon: ICONS.EXTERNAL, label: "Open on GitHub" },
];
