// Link with… / Unlink: the same human known as two or more people (Evellin on Discord, Evellin again on WhatsApp)
// becomes one. The person picked first stays (their id, name, AI chats); each other one is kept whole inside them
// (`links`, with their own id, identities, notes and read state), so Unlink brings them back as they were. Their
// identifiers fill the primary's empty ones; the rest stay reachable through `facets` (accounts.ts), which is how
// chats, badges, tracking and search see every channel of a linked person.
import { LINK_FIELDS, personLabel } from './data.ts'
import { allPeers, KINDS, SECTIONS } from './accounts.ts'
import { laterMark } from './readState.ts'
import type { AppData, Identity, LinkAdded, Person, PersonLink } from './types.ts'

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** The heading their notes go under in the person they join. */
export const notesHeading = (name: string) => `— ${name} —`

/** Profile fields that go with an identifier: copied (and taken back) together with it. */
const GROUPS: { key: 'discordId' | 'email' | 'whatsapp'; with: string[] }[] = [
  { key: 'discordId', with: ['discordUsername', 'displayName', 'avatar', 'profileAt'] },
  { key: 'email', with: ['photo', 'photoAt', 'photoFull'] },
  { key: 'whatsapp', with: [] },
]

type Fields = Record<string, string | boolean | null | undefined>
const fieldsOf = (p: Person): Fields => p as unknown as Fields

/**
 * Settled per section after a link: a section stays settled only when everyone in it was settled there (the
 * latest mark); someone still active there keeps the person active.
 */
function mergeSettled(parts: Person[], sectionsOf: (p: Person) => string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const sec of SECTIONS) {
    const inSec = parts.filter((p) => sectionsOf(p).includes(sec) || p.settled?.[sec])
    if (!inSec.length || inSec.some((p) => !p.settled?.[sec])) continue
    out[sec] = inSec.map((p) => p.settled![sec]!).sort((a, b) => time(b) - time(a))[0]!
  }
  return Object.keys(out).length ? out : undefined
}

const sectionsOf = (d: Pick<AppData, 'stores'>) => (p: Person): string[] => [
  ...(p.storeIds.length || d.stores.some((s) => s.ownerId === p.id) ? ['stores'] : []),
  ...p.listIds.filter((l) => (SECTIONS as string[]).includes(l)),
]

/** `other` joined into `into`: the merged person (`into`'s id) and what was added, for Unlink. */
export function mergeInto(into: Person, other: Person, d: Pick<AppData, 'stores'>, at = new Date().toISOString()): Person {
  const next: Person = { ...into }
  const f = fieldsOf(next), o = fieldsOf(other)
  const added: LinkAdded = { fields: {}, identities: [], storeIds: [], listIds: [], socials: [], notes: '', owned: [] }
  // identifiers (and the profile that goes with them) into empty slots; taken ones stay theirs, reached through facets
  for (const g of GROUPS) {
    if (f[g.key] || !o[g.key]) continue
    for (const k of [g.key, ...g.with]) {
      if (o[k] === undefined || (f[k] !== undefined && f[k] !== '')) continue
      f[k] = o[k]
      added.fields[k] = o[k] as string | boolean | null
    }
  }
  if (!next.name && other.name) {
    next.name = other.name
    added.fields.name = other.name
  }
  // their per-section identities where the person has none of that kind in that section
  const ids: Identity[] = [...(next.identities ?? [])]
  for (const i of other.identities ?? []) {
    if (ids.some((x) => x.kind === i.kind && x.section === i.section)) continue
    ids.push(i)
    added.identities.push(i)
  }
  if (ids.length) next.identities = ids
  // stores, lists and socials: the union
  added.storeIds = other.storeIds.filter((s) => !next.storeIds.includes(s))
  added.listIds = other.listIds.filter((l) => !next.listIds.includes(l))
  next.storeIds = [...next.storeIds, ...added.storeIds]
  next.listIds = [...next.listIds, ...added.listIds]
  added.socials = (other.socials ?? []).filter((u) => !(next.socials ?? []).includes(u))
  if (added.socials.length) next.socials = [...(next.socials ?? []), ...added.socials]
  // notes: theirs under a heading with their name
  const theirs = other.notes?.trim()
  if (theirs && !(next.notes ?? '').includes(theirs)) {
    added.notes = `${next.notes?.trim() ? '\n\n' : ''}${notesHeading(personLabel(other))}\n${theirs}`
    next.notes = `${next.notes?.trim() ?? ''}${added.notes}`
  }
  // stores they owned
  added.owned = d.stores.filter((s) => s.ownerId === other.id).map((s) => s.id)
  // read state: the later mark of each chat; settled: only where everyone was
  const seen: Record<string, string> = { ...next.seen }
  for (const [k, v] of Object.entries(other.seen ?? {})) seen[k] = laterMark(seen[k], v)!
  if (Object.keys(seen).length) next.seen = seen
  const settled = mergeSettled([into, other], sectionsOf(d))
  if (settled) next.settled = settled
  else delete next.settled
  const dropped = Object.fromEntries(Object.entries(into.settled ?? {}).filter(([sec]) => !settled?.[sec]))
  if (Object.keys(dropped).length) added.unsettled = dropped
  next.links = [...(into.links ?? []), { person: other, at, added }]
  next.updatedAt = at
  return next
}

export interface LinkResult {
  data: AppData
  person: Person
  /** The ids that joined (those found, not the primary). */
  linked: string[]
}

/** `ids` linked into `primaryId`: they leave the list and live inside the primary (Unlink brings them back). */
export function linkPeople(d: AppData, primaryId: string, ids: string[], at = new Date().toISOString()): LinkResult | null {
  let primary = d.people.find((p) => p.id === primaryId)
  if (!primary) return null
  const others = [...new Set(ids)].filter((id) => id !== primaryId).map((id) => d.people.find((p) => p.id === id)).filter((p): p is Person => !!p)
  if (!others.length) return null
  for (const o of others) primary = mergeInto(primary, o, d, at)
  const gone = new Set(others.map((o) => o.id))
  const person = primary
  return {
    person,
    linked: others.map((o) => o.id),
    data: {
      ...d,
      people: d.people.filter((p) => !gone.has(p.id)).map((p) => (p.id === primaryId ? person : p)),
      stores: d.stores.map((s) => (s.ownerId && gone.has(s.ownerId) ? { ...s, ownerId: primaryId } : s)),
    },
  }
}

/** Whether a read mark ("<connection>:<identifier>") is for one of a person's identifiers. */
function ownsSeenKey(p: Person, key: string): boolean {
  const peer = key.slice(key.indexOf(':') + 1)
  return KINDS.some((k) => allPeers(p, k).includes(peer))
}

/**
 * `linkedId` taken back out of `personId`: they come back as they were when linked (with read marks made since
 * on their chats), and the person loses what the link gave them, where it is still the same.
 */
export function unlinkPerson(d: AppData, personId: string, linkedId: string, at = new Date().toISOString()): { data: AppData; person: Person; restored: Person } | null {
  const p = d.people.find((x) => x.id === personId)
  const link = p?.links?.find((l) => l.person.id === linkedId)
  if (!p || !link || d.people.some((x) => x.id === linkedId)) return null
  const a = link.added
  const next: Person = { ...p, links: p.links!.filter((l) => l !== link), updatedAt: at }
  if (!next.links!.length) delete next.links
  const f = fieldsOf(next)
  for (const g of GROUPS) {
    if (!(g.key in a.fields) || f[g.key] !== a.fields[g.key]) continue
    for (const k of [g.key, ...g.with]) {
      if (!(k in a.fields)) continue
      if (k === 'discordId') f[k] = ''
      else delete f[k]
    }
  }
  if ('name' in a.fields && next.name === a.fields.name) next.name = ''
  const back = new Set(a.identities.map((i) => `${i.kind}|${i.section}|${i.value}`))
  const ids = (next.identities ?? []).filter((i) => !back.has(`${i.kind}|${i.section}|${i.value}`))
  if (ids.length) next.identities = ids
  else delete next.identities
  next.storeIds = next.storeIds.filter((s) => !a.storeIds.includes(s))
  next.listIds = next.listIds.filter((l) => !a.listIds.includes(l))
  const socials = (next.socials ?? []).filter((u) => !a.socials.includes(u))
  if (socials.length) next.socials = socials
  else delete next.socials
  if (a.notes && next.notes?.includes(a.notes)) {
    const n = next.notes.replace(a.notes, '').trim()
    if (n) next.notes = n
    else delete next.notes
  }
  // settled again where only the link had made them active
  for (const [sec, mark] of Object.entries(a.unsettled ?? {})) if (!next.settled?.[sec]) next.settled = { ...next.settled, [sec]: mark }
  // a person with nothing left to show keeps a name
  if (!next.name && !next.discordId && !next.discordUsername && !next.email && !next.whatsapp) next.name = personLabel(p)
  // they come back with the read marks made on their chats meanwhile
  const restored: Person = { ...link.person, updatedAt: at }
  const seen: Record<string, string> = { ...restored.seen }
  for (const [k, v] of Object.entries(p.seen ?? {})) if (ownsSeenKey(link.person, k)) seen[k] = laterMark(seen[k], v)!
  if (Object.keys(seen).length) restored.seen = seen
  // the merged person stays settled where they were and are now in no section shared with them
  const people = d.people.map((x) => (x.id === personId ? next : x))
  people.splice(people.indexOf(next) + 1, 0, restored)
  return {
    person: next,
    restored,
    data: {
      ...d,
      people,
      stores: d.stores.map((s) => (s.ownerId === personId && a.owned.includes(s.id) ? { ...s, ownerId: linkedId } : s)),
    },
  }
}

/** The people linked into a person (top level), for the panel and the menus' Unlink. */
export const linksOf = (p: Person): PersonLink[] => p.links ?? []
