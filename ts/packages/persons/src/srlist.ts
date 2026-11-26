// Headquarters' Home › Site requests list (convex/siteRequestList/*, app/src/spaces/spokpay/home/{data,row}.ts), read
// from SpokPay's `/admin/site-requests/active` with the saved admin key instead of Headquarters' Convex (Person Hub's
// src/lib/siteRequestList.ts). Pure: the board (srboard.ts), the state JSON and the tests use it.
import type { Side, SrRow } from "./spokpay-core.ts";

/** Why the list may be old: the last read did not happen or failed. The rows stay from the read before. */
export type ListProblem = { kind: "none" } | { kind: "not-connected" } | { kind: "failed"; reason: string; since: number };

/** SpokPay sends at most this many (Headquarters' ACTIVE_LIMIT). */
export const ACTIVE_LIMIT = 100;

/** Headquarters' `lastMessage`: only when SpokPay sent both a preview and a side. */
export const lastMessageOf = (r: Pick<SrRow, "lastMessagePreview" | "lastMessageSide">): { side: Side; preview: string } | undefined =>
  r.lastMessagePreview != null && r.lastMessageSide ? { side: r.lastMessageSide, preview: r.lastMessagePreview } : undefined;

/** A request with no message yet is the store's opening ask, so it waits on SpokPay too. */
export const waitsOnSpokPay = (r: Pick<SrRow, "status" | "lastMessagePreview" | "lastMessageSide">): boolean =>
  r.status !== "review" && (lastMessageOf(r)?.side ?? "store") === "store";

/**
 * Headquarters' own unread: the store wrote after the user last opened the request here. One never opened here keeps
 * SpokPay's flag (its admin has not read the latest).
 */
export function isUnread(r: Pick<SrRow, "unread" | "lastActivityAt" | "lastMessagePreview" | "lastMessageSide">, seenActivityAt: number | undefined): boolean {
  if (lastMessageOf(r)?.side === "spokpay") return false;
  return seenActivityAt === undefined ? r.unread : r.lastActivityAt > seenActivityAt;
}

const oneLine = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Who spoke last (the row's tooltip), as the Conversations list says "You:". */
export function preview(r: SrRow): string {
  const last = lastMessageOf(r);
  if (!last) return "No messages yet";
  return `${last.side === "spokpay" ? "SpokPay" : r.storeName}: ${oneLine(last.preview) || "Sent a file"}`;
}

export type SideTone = "info" | "warning";
/** A row: the store's side is "Store replied" (it wrote and the user has not opened it) or "Store waiting" (it spoke last). */
export interface ListRow {
  ref: string;
  subject: string;
  store: string;
  storeSlug: string | null;
  line: string;
  waiting: boolean;
  unread: boolean;
  lastActivityAt: number;
  side: { text: string; tone: SideTone } | null;
}

/** Headquarters' rows: newest activity first (Home sorts the requests by their last move). */
export function listRows(active: readonly SrRow[], seen: Readonly<Record<string, number>>): ListRow[] {
  return active
    .map((r) => {
      const waiting = waitsOnSpokPay(r);
      const unread = isUnread(r, seen[r.ref]);
      return {
        ref: r.ref,
        subject: r.subject,
        store: r.storeName,
        storeSlug: r.storeSlug,
        line: preview(r),
        waiting,
        unread,
        lastActivityAt: r.lastActivityAt,
        side: unread ? { text: "Store replied", tone: "info" as const } : waiting ? { text: "Store waiting", tone: "warning" as const } : null,
      };
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export interface Notice {
  title: string;
  text: string;
}

/** What keeps the list from being complete or current (Headquarters' siteRequestNotices, for Hub). */
export function listNotices(problem: ListProblem, read: boolean, truncated: boolean): Notice[] {
  const notices: Notice[] = [];
  switch (problem.kind) {
    case "not-connected":
      notices.push({ title: "SpokPay is not connected", text: "Hub has no SpokPay key, so site requests are not read." });
      break;
    case "failed":
      notices.push({ title: "Site requests not read", text: problem.reason });
      break;
    case "none":
      if (!read) notices.push({ title: "Site requests not read yet", text: "They show within a minute." });
      break;
  }
  if (truncated) notices.push({ title: `Only the newest ${ACTIVE_LIMIT}`, text: "SpokPay sent its limit, so the oldest active requests are missing." });
  return notices;
}

/** The failure kept: the first one's time stays while it keeps failing. */
export const failedAgain = (before: ListProblem, reason: string, now: number): ListProblem =>
  before.kind === "failed" ? { ...before, reason } : { kind: "failed", reason, since: now };

/** Seen marks of requests no longer active go (Headquarters sweeps them on each full read). */
export function sweepSeen(seen: Readonly<Record<string, number>>, active: readonly Pick<SrRow, "ref">[], truncated: boolean): Record<string, number> {
  if (truncated) return { ...seen };
  const live = new Set(active.map((r) => r.ref));
  return Object.fromEntries(Object.entries(seen).filter(([ref]) => live.has(ref)));
}

/** The admin page of a request (Headquarters' siteRequestPageUrl). */
export const siteRequestPageUrl = (ref: string): string => `https://spokpay.com/admin/requests?thread=${encodeURIComponent(ref)}`;

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("pt-BR", { granularity: "grapheme" }) : null;
const firstLetters = (word: string, count: number): string[] => (graphemes ? Array.from(graphemes.segment(word), (p) => p.segment) : Array.from(word)).slice(0, count);

/** Headquarters' avatar initials: first and last word's first letters, else a word's first two. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? [...firstLetters(words[0]!, 1), ...firstLetters(words[words.length - 1]!, 1)] : firstLetters(words[0]!, 2);
  return letters.join("").toUpperCase();
}
