import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatsFor, type ConnMeta } from '../src/model/accounts.ts'
import { normalizeData } from '../src/model/data.ts'
import { movePerson, parsePlace, placesOf } from '../src/model/move.ts'
import type { AppData, Person } from '../src/model/types.ts'
import { PersonAi } from '../src/ai.ts'

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
      person({
        id: 'pd', name: 'Evellin', discordId: DISCORD, discordUsername: 'evellin_rbx', displayName: 'Evellin R', avatar: 'abc', photo: 'https://lh3.example/p.jpg',
        email: 'ev@example.com', storeIds: ['s1'], notes: 'Owns Loja.', socials: ['https://www.tiktok.com/@evellin'],
        seen: { [`stores:${DISCORD}`]: '2026-11-24T09:00:00.000Z' }, settled: { stores: '2026-11-24T11:00:00.000Z' },
        identities: [{ kind: 'whatsapp', value: '5511987654321', section: 'stores' }],
      }),
      person({ id: 'px', name: 'Someone else', email: 'x@example.com', listIds: ['creators'] }),
    ],
  })
}

const conns: ConnMeta[] = [
  { id: 'stores', kind: 'discord', section: 'stores' },
  { id: 'spokpay', kind: 'discord', section: 'spokpay' },
  { id: 'creators-gmail-1', kind: 'gmail', section: 'creators' },
]

describe('movePerson', () => {
  it('moves a store member to SpokPay and keeps everything of theirs', () => {
    const d = data()
    const before = d.people.find((p) => p.id === 'pd')!
    const r = movePerson(d, 'pd', parsePlace('store:s1'), parsePlace('spokpay')!, AT)!
    const p = r.data.people.find((x) => x.id === 'pd')!
    expect(r.left).toEqual(['stores'])
    expect(p.storeIds).toEqual([])
    expect(p.listIds).toEqual(['spokpay'])
    // the store stays, without its owner
    expect(r.data.stores.find((s) => s.id === 's1')).toEqual({ id: 's1', name: 'Loja' })
    // nothing of theirs is lost
    for (const k of ['name', 'discordId', 'discordUsername', 'displayName', 'avatar', 'photo', 'email', 'notes', 'socials', 'seen', 'createdAt'] as const) expect(p[k]).toEqual(before[k])
    expect(p.identities).toEqual([{ kind: 'whatsapp', value: '5511987654321', section: 'stores' }, { kind: 'whatsapp', value: '5511987654321', section: 'spokpay' }])
    expect(p.settled).toEqual({ spokpay: '2026-11-24T11:00:00.000Z' })
    expect(p.carried).toEqual(['stores'])
    // other people untouched
    expect(r.data.people.find((x) => x.id === 'px')).toBe(d.people.find((x) => x.id === 'px')!)
  })

  it('keeps the old account’s chat, after the new section’s own', () => {
    const r = movePerson(data(), 'pd', { section: 'stores', store: 's1' }, { section: 'spokpay' }, AT)!
    const p = r.data.people.find((x) => x.id === 'pd')!
    expect(chatsFor(p, conns, 'spokpay').map((c) => `${c.conn.id}:${c.peer}`)).toEqual([`spokpay:${DISCORD}`, `stores:${DISCORD}`])
    expect(placesOf(p, r.data)).toEqual([{ section: 'spokpay' }])
  })

  it('survives a save and load (carried is kept in data.json)', () => {
    const r = movePerson(data(), 'pd', { section: 'stores', store: 's1' }, { section: 'creators' }, AT)!
    const back = normalizeData(JSON.parse(JSON.stringify(r.data)))
    expect(back.people.find((x) => x.id === 'pd')).toEqual(r.data.people.find((x) => x.id === 'pd')!)
  })

  it('moves between stores without leaving Stores', () => {
    const r = movePerson(data(), 'pd', { section: 'stores', store: 's1' }, { section: 'stores', store: 's2' }, AT)!
    const p = r.data.people.find((x) => x.id === 'pd')!
    expect(p.storeIds).toEqual(['s2'])
    expect(r.left).toEqual([])
    expect(p.carried).toBeUndefined()
    expect(p.settled).toEqual({ stores: '2026-11-24T11:00:00.000Z' })
  })

  it('moving back drops the carried section', () => {
    const a = movePerson(data(), 'pd', { section: 'stores', store: 's1' }, { section: 'spokpay' }, AT)!
    const b = movePerson(a.data, 'pd', { section: 'spokpay' }, { section: 'stores', store: 's1' }, AT)!
    const p = b.data.people.find((x) => x.id === 'pd')!
    expect(p.storeIds).toEqual(['s1'])
    expect(p.listIds).toEqual([])
    expect(p.carried).toEqual(['spokpay'])
  })

  it('from All people leaves every place; nothing to do when already only there', () => {
    const d = data()
    d.people[0] = { ...d.people[0]!, listIds: ['creators'] }
    const r = movePerson(d, 'pd', null, { section: 'spokpay' }, AT)!
    expect(placesOf(r.data.people[0]!, r.data)).toEqual([{ section: 'spokpay' }])
    expect(movePerson(r.data, 'pd', null, { section: 'spokpay' }, AT)).toBeNull()
    expect(movePerson(d, 'pd', null, { section: 'stores', store: 'nope' }, AT)).toBeNull()
    expect(movePerson(d, 'nobody', null, { section: 'spokpay' }, AT)).toBeNull()
  })
})

describe('PersonAi.move', () => {
  it('the AI chat of the old section becomes the new one’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persons-move-'))
    try {
      const ai = new PersonAi(dir, async () => ({ status: 200, body: {} }))
      const p = data().people[0]!
      ;(ai as unknown as { chats: Record<string, string> }).chats = { 'pd:stores': '42' }
      ai.move(p, 'stores', 'spokpay')
      expect(ai.chatOf(p, 'spokpay')).toBe('42')
      expect(ai.chatOf(p, 'stores')).toBeNull()
      expect(JSON.parse(readFileSync(join(dir, 'ai-chats.json'), 'utf8'))).toEqual({ 'pd:spokpay': '42' })
      // a section with its own AI chat keeps it
      ;(ai as unknown as { chats: Record<string, string> }).chats = { 'pd:stores': '1', 'pd:spokpay': '2' }
      ai.move(p, 'stores', 'spokpay')
      expect(ai.chatOf(p, 'spokpay')).toBe('2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
