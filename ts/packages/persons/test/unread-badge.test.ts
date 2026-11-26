import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonsRoutes } from '../src/routes.ts'
import { PersonsService } from '../src/service.ts'

const DC = '222222222222222222'
const T0 = '2026-11-20T10:00:00.000Z'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** One SpokPay person on the second Discord account, with two of their messages and a reply; offline, drawn connected. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-unread-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'data.json'), JSON.stringify({
    version: 7, updatedAt: T0, readSince: T0,
    stores: [],
    lists: [{ id: 'spokpay', name: 'SpokPay', accountId: 'spokpay' }],
    people: [{ id: 'py', name: 'Yagas', discordId: DC, storeIds: [], listIds: ['spokpay'], createdAt: T0, updatedAt: T0 }],
  }))
  writeFileSync(join(dir, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id: 'spokpay', kind: 'discord', section: 'spokpay' }] }))
  const m = (id: string, at: string, fromMe: boolean) => ({ id, channelId: 'dm', authorId: fromMe ? 'me' : 'them', fromMe, content: id, timestamp: at })
  writeFileSync(join(dir, 'discord-cache-spokpay.json'), JSON.stringify({ conversations: { [DC]: { channelId: 'dm', messages: [m('d1', '2026-11-24T10:00:00.000Z', false), m('d2', '2026-11-24T10:01:00.000Z', false), m('d3', '2026-11-24T10:05:00.000Z', true)] } } }))
  const s = new PersonsService({ dir, offline: true, offlineConnected: true })
  await s.start()
  const r = new PersonsRoutes(s)
  const call = async (method: string, path: string, body: unknown = null, query: [string, string][] = []) => (await r.route({ method, path: ['v1', 'persons', ...path.split('/')], query, body }))!
  return { s, call }
}

describe('Mark as unread shows in the counts', () => {
  it("the person's row and the tab's total count from the marked message on, and read clears them", async () => {
    const { s, call } = await setup()
    const total = async () => ((await call('GET', 'unread')).body as { unread: number }).unread
    await call('POST', 'chat/py/read', { section: 'spokpay' })
    expect(s.rowInfo(s.person('py')!, 'spokpay').unread).toBe(0)
    expect(await total()).toBe(0)

    // their last message marked unread: 1 on the row, 1 on the tab, as the state says
    expect(((await call('POST', 'chat/py/unread', { section: 'spokpay', messageId: 'd2' })).body as { ok: boolean }).ok).toBe(true)
    expect(s.rowInfo(s.person('py')!, 'spokpay').unread).toBe(1)
    expect(await total()).toBe(1)
    const state = (await call('GET', 'state')).body as { unread: number; people: { id: string; rows: Record<string, { unread: number }> }[] }
    expect(state.unread).toBe(1)
    expect(state.people.find((p) => p.id === 'py')!.rows.spokpay!.unread).toBe(1)

    // from the first one: both of theirs (my reply doesn't count)
    await call('POST', 'chat/py/unread', { section: 'spokpay', messageId: 'd1' })
    expect(await total()).toBe(2)

    await call('POST', 'chat/py/read', { section: 'spokpay' })
    expect(await total()).toBe(0)
    await s.stop()
  })
})
