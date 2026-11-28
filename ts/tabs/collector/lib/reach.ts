// Reach and Social media, as the SpokPay CRM has them (src/lib/creator-contacts.ts, src/lib/social-brands.tsx,
// src/lib/creator-display.ts): one operator-owned way to contact a creator (Email, Discord user ID, WhatsApp, Instagram
// handle) with the CRM's checks, and each profile link's brand (host first, then its label) and title.
import { contactsOf } from "./contacts.ts";
import { REACH_KINDS, type CreatorLink, type CreatorRecord, type Reach, type ReachKind } from "./types.ts";

export const REACH_META: Record<ReachKind, { label: string; color: string; placeholder: string; send: string }> = {
  email: { label: "Email", color: "#9aa4b2", placeholder: "name@studio.com", send: "Send email" },
  discord: { label: "Discord", color: "#5865F2", placeholder: "Discord user ID (17-20 digits)", send: "Open in Discord" },
  whatsapp: { label: "WhatsApp", color: "#25D366", placeholder: "+55 21 97570-9440", send: "Send WhatsApp" },
  instagram: { label: "Instagram", color: "#E1306C", placeholder: "@handle or instagram.com/handle", send: "Open Instagram" },
};

export const isReachKind = (k: unknown): k is ReachKind => (REACH_KINDS as readonly unknown[]).includes(k);

const SNOWFLAKE = /^\d{17,20}$/;
const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** Bare handle from `@name`, `name`, or an instagram.com profile URL. */
export function instagramHandle(raw: string): string {
  const t = raw.trim();
  const url = t.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i);
  return (url ? url[1]! : t).replace(/^@/, "");
}

/** A WhatsApp number's digits, country code first: a Brazilian one typed without +55 (DDD + 8 or 9 digits) gets it. */
export function whatsappDigits(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if ((d.length === 10 || d.length === 11) && !raw.trim().startsWith("+")) return `55${d}`;
  return d;
}

/** Empty is allowed (clears Reach). Non-empty must match the kind (the CRM's reachValidationError). */
export function reachError(kind: ReachKind, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (kind) {
    case "email": {
      const at = v.indexOf("@");
      return at > 0 && at < v.length - 1 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : "That isn't an email address.";
    }
    case "whatsapp": {
      const d = whatsappDigits(v);
      return d.length >= 12 && d.length <= 15 ? null : "A WhatsApp number: country code, area code and number.";
    }
    case "discord":
      return SNOWFLAKE.test(v.replace(/^@/, "")) ? null : "A Discord user ID, 17-20 digits (Developer Mode › right-click › Copy User ID).";
    case "instagram":
      return INSTAGRAM_HANDLE.test(instagramHandle(v)) ? null : "An Instagram handle: letters, numbers, . and _ only.";
  }
}

/** Discord's usernames (the new kind: 2-32 of letters, digits, _ and .). */
const DISCORD_USERNAME = /^[\w.]{2,32}$/;

/** Send message's To (pure: tested): as Reach's checks, except that Discord also takes a username (Persons looks it up
 *  for the user ID when it sends), so a Discord contact found as a username can be written to. Null: fine. */
export function sendToError(kind: ReachKind, value: string): string | null {
  const v = value.trim();
  if (kind === "discord") {
    const t = v.replace(/^@/, "");
    // digits alone are a user ID (17-20 of them), anything else a username
    return !t || SNOWFLAKE.test(t) || (!/^\d+$/.test(t) && DISCORD_USERNAME.test(t)) ? null : "A Discord username, or a user ID (17-20 digits).";
  }
  return reachError(kind, v);
}

/** The value Send message's To takes for a contact on `kind` (pure: tested): a Discord user ID or username (not an
 *  invite: nobody to write to), the others as found. "" when there is none. */
export function sendToOf(c: CreatorRecord, kind: ReachKind): string {
  const drafts = reachDrafts(c);
  if (drafts[kind] && !sendToError(kind, drafts[kind])) return drafts[kind];
  const found = contactsOf(c).find((x) => x.kind === kind && !!x.value.trim() && !sendToError(kind, x.value));
  return found ? (kind === "discord" ? found.value.trim().replace(/^@/, "") : found.value) : drafts[kind];
}

export function normalizeReach(kind: ReachKind, value: string): string {
  const v = value.trim();
  if (kind === "email") return v.toLowerCase();
  if (kind === "whatsapp") return `+${whatsappDigits(v)}`;
  if (kind === "discord") return v.replace(/^@/, "");
  return `@${instagramHandle(v)}`;
}

/** Where a reach opens outside Hub (email goes through Send message instead). */
export function reachHref(r: Reach): string | null {
  const v = r.value.trim();
  if (!v) return null;
  if (r.kind === "whatsapp") {
    const d = v.replace(/\D/g, "");
    return d ? `https://wa.me/${d}` : null;
  }
  if (r.kind === "discord") return SNOWFLAKE.test(v) ? `https://discord.com/users/${v}` : null;
  if (r.kind === "instagram") {
    const h = instagramHandle(v);
    return h ? `https://www.instagram.com/${h}/` : null;
  }
  return null;
}

/** What each Reach kind's field starts with: the saved Reach, else what Collector found (email, bio's WhatsApp, the
 *  Instagram profile or a link to it). */
export function reachDrafts(c: CreatorRecord): Record<ReachKind, string> {
  const found = contactsOf(c);
  const ig = c.platform === "instagram" && c.handle ? c.handle : (found.find((x) => x.kind === "instagram")?.value ?? c.links.map((l) => l.url).find((u) => /instagram\.com\/[^/?#]+/i.test(u)) ?? "");
  const out: Record<ReachKind, string> = {
    email: c.email ?? "",
    // a Discord user ID found (Send's Discord needs one; an invite or a username isn't)
    discord: found.find((x) => x.kind === "discord" && SNOWFLAKE.test(x.value))?.value ?? "",
    whatsapp: c.whatsapp ? `+${c.whatsapp.replace(/\D/g, "")}` : "",
    instagram: ig ? `@${instagramHandle(ig).replace(/^@/, "")}` : "",
  };
  if (c.reach) out[c.reach.kind] = c.reach.value;
  return out;
}

/** The Reach kind the detail opens on: the saved one, else the first that has something found. */
export function reachStart(c: CreatorRecord): ReachKind {
  if (c.reach) return c.reach.kind;
  // their best contact the Reach can hold (a Discord invite or username can't: the CRM keeps a user ID)
  return contactsOf(c).find((x) => x.kind !== "discord" || SNOWFLAKE.test(x.value))?.kind ?? "email";
}

export interface Brand {
  /** "discord", "instagram", "youtube", "tiktok", "twitch", "x", "email", "link". */
  key: string;
  name: string;
  color: string;
}

const NEUTRAL: Brand = { key: "link", name: "Link", color: "#9aa4b2" };
const BY_HOST: [string, Brand][] = [
  ["discord.gg", { key: "discord", name: "Discord", color: "#5865F2" }],
  ["discord.com", { key: "discord", name: "Discord", color: "#5865F2" }],
  ["discordapp.com", { key: "discord", name: "Discord", color: "#5865F2" }],
  ["instagram.com", { key: "instagram", name: "Instagram", color: "#E1306C" }],
  ["youtube.com", { key: "youtube", name: "YouTube", color: "#FF0000" }],
  ["youtu.be", { key: "youtube", name: "YouTube", color: "#FF0000" }],
  ["tiktok.com", { key: "tiktok", name: "TikTok", color: "#FE2C55" }],
  ["twitch.tv", { key: "twitch", name: "Twitch", color: "#9146FF" }],
  ["twitter.com", { key: "x", name: "X", color: "#D7DBE0" }],
  ["x.com", { key: "x", name: "X", color: "#D7DBE0" }],
  ["wa.me", { key: "whatsapp", name: "WhatsApp", color: "#25D366" }],
  ["whatsapp.com", { key: "whatsapp", name: "WhatsApp", color: "#25D366" }],
];

/** A link's brand: its host first (the label is whatever the creator typed), then its label. */
export function brandOf(link: CreatorLink): Brand {
  const url = link.url.toLowerCase();
  if (url.startsWith("mailto:")) return { key: "email", name: "Email", color: "#9aa4b2" };
  let host = "";
  try {
    host = new URL(/^[a-z]+:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    host = url;
  }
  for (const [h, b] of BY_HOST) if (host === h || host.endsWith(`.${h}`)) return b;
  const label = (link.label ?? "").toLowerCase();
  for (const [, b] of BY_HOST) if (label.includes(b.name.toLowerCase())) return b;
  return NEUTRAL;
}

/** A link's title: its label, else its host. */
export function linkTitle(link: CreatorLink): string {
  if (link.label?.trim()) return link.label.trim();
  try {
    return new URL(/^[a-z]+:/i.test(link.url) ? link.url : `https://${link.url}`).hostname.replace(/^www\./, "");
  } catch {
    return link.url;
  }
}

/** Edit's links box: one link a line, "Title https://…" or just the URL. */
export function parseLinks(text: string): CreatorLink[] {
  const out: CreatorLink[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*[|·—-]?\s*((?:https?:\/\/|mailto:|www\.)\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/i);
    if (!m) continue;
    const url = /^(https?:|mailto:)/i.test(m[2]!) ? m[2]! : `https://${m[2]!}`;
    const label = m[1]!.trim().replace(/[|·—-]\s*$/, "").trim();
    if (!out.some((l) => l.url === url)) out.push({ label: label || null, url });
  }
  return out;
}

/** The links box's text for Edit (the inverse of parseLinks). */
export function linksText(links: CreatorLink[]): string {
  return links.map((l) => (l.label?.trim() ? `${l.label.trim()} ${l.url}` : l.url)).join("\n");
}
