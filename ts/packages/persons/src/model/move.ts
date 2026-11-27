// Move to… (a person row's menu): the person leaves where they are (a store, Creators or SpokPay) and joins the place
// picked. Nothing else of theirs changes: identifiers, read state, notes, pictures, socials and links stay as they were.
// When the section changes, the old section's chats come along (`carried`: its connections still show their history
// and can still be picked in the composer), their per-section identities follow them, and so does Settled. The Person
// AI chat follows in the service (PersonAi.move). Pure, so it is unit tested; nothing is sent anywhere.
import { DEFAULT_LISTS } from './data.ts'
import type { AppData, Person, SectionId } from './types.ts'

/** A place a person can be in: a store (in Stores), or the Creators / SpokPay / Neobux / Personal list. */
export type ListSection = 'creators' | 'spokpay' | 'neobux' | 'personal'
export const LIST_SECTIONS: readonly ListSection[] = ['creators', 'spokpay', 'neobux', 'personal']
export const isListSection = (s: string): s is ListSection => (LIST_SECTIONS as readonly string[]).includes(s)
export type Place = { section: 'stores'; store: string } | { section: ListSection }

export const samePlace = (a: Place, b: Place): boolean => a.section === b.section && (a.section !== 'stores' || a.store === (b as { store: string }).store)

/** Every place a person is in: their stores (and the ones they own), then their lists that are sections. */
export function placesOf(p: Person, d: Pick<AppData, 'stores'>): Place[] {
  const stores = [...p.storeIds, ...d.stores.filter((s) => s.ownerId === p.id && !p.storeIds.includes(s.id)).map((s) => s.id)]
  return [...stores.map((store): Place => ({ section: 'stores', store })), ...p.listIds.filter(isListSection).map((section): Place => ({ section }))]
}

/** A place from the UI's words: "creators", "spokpay", "neobux", "personal" or "store:<id>". */
export function parsePlace(s: string): Place | null {
  if (isListSection(s)) return { section: s }
  if (s.startsWith('store:') && s.length > 6) return { section: 'stores', store: s.slice(6) }
  return null
}

export interface MoveResult {
  data: AppData
  /** The sections they left entirely (their AI chat follows them from there to `to.section`). */
  left: SectionId[]
}

/**
 * Moves person `id` from `from` (the place the menu was opened in; null = everywhere they are, as All people) to `to`.
 * Null when there's nothing to do (no such person or store, or already only there).
 */
export function movePerson(d: AppData, id: string, from: Place | null, to: Place, at = new Date().toISOString()): MoveResult | null {
  const p = d.people.find((x) => x.id === id)
  if (!p) return null
  if (to.section === 'stores' && !d.stores.some((s) => s.id === to.store)) return null
  const before = placesOf(p, d)
  const leaving = (from ? before.filter((x) => samePlace(x, from)) : before).filter((x) => !samePlace(x, to))
  const already = before.some((x) => samePlace(x, to))
  if (!leaving.length && already) return null

  const leftStores = new Set(leaving.flatMap((x) => (x.section === 'stores' ? [x.store] : [])))
  const leftLists = new Set<string>(leaving.flatMap((x) => (x.section !== 'stores' ? [x.section] : [])))
  let n: Person = { ...p, updatedAt: at }
  n.storeIds = p.storeIds.filter((s) => !leftStores.has(s))
  n.listIds = p.listIds.filter((l) => !leftLists.has(l))
  if (to.section === 'stores') {
    if (!n.storeIds.includes(to.store)) n.storeIds = [...n.storeIds, to.store]
  } else if (!n.listIds.includes(to.section)) n.listIds = [...n.listIds, to.section]

  // stores they owned and left lose their owner (the store stays)
  const stores = d.stores.map((s) => (s.ownerId === id && leftStores.has(s.id) ? (({ ownerId: _, ...rest }) => rest)(s) : s))
  const lists = to.section !== 'stores' && !d.lists.some((l) => l.id === to.section) ? [...d.lists, { ...DEFAULT_LISTS.find((l) => l.id === to.section)! }] : d.lists

  // the sections they are no longer in at all
  const still = new Set(placesOf(n, { stores }).map((x) => x.section))
  const left = [...new Set(leaving.map((x) => x.section))].filter((s) => !still.has(s))
  for (const s of left) n = carry(n, s, to.section)
  if (n.carried?.includes(to.section)) {
    const rest = n.carried.filter((s) => s !== to.section)
    if (rest.length) n.carried = rest
    else delete n.carried
  }
  return { data: { ...d, stores, lists, people: d.people.map((x) => (x.id === id ? n : x)), updatedAt: at }, left }
}

/** What leaving section `from` for `to` keeps: its chats (carried), its identities (copied to `to` where it has none) and Settled. */
function carry(p: Person, from: SectionId, to: SectionId): Person {
  if (from === to) return p
  const n: Person = { ...p, carried: [...new Set([...(p.carried ?? []), from])] }
  // an identity for the old section stays (its carried chats are found by it) and gets a copy for the new one
  const copies = (p.identities ?? []).filter((i) => i.section === from && !p.identities!.some((j) => j.kind === i.kind && j.section === to)).map((i) => ({ ...i, section: to }))
  if (copies.length) n.identities = [...p.identities!, ...copies]
  const mark = p.settled?.[from]
  if (mark && !p.settled?.[to]) {
    const { [from]: _, ...rest } = p.settled!
    n.settled = { ...rest, [to]: mark }
  }
  return n
}
