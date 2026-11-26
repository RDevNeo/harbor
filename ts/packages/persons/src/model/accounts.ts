import type { Person } from './types.ts'
import { isDiscordId, isEmail, type Scope } from './data.ts'

/**
 * Channels: every section (Stores, Creators, SpokPay) can connect any number of integrations —
 * Discord, Gmail, WhatsApp — each its own account (a "connection", id from the shell). A person has
 * an identifier per kind (Discord id, email, WhatsApp number); their chat uses one connection.
 */
export type ChannelKind = 'discord' | 'gmail' | 'whatsapp'
export type SectionId = 'stores' | 'creators' | 'spokpay'
/** A connection's id (the shell's: "stores", "spokpay", "gmail" for the original three, else generated). */
export type AccountId = string

export const KINDS: ChannelKind[] = ['discord', 'gmail', 'whatsapp']
export const KIND_LABEL: Record<ChannelKind, string> = { discord: 'Discord', gmail: 'Gmail', whatsapp: 'WhatsApp' }
export const SECTIONS: SectionId[] = ['stores', 'creators', 'spokpay']
export const SECTION_LABEL: Record<SectionId, string> = { stores: 'Stores', creators: 'Creators', spokpay: 'SpokPay' }
export const isSection = (s: string): s is SectionId => (SECTIONS as string[]).includes(s)

export interface ConnMeta {
  id: AccountId
  kind: ChannelKind
  section: SectionId
}

/** A WhatsApp number as kept: digits with the country code (8–15). */
export const normPhone = (s: string) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 8 && d.length <= 15 ? d : '' }
/**
 * A typed WhatsApp number (the shell's normWhatsApp): digits with the country code; Brazilian
 * numbers without it get 55, and mobiles their 9th digit.
 */
export function normWhatsApp(s: string): string {
  const raw = String(s ?? '').trim()
  let d = raw.replace(/\D/g, '')
  if (!raw.startsWith('+') && d.startsWith('0')) d = d.replace(/^0+/, '')
  if (!raw.startsWith('+') && /^[1-9][1-9](?:9\d{8}|[2-9]\d{7})$/.test(d)) d = `55${d}`
  if (/^55[1-9][1-9][6-9]\d{7}$/.test(d)) d = `${d.slice(0, 4)}9${d.slice(4)}`
  return normPhone(d)
}
/** The same Brazilian mobile with and without its 9th digit (both may be someone's WhatsApp). */
export function phoneVariants(digits: string): string[] {
  const d = normPhone(digits)
  if (!d) return []
  const m = /^55([1-9][1-9])9(\d{8})$/.exec(d)
  return m && /^[6-9]/.test(m[2] ?? "") ? [d, `55${m[1]}${m[2]}`] : [d]
}

/**
 * Who the person is on a kind of channel: Discord id, email address or WhatsApp number. With a
 * `section`, an identity of theirs for that section wins over the default (the person's own fields).
 */
export function peerOf(p: Person, kind: ChannelKind, section?: SectionId): string {
  const own = section ? p.identities?.find((i) => i.kind === kind && i.section === section) : undefined
  if (own) return own.value
  if (kind === 'gmail') return (p.email ?? '').toLowerCase()
  if (kind === 'whatsapp') return normPhone(p.whatsapp ?? '')
  return p.discordId
}

/** Every identifier the person has on a kind (default and per-section, theirs and their linked people's), for tracking and duplicates. */
export function allPeers(p: Person, kind: ChannelKind): string[] {
  return [...new Set(facets(p).flatMap((f) => [peerOf(f, kind), ...(f.identities ?? []).filter((i) => i.kind === kind).map((i) => i.value)]).filter((v) => validPeer(kind, v)))]
}

/**
 * The person and everyone linked into them (Link with…, link.ts), each with the person's own stores and lists: one
 * human on several channels. Their own identifiers come first.
 */
export function facets(p: Person): Person[] {
  const out: Person[] = [p]
  const walk = (x: Person, depth: number): void => {
    for (const l of x.links ?? []) {
      out.push({ ...l.person, storeIds: p.storeIds, listIds: p.listIds })
      if (depth < 8) walk(l.person, depth + 1)
    }
  }
  walk(p, 0)
  return out
}

/** One chat with a person: a connection and who they are on it. */
export interface ChatRef<T extends ConnMeta = ConnMeta> {
  conn: T
  peer: string
}

/** A chat's key ("<connection id>:<identifier>", as read state's): what the API's `account` carries. */
export const chatKey = (c: { conn: { id: string }; peer: string }) => seenKey(c.conn.id, c.peer)

/**
 * Every chat a person has from a section (channelsFor over them and their linked people): one per connection and
 * identifier, so two WhatsApp numbers of a linked person are two chats on the same connection.
 */
export function chatsFor<T extends ConnMeta>(p: Person, conns: T[], from: SectionId | null): ChatRef<T>[] {
  const out: ChatRef<T>[] = []
  const seen = new Set<string>()
  for (const f of facets(p)) {
    for (const conn of channelsFor(f, conns, from)) {
      const peer = peerOf(f, conn.kind, conn.section)
      const k = seenKey(conn.id, peer)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ conn, peer })
    }
  }
  return out
}

/** The chat an API call names: `account` is a chat key (or a connection id alone: its first chat), else none. */
export function pickChat<T extends ConnMeta>(chats: ChatRef<T>[], account: string | null | undefined): ChatRef<T> | undefined {
  if (!account) return undefined
  return chats.find((c) => chatKey(c) === account) ?? chats.find((c) => c.conn.id === account)
}

/** Read-state key of a chat: the connection and who the person is on it. */
export const seenKey = (connId: string, peer: string) => `${connId}:${peer}`
export function validPeer(kind: ChannelKind, s: string): boolean {
  return kind === 'gmail' ? isEmail(s) : kind === 'whatsapp' ? !!normPhone(s) && normPhone(s) === s : isDiscordId(s)
}

/** The section a sidebar view belongs to (All people: none). */
export const sectionOfScope = (s: Scope): SectionId | null => (s.kind === 'store' ? 'stores' : s.kind === 'list' && isSection(s.id) ? s.id : null)

/** The sections a person is in: Stores when in any store, plus their lists (Creators, SpokPay). */
export function personSections(p: Person): SectionId[] {
  const out: SectionId[] = []
  if (p.storeIds.length) out.push('stores')
  for (const l of p.listIds) if (isSection(l) && !out.includes(l)) out.push(l)
  return out
}

/**
 * The connections a person can be talked to through: those of the section they were opened from
 * (or of all their sections from All people), then those of the sections they were moved out of (`carried`), for
 * kinds the person has an identifier for.
 */
export function channelsFor<T extends ConnMeta>(p: Person, conns: T[], from: SectionId | null): T[] {
  const mine = personSections(p)
  // chats of the sections they were moved out of (Move to…) come along, after the section's own
  const carried = (p.carried ?? []).filter((s) => !mine.includes(s))
  const sections = [...(from ? [from] : mine), ...carried.filter((s) => s !== from)]
  const rank = (c: T) => sections.indexOf(c.section)
  return conns.filter((c) => rank(c) >= 0 && validPeer(c.kind, peerOf(p, c.kind, c.section))).sort((a, b) => rank(a) - rank(b))
}
