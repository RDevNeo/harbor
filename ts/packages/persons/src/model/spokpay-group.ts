// SpokPay's two sub-categories, Clients and Leads (the sidebar shows them as Stores shows its stores). Everyone who joins
// SpokPay (Add contact, Move to, a send from Collector or Persons, an import…) is a Lead: a person in SpokPay without
// `spokpayGroup` is one. The user moves people by hand (Move to Clients / Move to Leads). Version 8 of data.json made
// everyone already in SpokPay a Client (normalizeData, once: a file at version 8 is never migrated again). The field is
// only kept while they're in SpokPay (tidyGroups), so someone who leaves and comes back is a Lead again. Pure, so it is
// unit tested.
import type { AppData, Person, SpokpayGroup } from './types.ts'

export const SPOKPAY_GROUPS: readonly SpokpayGroup[] = ['clients', 'leads']
export const GROUP_LABEL: Record<SpokpayGroup, string> = { clients: 'Clients', leads: 'Leads' }
export const isSpokpayGroup = (s: unknown): s is SpokpayGroup => s === 'clients' || s === 'leads'

/** Their SpokPay sub-category, or null when they aren't in SpokPay. */
export const groupOf = (p: Pick<Person, 'listIds' | 'spokpayGroup'>): SpokpayGroup | null => (p.listIds.includes('spokpay') ? p.spokpayGroup ?? 'leads' : null)

/** `p` in SpokPay's `g` (they must be in SpokPay); the same person when already there. */
export function setGroup(p: Person, g: SpokpayGroup, at = new Date().toISOString()): Person {
  if (!p.listIds.includes('spokpay') || groupOf(p) === g) return p
  return { ...p, spokpayGroup: g, updatedAt: at }
}

/** `p` without a sub-category when they aren't in SpokPay (left it); the same person otherwise. */
export function tidyGroup(p: Person): Person {
  if (!p.spokpayGroup || p.listIds.includes('spokpay')) return p
  const { spokpayGroup: _, ...rest } = p
  return rest as Person
}

/** Every person tidied (tidyGroup); the same object when nobody changes. */
export function tidyGroups(d: AppData): AppData {
  let changed = false
  const people = d.people.map((p) => {
    const n = tidyGroup(p)
    if (n !== p) changed = true
    return n
  })
  return changed ? { ...d, people } : d
}

/** Version 7 → 8: everyone in SpokPay without a sub-category becomes a Client (they were SpokPay's people before Leads
 *  existed). Marks no one twice: a person with one keeps it. */
export function migrateClients(people: Person[]): Person[] {
  return people.map((p) => (p.listIds.includes('spokpay') && !p.spokpayGroup ? { ...p, spokpayGroup: 'clients' as const } : p))
}
