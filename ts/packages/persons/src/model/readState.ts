import { isDiscordId, isEmail } from './data.ts'
import { chatsFor, facets, KINDS, normPhone, peerOf, SECTIONS, seenKey, validPeer, type ChannelKind, type ChatRef, type ConnMeta, type SectionId } from './accounts.ts'
import type { AppData, Conversation, Person } from './types.ts'

/**
 * Read state: per person, `seen["<connection id>:<identifier>"]` = the time of the newest message
 * seen in the app for that chat. Older files have per-connection keys (`seen["stores"]`) and keys of
 * connections that were removed and added again under a new id; `migrateSeen` moves those.
 */

const time = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : NaN }
/** The later of two read marks (by time: Discord writes "+00:00", Gmail "Z"). */
export const laterMark = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : time(b) > time(a) ? b : a)

/** The read mark of one chat (a legacy per-connection key still counts). */
export const seenOf = (p: Person, connId: string, peer: string): string | undefined => p.seen?.[seenKey(connId, peer)] ?? p.seen?.[connId]

/**
 * Unread messages from them: newer than what was seen in the app. Never opened here: newer than
 * `readSince`, plus older ones the platform still marks unread. Compared by time, not as strings.
 */
export function unreadSince(conv: Conversation | undefined, seen: string | undefined, readSince: string | undefined): number {
  const s = time(seen), since = time(readSince)
  let n = 0
  for (const m of conv?.messages ?? []) {
    if (m.fromMe) continue
    const t = time(m.timestamp)
    if (seen ? t > s : (readSince ? t > since : false) || m.unread === true) n++
  }
  return n
}

/** The fields of a connection the badge needs. */
export type BadgeConn = ConnMeta & { convos: Record<string, Conversation> }

/** Unread count of a person's chat on one connection (`peer`: who they are there, default their own identifier). */
export function chatUnread(p: Person, c: BadgeConn, readSince: string | undefined, peer = peerOf(p, c.kind, c.section)): number {
  if (!peer) return 0
  return unreadSince(c.convos[peer], seenOf(p, c.id, peer), readSince)
}

/**
 * The chats a person's card counts from a section (null = All people: all of their sections;
 * a person in no section: every connection they, or someone linked into them, have an identifier on).
 */
export function badgeChats<T extends ConnMeta>(p: Person, conns: T[], section: SectionId | null): ChatRef<T>[] {
  if (section) return chatsFor(p, conns, section)
  const mine = chatsFor(p, conns, null)
  if (mine.length) return mine
  const out: ChatRef<T>[] = []
  for (const f of facets(p)) for (const conn of conns) {
    const peer = peerOf(f, conn.kind, conn.section)
    if (validPeer(conn.kind, peer) && !out.some((x) => x.conn.id === conn.id && x.peer === peer)) out.push({ conn, peer })
  }
  return out
}

/** The connections of badgeChats (one entry per chat). */
export function badgeChannels<T extends ConnMeta>(p: Person, conns: T[], section: SectionId | null): T[] {
  return badgeChats(p, conns, section).map((c) => c.conn)
}

/** A person's badge: unread messages over the chats they have from a section. */
export function personUnread(p: Person, conns: BadgeConn[], section: SectionId | null, readSince: string | undefined): number {
  let n = 0
  for (const c of badgeChats(p, conns, section)) n += chatUnread(p, c.conn, readSince, c.peer)
  return n
}

/** Section and kind a connection id stands for: the original three, or the shell's "<section>-<kind>-<random>". */
function connShape(id: string): { section?: SectionId; kind?: ChannelKind } {
  if (id === 'stores' || id === 'spokpay') return { section: id, kind: 'discord' }
  if (id === 'gmail' || id === 'creators') return { section: 'creators', kind: id === 'gmail' ? 'gmail' : 'discord' }
  const [section = '', kind = ''] = id.split('-')
  const out: { section?: SectionId; kind?: ChannelKind } = {}
  if ((SECTIONS as string[]).includes(section)) out.section = section as SectionId
  if ((KINDS as string[]).includes(kind)) out.kind = kind as ChannelKind
  return out
}
/** The kind an identifier belongs to, by its shape. */
const kindOfPeer = (peer: string): ChannelKind | undefined => (isEmail(peer) ? 'gmail' : isDiscordId(peer) ? 'discord' : normPhone(peer) === peer ? 'whatsapp' : undefined)

/**
 * Moves a person's read marks to the current connections: legacy per-connection keys become
 * "<connection>:<identifier>", and keys of a connection that no longer exists move to the current one
 * of the same section and kind (a reconnected Gmail gets a new id). Marks without a home are kept.
 * Returns the same object when nothing changes.
 */
export function migrateSeen(p: Person, conns: ConnMeta[]): Person {
  if (!p.seen || !conns.length) return p
  const ids = new Set(conns.map((c) => c.id))
  const out: Record<string, string> = {}
  let changed = false
  const put = (k: string, v: string) => { out[k] = laterMark(out[k], v)! }
  for (const [k, v] of Object.entries(p.seen)) {
    const i = k.indexOf(':')
    const connId = i < 0 ? k : k.slice(0, i)
    let peer = i < 0 ? '' : k.slice(i + 1)
    if (ids.has(connId) && peer) { put(k, v); continue }
    const shape = connShape(connId)
    const kind = shape.kind ?? (peer ? kindOfPeer(peer) : undefined)
    const target = ids.has(connId) ? conns.find((c) => c.id === connId)
      : conns.find((c) => c.kind === kind && (!shape.section || c.section === shape.section) && (!peer || peerOf(p, c.kind, c.section) === peer))
    if (target && !peer) peer = peerOf(p, target.kind, target.section)
    if (!target || !validPeer(target.kind, peer)) { put(k, v); continue }
    put(seenKey(target.id, peer), v)
    changed = true
  }
  return changed ? { ...p, seen: out } : p
}

/** Every person's read marks moved to the current connections (same object when nothing changes). */
export function migrateAllSeen(d: AppData, conns: ConnMeta[]): AppData {
  let changed = false
  const people = d.people.map((p) => { const n = migrateSeen(p, conns); if (n !== p) changed = true; return n })
  return changed ? { ...d, people } : d
}

/**
 * Three-way merge of read marks. `local` changed some since `base` (the file as last read or written);
 * `remote` is the file now (another window or the phone wrote it). Marks changed locally win; the
 * rest come from `remote`. The result is `into` (one of the two documents) with merged `seen` maps, so
 * an older snapshot written elsewhere can't take back chats that were read here, and vice versa.
 */
export function mergeSeen(into: AppData, base: AppData | null, local: AppData, remote: AppData): AppData {
  const by = (d: AppData | null) => new Map((d?.people ?? []).map((p) => [p.id, p.seen ?? {}]))
  const b = by(base), l = by(local), r = by(remote)
  let changed = false
  const people = into.people.map((p) => {
    const bs = b.get(p.id) ?? {}, ls = l.get(p.id) ?? {}, rs = r.get(p.id) ?? {}
    const seen: Record<string, string> = {}
    for (const k of new Set([...Object.keys(bs), ...Object.keys(ls), ...Object.keys(rs)])) {
      const v = ls[k] !== bs[k] ? ls[k] : rs[k]
      if (v) seen[k] = v
    }
    const cur = p.seen ?? {}
    if (JSON.stringify(Object.entries(seen).sort()) === JSON.stringify(Object.entries(cur).sort())) return p
    changed = true
    const n = { ...p }
    if (Object.keys(seen).length) n.seen = seen
    else delete n.seen
    return n
  })
  return changed ? { ...into, people } : into
}

/**
 * The chat a person's composer sends on: the one their latest message came in on (they're answered where they
 * wrote), else the most recent conversation, else the first.
 */
export function defaultChat<T extends BadgeConn>(p: Person, choices: ChatRef<T>[], _readSince?: string): ChatRef<T> | undefined {
  const msgs = (c: ChatRef<T>) => c.conn.convos[c.peer]?.messages ?? []
  const lastIn = (c: ChatRef<T>) => time(msgs(c).findLast((m) => !m.fromMe)?.timestamp) || 0
  const lastAny = (c: ChatRef<T>) => time(msgs(c).at(-1)?.timestamp) || 0
  return [...choices].sort((a, b) => lastIn(b) - lastIn(a) || lastAny(b) - lastAny(a))[0]
}
