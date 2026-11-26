// Ported from Person Hub's src/lib/spokpay-core.test.ts: the pure part, then spokpay.ts against a fake SpokPay.
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/spokpay-core.ts";
import { createSpokpay } from "../src/spokpay.ts";

const KEY = `spk_admin_${'ab12'.repeat(16)}`
const BASE = 'https://spokpay.test/assistant/v1'
const row = (ref: string, slug: string | null, extra: Record<string, unknown> = {}) => ({
  ref, category: 'website', subject: `Subject ${ref}`, status: 'open', storeName: 'Lulu Store', storeSlug: slug, ownerEmail: 'o@x.com',
  lastMessagePreview: null, lastMessageSide: null, waitingOn: 'store', unread: false, createdAt: 1, lastActivityAt: 10, ...extra,
})
const header = (ref: string, slug = 'lulu-store', extra: Record<string, unknown> = {}) => ({
  ref, category: 'delivery', subject: 'Pedido 1234', status: 'open', store: { name: 'Lulu Store', slug }, waitingOn: 'store',
  brief: { change: 'Ver', where: '', references: '', deadline: '', outcome: '' }, attachments: [], createdAt: 5, lastActivityAt: 50, ...extra,
})

describe('spokpay-core: keys and refs', () => {
  it('accepts only spk_admin_ + 64 hex, and hints without the key', () => {
    expect(core.isKey(KEY)).toBe(true)
    expect(core.isKey(KEY.toUpperCase())).toBe(false)
    expect(core.isKey(`${KEY}0`)).toBe(false)
    expect(core.keyHint(KEY)).toBe('spk_admin_…ab12')
    expect(core.keyHint(KEY)).not.toContain(KEY.slice(10, 30))
  })
  it('normalizes refs as the route does (case-insensitive)', () => {
    expect(core.normalizeRef(' sr-0116 ')).toBe('SR-116')
    expect(core.normalizeRef('SR-140')).toBe('SR-140')
    expect(core.normalizeRef('SR-')).toBeNull()
    expect(core.normalizeRef('SR-1/../x')).toBeNull()
  })
})

describe('spokpay-core: errors', () => {
  it('reads { error: { code, message } } and says what to do', () => {
    const e = core.errorFrom(403, { error: { code: 'NOT_AUTHORIZED', message: 'This API key does not have the site-requests:open permission. The admin can add it here: https://spokpay.com/admin?…' } })
    expect(e.code).toBe('NOT_AUTHORIZED')
    expect(e.message).toContain('site-requests:open')
    expect(e.message).not.toContain('https://')
    expect(core.errorFrom(401, null).code).toBe('UNAUTHENTICATED')
    const lim = core.errorFrom(429, { error: { code: 'LIMIT_REACHED', message: 'x' } }, '12')
    expect(lim.retryAfter).toBe('12')
    expect(lim.message).toContain('12 s')
    expect(core.errorFrom(404, { error: { code: 'SITE_REQUEST_NOT_FOUND', message: 'No site request SR-9' } }).message).toBe('No site request SR-9')
    expect(core.errorFrom(502, '<html>').code).toBe('HTTP_502')
  })
  it('a permission is held unless the route refused it with 403', () => {
    expect(core.heldFromProbe(200)).toBe(true)
    expect(core.heldFromProbe(400, 'INVALID_INPUT')).toBe(true) // POST {} past the permission check
    expect(core.heldFromProbe(403, 'NOT_AUTHORIZED')).toBe(false)
    expect(core.heldFromProbe(401)).toBeNull()
    expect(core.heldFromProbe(500)).toBeNull()
  })
})

describe('spokpay-core: answers', () => {
  it('reads list rows exactly as adminAssistantSiteRequestRowValidator', () => {
    const [r] = core.readRows({ siteRequests: [row('SR-116', 'lulu-store', { category: 'nope', status: 'review', lastMessageSide: 'spokpay', unread: true })] })
    expect(r as unknown).toEqual({ ...row('SR-116', 'lulu-store'), category: 'website', status: 'review', lastMessageSide: 'spokpay', unread: true })
    expect(() => core.readRows({})).toThrow(/unexpected/)
    expect(() => core.readRows({ siteRequests: [{ ref: 'x' }] })).toThrow()
  })
  it('reads a thread: header with every brief part, messages, known events', () => {
    const t = core.readThread({
      siteRequest: header('SR-116', 'lulu-store', { brief: { change: 'Um banner' }, attachments: [{ url: 'https://u', name: 'p.png', contentType: 'image/png' }] }),
      messages: [{ messageId: 'm1', side: 'store', authorName: 'dono@x.com', text: 'oi', attachments: [], createdAt: 7 }],
      events: [{ event: 'review', createdAt: 6 }, { event: 'mystery', createdAt: 8 }],
      hasMore: true,
    })
    expect(t.siteRequest.brief).toEqual({ change: 'Um banner', where: '', references: '', deadline: '', outcome: '' })
    expect(t.siteRequest.attachments[0]).toEqual({ url: 'https://u', name: 'p.png', contentType: 'image/png' })
    expect(t.messages[0]?.side).toBe('store')
    expect(t.events).toEqual([{ event: 'review', createdAt: 6 }])
    expect(t.hasMore).toBe(true)
  })
  it('reads store and CRM pages, only the fields used', () => {
    expect(core.readStorePage({ page: [{ name: 'A', slug: 'a', ownerEmail: 'e', iconUrl: null, availableBalance: 9, lastPaidAt: null, frozenAt: null, createdAt: 1 }, { name: 'no slug', slug: null }], isDone: true, continueCursor: '', total: 2 }).page)
      .toEqual([{ name: 'A', slug: 'a', ownerEmail: 'e', iconUrl: null, frozenAt: null }])
    const [c] = core.readCrmPage({ page: [{ ref: 'C-5', kind: 'store_owner', name: 'Lua', channels: { discord: 'Horizon.A' }, stores: [{ slug: 'shark-store', name: 'Shark Store', state: 'open', role: 'owner' }] }] })
    expect(c).toEqual({ ref: 'C-5', kind: 'store_owner', name: 'Lua', discord: 'Horizon.A', stores: [{ slug: 'shark-store', name: 'Shark Store', state: 'open', role: 'owner' }] })
  })
})

describe('spokpay-core: opening body', () => {
  it('JSON without images: trimmed, cut at the limits, blank brief parts left out', () => {
    const b = core.buildOpening({ store: ' lulu-store ', category: 'delivery', subject: 'x'.repeat(200), summary: ' s ', brief: { change: ' c ', where: '', outcome: 'o'.repeat(700) } })
    expect(b.json).toEqual({ store: 'lulu-store', category: 'delivery', subject: 'x'.repeat(120), summary: 's', brief: { change: 'c', outcome: 'o'.repeat(600) } })
  })
  it('multipart with images: brief as JSON text, at most 5 images/*, 10 MB each', () => {
    const img = { name: 'p.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }
    const b = core.buildOpening({ store: 's', subject: 'a', summary: 'b', brief: { where: 'w' }, images: [img] })
    expect(b.form).toEqual({ store: 's', category: 'website', subject: 'a', summary: 'b', brief: '{"where":"w"}' })
    expect(b.images).toHaveLength(1)
    expect(() => core.buildOpening({ store: 's', subject: 'a', summary: 'b', images: Array(6).fill(img) })).toThrow(/At most 5/)
    expect(() => core.buildOpening({ store: 's', subject: 'a', summary: 'b', images: [{ ...img, type: 'application/pdf' }] })).toThrow(/not an image/)
    expect(() => core.buildOpening({ store: 's', subject: 'a', summary: 'b', images: [{ ...img, data: new Uint8Array(0) }] })).toThrow(/10 MB/)
  })
  it('refuses what the route refuses before any call', () => {
    expect(() => core.buildOpening({ subject: 'a', summary: 'b' })).toThrow(/store/)
    expect(() => core.buildOpening({ store: 's', subject: ' ', summary: 'b' })).toThrow(expect.objectContaining({ code: 'SITE_REQUEST_SUBJECT_REQUIRED' }))
    expect(() => core.buildOpening({ store: 's', subject: 'a', summary: '' })).toThrow(expect.objectContaining({ code: 'SITE_REQUEST_SUMMARY_REQUIRED' }))
    expect(() => core.buildOpening({ store: 's', subject: 'a', summary: 'b', category: 'bug' })).toThrow(/category/)
  })
})

describe('spokpay-core: a person’s stores from the CRM', () => {
  const contacts: { ref: string; discord: string; stores: core.CrmStore[] }[] = [
    { ref: 'C-1', discord: 'Horizon.A', stores: [{ slug: 'shark-store', name: 'Shark Store', state: 'open', role: 'owner' }, { slug: 'old', name: 'Old', state: 'deleted', role: 'owner' }] },
    { ref: 'C-2', discord: 'horizon.ab', stores: [{ slug: 'other', name: 'Other', state: 'open', role: 'owner' }] },
    { ref: 'C-3', discord: 'horizon.a', stores: [{ slug: 'shark-store', name: 'Shark Store', state: 'open', role: 'co_owner' }] },
  ]
  it('matches the Discord handle exactly (case and @ folded), drops deleted stores, one per slug', () => {
    expect(core.storesOfDiscord(contacts, ['@horizon.a'])).toEqual([{ slug: 'shark-store', name: 'Shark Store', state: 'open', role: 'owner', contact: 'C-1' }])
    expect(core.storesOfDiscord(contacts, ['nobody'])).toEqual([])
  })
})

// ---------- the shell module against a fake SpokPay ----------

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown }

function fakeSpokpay(perms: string[], opts: { active?: unknown[]; open?: unknown } = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: URL, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body })
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (init.headers.Authorization !== `Bearer ${KEY}`) return res(401, { error: { code: 'UNAUTHENTICATED', message: 'The API key is invalid, revoked or expired.' } })
    const p = url.pathname.replace('/assistant/v1', '')
    const need = (perm: string) => (perms.includes(perm) ? null : res(403, { error: { code: 'NOT_AUTHORIZED', message: `This API key does not have the ${perm} permission. The admin can add it here: https://x` } }))
    if (init.method === 'GET' && p === '/admin/site-requests/active') return need('site-requests:read') ?? res(200, { siteRequests: opts.active ?? [] })
    if (init.method === 'POST' && p === '/admin/site-requests') {
      const refused = need('site-requests:open')
      if (refused) return refused
      if (typeof init.body === 'string' && init.body === '{}') return res(400, { error: { code: 'INVALID_INPUT', message: 'store is required' } })
      return res(201, opts.open ?? { siteRequest: header('SR-200'), opened: true })
    }
    const w = /^\/admin\/site-requests\/(SR-\d+)\/(messages|status)$/.exec(p)
    if (init.method === 'POST' && w) {
      const refused = need(w[2] === 'messages' ? 'site-requests:write' : 'site-requests:status')
      if (refused) return refused
      if (init.body === '{}') return res(400, { error: { code: 'INVALID_INPUT', message: w[2] === 'messages' ? 'text is required and must be a string.' : 'status is required' } })
      if (w[1] === 'SR-0') return res(404, { error: { code: 'SITE_REQUEST_NOT_FOUND', message: 'no' } })
      if (w[2] === 'status') return JSON.parse(String(init.body)).status === 'working' ? res(200, { siteRequest: header(w[1] ?? '', 'lulu-store', { status: 'working' }) }) : res(400, { error: { code: 'SITE_REQUEST_TRANSITION_INVALID', message: 'x' } })
      if (w[1] === 'SR-9') return res(400, { error: { code: 'SITE_REQUEST_ALREADY_COMPLETED', message: 'done' } })
      return res(200, { siteRequest: header(w[1] ?? ''), message: { messageId: 'm9', side: 'spokpay', authorName: 'SpokPay', text: 'ok', attachments: [], createdAt: 9 } })
    }
    if (init.method === 'GET' && p === '/admin/stores') return need('stores:read') ?? res(200, { page: [], isDone: true, continueCursor: '', total: 0 })
    if (init.method === 'GET' && p === '/admin/crm/contacts') return need('crm:read') ?? res(200, { page: [], isDone: true, continueCursor: '', total: null })
    const m = /^\/admin\/site-requests\/(SR-\d+)\/messages$/.exec(p)
    if (init.method === 'GET' && m) return need('site-requests:read') ?? res(200, { siteRequest: header(m[1] ?? '', 'lulu-store', { status: 'completed', lastActivityAt: 99 }), messages: [], events: [], hasMore: false })
    return res(404, { error: { code: 'NOT_FOUND', message: 'no route' } })
  }
  return { calls, fetchImpl }
}

describe('spokpay.ts', () => {
  let dir = ''
  const logs: string[] = []
  const events: unknown[] = []
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-spokpay-')); logs.length = 0; events.length = 0 })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const make = (f: ReturnType<typeof fakeSpokpay>) => createSpokpay({ dir, base: BASE, fetch: f.fetchImpl, log: (...a: unknown[]) => logs.push(a.join(' ')), emit: (e: unknown) => events.push(e) })

  it('checks the key by reading, probes permissions without writing, keeps it 0600 and never logs it', async () => {
    const f = fakeSpokpay(['site-requests:read', 'site-requests:open'])
    const sp = make(f)
    const st = await sp.setKey(`  ${KEY}\n`)
    expect(st).toMatchObject({ connected: true, keyHint: 'spk_admin_…ab12', permissions: { 'site-requests:read': true, 'site-requests:open': true, 'site-requests:write': false, 'site-requests:status': false, 'stores:read': false, 'crm:read': false } })
    expect(JSON.stringify(st)).not.toContain(KEY)
    const file = path.join(dir, 'spokpay.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).key).toBe(KEY)
    // the only POSTs are the empty-body probes (refused before anything is written)
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => [c.url.pathname.replace('/assistant/v1', ''), c.body])).toEqual([['/admin/site-requests', '{}'], ['/admin/site-requests/SR-0/messages', '{}'], ['/admin/site-requests/SR-0/status', '{}']])
    expect(f.calls.every((c) => c.url.origin === 'https://spokpay.test')).toBe(true)
    expect(logs.join('\n')).not.toContain(KEY)
    expect(JSON.stringify(events)).not.toContain(KEY)
  })

  it('refuses a malformed, rejected, or read-less key and saves nothing', async () => {
    const sp = make(fakeSpokpay(['site-requests:open']))
    await expect(sp.setKey('spk_admin_nope')).rejects.toThrow(/not a SpokPay admin key/)
    await expect(sp.setKey(`spk_admin_${'0'.repeat(64)}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(sp.setKey(KEY)).rejects.toThrow(/site-requests:read/)
    expect(fs.existsSync(path.join(dir, 'spokpay.json'))).toBe(false)
    expect(sp.status().connected).toBe(false)
  })

  it('a proposal waits; Open posts it once (Idempotency-Key from the proposal), JSON or multipart, and remembers the ref', async () => {
    const f = fakeSpokpay(['site-requests:read', 'site-requests:open'])
    const sp = make(f)
    await sp.setKey(KEY)
    const posts = () => f.calls.filter((c) => c.method === 'POST' && c.body !== '{}')
    const p = sp.propose({ personId: 'p1', store: { slug: 'lulu-store', name: 'Lulu Store' }, fields: { category: 'delivery', subject: 'Pedido 1234', details: 'Não entregou', brief: { change: 'Ver' } }, why: 'asked', from: { name: 'SpokPay agent' } })
    expect(p.state).toEqual({ kind: 'waiting' })
    expect(posts()).toHaveLength(0) // proposing reaches nothing at SpokPay
    sp.saveProposal(p.id, { fields: { ...p.shown, subject: 'Pedido 1234 não entregue' } })
    const opened = await sp.openProposal(p.id, undefined, [])
    expect(opened?.state).toMatchObject({ kind: 'opened', ref: 'SR-200' })
    expect(JSON.parse(String(posts()[0]?.body))).toEqual({ store: 'lulu-store', category: 'delivery', subject: 'Pedido 1234 não entregue', summary: 'Não entregou', brief: { change: 'Ver' } })
    expect(posts()[0]?.headers['Idempotency-Key']).toMatch(new RegExp(`^${p.id}-[0-9a-f]{12}$`))
    await expect(sp.openProposal(p.id)).rejects.toThrow(/Already opened as SR-200/)
    const q = sp.propose({ personId: 'p1', store: { slug: 'lulu-store', name: 'L' }, fields: { subject: 'a', details: 'b' } })
    await sp.openProposal(q.id, undefined, [{ name: 'p.png', type: 'image/png', data: new Uint8Array([1, 2]) }])
    const form = posts().at(-1)!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('summary')).toBe('b')
    expect(form.getAll('images')).toHaveLength(1)
    expect(sp.links().refs['lulu-store']).toEqual(['SR-200'])
    expect(fs.statSync(path.join(dir, 'spokpay-proposals.json')).mode & 0o777).toBe(0o600)
  })

  it('a failed Open keeps the proposal for Retry; Discard hides it', async () => {
    const sp = make(fakeSpokpay(['site-requests:read']))
    await sp.setKey(KEY)
    const p = sp.propose({ personId: 'p1', store: null, fields: { subject: 'a', details: 'b' } })
    await expect(sp.openProposal(p.id)).rejects.toThrow(/Pick the store/)
    sp.saveProposal(p.id, { store: { slug: 'lulu-store', name: 'L' } })
    const out = await sp.openProposal(p.id)
    expect(out?.state).toMatchObject({ kind: 'failed', fix: 'connections' })
    expect(JSON.stringify(out?.state)).toMatch(/site-requests:open/)
    sp.discardProposal(p.id)
    expect(sp.proposals()).toEqual([])
  })

  it('replies and moves status only with their permissions, in Headquarters’ words', async () => {
    const f = fakeSpokpay(['site-requests:read', 'site-requests:write', 'site-requests:status'])
    const sp = make(f)
    await sp.setKey(KEY)
    expect(sp.status().permissions).toMatchObject({ 'site-requests:write': true, 'site-requests:status': true })
    const r = await sp.reply('sr-140', { text: '  Pronto  ' }, 'k1')
    expect(r.message).toMatchObject({ side: 'spokpay', text: 'ok' })
    const post = f.calls.filter((c) => c.method === 'POST').at(-1)!
    expect(post.url.pathname).toBe('/assistant/v1/admin/site-requests/SR-140/messages')
    expect(JSON.parse(String(post.body))).toEqual({ text: 'Pronto' })
    expect(post.headers['Idempotency-Key']).toBe('k1')
    await expect(sp.reply('SR-9', { text: 'x' })).rejects.toThrow('SpokPay finished this request, so it takes no reply.')
    await expect(sp.reply('SR-1', { text: ' ' })).rejects.toThrow(/Write the reply/)
    expect((await sp.setStatus('SR-140', 'working')).siteRequest.status).toBe('working')
    await expect(sp.setStatus('SR-140', 'review')).rejects.toThrow(/does not move this request there/)
    await expect(sp.setStatus('SR-140', 'open')).rejects.toThrow(/working, review, completed or closed/)
  })

  it('reply drafts wait for Send; Send replies with the edited text and drops the draft', async () => {
    const f = fakeSpokpay(['site-requests:read', 'site-requests:write'])
    const sp = make(f)
    await sp.setKey(KEY)
    const d = sp.saveDraft({ ref: 'SR-140', text: 'Oi', why: 'w', from: { name: 'SpokPay agent' } })
    sp.saveDraft({ id: d.id, ref: 'SR-140', text: 'Oi, pronto' })
    expect(sp.drafts('SR-140')[0]).toMatchObject({ text: 'Oi, pronto', agentText: 'Oi' })
    await sp.sendDraft(d.id, 'Oi, pronto!')
    expect(JSON.parse(String(f.calls.filter((c) => c.method === 'POST').at(-1)!.body))).toEqual({ text: 'Oi, pronto!' })
    expect(sp.drafts('SR-140')).toEqual([])
  })

  it('lists a store’s requests: active ones of that slug plus refs opened here, newest first', async () => {
    const f = fakeSpokpay(['site-requests:read', 'site-requests:open'], { active: [row('SR-1', 'lulu-store', { lastActivityAt: 20 }), row('SR-2', 'other')] })
    const sp = make(f)
    await sp.setKey(KEY)
    const p = sp.propose({ personId: 'p1', store: { slug: 'lulu-store', name: 'L' }, fields: { subject: 'a', details: 'b' } })
    await sp.openProposal(p.id)
    const list = await sp.requests(['lulu-store'])
    expect(list.map((r: { ref: string; status: string }) => [r.ref, r.status])).toEqual([['SR-200', 'completed'], ['SR-1', 'open']])
  })
  it('a permission added to the key on spokpay.com/admin is picked up without the key typed again', async () => {
    const perms = ['site-requests:read']
    const f = fakeSpokpay(perms)
    const sp = make(f)
    const t0 = Date.now()
    try {
      await sp.setKey(KEY)
      expect(sp.status().permissions['site-requests:write']).toBe(false)
      perms.push('site-requests:write')
      // refused at once while the last ask is fresh: no call
      const before = f.calls.length
      await expect(sp.reply('SR-7', { text: 'oi' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
      expect(f.calls.length).toBe(before)
      // a pane's recheck (a minute old) asks again and the permission shows as held
      setSystemTime(new Date(t0 + 61_000))
      expect((await sp.recheck(60_000)).permissions['site-requests:write']).toBe(true)
      perms.push('site-requests:status')
      // a refused action asks again first (15 s old) and then goes through
      setSystemTime(new Date(t0 + 80_000))
      await expect(sp.setStatus('SR-7', 'working')).resolves.toMatchObject({ siteRequest: { status: 'working' } })
      expect(sp.status().permissions['site-requests:status']).toBe(true)
      // just asked: not again
      const n = f.calls.length
      await sp.recheck(60_000)
      expect(f.calls.length).toBe(n)
    } finally {
      setSystemTime()
    }
  })

  it('does not call routes the key lacks, and remembers store links', async () => {
    const f = fakeSpokpay(['site-requests:read'])
    const sp = make(f)
    await sp.setKey(KEY)
    const before = f.calls.length
    const p = sp.propose({ personId: 'p1', store: { slug: 's', name: 's' }, fields: { subject: 'a', details: 'b' } })
    expect(JSON.stringify((await sp.openProposal(p.id))?.state)).toMatch(/site-requests:open/)
    await expect(sp.reply('SR-1', { text: 'x' })).rejects.toThrow(/site-requests:write/)
    await expect(sp.setStatus('SR-1', 'working')).rejects.toThrow(/site-requests:status/)
    await expect(sp.ownerStores(['horizon.a'])).rejects.toThrow(/crm:read/)
    expect(f.calls.length).toBe(before)
    sp.setLink('people', 'p_1', 'shark-store')
    sp.setLink('stores', 's_1', 'shark-store')
    expect(sp.links()).toMatchObject({ people: { p_1: 'shark-store' }, stores: { s_1: 'shark-store' } })
    expect(() => sp.setLink('people', 'p_1', 'Bad Slug')).toThrow()
    expect(fs.statSync(path.join(dir, 'spokpay-links.json')).mode & 0o777).toBe(0o600)
    sp.clearKey()
    expect(fs.existsSync(path.join(dir, 'spokpay.json'))).toBe(false)
  })
})
