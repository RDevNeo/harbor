import { describe, expect, it } from 'bun:test'
import { ImportError, PACKED_PREFIX, TRANSFER_URL, keysFor, normCode, parseBundle, readByCode, readExport, restore, showCode, unpack } from '../lib/transfer'

const data = {
  version: 8,
  goals: [
    { id: 'water', name: 'Water', target: 3500, unit: 'ml', icon: 'droplet', color: '#3b82f6', createdAt: '2026-11-01' },
    { id: 'bike', name: 'Bike', target: 1800, unit: 'sec', kind: 'ride', icon: 'bike', color: '#eab308', createdAt: '2026-11-01', days: [1, 2, 3, 5, 6] },
    { id: 'old', name: 'Old', target: 10, unit: 'reps', icon: 'activity', color: '#7c5cff', createdAt: '2026-11-01', archived: true },
  ],
  entries: {
    '2026-11-20': [{ id: 'e1', goalId: 'water', amount: 500, at: 1 }],
    '2026-11-21': [
      { id: 'e2', goalId: 'bike', amount: 1900, at: 2, ride: { km: 8.1, durationSec: 1900, gainM: 40, points: 3 } },
      { id: 'e3', goalId: 'water', amount: 1000, at: 3 },
    ],
  },
  sleep: { wakeBy: '06:30' },
  timers: {},
  plan: { id: 'igor' },
}

const exported = (items: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ app: 'schedule-fixer', kind: 'export', v: 1, exportedAt: '2026-11-24T19:00:00.000Z', items, ...extra })

const items = {
  'schedule-fixer:data': JSON.stringify(data),
  'schedule-fixer:ride:e2': JSON.stringify([{ t: 1, lat: 1, lon: 1, acc: 3 }]),
  'schedule-fixer:coach': JSON.stringify({ messages: [{ id: '1', role: 'user', text: 'hi', at: 1 }, { id: '2', role: 'agent', text: 'hey', at: 2 }], sent: null }),
  'schedule-fixer:walking': JSON.stringify({ days: { '2026-11-20': { km: 3.2 } }, asked: true, retried: false, historyAt: null }),
  'schedule-fixer:harbor-token': 'secret',
}

async function pack(s: string): Promise<string> {
  const gz = new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  let bin = ''
  for (const b of gz) bin += String.fromCharCode(b)
  return PACKED_PREFIX + btoa(bin)
}


describe('Schedule Fixer import', () => {
  it('reads an export and summarizes it (archived goals not counted, Harbor token dropped)', async () => {
    const { bundle, summary } = await readExport(exported(items))
    expect(Object.keys(bundle.items)).not.toContain('schedule-fixer:harbor-token')
    expect(summary).toEqual({ goals: 2, days: 2, entries: 3, rides: 1, coachMessages: 2, walkingDays: 1, wakeBy: '06:30', exportedAt: '2026-11-24T19:00:00.000Z' })
  })

  it('takes the packed clipboard form (SFX1: + base64 gzip) the same', async () => {
    const plain = exported(items)
    expect(await unpack(await pack(plain))).toBe(plain)
    expect((await readExport(`  ${await pack(plain)}\n`)).summary.rides).toBe(1)
  })

  it('rejects what is not a Schedule Fixer export', async () => {
    expect(() => parseBundle('nope')).toThrow(ImportError)
    expect(() => parseBundle('{"app":"other","kind":"export","v":1,"items":{}}')).toThrow(/Not a Schedule Fixer export/)
    expect(() => parseBundle(exported(items, { v: 2 }))).toThrow(/newer/)
    expect(() => parseBundle(exported({ 'schedule-fixer:coach': '{}' }))).toThrow(/no goals data/)
    expect(() => parseBundle(exported({ 'schedule-fixer:data': '{"goals":5}' }))).toThrow(/no goals list/)
    expect(() => parseBundle(exported({ 'schedule-fixer:data': JSON.stringify(data), 'schedule-fixer:x': 5 as unknown as string }))).toThrow(/Damaged/)
    await expect(readExport(`${PACKED_PREFIX}AAAA`)).rejects.toThrow(/incomplete or damaged/)
  })

  it('ignores keys of other apps', () => {
    const b = parseBundle(exported({ ...items, 'CapacitorStorage.other': 'x', 'personhub.tab': 'routine' }))
    expect(Object.keys(b.items).every((k) => k.startsWith('schedule-fixer:'))).toBe(true)
  })

  it('restores 1:1: same keys and strings, stale Routine keys removed, other keys untouched', async () => {
    const store: Record<string, string> = { 'schedule-fixer:data': '{"goals":[]}', 'schedule-fixer:ride-active': '{}', 'schedule-fixer:harbor-token': 'keep', 'other:key': 'x' }
    const { bundle } = await readExport(exported(items))
    expect(restore(bundle, store)).toBe(4)
    expect(store['schedule-fixer:data']).toBe(items['schedule-fixer:data'])
    expect(store['schedule-fixer:ride:e2']).toBe(items['schedule-fixer:ride:e2'])
    expect('schedule-fixer:ride-active' in store).toBe(false)
    expect(store['schedule-fixer:harbor-token']).toBe('keep')
    expect(store['other:key']).toBe('x')
  })
})

/** What Schedule Fixer's exportData() uploads: base64url(iv ‖ AES-GCM(gzip(json))). */
async function sealLikeSF(code: string, json: string): Promise<{ id: string; blob: string }> {
  const { id, key } = await keysFor(code)
  const gz = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  let bin = ''
  for (const b of out) bin += String.fromCharCode(b)
  return { id, blob: btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
}

describe('import with a one-time code', () => {
  const CODE = 'ABCDEFGHJKMN'
  it('reads codes the way people type them', () => {
    expect(normCode('abcd-efgh-jkmn')).toBe(CODE)
    expect(normCode(' abcd efgh jkmn ')).toBe(CODE)
    expect(normCode('ABCD-EFGH-JK')).toBeNull()
    expect(showCode(CODE)).toBe('ABCD-EFGH-JKMN')
  })

  it('downloads every part, decrypts and validates', async () => {
    const { id, blob } = await sealLikeSF(CODE, exported(items))
    const parts = [blob.slice(0, 10), blob.slice(10)]
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      const part = Number(new URL(url).searchParams.get('part'))
      return Response.json({ total: parts.length, blob: parts[part] })
    }
    const { summary } = await readByCode('abcd-efgh-jkmn', fetchFn)
    expect(summary.goals).toBe(2)
    expect(urls).toEqual([`${TRANSFER_URL}?id=${id}&part=0`, `${TRANSFER_URL}?id=${id}&part=1`])
  })

  it('explains a wrong or expired code, and a code that does not open the data', async () => {
    await expect(readByCode(CODE, async () => new Response('{}', { status: 404 }))).rejects.toThrow(/No export with this code/)
    const { blob } = await sealLikeSF('ZZZZZZZZZZZZ', exported(items))
    await expect(readByCode(CODE, async () => Response.json({ total: 1, blob }))).rejects.toThrow(/doesn’t open/)
    await expect(readByCode('nope')).rejects.toThrow(/12 letters/)
  })
})
