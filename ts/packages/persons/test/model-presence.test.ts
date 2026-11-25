import { describe, expect, it } from 'bun:test'
import { headerStatus, lastSeenShort, lastSeenText, mergePresence, rowStatus } from '../src/model/presence.ts'

const at = (d: number, h: number, m: number, month = 10, y = 2026) => new Date(y, month, d, h, m).getTime()
const NOW = at(25, 15, 0)

describe('presence', () => {
  it('merges events: null forgets, same values keep the object', () => {
    const prev = { a: 'online' as const, b: 'idle' as const }
    expect(mergePresence(prev, { a: 'online' })).toBe(prev)
    expect(mergePresence(prev, { a: null, c: 'dnd' })).toEqual({ b: 'idle', c: 'dnd' })
    expect(mergePresence(prev, { z: null })).toBe(prev)
  })

  it('row: best Discord status, WhatsApp online wins, else last seen, else nothing', () => {
    expect(rowStatus(['offline', 'idle'], [])).toEqual({ dot: 'idle', text: 'Idle', tone: 'idle' })
    expect(rowStatus(['dnd'], [])).toEqual({ dot: 'dnd', text: 'Do not disturb', tone: 'dnd' })
    expect(rowStatus(['offline'], [{ status: 'online' }])).toEqual({ dot: 'online', text: 'online', tone: 'online' })
    expect(rowStatus(['online'], [{ status: 'offline' }])?.text).toBe('Online')
    expect(rowStatus([undefined], [{ status: 'offline', lastSeen: at(25, 14, 32) }], NOW)).toEqual({ text: 'last seen 14:32', tone: 'muted' })
    expect(rowStatus(['offline'], [{ lastSeen: at(25, 14, 32) }], NOW)?.text).toBe('Offline')
    expect(rowStatus([undefined], [{}])).toBeUndefined()
    expect(rowStatus([], [])).toBeUndefined()
  })

  it('formats last seen as WhatsApp does', () => {
    expect(lastSeenText(at(25, 14, 32), NOW)).toBe('last seen today at 14:32')
    expect(lastSeenText(at(24, 9, 5), NOW)).toBe('last seen yesterday at 09:05')
    expect(lastSeenText(at(12, 9, 5), NOW)).toBe('last seen 12 Nov')
    expect(lastSeenText(at(3, 9, 5, 11, 2025), NOW)).toBe('last seen 3 Dec 2025')
    expect(lastSeenShort(at(25, 8, 1), NOW)).toBe('last seen 08:01')
    expect(lastSeenShort(at(24, 23, 59), NOW)).toBe('last seen yesterday')
    expect(lastSeenShort(at(1, 0, 0), NOW)).toBe('last seen 1 Nov')
  })

  it('header: Discord in words, WhatsApp online / typing / last seen', () => {
    expect(headerStatus('discord', 'online', undefined)).toEqual({ text: 'Online on Discord', tone: 'online' })
    expect(headerStatus('discord', 'dnd', undefined)?.text).toBe('Do not disturb on Discord')
    expect(headerStatus('discord', 'offline', undefined)).toEqual({ text: 'Offline on Discord', tone: 'muted' })
    expect(headerStatus('discord', undefined, undefined)).toBeUndefined()
    expect(headerStatus('discord', 'idle', undefined, 'typing')?.text).toBe('typing…')
    expect(headerStatus('whatsapp', 'online', undefined, 'typing')).toEqual({ text: 'online · typing…', tone: 'online' })
    expect(headerStatus('whatsapp', 'online', undefined)?.text).toBe('online')
    expect(headerStatus('whatsapp', undefined, at(25, 14, 32), undefined, NOW)).toEqual({ text: 'last seen today at 14:32', tone: 'muted' })
    expect(headerStatus('whatsapp', undefined, undefined, 'recording')?.text).toBe('recording audio…')
    expect(headerStatus('whatsapp', 'offline', undefined)).toBeUndefined()
    expect(headerStatus('gmail', undefined, undefined)).toBeUndefined()
  })
})
