import { describe, expect, it } from 'bun:test'
import { normalizeData } from '../src/model/data.ts'
import { seenKey, type ConnMeta } from '../src/model/accounts.ts'
import { defaultChat, laterMark, mergeSeen, migrateSeen, personUnread, unreadSince, type BadgeConn } from '../src/model/readState.ts'
import type { AppData, Conversation, Message, Person } from '../src/model/types.ts'

const EVELLIN = '678676528648683585'
const CLARA = 'parceria.clarabou@gmail.com'
const READ_SINCE = '2026-11-24T17:35:49.497Z'

const msg = (id: string, timestamp: string, fromMe = false, unread?: boolean): Message => ({ id, channelId: 'c', authorId: fromMe ? 'me' : 'them', fromMe, content: id, timestamp, ...(unread ? { unread } : {}) })
const conv = (...messages: Message[]): Conversation => ({ channelId: 'c', messages })

/** The conversations as the shell hands them back after a start (its cache + Discord's read state). */
function shellAfterStart(): BadgeConn[] {
  return [
    { id: 'stores', kind: 'discord', section: 'stores', convos: { [EVELLIN]: conv(
      msg('1', '2026-11-24T18:10:00.000000+00:00'),
      // their messages: Discord still flags them unread when the ack didn't stick (another device, offline)
      msg('2', '2026-11-24T20:10:45.653000+00:00', false, true),
      msg('3', '2026-11-24T20:27:41.464000+00:00', true),
    ) } },
    { id: 'spokpay', kind: 'discord', section: 'spokpay', convos: { [EVELLIN]: conv(
      msg('4', '2026-11-22T10:00:00.000000+00:00', false, true),
      msg('5', '2026-11-24T18:01:48.961000+00:00', false, true),
    ) } },
    { id: 'creators-gmail-8ce5c1', kind: 'gmail', section: 'creators', convos: { [CLARA]: conv(
      msg('m1', '2026-11-24T20:35:32.000Z', false, true),
      msg('m2', '2026-11-24T20:37:10.000Z', true),
    ) } },
  ]
}

const DISK = {
  version: 6,
  readSince: READ_SINCE,
  updatedAt: '2026-11-24T21:08:02.246Z',
  lists: [{ id: 'creators', name: 'Creators', accountId: 'gmail' }, { id: 'spokpay', name: 'SpokPay', accountId: 'spokpay' }],
  stores: [{ id: 's1', name: 'Store' }],
  people: [
    { id: 'p_ev', name: 'Evellin', discordId: EVELLIN, storeIds: ['s1'], listIds: ['spokpay'], createdAt: 'a', updatedAt: 'a' },
    { id: 'p_cb', name: 'Clara Bou', discordId: '', email: CLARA, storeIds: [], listIds: ['creators'], createdAt: 'a', updatedAt: 'a' },
  ],
}

/** What the chat does while it's visible: the mark becomes its newest message (as useHub.markSeen). */
function view(d: AppData, personId: string, conn: BadgeConn): AppData {
  return {
    ...d,
    people: d.people.map((p) => {
      if (p.id !== personId) return p
      const peer = p.email && conn.kind === 'gmail' ? p.email : p.discordId
      const mark = conn.convos[peer]?.messages.at(-1)?.timestamp
      return mark ? { ...p, seen: { ...p.seen, [seenKey(conn.id, peer)]: mark } } : p
    }),
  }
}

const person = (d: AppData, id: string) => d.people.find((p) => p.id === id)!

describe('badges across a restart', () => {

  it('the real file keeps its per-identity keys through normalizeData', () => {
    const seen = { spokpay: '2026-11-21T13:20:06.958000+00:00', 'stores:581633588764606504': '2026-11-24T17:49:02.037000+00:00', [`creators-gmail-8ce5c1:${CLARA}`]: '2026-11-24T20:37:10.000Z', 'creators-whatsapp-de2af0:5511912345678': '2026-11-24T20:00:00.000Z' }
    const d = normalizeData({ ...DISK, people: [{ ...DISK.people[0], seen: { ...seen, 'bad key': '2026-11-24T00:00:00Z', 'x:y': 'not a date' } }] })
    expect(d.people[0]!.seen).toEqual(seen)
  })

  it('a message that arrives while the chat is open is marked (the mark comes from the chat)', () => {
    // the chat passes its newest message; the connection list in the hook may still be one render behind
    expect(laterMark('2026-11-24T20:27:41.464000+00:00', '2026-11-24T20:27:00.000000+00:00')).toBe('2026-11-24T20:27:41.464000+00:00')
    expect(laterMark(undefined, '2026-11-24T20:00:00.000Z')).toBe('2026-11-24T20:00:00.000Z')
  })

  it('compares times, not strings (Discord "+00:00" vs readSince "Z")', () => {
    const c = conv(msg('1', '2026-11-24T17:35:49.497000+00:00'), msg('2', '2026-11-24T17:35:49.498000+00:00'))
    expect(unreadSince(c, undefined, READ_SINCE)).toBe(1)
    expect(unreadSince(c, '2026-11-24T17:35:49.498Z', undefined)).toBe(0)
  })

  it('the composer sends on the chat of their latest message (the timeline shows every chat)', () => {
    const conns = shellAfterStart()
    const p = normalizeData(DISK).people[0]!
    const chats = conns.slice(0, 2).map((conn) => ({ conn, peer: EVELLIN }))
    // stores has their latest message (20:10; spokpay's is 18:01), whatever is unread
    expect(defaultChat(p, chats, READ_SINCE)?.conn.id).toBe('stores')
    // their latest message on spokpay: spokpay
    const later = [chats[0]!, { conn: { ...conns[1]!, convos: { [EVELLIN]: conv(msg('6', '2026-11-24T21:00:00.000Z')) } }, peer: EVELLIN }]
    expect(defaultChat(p, later, READ_SINCE)?.conn.id).toBe('spokpay')
    // none of theirs anywhere: the most recent conversation
    const mine = chats.map((c) => ({ ...c, conn: { ...c.conn, convos: { [EVELLIN]: conv(msg(`x${c.conn.id}`, c.conn.id === 'spokpay' ? '2026-11-25T00:00:00Z' : '2026-11-24T00:00:00Z', true)) } } }))
    expect(defaultChat(p, mine, READ_SINCE)?.conn.id).toBe('spokpay')
  })
})

describe('migrateSeen', () => {
  const conns: ConnMeta[] = [
    { id: 'stores', kind: 'discord', section: 'stores' },
    { id: 'spokpay', kind: 'discord', section: 'spokpay' },
    { id: 'creators-gmail-8ce5c1', kind: 'gmail', section: 'creators' },
  ]
  const base = normalizeData(DISK)

  it('moves per-connection keys to "<connection>:<identifier>" (keeping the later mark)', () => {
    const p: Person = { ...base.people[0]!, seen: { stores: '2026-11-24T18:03:28.766000+00:00', [`stores:${EVELLIN}`]: '2026-11-24T20:27:41.464000+00:00', spokpay: '2026-11-21T13:20:06.958000+00:00' } }
    expect(migrateSeen(p, conns).seen).toEqual({ [`stores:${EVELLIN}`]: '2026-11-24T20:27:41.464000+00:00', [`spokpay:${EVELLIN}`]: '2026-11-21T13:20:06.958000+00:00' })
  })

  it('moves keys of a removed connection to the current one of the same section and kind', () => {
    const p: Person = { ...base.people[1]!, seen: { [`creators-gmail-db3d19:${CLARA}`]: '2026-11-24T20:37:10.000Z', gmail: '2026-11-24T19:00:00.000Z' } }
    const m = migrateSeen(p, conns)
    expect(m.seen).toEqual({ [`creators-gmail-8ce5c1:${CLARA}`]: '2026-11-24T20:37:10.000Z' })
    const conns2 = shellAfterStart()
    expect(personUnread(m, conns2, 'creators', READ_SINCE)).toBe(0)
  })

  it('keeps marks it has no connection for, and changes nothing twice', () => {
    const p: Person = { ...base.people[1]!, seen: { [`creators-whatsapp-de2af0:5511912345678`]: '2026-11-24T20:00:00.000Z', [`creators-gmail-8ce5c1:${CLARA}`]: '2026-11-24T20:37:10.000Z' } }
    expect(migrateSeen(p, conns)).toBe(p)
    const once = migrateSeen({ ...base.people[0]!, seen: { stores: '2026-11-24T18:00:00.000Z' } }, conns)
    expect(migrateSeen(once, conns)).toBe(once)
    expect(migrateSeen(p, [])).toBe(p) // connections not listed yet: wait
  })
})

describe('read marks written from two places (PC page and phone)', () => {
  const withSeen = (d: AppData, id: string, key: string, at: string): AppData => ({ ...d, people: d.people.map((p) => (p.id === id ? { ...p, seen: { ...p.seen, [key]: at } } : p)) })
  const K_EV = `stores:${EVELLIN}`, K_CB = `creators-gmail-8ce5c1:${CLARA}`




  it('mergeSeen returns the same object when nothing differs', () => {
    const d = normalizeData(DISK)
    expect(mergeSeen(d, d, d, d)).toBe(d)
  })
})
