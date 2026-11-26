// Ported from Person Hub's src/lib/siteRequestList.test.ts (Headquarters' Site requests list).
import { describe, expect, it } from 'bun:test'
import { ACTIVE_LIMIT, failedAgain, initialsOf, isUnread, listNotices, listRows, preview, siteRequestPageUrl, sweepSeen, waitsOnSpokPay } from '../src/srlist.ts'
import type { SrRow } from '../src/spokpay-core.ts'

const row = (r: Partial<SrRow> = {}): SrRow => ({
  ref: 'SR-1', category: 'website', subject: 'Banner', status: 'open', storeName: 'Loja Nebulosa', storeSlug: 'nebulosa', ownerEmail: '',
  lastMessagePreview: null, lastMessageSide: null, waitingOn: null, unread: false, createdAt: 1, lastActivityAt: 10, ...r,
})

describe('site request list (Headquarters)', () => {
  it('waits on SpokPay unless in review or SpokPay spoke last; no message is the opening ask', () => {
    expect(waitsOnSpokPay(row())).toBe(true)
    expect(waitsOnSpokPay(row({ lastMessagePreview: 'oi', lastMessageSide: 'store', status: 'working' }))).toBe(true)
    expect(waitsOnSpokPay(row({ lastMessagePreview: 'ok', lastMessageSide: 'spokpay' }))).toBe(false)
    expect(waitsOnSpokPay(row({ status: 'review', lastMessagePreview: 'oi', lastMessageSide: 'store' }))).toBe(false)
  })

  it('unread: SpokPay flag until seen here, then activity after the mark; never when SpokPay spoke last', () => {
    expect(isUnread(row({ unread: true }), undefined)).toBe(true)
    expect(isUnread(row({ unread: true, lastActivityAt: 10 }), 10)).toBe(false)
    expect(isUnread(row({ unread: false, lastActivityAt: 20 }), 10)).toBe(true)
    expect(isUnread(row({ unread: true, lastMessagePreview: 'x', lastMessageSide: 'spokpay' }), undefined)).toBe(false)
  })

  it('previews who spoke last', () => {
    expect(preview(row())).toBe('No messages yet')
    expect(preview(row({ lastMessagePreview: '  muda\n o banner ', lastMessageSide: 'store' }))).toBe('Loja Nebulosa: muda o banner')
    expect(preview(row({ lastMessagePreview: '', lastMessageSide: 'spokpay' }))).toBe('SpokPay: Sent a file')
  })

  it('rows: newest activity first, store side words', () => {
    const rows = listRows([
      row({ ref: 'SR-1', lastActivityAt: 5 }),
      row({ ref: 'SR-2', lastActivityAt: 30, unread: true }),
      row({ ref: 'SR-3', lastActivityAt: 20, lastMessagePreview: 'feito', lastMessageSide: 'spokpay' }),
    ], {})
    expect(rows.map((r) => r.ref)).toEqual(['SR-2', 'SR-3', 'SR-1'])
    expect(rows.map((r) => r.side?.text ?? null)).toEqual(['Store replied', null, 'Store waiting'])
  })

  it('notices', () => {
    expect(listNotices({ kind: 'none' }, false, false)).toEqual([{ title: 'Site requests not read yet', text: 'They show within a minute.' }])
    expect(listNotices({ kind: 'none' }, true, false)).toEqual([])
    expect(listNotices({ kind: 'not-connected' }, true, false)[0]!.title).toBe('SpokPay is not connected')
    expect(listNotices({ kind: 'failed', reason: 'boom', since: 1 }, true, true).map((n) => n.title)).toEqual(['Site requests not read', `Only the newest ${ACTIVE_LIMIT}`])
  })

  it('keeps the first failure time; sweeps seen marks only on a full read', () => {
    const f = failedAgain({ kind: 'none' }, 'a', 5)
    expect(failedAgain(f, 'b', 9)).toEqual({ kind: 'failed', reason: 'b', since: 5 })
    expect(sweepSeen({ 'SR-1': 1, 'SR-2': 2 }, [{ ref: 'SR-2' }], false)).toEqual({ 'SR-2': 2 })
    expect(sweepSeen({ 'SR-1': 1 }, [], true)).toEqual({ 'SR-1': 1 })
  })

  it('initials and link', () => {
    expect(initialsOf('Loja Nebulosa')).toBe('LN')
    expect(initialsOf('zeus-robux')).toBe('ZR')
    expect(initialsOf('Arena')).toBe('AR')
    expect(initialsOf('  ')).toBe('?')
    expect(siteRequestPageUrl('SR-121')).toBe('https://spokpay.com/admin/requests?thread=SR-121')
  })
})
