// A site request's pane (SpokPay's admin request page, app/(app)/admin/requests/request-thread.tsx, as Hub draws it):
// the header (subject, status pill, store · ref), the brief card (components/site-requests/request-brief.tsx), the
// timeline of events and messages in order (request-line.tsx: runs of one author within an hour, events as centered
// dividers), the status choices (rules.ts listAdminTransitionsFromStatus) and the composer's words. Pure: the routes
// read the thread with the admin key and send this to the PC window and the phone; tested in test/srpane.test.ts.
import { STATUS_MOVES, type BriefPart, type Category, type Side, type SrAttachment, type SrEvent, type SrStatus, type SrThread } from "./spokpay-core.ts";

export type StatusTone = "neutral" | "info" | "warning" | "success";

/** request-labels.ts STATUS_LABEL (en). */
export const STATUS_LABEL: Record<SrStatus, { label: string; tone: StatusTone }> = {
  open: { label: "Open", tone: "neutral" },
  working: { label: "Working", tone: "info" },
  review: { label: "Waiting review", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

/** request-labels.ts EVENT_LABEL (en). */
export const EVENT_LABEL: Record<SrEvent, string> = {
  sent: "Sent to SpokPay",
  opened_by_spokpay: "Opened by SpokPay",
  edited: "Details edited",
  started: "Work started",
  review: "Sent for review",
  completed: "Completed",
  closed: "Closed",
  approved: "Store approved — finish and complete",
  rejected: "Store asked for changes",
};

/** request-labels.ts CATEGORY_LABEL (en). */
export const CATEGORY_LABEL: Record<Category, string> = { website: "Website", catalog: "Catalog", delivery: "Delivery", dashboard: "Dashboard", other: "Other" };

/** request-labels.ts listBriefLabelsFromCategory (en): the order and width of the brief's parts. */
export function briefLabels(category: Category): [BriefPart, string, "full" | "half"][] {
  return [
    ["change", category === "website" ? "What changes" : "What is asked", "full"],
    ["where", "Where", "half"],
    ["deadline", "Deadline", "half"],
    ["references", "References", "full"],
    ["outcome", "Expected outcome", "full"],
  ];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** lib/formatters.ts formatDateEnglish (en-GB, day numeric, month short, year): "19 Nov 2026". */
export function dateEnglish(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** lib/formatters.ts formatRelativeTimeEnglish: "just now", "5 min ago", "7 h ago", "Yesterday", "3 days ago", then the date. */
export function relativeEnglish(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return dateEnglish(at);
}

/** A picture or a file of the brief or a message: `src` is Hub's route for its bytes (pictures only). */
export interface PaneFile {
  url: string;
  name: string;
  image: boolean;
  src: string | null;
}

export interface PaneMessage {
  kind: "msg";
  id: string;
  mine: boolean;
  side: Side;
  author: string;
  /** "Truth · 7 h ago": shown on a run's first message only. */
  head: string;
  text: string;
  files: PaneFile[];
  /** request-line.tsx buildRequestRuns: the same author within an hour of the run's first message. */
  joinsPrev: boolean;
  joinsNext: boolean;
  at: number;
}
export interface PaneEvent {
  kind: "event";
  id: string;
  text: string;
  at: number;
}
export type PaneItem = PaneMessage | PaneEvent;

export interface PaneFact {
  label: string;
  text: string;
  full: boolean;
}

export interface PaneView {
  ref: string;
  subject: string;
  status: SrStatus;
  statusLabel: string;
  tone: StatusTone;
  store: string;
  storeSlug: string | null;
  brief: { title: string; sub: string; summary: string; facts: PaneFact[]; files: PaneFile[] };
  items: PaneItem[];
  /** The status menu: the current one first, then where SpokPay lets the admin move it. */
  statuses: { status: SrStatus; label: string; current: boolean }[];
  finished: boolean;
  /** "This request is completed. The store opens a new one if something else comes up." */
  finishedNote: string;
  /** Who the composer writes to: the store owner (their name in the thread, else the list's address, else the store). */
  owner: string;
  /** "Message <owner> on SpokPay" (the person chats' "Message <name> on Discord"). */
  placeholder: string;
  /** Older messages SpokPay didn't send (the API's 100). */
  hasMore: boolean;
  /** Why the composer / the status menu can't act with this key (null: it can). */
  writeBlocked: string | null;
  statusBlocked: string | null;
  lastActivityAt: number;
  /** Shown above the brief: this is an earlier read ("Not read now (…). Shown as read 5 min ago."). */
  note: string | null;
}

export interface PaneOptions {
  now: number;
  /** The store owner's address from the active list (the admin page's ownerDisplayName ?? ownerEmail). */
  ownerEmail?: string;
  /** The summary as Hub opened it (a proposal it sent), while the admin API doesn't send `summary`. */
  summary?: string;
  /** The key's permissions (spokpay.ts status): false = refused, anything else = try. */
  permissions?: Partial<Record<string, boolean | null>>;
  /** Hub's route for a picture's bytes. */
  imageRoute?: (url: string) => string;
  /** Why this is an earlier read (SpokPay didn't answer now). */
  note?: string | null;
}

const RUN_WINDOW = HOUR;
const isImage = (a: SrAttachment): boolean => (a.contentType ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(a.name);
const files = (list: readonly SrAttachment[], route: PaneOptions["imageRoute"]): PaneFile[] =>
  list.flatMap((a) => (a.url ? [{ url: a.url, name: a.name || "file", image: isImage(a), src: isImage(a) && route ? route(a.url) : null }] : []));

export const isFinished = (s: SrStatus): boolean => s === "completed" || s === "closed";

/** The confirm dialog before a final move (request-thread.tsx's AlertDialog). */
export function finishWords(to: "completed" | "closed", store: string): { title: string; text: string; ok: string } {
  return to === "closed"
    ? { title: "Close this request?", text: `${store} sees it as closed without a change. This is final: the thread stops taking messages and the store opens a new request if something else comes up.`, ok: "Close request" }
    : { title: "Complete this request?", text: `${store} sees it as done. This is final: the thread stops taking messages and the store opens a new request if something else comes up.`, ok: "Complete request" };
}

export function paneView(t: SrThread, o: PaneOptions): PaneView {
  const h = t.siteRequest;
  const store = h.store.name || h.ref;
  const look = STATUS_LABEL[h.status];
  const finished = isFinished(h.status);
  const openedBy: Side = t.events.some((e) => e.event === "opened_by_spokpay") ? "spokpay" : "store";
  const facts = briefLabels(h.category)
    .filter(([p]) => h.brief[p].trim() !== "")
    .map(([p, label, width]) => ({ label, text: h.brief[p].trim(), full: width === "full" }));

  // events and messages in time order; an event first when they tie (the opening before the first words)
  const merged: ({ at: number; ev: { event: SrEvent; i: number } } | { at: number; msg: SrThread["messages"][number] })[] = [
    ...t.events.map((e, i) => ({ at: e.createdAt, ev: { event: e.event, i } })),
    ...t.messages.map((m) => ({ at: m.createdAt, msg: m })),
  ];
  merged.sort((a, b) => a.at - b.at || ("ev" in a ? 0 : 1) - ("ev" in b ? 0 : 1));

  const items: PaneItem[] = [];
  let run: { side: Side; author: string; startedAt: number; last: PaneMessage } | null = null;
  for (const x of merged) {
    if ("ev" in x) {
      run = null;
      items.push({ kind: "event", id: `e${x.ev.i}`, text: `${EVENT_LABEL[x.ev.event]} · ${relativeEnglish(x.at, o.now)}`, at: x.at });
      continue;
    }
    const m = x.msg;
    const author = m.authorName || (m.side === "spokpay" ? "SpokPay" : store);
    const joins = run !== null && run.side === m.side && run.author === author && m.createdAt - run.startedAt < RUN_WINDOW;
    const line: PaneMessage = {
      kind: "msg",
      id: m.messageId || `m${items.length}`,
      mine: m.side === "spokpay",
      side: m.side,
      author,
      head: `${author} · ${relativeEnglish(m.createdAt, o.now)}`,
      text: m.text,
      files: files(m.attachments, o.imageRoute),
      joinsPrev: joins,
      joinsNext: false,
      at: m.createdAt,
    };
    if (run && joins) {
      run.last.joinsNext = true;
      run.last = line;
    } else run = { side: m.side, author, startedAt: m.createdAt, last: line };
    items.push(line);
  }

  const lastStoreAuthor = [...t.messages].reverse().find((m) => m.side === "store" && m.authorName)?.authorName;
  const owner = lastStoreAuthor || o.ownerEmail || store;
  const refused = (perm: string): boolean => o.permissions?.[perm] === false;
  return {
    ref: h.ref,
    subject: h.subject || h.ref,
    status: h.status,
    statusLabel: look.label,
    tone: look.tone,
    store,
    storeSlug: h.store.slug,
    brief: {
      title: "Request brief",
      sub: `${CATEGORY_LABEL[h.category]} · ${openedBy === "spokpay" ? "Opened by SpokPay" : `From ${store}`} · ${relativeEnglish(h.createdAt, o.now)}`,
      summary: (h.summary || o.summary || "").trim(),
      facts,
      files: files(h.attachments, o.imageRoute),
    },
    items,
    statuses: [h.status, ...STATUS_MOVES[h.status]].map((s) => ({ status: s, label: STATUS_LABEL[s].label, current: s === h.status })),
    finished,
    finishedNote: `This request is ${look.label.toLowerCase()}. The store opens a new one if something else comes up.`,
    owner,
    placeholder: `Message ${owner} on SpokPay`,
    hasMore: t.hasMore,
    writeBlocked: refused("site-requests:write") ? "The SpokPay key lacks site-requests:write. Add it in Connect Claude on spokpay.com/admin." : null,
    statusBlocked: refused("site-requests:status") ? "The SpokPay key lacks site-requests:status. Add it in Connect Claude on spokpay.com/admin." : null,
    lastActivityAt: h.lastActivityAt,
    note: o.note ?? null,
  };
}

/** The brief's facts as the card lays them out: a full one alone, two half ones side by side (sm:grid-cols-2). */
export function factRows(facts: readonly PaneFact[]): [PaneFact, PaneFact | null][] {
  const out: [PaneFact, PaneFact | null][] = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    const next = facts[i + 1];
    if (!f.full && next && !next.full) {
      out.push([f, next]);
      i++;
    } else out.push([f, null]);
  }
  return out;
}


/** How many of the thread's newest lines go to the AI. */
export const AI_CONTEXT_LINES = 40;

/**
 * The hidden context of a note to the AI from a site request's composer (ai.ts withAiContext wraps it): the request
 * (ref, subject, status, store, owner, the admin page), its brief as the admin page shows it, and the newest messages
 * and events, oldest first. The AI drafts replies in ```reply blocks, as SpokPay, and never writes on the request.
 */
export function srAiContext(t: SrThread, o: { now: number; url: string; owner?: string; summary?: string }): string {
  const v = paneView(t, { now: o.now, ...(o.owner ? { ownerEmail: o.owner } : {}), ...(o.summary ? { summary: o.summary } : {}) });
  const h = t.siteRequest;
  const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    ...t.events.map((e) => ({ at: e.createdAt, text: `[${stamp(e.createdAt)}] — ${EVENT_LABEL[e.event]} —` })),
    ...t.messages.map((m) => {
      const who = m.side === "spokpay" ? `SpokPay (${m.authorName || "SpokPay"})` : `${m.authorName || v.store} (store)`;
      const pics = m.attachments.length ? ` [${m.attachments.map((a) => a.name || "file").join(", ")}]` : "";
      return { at: m.createdAt, text: `[${stamp(m.createdAt)}] ${who}: ${m.text.replace(/\n+/g, " ⏎ ")}${pics}` };
    }),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-AI_CONTEXT_LINES);
  return [
    "This note comes from a SpokPay site request's pane in Hub's Persons tab (SpokPay's admin request page). The user writes to you here; you never write on the request or to the store yourself (no SpokPay API writes, no Discord, Gmail or WhatsApp sends).",
    "When you suggest a reply for the user to send on the request, put exactly that text in a fenced block that starts with ```reply, written as SpokPay to the store owner, in the store's language (usually Portuguese).",
    "",
    `Site request: ${v.ref} · ${v.subject}`,
    `Status: ${v.statusLabel}${h.waitingOn ? ` · waiting on ${h.waitingOn === "spokpay" ? "SpokPay" : "the store"}` : ""}`,
    `Store: ${v.store}${h.store.slug ? ` (slug ${h.store.slug})` : ""} · owner ${v.owner}`,
    `Admin page: ${o.url}`,
    "",
    `Request brief: ${v.brief.sub}`,
    v.brief.summary ? `Summary: ${v.brief.summary}` : "",
    ...v.brief.facts.map((f) => `${f.label}: ${f.text}`),
    v.brief.files.length ? `Pictures: ${v.brief.files.map((f) => f.name).join(", ")}` : "",
    "",
    lines.length ? `The last ${lines.length} messages and events of the request (oldest first${t.hasMore ? "; older ones not shown" : ""}):` : "No messages on the request yet.",
    ...lines.map((l) => l.text),
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n");
}
