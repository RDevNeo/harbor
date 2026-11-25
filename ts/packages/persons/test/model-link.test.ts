import { describe, expect, it } from 'bun:test'
import { allPeers, chatKey, chatsFor, facets, pickChat, type ConnMeta } from '../src/model/accounts.ts'
import { matchesQuery, normalizeData } from '../src/model/data.ts'
import { linkPeople, unlinkPerson } from '../src/model/link.ts'
import { personUnread, type BadgeConn } from '../src/model/readState.ts'
import type { AppData, Person } from '../src/model/types.ts'

const T0 = '2026-11-20T10:00:00.000Z'
const AT = '2026-11-25T12:00:00.000Z'
const DISCORD = '678676528648683585'

const person = (x: Partial<Person> & { id: string }): Person => ({ name: '', discordId: '', storeIds: [], listIds: [], createdAt: T0, updatedAt: T0, ...x })

function data(): AppData {
  return normalizeData({
    version: 7,
    updatedAt: T0,
    stores: [{ id: 's1', name: 'Loja', ownerId: 'pd' }, { id: 's2', name: 'Outra' }],
    lists: [{ id: 'creators', name: 'Creators', accountId: 'gmail' }, { id: 'spokpay', name: 'SpokPay', accountId: 'spokpay' }],
    people: [
      // Evellin on WhatsApp (the one right-clicked: stays)
      person({ id: 'pw', name: 'Evellin', whatsapp: '5511912345678', listIds: ['spokpay'], notes: 'Met at the fair.', seen: { 'spokpay-whatsapp-1:5511912345678': '2026-11-24T10:00:00.000Z' }, settled: { spokpay: '2026-11-24T11:00:00.000Z' }, socials: ['https://www.tiktok.com/@evellin'] }),
      // Evellin on Discord, owner of a store, active in Stores
      person({ id: 'pd', name: 'evellin_rbx', discordId: DISCORD, discordUsername: 'evellin_rbx', displayName: 'Evellin R', avatar: 'abc', storeIds: ['s2'], listIds: ['spokpay'], notes: 'Owns Loja.', seen: { [`stores:${DISCORD}`]: '2026-11-24T09:00:00.000Z', 'spokpay-whatsapp-1:5511912345678': '2026-11-24T12:00:00.000Z' }, identities: [{ kind: 'whatsapp', value: '5511987654321', section: 'spokpay' }] }),
      person({ id: 'px', name: 'Someone else', email: 'x@example.com' }),
    ],
  })
}

describe('linkPeople', () => {
  it('makes one person: identifiers combined, notes concatenated, stores / lists / socials unioned, read state kept', () => {
    const d = data()
    const r = linkPeople(d, 'pw', ['pd'], AT)!
    expect(r.linked).toEqual(['pd'])
    expect(r.data.people.map((p) => p.id)).toEqual(['pw', 'px'])
    const p = r.person
    expect(p.name).toBe('Evellin')
    expect(p.whatsapp).toBe('5511912345678')
    // the Discord identity (and its profile) filled the empty slots
    expect(p.discordId).toBe(DISCORD)
    expect(p.discordUsername).toBe('evellin_rbx')
    expect(p.avatar).toBe('abc')
    // their per-section WhatsApp number: the primary had none for SpokPay
    expect(p.identities).toEqual([{ kind: 'whatsapp', value: '5511987654321', section: 'spokpay' }])
    expect(p.notes).toBe('Met at the fair.\n\n— evellin_rbx —\nOwns Loja.')
    expect(p.storeIds).toEqual(['s2'])
    expect(p.listIds).toEqual(['spokpay'])
    expect(p.socials).toEqual(['https://www.tiktok.com/@evellin'])
    // read marks: the later one per chat
    expect(p.seen).toEqual({ 'spokpay-whatsapp-1:5511912345678': '2026-11-24T12:00:00.000Z', [`stores:${DISCORD}`]: '2026-11-24T09:00:00.000Z' })
    // SpokPay: one of them was still active there, so the person is too
    expect(p.settled).toBeUndefined()
    // the store they owned now has the person as owner
    expect(r.data.stores.find((s) => s.id === 's1')?.ownerId).toBe('pw')
    expect(p.links?.map((l) => l.person.id)).toEqual(['pd'])
  })

  it('survives a save and a load (normalizeData keeps the links)', () => {
    const r = linkPeople(data(), 'pw', ['pd'], AT)!
    const back = normalizeData(JSON.parse(JSON.stringify(r.data)))
    expect(back.people.find((p) => p.id === 'pw')).toEqual(r.person)
  })

  it('keeps a taken identifier reachable: two WhatsApp numbers are two chats', () => {
    const d = data()
    d.people[2] = { ...d.people[2]!, whatsapp: '5521999990000', listIds: ['creators'] }
    const p = linkPeople(d, 'pw', ['px'], AT)!.person
    expect(p.whatsapp).toBe('5511912345678')
    expect(allPeers(p, 'whatsapp').sort()).toEqual(['5511912345678', '5521999990000'])
    expect(allPeers(p, 'gmail')).toEqual(['x@example.com'])
    expect(facets(p).map((f) => f.id)).toEqual(['pw', 'px'])
    const conns: ConnMeta[] = [{ id: 'wa', kind: 'whatsapp', section: 'creators' }, { id: 'gm', kind: 'gmail', section: 'creators' }]
    const chats = chatsFor(p, conns, 'creators')
    expect(chats.map(chatKey)).toEqual(['wa:5511912345678', 'gm:x@example.com', 'wa:5521999990000'])
    expect(pickChat(chats, 'wa:5521999990000')?.peer).toBe('5521999990000')
    expect(pickChat(chats, 'wa')?.peer).toBe('5511912345678')
    // search finds them by the linked person's name too; the badge counts their chat
    expect(matchesQuery(p, 'someone')).toBe(true)
    const badge: BadgeConn[] = [{ ...conns[0]!, convos: { '5521999990000': { channelId: 'c', messages: [{ id: '1', channelId: 'c', authorId: 'x', fromMe: false, content: 'oi', timestamp: '2026-11-25T00:00:00.000Z' }] } } }]
    expect(personUnread(p, badge, 'creators', '2026-11-01T00:00:00.000Z')).toBe(1)
  })

  it('stays settled only where everyone was', () => {
    const d = data()
    d.people[1] = { ...d.people[1]!, settled: { spokpay: '2026-11-24T13:00:00.000Z' } }
    expect(linkPeople(d, 'pw', ['pd'], AT)!.person.settled).toEqual({ spokpay: '2026-11-24T13:00:00.000Z' })
  })

  it('ignores the primary itself and unknown ids', () => {
    expect(linkPeople(data(), 'pw', ['pw', 'nobody'], AT)).toBeNull()
    expect(linkPeople(data(), 'nobody', ['pd'], AT)).toBeNull()
  })

  it('links several at once, and someone already linked keeps their own links inside', () => {
    const d = linkPeople(data(), 'pd', ['px'], AT)!.data
    const r = linkPeople(d, 'pw', ['pd'], AT)!
    expect(r.data.people.map((p) => p.id)).toEqual(['pw'])
    expect(facets(r.person).map((f) => f.id)).toEqual(['pw', 'pd', 'px'])
    expect(allPeers(r.person, 'gmail')).toEqual(['x@example.com'])
  })
})

describe('unlinkPerson', () => {
  it('brings them back as they were, and takes back what the link added', () => {
    const d0 = data()
    const r = linkPeople(d0, 'pw', ['pd'], AT)!
    const u = unlinkPerson(r.data, 'pw', 'pd', AT)!
    expect(u.data.people.map((p) => p.id)).toEqual(['pw', 'pd', 'px'])
    const back = (id: string) => u.data.people.find((p) => p.id === id)!
    const strip = (p: Person) => ({ ...p, updatedAt: '' })
    // the primary as before (read marks may have grown: the later ones)
    expect(strip({ ...back('pw'), seen: d0.people[0]!.seen! })).toEqual(strip(d0.people[0]!))
    expect(strip(back('pd'))).toEqual(strip(d0.people[1]!))
    expect(u.data.stores).toEqual(d0.stores)
  })

  it('keeps what changed since (a note edited, a store added later)', () => {
    const r = linkPeople(data(), 'pw', ['pd'], AT)!
    const p = { ...r.person, notes: `${r.person.notes}\nCalled on Monday.`, storeIds: [...r.person.storeIds, 's1'] }
    const d = { ...r.data, people: r.data.people.map((x) => (x.id === 'pw' ? p : x)) }
    const u = unlinkPerson(d, 'pw', 'pd', AT)!
    expect(u.person.storeIds).toEqual(['s1'])
    expect(u.person.notes).toBe('Met at the fair.\nCalled on Monday.')
  })

  it('gives them the read marks made on their chats while linked', () => {
    const r = linkPeople(data(), 'pw', ['pd'], AT)!
    const p = { ...r.person, seen: { ...r.person.seen, [`stores:${DISCORD}`]: '2026-11-25T11:00:00.000Z' } }
    const u = unlinkPerson({ ...r.data, people: r.data.people.map((x) => (x.id === 'pw' ? p : x)) }, 'pw', 'pd', AT)!
    expect(u.restored.seen?.[`stores:${DISCORD}`]).toBe('2026-11-25T11:00:00.000Z')
  })

  it('does nothing for someone not linked, or an id taken meanwhile', () => {
    const r = linkPeople(data(), 'pw', ['pd'], AT)!
    expect(unlinkPerson(r.data, 'pw', 'px', AT)).toBeNull()
    expect(unlinkPerson({ ...r.data, people: [...r.data.people, { ...r.data.people[1]!, id: 'pd' }] }, 'pw', 'pd', AT)).toBeNull()
  })
})
