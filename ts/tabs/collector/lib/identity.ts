// Who a creator is, as keys: `<platform>:<id>`, `<platform>:@handle`, and the profiles their links point at on the other
// platforms (a YouTube channel whose About links instagram.com/x is the same person as Instagram @x). Collector keeps
// every key it ever collected (the `seen` ledger, which Clear doesn't empty), so no run, on any platform, collects a
// person twice; Persons › Creators adds the people already talked to.
import { profileKeyOf } from "./links.ts";
import type { CreatorRecord } from "./types.ts";

export const recordId = (c: Pick<CreatorRecord, "platform" | "platform_id">): string => `${c.platform}:${c.platform_id}`;

export function handleKey(platform: string, handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  return h ? `${platform}:@${h}` : null;
}

/** The record's own keys (id, handle, profile URL). */
export function ownKeys(c: Pick<CreatorRecord, "platform" | "platform_id" | "handle" | "profile_url">): string[] {
  const out = [recordId(c)];
  const h = handleKey(c.platform, c.handle);
  if (h) out.push(h);
  const p = c.profile_url ? profileKeyOf(c.profile_url) : null;
  if (p) out.push(p);
  return [...new Set(out)];
}

/** The other platforms' profiles its links point at (same person elsewhere). */
export function linkedKeys(c: Pick<CreatorRecord, "platform" | "links">): string[] {
  const out: string[] = [];
  for (const l of c.links) {
    const k = profileKeyOf(l.url);
    if (k && !k.startsWith(`${c.platform}:`) && !out.includes(k)) out.push(k);
  }
  return out;
}

export const allKeys = (c: CreatorRecord): string[] => [...new Set([...ownKeys(c), ...linkedKeys(c), ...(c.email ? [`email:${c.email.toLowerCase()}`] : [])])];

/** Keys out of the people Persons › Creators already has (their handles/links/emails, as Persons stores them). */
export function personKeys(p: { handles?: { platform: string; handle: string }[]; links?: string[]; emails?: string[] }): string[] {
  const out: string[] = [];
  for (const h of p.handles ?? []) {
    const k = handleKey(h.platform, h.handle);
    if (k) out.push(k);
  }
  for (const u of p.links ?? []) {
    const k = profileKeyOf(u);
    if (k) out.push(k);
  }
  for (const e of p.emails ?? []) out.push(`email:${e.toLowerCase()}`);
  return out;
}
