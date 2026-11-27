// A creator's ways of contact, whichever channel they are: an email (any), a WhatsApp number, a Discord (an invite, a
// user ID, or a username their bio labels "Discord:"), an Instagram (a profile link, or an @handle labelled
// "Instagram:"/"IG:"/"insta:"). Found in what they publish (the bio, their link list, link-in-bio pages' links), each
// with where it was found, as emails always were; typed ones (the row's Add contact, the detail's Reach, the email
// typed) come first and are never replaced by a read. contactsOf() is what the cards show: the best one first.
import { extractEmails } from "./email.ts";
import { extractUrls, profileKeyOf } from "./links.ts";
import type { Contact, ContactKind, CreatorLink, CreatorRecord } from "./types.ts";

/** Which one shows first among found ones (typed ones always lead). */
export const CONTACT_ORDER: readonly ContactKind[] = ["email", "whatsapp", "instagram", "discord"];

export const CONTACT_LABEL: Record<ContactKind, string> = { email: "Email", whatsapp: "WhatsApp", discord: "Discord", instagram: "Instagram" };

/** The Add contact field's hint for each channel. */
export const CONTACT_HINT: Record<ContactKind, string> = {
  email: "name@studio.com",
  whatsapp: "+55 21 97570-9440",
  discord: "discord.gg/invite, user ID or username",
  instagram: "@handle or instagram.com/handle",
};

const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_USER = /^[a-z0-9_.]{2,32}$/;
/** Words a "Discord:" label is followed by that aren't a username. */
const DISCORD_WORDS = new Set(["server", "servidor", "oficial", "official", "comunidade", "community", "link", "links", "abaixo", "below", "aqui", "here", "entre", "join", "do", "da", "de", "no", "na", "the", "my", "meu", "nosso", "invite", "convite", "https", "http", "www", "discord", "gg"]);

/** A Brazilian (or international) WhatsApp number as "+<digits>": a 10–11 digit one gets +55; null when it isn't one. */
export function phoneOf(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return /^[1-9][1-9]/.test(d) ? `+55${d}` : null;
  if (d.length >= 12 && d.length <= 15) return `+${d}`;
  return null;
}

/** "+55 11 98765-4321" for a Brazilian number, else "+<digits>". */
export function phoneText(v: string): string {
  const d = v.replace(/\D/g, "");
  const br = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${d}`;
}

/** One contact a URL is (a wa.me link, a Discord invite or user page, an Instagram profile), or null. */
export function contactOfUrl(url: string): { kind: ContactKind; value: string } | null {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (u.protocol === "mailto:") {
    const e = extractEmails(url)[0];
    return e ? { kind: "email", value: e } : null;
  }
  if (h === "wa.me" || h === "api.whatsapp.com" || h === "web.whatsapp.com" || h === "whatsapp.com") {
    const raw = h === "wa.me" ? (parts[0] ?? "") : (u.searchParams.get("phone") ?? "");
    const p = /^\+?[\d\s().-]+$/.test(raw) ? phoneOf(raw) : null;
    return p ? { kind: "whatsapp", value: p } : null;
  }
  if (h === "discord.gg" || h === "dsc.gg") {
    const code = parts[0];
    return code && /^[\w-]{2,40}$/.test(code) ? { kind: "discord", value: `discord.gg/${code}` } : null;
  }
  if (h === "discord.com" || h === "discordapp.com") {
    if ((parts[0] === "invite" || parts[0] === "invites") && parts[1] && /^[\w-]{2,40}$/.test(parts[1])) return { kind: "discord", value: `discord.gg/${parts[1]}` };
    if (parts[0] === "users" && parts[1] && SNOWFLAKE.test(parts[1])) return { kind: "discord", value: parts[1] };
    return null;
  }
  const key = profileKeyOf(u.toString());
  if (key?.startsWith("instagram:@")) return { kind: "instagram", value: `@${key.slice("instagram:@".length)}` };
  return null;
}

/** The contacts a bio's words give: a labelled WhatsApp number, a labelled Discord username or @Instagram, emails, and
 *  the contact links typed in it. */
export function contactsInText(text: string | null | undefined): { kind: ContactKind; value: string }[] {
  if (!text) return [];
  const out: { kind: ContactKind; value: string }[] = [];
  for (const e of extractEmails(text)) out.push({ kind: "email", value: e });
  for (const u of extractUrls(text)) {
    const c = contactOfUrl(u);
    if (c) out.push(c);
  }
  // "WhatsApp: (11) 98765-4321", "Zap 11 98765 4321", "wpp: +55 21 9…", "📱 Whats - 11987654321"
  for (const m of text.matchAll(/\b(?:whats\s?app|whatsapp|whats|zap\s?zap|zap|wpp|wa)\b[^\d+\n]{0,24}(\+?\d[\d ().-]{8,18}\d)/gi)) {
    const p = phoneOf(m[1]!);
    if (p) out.push({ kind: "whatsapp", value: p });
  }
  // "Discord: fulano", "discord - fulano_123" (a username after a label; invites came with the links above)
  for (const m of text.matchAll(/\bdiscord\s*[:：\-–—]\s*@?([A-Za-z0-9_.]{2,32})(?![\w/:@-]|\.[a-z])/gi)) {
    const v = m[1]!.toLowerCase().replace(/\.+$/, "");
    if (DISCORD_USER.test(v) && !DISCORD_WORDS.has(v) && !/^\d+$/.test(v)) out.push({ kind: "discord", value: v });
    else if (SNOWFLAKE.test(v)) out.push({ kind: "discord", value: v });
  }
  // "Instagram: @fulano", "IG @fulano", "insta: @fulano" (only with the @: a bare word after it is too often not one)
  for (const m of text.matchAll(/\b(?:instagram|insta|ig)\b[^\w\n@]{0,6}@([A-Za-z0-9._]{1,30})/gi)) {
    const v = m[1]!.replace(/\.+$/, "").toLowerCase();
    if (v) out.push({ kind: "instagram", value: `@${v}` });
  }
  return out;
}

const keyOf = (k: ContactKind, v: string): string => `${k}:${k === "whatsapp" ? v.replace(/\D/g, "") : v.toLowerCase().replace(/^@/, "")}`;

/** Each contact once (by channel and value), keeping the first (its source). */
export function dedupeContacts<T extends { kind: ContactKind; value: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = keyOf(c.kind, c.value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Every contact found for a creator: in their bio (`textSource` names it, "YouTube About"), then in their links (each
 * link's own source when it came from a link-in-bio page, else the bio's), then the emails already found (with
 * theirs). Found ones only; the order is CONTACT_ORDER's.
 */
export function findContacts(input: { text?: string | null; textSource: string; links: CreatorLink[]; emails?: { email: string; source: string }[] }): Contact[] {
  const out: Contact[] = [];
  for (const e of input.emails ?? []) out.push({ kind: "email", value: e.email.toLowerCase(), source: e.source });
  for (const c of contactsInText(input.text)) out.push({ ...c, source: input.textSource });
  for (const l of input.links) {
    const c = contactOfUrl(l.url);
    if (c) out.push({ ...c, source: l.source ?? input.textSource });
  }
  const list = dedupeContacts(out);
  return CONTACT_ORDER.flatMap((k) => list.filter((c) => c.kind === k));
}

/** What the platform's bio is called, for a contact found in it. */
export function bioSourceOf(platform: string): string {
  return platform === "youtube" ? "YouTube About" : platform === "tiktok" ? "TikTok bio" : platform === "instagram" ? "Instagram bio" : "bio";
}

/**
 * The ways to contact a lead, best first: what was typed (the detail's Reach, then Add contact's, the typed email and
 * number), then what was found (email, WhatsApp, Instagram, Discord), then, on an Instagram lead, their own profile
 * (a DM). Each once.
 */
export function contactsOf(c: CreatorRecord): Contact[] {
  const typed: Contact[] = [];
  const found: Contact[] = [];
  for (const x of c.contacts ?? []) (x.manual ? typed : found).push(x);
  if (c.email) (c.email_manual ? typed : found).push({ kind: "email", value: c.email, source: c.email_manual ? (c.email_source && c.email_source !== "typed" ? c.email_source : "typed") : (c.email_source ?? bioSourceOf(c.platform)), ...(c.email_manual ? { manual: true } : {}) });
  if (c.whatsapp) {
    const p = phoneOf(c.whatsapp) ?? `+${c.whatsapp.replace(/\D/g, "")}`;
    const src = (c.contacts ?? []).find((x) => x.kind === "whatsapp" && x.value.replace(/\D/g, "") === p.replace(/\D/g, ""))?.source;
    (c.whatsapp_manual ? typed : found).push({ kind: "whatsapp", value: p, source: c.whatsapp_manual ? "typed" : (src ?? bioSourceOf(c.platform)), ...(c.whatsapp_manual ? { manual: true } : {}) });
  }
  const sorted = CONTACT_ORDER.flatMap((k) => found.filter((x) => x.kind === k));
  const own: Contact[] = c.platform === "instagram" && c.handle ? [{ kind: "instagram", value: `@${c.handle.replace(/^@/, "").toLowerCase()}`, source: "Instagram profile" }] : [];
  const rest = [...typed, ...sorted, ...own];
  // the detail's Reach, the one the user picked, leads (keeping where it was found when it was)
  const r = c.reach?.value ? { kind: c.reach.kind, value: c.reach.value } : null;
  const same = r ? rest.find((x) => keyOf(x.kind, x.value) === keyOf(r.kind, r.value)) : undefined;
  return dedupeContacts([...(r ? [{ ...r, source: same?.source ?? "typed", manual: true }] : []), ...rest]);
}

/** How a contact reads on a card: the number spaced, the rest as kept. */
export function contactText(c: { kind: ContactKind; value: string }): string {
  return c.kind === "whatsapp" ? phoneText(c.value) : c.value;
}

/** Where a contact opens (WhatsApp's chat, the Discord invite or user, the Instagram profile); null for an email (copied
 *  instead) and a Discord username (no page). */
export function contactHref(c: { kind: ContactKind; value: string }): string | null {
  const v = c.value.trim();
  if (c.kind === "whatsapp") {
    const d = v.replace(/\D/g, "");
    return d ? `https://wa.me/${d}` : null;
  }
  if (c.kind === "discord") {
    if (/^discord\.gg\//i.test(v)) return `https://${v}`;
    return SNOWFLAKE.test(v) ? `https://discord.com/users/${v}` : null;
  }
  if (c.kind === "instagram") {
    const h = v.replace(/^@/, "");
    return h ? `https://www.instagram.com/${h}/` : null;
  }
  return null;
}

/** A contact typed by hand, as kept ("" value = an error): the email lowercased, the number +<digits>, a Discord invite
 *  as discord.gg/x (or a user ID, or a username), an Instagram @handle. */
export function typedContact(kind: ContactKind, raw: string): { value: string; error: string } {
  const t = raw.trim();
  if (!t) return { value: "", error: "Type it first." };
  if (kind === "email") {
    const e = t.toLowerCase().replace(/^mailto:/, "");
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? { value: e, error: "" } : { value: "", error: "That isn't an email address." };
  }
  if (kind === "whatsapp") {
    const viaLink = /wa\.me|whatsapp\.com/i.test(t) ? contactOfUrl(t) : null;
    const p = viaLink?.value ?? (/^[+\d\s().-]+$/.test(t) ? phoneOf(t) : null);
    return p ? { value: p, error: "" } : { value: "", error: "A WhatsApp number: country code, area code and number." };
  }
  if (kind === "discord") {
    if (/discord(app)?\.(gg|com)|dsc\.gg/i.test(t)) {
      const c = contactOfUrl(t);
      return c?.kind === "discord" ? { value: c.value, error: "" } : { value: "", error: "That isn't a Discord invite or profile link." };
    }
    const v = t.replace(/^@/, "").toLowerCase();
    return SNOWFLAKE.test(v) || DISCORD_USER.test(v) ? { value: v, error: "" } : { value: "", error: "A Discord invite (discord.gg/…), user ID or username." };
  }
  const url = t.match(/instagram\.com\/([^/?#\s]+)/i);
  const h = (url ? url[1]! : t).replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? { value: `@${h.toLowerCase()}`, error: "" } : { value: "", error: "An Instagram handle: letters, numbers, . and _ only." };
}

/**
 * A lead's contacts read again from what it keeps (its bio and links; `emails`: those a read just found on pages, with
 * their sources): typed ones stay first and untouched, found ones are replaced (or, `keepOld`, added to), and a
 * WhatsApp number found fills the number Send writes to when none was there.
 */
export function refreshContacts(c: CreatorRecord, o: { emails?: { email: string; source: string }[]; bioSource?: string; keepOld?: boolean } = {}): void {
  const typed = (c.contacts ?? []).filter((x) => x.manual);
  const old = o.keepOld ? (c.contacts ?? []).filter((x) => !x.manual) : [];
  const found = findContacts({ text: c.description, textSource: o.bioSource ?? bioSourceOf(c.platform), links: c.links, emails: o.emails ?? [] });
  const merged = dedupeContacts([...found, ...old]);
  c.contacts = [...typed, ...CONTACT_ORDER.flatMap((k) => merged.filter((x) => x.kind === k))];
  if (!c.whatsapp_manual && !c.whatsapp) {
    const w = c.contacts.find((x) => x.kind === "whatsapp");
    if (w) c.whatsapp = w.value.replace(/\D/g, "");
  }
}
