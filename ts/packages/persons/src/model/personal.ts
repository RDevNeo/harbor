// Personal: the user's own contacts, on their own Discord (the Stores login), WhatsApp and Instagram. Pure parts: which
// connections Personal talks through, and how Add contact's one field (a number or a username) becomes who they are.
import { isInstagramId, normWhatsApp, serves, type ConnMeta } from './accounts.ts'
import { isDiscordId } from './data.ts'
import type { LookupResult } from './types.ts'

export type ContactKind = 'discord' | 'whatsapp' | 'instagram'
export const CONTACT_KINDS: ContactKind[] = ['discord', 'whatsapp', 'instagram']
export const isContactKind = (s: unknown): s is ContactKind => typeof s === 'string' && (CONTACT_KINDS as string[]).includes(s)

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
export function contactHandleError(kind: ContactKind, handle: string): string | null {
  const h = handle.trim()
  if (!h) return kind === 'whatsapp' ? 'Type their WhatsApp number' : `Type their ${kind === 'discord' ? 'Discord' : 'Instagram'} username`
  if (kind === 'whatsapp') return normWhatsApp(h) ? null : 'That isn’t a phone number: type it with the country code, like +55 11 91234-5678'
  if (kind === 'discord') return /^[\w.]{2,32}$/.test(bare(h)) || isDiscordId(h) ? null : 'A Discord username has 2 to 32 letters, digits, _ or .'
  return /^[\w.]{1,30}$/.test(bare(h)) ? null : 'An Instagram username has up to 30 letters, digits, _ or .'
}

/**
 * Add contact's field resolved through the platform (`lookup` = the connection's): a WhatsApp number that is on WhatsApp,
 * a Discord username matched exactly (or an id), an Instagram username matched exactly. Throws the reason otherwise.
 */
export async function resolveContact(kind: ContactKind, handle: string, lookup: (q: string) => Promise<LookupResult>): Promise<Resolved> {
  const bad = contactHandleError(kind, handle)
  if (bad) throw new Error(bad)
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
