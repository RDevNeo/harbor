import { describe, expect, it } from 'bun:test'
import { allPeers, channelsFor, normPhone, normWhatsApp, phoneVariants, peerOf, personSections, sectionOfScope, seenKey, validPeer, type ConnMeta } from '../src/model/accounts.ts'
import type { Person } from '../src/model/types.ts'

const p = (over: Partial<Person> = {}): Person => ({ id: 'p', name: 'P', discordId: '', storeIds: [], listIds: [], createdAt: '', updatedAt: '', ...over })
const conns: ConnMeta[] = [
  { id: 'stores', kind: 'discord', section: 'stores' },
  { id: 'stores-wa', kind: 'whatsapp', section: 'stores' },
  { id: 'gmail', kind: 'gmail', section: 'creators' },
  { id: 'spokpay', kind: 'discord', section: 'spokpay' },
]

describe('channels per section', () => {
  it('knows who a person is on each kind of channel', () => {
    const x = p({ discordId: '581633588764606504', email: 'Ana@X.com', whatsapp: '5511912345678' })
    expect(peerOf(x, 'discord')).toBe('581633588764606504')
    expect(peerOf(x, 'gmail')).toBe('ana@x.com')
    expect(peerOf(x, 'whatsapp')).toBe('5511912345678')
    expect(validPeer('whatsapp', '5511912345678')).toBe(true)
    expect(validPeer('whatsapp', '123')).toBe(false)
    expect(normPhone('+55 (11) 91234-5678')).toBe('5511912345678')
    expect(normPhone('12')).toBe('')
  })

  it('maps views and people to sections', () => {
    expect(sectionOfScope({ kind: 'all' })).toBeNull()
    expect(sectionOfScope({ kind: 'store', id: 's1' })).toBe('stores')
    expect(sectionOfScope({ kind: 'list', id: 'spokpay' })).toBe('spokpay')
    expect(personSections(p({ storeIds: ['s1'], listIds: ['creators', 'x'] }))).toEqual(['stores', 'creators'])
  })

  it('offers the section’s connected channels the person has an identifier for', () => {
    const both = p({ storeIds: ['s1'], listIds: ['creators'], discordId: '581633588764606504', whatsapp: '5511912345678', email: 'a@b.co' })
    expect(channelsFor(both, conns, 'stores').map((c) => c.id)).toEqual(['stores', 'stores-wa'])
    expect(channelsFor(both, conns, 'creators').map((c) => c.id)).toEqual(['gmail'])
    // from All people: every section of theirs
    expect(channelsFor(both, conns, null).map((c) => c.id)).toEqual(['stores', 'stores-wa', 'gmail'])
    // no identifier, no channel
    expect(channelsFor(p({ storeIds: ['s1'], discordId: '581633588764606504' }), conns, 'stores').map((c) => c.id)).toEqual(['stores'])
    expect(channelsFor(p({ listIds: ['spokpay'] }), conns, 'spokpay')).toEqual([])
  })
})

describe('identities per section', () => {
  const x = p({ storeIds: ['s1'], listIds: ['spokpay'], discordId: '581633588764606504', identities: [{ kind: 'discord', value: '1478584833310457920', section: 'spokpay' }] })
  it('uses the section’s identity, else the default', () => {
    expect(peerOf(x, 'discord', 'spokpay')).toBe('1478584833310457920')
    expect(peerOf(x, 'discord', 'stores')).toBe('581633588764606504')
    expect(peerOf(x, 'discord')).toBe('581633588764606504')
    expect(allPeers(x, 'discord')).toEqual(['581633588764606504', '1478584833310457920'])
  })
  it('offers each section’s channel with its own identity', () => {
    expect(channelsFor(x, conns, 'spokpay').map((c) => c.id)).toEqual(['spokpay'])
    expect(channelsFor(p({ listIds: ['spokpay'], identities: [{ kind: 'discord', value: '1478584833310457920', section: 'spokpay' }] }), conns, 'spokpay').map((c) => c.id)).toEqual(['spokpay'])
    expect(seenKey('spokpay', '1478584833310457920')).toBe('spokpay:1478584833310457920')
  })

  it('normalizes typed WhatsApp numbers (Brazil: 55 and the 9th digit)', () => {
    expect(normWhatsApp('+55 11 91234-5678')).toBe('5511912345678')
    expect(normWhatsApp('(11) 91234-5678')).toBe('5511912345678')
    expect(normWhatsApp('011 91234-5678')).toBe('5511912345678')
    expect(normWhatsApp('+55 31 8765-4321')).toBe('5531987654321')
    expect(normWhatsApp('11 3456-7890')).toBe('551134567890')
    expect(normWhatsApp('+1 415 555 1234')).toBe('14155551234')
    expect(normWhatsApp('+44 7700 900123')).toBe('447700900123')
    expect(normWhatsApp('12')).toBe('')
    expect(phoneVariants('5531987654321')).toEqual(['5531987654321', '553187654321'])
    expect(phoneVariants('551134567890')).toEqual(['551134567890'])
    expect(phoneVariants('14155551234')).toEqual(['14155551234'])
  })
})
