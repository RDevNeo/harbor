import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonsRoutes } from '../src/routes.ts'
import { PersonsService } from '../src/service.ts'

const DC = '111111111111111111'
const WA = '5511912345678'
const T0 = '2026-11-20T10:00:00.000Z'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A persons folder with Evellin twice (WhatsApp and Discord) and their cached chats; offline, drawn connected. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-link-'))
  dirs.push(dir)
  const person = (x: Record<string, unknown>) => ({ name: '', discordId: '', storeIds: ['s1'], listIds: [], createdAt: T0, updatedAt: T0, ...x })
  writeFileSync(join(dir, 'data.json'), JSON.stringify({
    version: 7, updatedAt: T0, readSince: T0,
    stores: [{ id: 's1', name: 'Loja', ownerId: 'pd' }],
    lists: [{ id: 'creators', name: 'Creators', accountId: 'gmail' }, { id: 'spokpay', name: 'SpokPay', accountId: 'spokpay' }],
    people: [person({ id: 'pw', name: 'Evellin', whatsapp: WA }), person({ id: 'pd', name: 'evellin.rbx', discordId: DC, discordUsername: 'evellin.rbx' })],
  }))
  writeFileSync(join(dir, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id: 'stores', kind: 'discord', section: 'stores' }, { id: 'wa1', kind: 'whatsapp', section: 'stores' }] }))
  const m = (id: string, at: string, fromMe: boolean, extra: Record<string, unknown> = {}) => ({ id, channelId: 'c', authorId: fromMe ? 'me' : 'them', fromMe, content: id, timestamp: at, ...extra })
  writeFileSync(join(dir, 'discord-cache.json'), JSON.stringify({ conversations: { [DC]: { channelId: 'dm', messages: [m('d1', '2026-11-24T10:00:00.000Z', false), m('d2', '2026-11-24T10:05:00.000Z', true)] } } }))
  mkdirSync(join(dir, 'whatsapp-wa1'))
  const voice = { name: 'voice-W2.ogg', url: 'chwa://wa1/W2?name=voice-W2.ogg&type=audio%2Fogg', type: 'audio/ogg; codecs=opus', duration: 20, waveform: Buffer.from([10, 50, 100]).toString('base64') }
  writeFileSync(join(dir, 'whatsapp-wa1', 'chats.json'), JSON.stringify({ version: 1, chats: { [WA]: [m('W1', '2026-11-25T09:00:00.000Z', false), m('W2', '2026-11-25T09:01:00.000Z', false, { voice: true, content: '', attachments: [voice] })] } }))
  const s = new PersonsService({ dir, offline: true, offlineConnected: true })
  await s.start()
  const r = new PersonsRoutes(s)
  const call = async (method: string, path: string, body: unknown = null, query: [string, string][] = []) => (await r.route({ method, path: ['v1', 'persons', ...path.split('/')], query, body }))!
  return { dir, s, call }
}

describe('Link with… over the API', () => {
  it('links, shows one timeline with channels, sends on the latest incoming chat, and unlinks back', async () => {
    const { dir, s, call } = await setup()
    const linked = await call('POST', 'person/pw/link', { ids: ['pd'] })
    expect(linked.status).toBe(200)
    expect(existsSync(join(dir, 'data.before-link.json'))).toBe(true)
    // the backup is data.json as it was: both people
    expect(JSON.parse(readFileSync(join(dir, 'data.before-link.json'), 'utf8')).people.map((p: { id: string }) => p.id)).toEqual(['pw', 'pd'])
    expect(s.data!.people.map((p) => p.id)).toEqual(['pw'])
    // the store they owned is the merged person's now
    expect(s.data!.stores[0]!.ownerId).toBe('pw')

    const chat = (await call('GET', 'chat/pw', null, [['section', 'stores']])).body as Record<string, any>
    expect(chat.messages.map((x: any) => [x.id, x.channel.kind])).toEqual([['d1', 'discord'], ['d2', 'discord'], ['W1', 'whatsapp'], ['W2', 'whatsapp']])
    expect(chat.accounts.map((a: any) => a.id).sort()).toEqual([`stores:${DC}`, `wa1:${WA}`])
    // their latest message came on WhatsApp: the composer sends there
    expect(chat.account.id).toBe(`wa1:${WA}`)
    // the voice message carries what the player needs
    const v = chat.messages[3].files[0]
    expect(v).toMatchObject({ kind: 'audio', audio: 'wa1:W2:0', bars: expect.any(Array), played: false, duration: 20 })
    // picking Discord
    const dc = (await call('GET', 'chat/pw', null, [['section', 'stores'], ['account', `stores:${DC}`]])).body as Record<string, any>
    expect(dc.account.kind).toBe('discord')
    // read: every chat on the page
    await call('POST', 'chat/pw/read', { section: 'stores' })
    expect(Object.keys(s.person('pw')!.seen ?? {}).sort()).toEqual([`stores:${DC}`, `wa1:${WA}`])
    expect(s.rowInfo(s.person('pw')!, 'stores').unread).toBe(0)

    // the panel lists who is linked; Unlink brings them back
    const panel = (await call('GET', 'person/pw', null, [['socials', 'cached']])).body as Record<string, any>
    expect(panel.linked.map((l: any) => l.id)).toEqual(['pd'])
    expect((await call('POST', 'person/pw/unlink', { id: 'pd' })).status).toBe(200)
    expect(s.data!.people.map((p) => p.id)).toEqual(['pw', 'pd'])
    expect(s.data!.stores[0]!.ownerId).toBe('pd')
    expect(s.person('pw')!.discordId).toBe('')
    // marked read while linked: still read
    expect(s.person('pd')!.seen?.[`stores:${DC}`]).toBeDefined()
    await s.stop()
  })

  it('refuses nonsense', async () => {
    const { s, call } = await setup()
    expect((await call('POST', 'person/pw/link', { ids: [] })).status).toBe(400)
    expect((await call('POST', 'person/pw/link', { ids: ['pw'] })).status).toBe(400)
    expect((await call('POST', 'person/nobody/link', { ids: ['pd'] })).status).toBe(404)
    expect((await call('POST', 'person/pw/unlink', { id: 'pd' })).status).toBe(400)
    await s.stop()
  })
})
