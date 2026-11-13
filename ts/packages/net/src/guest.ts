/**
 * Someone else's phone on this PC. A phone signed in as another member of this PC's workspace reaches it directly (its
 * own PC may be off: the phone falls back to the PCs of every workspace its account is in). What it may do here is what
 * this PC's owner lets that person's PCs' chats do here (Settings › Workspace, the `machines` levels, keyed by PC):
 * the most any of their PCs gets, "full" when none is set (the levels' default) or they have no PC. The owner's own
 * phones aren't guests.
 *
 * `/v1/state` says it as `guest` ({level, start, why}; null for the owner's phones), so the phone offers this PC only
 * when it may start chats here; a chat such a phone starts runs at most at that level (`guestAccess`), as one another
 * PC starts on this PC's accounts does (meshaccounts.ts `sharedAccess`).
 */
import { sharedWith } from "./meshaccounts.ts";

const RANK: Record<string, number> = { off: 0, read: 1, edit: 2, full: 3 };
/** What a chat may do for each level ("off": nothing). */
const CAP: Record<string, string> = { read: "plan", edit: "edits", full: "full" };
const ACCESS_RANK: Record<string, number> = { plan: 0, edits: 1, full: 2 };

/** A PC of the directory: its mesh id and the account that registered it. */
export interface GuestPc {
  id: string;
  owner: string;
}

/**
 * The level that applies to a phone signed in as `caller`: null for this PC's owner (or a phone from before accounts,
 * `caller` ""); else the most `levelOf` gives any PC `caller` owns, "full" when they own none.
 */
export function guestLevel(caller: string, owner: string, pcs: readonly GuestPc[], levelOf: (pc: string) => string): string | null {
  if (caller === "" || caller === owner) return null;
  let best: string | null = null;
  const seen = new Set<string>();
  for (const p of pcs) {
    if (p.owner !== caller || p.id === "" || seen.has(p.id)) continue;
    seen.add(p.id);
    const l = levelOf(p.id);
    if (RANK[l] === undefined) continue;
    if (best === null || (RANK[l] ?? 0) > (RANK[best] ?? 0)) best = l;
  }
  return best ?? "full";
}

/** `guest` in `/v1/state`: whether that phone may start chats here (one of this PC's accounts runs within its level). */
export function guestJson(level: string, owner: string, me: string, accounts: readonly { kind: string; access: readonly string[] }[]): { level: string; start: boolean; why: string | null } {
  if (CAP[level] === undefined) return { level, start: false, why: `${ownerOf(owner, me)} doesn't let your PCs' chats use ${me}` };
  if (accounts.length === 0) return { level, start: false, why: `${me} has no agent account signed in` };
  if (!accounts.some((a) => sharedWith(level, a.access))) return { level, start: false, why: `${ownerOf(owner, me)} lets your chats only ${level === "read" ? "read" : "edit files"} on ${me}, and its accounts run with full access only` };
  return { level, start: true, why: null };
}

/** The access a chat that phone starts here runs with: what it asked for, at most what its level allows; or why not. */
export function guestAccess(level: string, asked: string, choices: readonly string[], who: { me: string; owner: string }): { access: string } | { why: string } {
  const cap = CAP[level];
  if (cap === undefined) return { why: `${ownerOf(who.owner, who.me)} doesn't let your PCs' chats use ${who.me} (Settings › Workspace there)` };
  const want = (ACCESS_RANK[asked] ?? 2) <= (ACCESS_RANK[cap] ?? 2) ? asked : cap;
  if (choices.includes(want)) return { access: want };
  return { why: `${ownerOf(who.owner, who.me)} lets your chats only ${level === "read" ? "read" : "edit files"} on ${who.me}, and this account runs with full access only` };
}

const ownerOf = (owner: string, me: string): string => (owner === "" ? `${me}'s owner` : owner);
