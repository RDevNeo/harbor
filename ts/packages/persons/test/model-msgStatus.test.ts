import { describe, expect, it } from 'bun:test'
import { mergeStatus } from '../src/model/msgStatus.ts'
import { mergeMessages } from '../src/model/conversation.ts'
import type { Message, MessageStatus } from '../src/model/types.ts'


const ALL: (MessageStatus | undefined)[] = [undefined, 'error', 'pending', 'sent', 'delivered', 'read']

describe('WhatsApp message status', () => {

  it('only moves forward', () => {
    expect(mergeStatus('read', 'delivered')).toBe('read')
    expect(mergeStatus('delivered', 'sent')).toBe('delivered')
    expect(mergeStatus('sent', 'delivered')).toBe('delivered')
    expect(mergeStatus('pending', 'read')).toBe('read')
    expect(mergeStatus(undefined, 'sent')).toBe('sent')
    expect(mergeStatus('sent', undefined)).toBe('sent')
  })

  it('an error replaces only pending / sent; delivered or read wins over an error', () => {
    expect(mergeStatus('pending', 'error')).toBe('error')
    expect(mergeStatus('sent', 'error')).toBe('error')
    expect(mergeStatus('delivered', 'error')).toBe('delivered')
    expect(mergeStatus('error', 'sent')).toBe('error')
    expect(mergeStatus('error', 'delivered')).toBe('delivered')
  })



  it('mergeMessages never downgrades the ticks, but takes the rest of a newer copy', () => {
    const m = (status: MessageStatus, content = 'hi'): Message => ({ id: 'a', channelId: 'c', authorId: 'me', fromMe: true, content, timestamp: '2026-01-01T00:00:00.000Z', status })
    let c = mergeMessages(undefined, [m('read')], 'c')
    c = mergeMessages(c, [m('sent', 'edited')])
    expect(c.messages[0]).toMatchObject({ status: 'read', content: 'edited' })
    c = mergeMessages(mergeMessages(undefined, [m('sent')], 'c'), [m('delivered')])
    expect(c.messages[0]!.status).toBe('delivered')
  })
})
