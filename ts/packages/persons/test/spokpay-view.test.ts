// Ported from Person Hub's src/lib/spokpay.test.ts (what the UI needs about SpokPay).
import { describe, expect, it } from "bun:test";
import type { Person, Store } from "../src/model/types.ts";
import { type OwnerStore, SpokpayError } from "../src/spokpay-core.ts";
import { discordUsernames, localDraft, moveWords, parseDraft, parseReplyDraft, partLabel, pickSpokpayProject, resolveStore, spError, SPOKPAY_CHECKOUT, STATUS, STATUS_MOVES } from "../src/spokpay-view.ts";

const person = (p: Partial<Person> = {}): Person => ({ id: 'p1', name: 'Lua', discordId: '1', discordUsername: 'Horizon.A', storeIds: [], listIds: ['spokpay'], createdAt: '', updatedAt: '', ...p })
const stores: Store[] = [{ id: 's1', name: 'Shark Store', ownerId: 'p1' }, { id: 's2', name: 'Other' }]
const crm = (slug: string, role = 'owner', state: OwnerStore['state'] = 'open'): OwnerStore => ({ slug, name: slug, state, role, contact: 'C-1' })

describe('which SpokPay store a person is', () => {
  it('a store remembered for the person wins', () => {
    const r = resolveStore(person(), { stores }, { people: { p1: 'shark-store' }, stores: { s1: 'x-store' } }, [crm('a'), crm('b')])
    expect(r).toMatchObject({ slug: 'shark-store', source: 'person' })
  })
  it('then the one remembered for their Person Hub store', () => {
    expect(resolveStore(person(), { stores }, { people: {}, stores: { s1: 'x-store' } })).toMatchObject({ slug: 'x-store', source: 'store' })
  })
  it('then the CRM: one store → it; several → the one they own; else pick', () => {
    expect(resolveStore(person(), { stores: [] }, null, [crm('only')])).toMatchObject({ slug: 'only', source: 'crm' })
    expect(resolveStore(person(), { stores: [] }, null, [crm('mine'), crm('team', 'team')])).toMatchObject({ slug: 'mine', source: 'crm' })
    const r = resolveStore(person(), { stores: [] }, null, [crm('a'), crm('b')])
    expect(r.slug).toBeNull()
    expect(r.choices.map((c) => c.slug)).toEqual(['a', 'b'])
  })
  it('deleted stores never count', () => {
    expect(resolveStore(person(), { stores: [] }, null, [crm('gone', 'owner', 'deleted'), crm('live')])).toMatchObject({ slug: 'live' })
  })
  it('last, a SpokPay store named exactly like theirs', () => {
    const r = resolveStore(person(), { stores }, null, [], [{ name: 'shark store', slug: 'shark-store', ownerEmail: '', iconUrl: null, frozenAt: null }, { name: 'Sharks', slug: 'sharks', ownerEmail: '', iconUrl: null, frozenAt: null }])
    expect(r).toMatchObject({ slug: 'shark-store', source: 'name' })
  })
  it('nothing known: no store, nothing to guess', () => {
    expect(resolveStore({ ...person(), discordUsername: '' }, { stores: [] }, null)).toEqual({ slug: null, name: '', source: null, choices: [] })
  })
  it('Discord usernames: the SpokPay identity first, folded, deduped', () => {
    const p = person({ identities: [{ kind: 'discord', value: '2', section: 'spokpay', username: '@Spok.One' }, { kind: 'discord', value: '3', section: 'stores', username: 'horizon.a' }] })
    expect(discordUsernames(p)).toEqual(['spok.one', 'horizon.a'])
  })
})

describe('proposals from the agent (Headquarters’ fields)', () => {
  it('reads the last json block: store, category, subject, details, brief, why', () => {
    const reply = 'Aqui:\n```json\n{"store":"Shark-Store","category":"delivery","subject":"Pedido 1234 não entregue","details":"S","brief":{"change":"Ver","where":"Pedido 1234","extra":"x"},"why":"Lua said it twice"}\n```'
    expect(parseDraft(reply)).toEqual({ store: 'shark-store', why: 'Lua said it twice', fields: { category: 'delivery', subject: 'Pedido 1234 não entregue', details: 'S', brief: { change: 'Ver', where: 'Pedido 1234', references: '', deadline: '', outcome: '' } } })
  })
  it('unknown category → website; cut at the limits; needs a subject and details', () => {
    const d = parseDraft(`{"category":"bug","subject":"${'a'.repeat(200)}","summary":"s"}`)!
    expect(d.fields.category).toBe('website')
    expect(d.fields.subject).toHaveLength(120)
    expect(d.fields.details).toBe('s')
    expect(parseDraft('no json here')).toBeNull()
    expect(parseDraft('```json\n{"subject":"only"}\n```')).toBeNull()
  })
  it('without Harbor, the message is the proposal', () => {
    expect(localDraft({ content: '\nO banner ficou cortado\nna home' })).toMatchObject({ category: 'website', subject: 'O banner ficou cortado', details: 'O banner ficou cortado\nna home', brief: { change: 'O banner ficou cortado\nna home' } })
  })
  it('reply drafts: {text, why}', () => {
    expect(parseReplyDraft('```json\n{"text":"Pronto, veja","why":"they asked"}\n```')).toEqual({ text: 'Pronto, veja', why: 'they asked' })
    expect(parseReplyDraft('```json\n{"text":"  "}\n```')).toBeNull()
  })
})

describe('status moves (SpokPay’s ADMIN_TRANSITIONS, Headquarters’ words)', () => {
  it('lists only the moves SpokPay takes; finished requests have none', () => {
    expect(STATUS_MOVES.open).toEqual(['working', 'review', 'completed', 'closed'])
    expect(STATUS_MOVES.review).toEqual(['working', 'completed', 'closed'])
    expect(STATUS_MOVES.completed).toEqual([])
    expect(moveWords('review', 'working').label).toBe('Back to working')
    expect(moveWords('open', 'working').label).toBe('Start working')
    expect(STATUS.review.label).toBe('Waiting review')
  })
  it('brief labels follow the category', () => {
    expect(partLabel('website', 'change')).toBe('What to change')
    expect(partLabel('delivery', 'where')).toBe('Where or which order')
  })
})

describe('the Harbor project to draft in', () => {
  const p = (id: string, path?: string, here?: boolean) => ({ id, name: path?.split('/').pop() ?? id, path, here })
  it('only SpokPay checkouts, this PC’s own first', () => {
    expect(pickSpokpayProject([p('crm', '/x/spokpay-crm'), p('mac', '/Users/f/work/spokpay', false), p('mine', SPOKPAY_CHECKOUT, true)])?.id).toBe('mine')
    expect(pickSpokpayProject([p('mac', '/Users/f/work/spokpay', false), p('here', '/srv/spokpay/', true)])?.id).toBe('here')
    expect(pickSpokpayProject([p('mac', '/Users/f/work/spokpay', false)])?.id).toBe('mac')
    expect(pickSpokpayProject([p('agents', '/x/spokpay-agents'), p('creators', '/x/creators')])).toBeNull()
  })
})

describe('errors', () => {
  it('splits SpokPay’s code from the message', () => {
    expect(spError(new Error('[NOT_AUTHORIZED] This SpokPay API key lacks site-requests:open'))).toEqual({ code: 'NOT_AUTHORIZED', message: 'This SpokPay API key lacks site-requests:open' })
    expect(spError(new SpokpayError(403, 'NOT_AUTHORIZED', 'lacks x'))).toEqual({ code: 'NOT_AUTHORIZED', message: 'lacks x' })
    expect(spError(new Error('PC offline'))).toEqual({ code: '', message: 'PC offline' })
  })
})
