// Personal: the user's own contacts, on their own Discord (the Stores login), WhatsApp and Instagram. Pure parts: which
// connections Personal talks through, and how Add contact's one field (a number or a username) becomes who they are.
import { isInstagramId, normWhatsApp, serves, type ConnMeta } from './accounts.ts'
import { isDiscordId } from './data.ts'
import type { LookupResult, Person } from './types.ts'

export type ContactKind = 'discord' | 'whatsapp' | 'instagram'
export const CONTACT_KINDS: ContactKind[] = ['discord', 'whatsapp', 'instagram']
export const isContactKind = (s: unknown): s is ContactKind => typeof s === 'string' && (CONTACT_KINDS as string[]).includes(s)
/** What Add contact takes in any section: Personal's platforms, plus an email (Gmail: Creators' channel). */
export type AddKind = ContactKind | 'gmail'
export const isAddKind = (s: unknown): s is AddKind => s === 'gmail' || isContactKind(s)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The connections with Personal in place: the Stores Discord and WhatsApp (falling back to another section's) also serve
 * Personal when no connection of that kind does yet, and Personal gets an Instagram connection (`instagramId`) when it
 * has none. The same array when nothing changes.
 */
export function personalShares<T extends ConnMeta>(metas: T[], instagramId: string): T[] {
  let out = metas
  for (const kind of ['discord', 'whatsapp'] as const) {
    if (out.some((m) => m.kind === kind && serves(m, 'personal'))) continue
    const of = out.filter((m) => m.kind === kind)
    const pick = of.find((m) => m.id === 'stores') ?? of.find((m) => m.section === 'stores') ?? of.find((m) => m.section !== 'spokpay')
    if (!pick) continue
    out = out.map((m) => (m === pick ? { ...m, also: [...(m.also ?? []), 'personal'] } : m))
  }
  if (!out.some((m) => m.kind === 'instagram' && serves(m, 'personal'))) out = [...out, { id: instagramId, kind: 'instagram', section: 'personal' } as T]
  return out
}

export interface Resolved {
  /** Discord id, WhatsApp number (digits), Instagram user id. */
  id: string
  username: string
  displayName?: string
  /** Discord avatar hash. */
  avatar?: string | null
  /** A picture URL (Instagram's). */
  photo?: string
}

const bare = (s: string) => s.trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '')

/** The words for a field that can't be what it says (null: fine). */
export function contactHandleError(kind: AddKind, handle: string): string | null {
  const h = handle.trim()
  if (kind === 'gmail') return !h ? 'Type their email' : EMAIL.test(h) ? null : 'That isn’t an email address'
  if (!h) return kind === 'whatsapp' ? 'Type their WhatsApp number' : `Type their ${kind === 'discord' ? 'Discord' : 'Instagram'} username`
  if (kind === 'whatsapp') return normWhatsApp(h) ? null : 'That isn’t a phone number: type it with the country code, like +55 11 91234-5678'
  if (kind === 'discord') return /^[\w.]{2,32}$/.test(bare(h)) || isDiscordId(h) ? null : 'A Discord username has 2 to 32 letters, digits, _ or .'
  return /^[\w.]{1,30}$/.test(bare(h)) ? null : 'An Instagram username has up to 30 letters, digits, _ or .'
}

/**
 * Add contact's field resolved through the platform (`lookup` = the connection's): a WhatsApp number that is on WhatsApp,
 * a Discord username matched exactly (or an id), an Instagram username matched exactly. Throws the reason otherwise.
 */
export async function resolveContact(kind: AddKind, handle: string, lookup: (q: string) => Promise<LookupResult>): Promise<Resolved> {
  const bad = contactHandleError(kind, handle)
  if (bad) throw new Error(bad)
  // an email is who they are: nothing to look up (Gmail finds no one by address)
  if (kind === 'gmail') return { id: handle.trim().toLowerCase(), username: handle.trim() }
  if (kind === 'whatsapp') {
    const typed = normWhatsApp(handle)
    const r = await lookup(typed)
    const u = r.matches[0]
    if (!u) throw new Error(r.notes?.[0] ?? `+${typed} isn’t on WhatsApp`)
    const out: Resolved = { id: u.id, username: u.username }
    if (u.globalName) out.displayName = u.globalName
    return out
  }
  const name = bare(handle)
  const r = await lookup(kind === 'discord' && isDiscordId(handle.trim()) ? handle.trim() : name)
  const want = name.toLowerCase()
  const u = r.matches.find((m) => m.id === handle.trim() || m.username.toLowerCase() === want)
  if (!u) {
    if (r.notes?.length && !r.matches.length) throw new Error(r.notes[0]!)
    throw new Error(kind === 'discord'
      ? `No Discord user @${name} found. Discord only finds people you share a server or a DM with.`
      : `No Instagram account @${name} found.`)
  }
  if (kind === 'instagram' && !isInstagramId(u.id)) throw new Error(`Instagram didn’t say who @${name} is`)
  const out: Resolved = { id: u.id, username: u.username }
  if (u.globalName) out.displayName = u.globalName
  if (kind === 'discord') out.avatar = u.avatar ?? null
  else if (u.avatarUrl) out.photo = u.avatarUrl
  return out
}

/** Two names for the same person: equal, or one inside the other ("Filipe" / "Filipe Sales"), case and accents aside. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  const x = n(a), y = n(b)
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x))
}

/** Add contact can't go on without the user's say-so: why (shown in the form) and what the button then says. */
export class ContactConflict extends Error {
  constructor(message: string, readonly confirm: string, readonly personId: string | null, readonly current: string) {
    super(message)
  }
}

/**
 * Whether Add contact needs a confirm first: the number/account is already `existing` (someone in Persons) under another
 * name than the one typed (Rename only on confirm), or WhatsApp itself names it otherwise (`platformName`: the address
 * book's or the account's own name), so a mistyped number isn't added as someone else. Null: go on.
 */
export function contactConflict(o: { typed: string; handle: string; existing: { id: string; label: string; inPersonal: boolean } | null; platformName?: string | undefined; section?: string }): ContactConflict | null {
  const typed = o.typed.trim()
  if (!typed) return null
  if (o.existing) {
    if (sameName(typed, o.existing.label)) return null
    // `inPersonal`: already in the section added to (`section`, Personal unless said)
    const where = o.existing.inPersonal ? `in ${o.section ?? 'Personal'}` : 'in Persons'
    return new ContactConflict(`${o.handle} is already ${o.existing.label} (${where}). Check the number, or press Rename to call ${o.existing.label} “${typed}”.`, 'Rename', o.existing.id, o.existing.label)
  }
  if (o.platformName && !sameName(typed, o.platformName)) return new ContactConflict(`${o.handle} is “${o.platformName}” on your WhatsApp, not ${typed}. Check the number, or press Add anyway.`, 'Add anyway', null, o.platformName)
  return null
}

/**
 * A WhatsApp number to save in the user's WhatsApp contacts after a person changed (`before` absent = just created): when
 * they're in Personal with a number and a name, and the number is new to them there (set, changed, or they just joined
 * Personal). Null otherwise: nothing to save.
 */
export function whatsAppContactToSave(before: Person | undefined, after: Person | undefined): { number: string; name: string } | null {
  if (!after?.listIds.includes('personal')) return null
  const number = normWhatsApp(after.whatsapp ?? '')
  const name = (after.name || after.displayName || '').trim()
  if (!number || !name) return null
  if (before?.listIds.includes('personal') && normWhatsApp(before.whatsapp ?? '') === number) return null
  return { number, name }
}
