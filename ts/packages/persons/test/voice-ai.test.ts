import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiContext, attachmentsLine } from '../src/ai.ts'
import { AudioService, audioKey, type AudioMeta } from '../src/audio.ts'
import { forwardedNote, splitForwarded } from '../src/forward.ts'
import type { Message, Person } from '../src/model/types.ts'
import { VoiceQueue, voiceJobs } from '../src/voicequeue.ts'

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const person: Person = { id: 'p1', name: 'Evellin', discordId: '', whatsapp: '5511912345678', storeIds: [], listIds: [], createdAt: '', updatedAt: '' }
const voice = (id: string, at: string, fromMe = false, secs = 20): Message => ({
  id, channelId: 'c', authorId: fromMe ? 'me' : 'them', fromMe, content: '', timestamp: at, voice: true,
  attachments: [{ name: `voice-${id}.ogg`, url: `chwa://wa/${id}?name=v.ogg`, type: 'audio/ogg; codecs=opus', duration: secs }],
})
const text = (id: string, at: string, content: string): Message => ({ id, channelId: 'c', authorId: 'them', fromMe: false, content, timestamp: at })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('the AI context knows what was said in voice messages', () => {
  it('writes "[voice 0:20] <transcript>" instead of "voice message"', () => {
    const msgs = [text('1', '2026-11-25T09:00:00.000Z', 'oi'), voice('V1', '2026-11-25T09:01:00.000Z'), voice('V2', '2026-11-25T09:02:00.000Z', false, 7)]
    const said: Record<string, string> = { V1: 'Queria saber  das taxas\ndo PIX.' }
    const ctx = aiContext({ person, section: 'stores', data: null, channel: 'WhatsApp', messages: msgs, transcriptOf: (m, i) => (i === 0 ? said[m.id] : undefined) })
    expect(ctx).toContain('Evellin: [voice 0:20] Queria saber das taxas do PIX.')
    expect(ctx).toContain('Evellin: [voice 0:07] (not transcribed)')
    expect(ctx).not.toContain('voice message')
    // without transcripts at all: still the length, never "Voice message"
    expect(aiContext({ person, section: 'stores', data: null, channel: 'WhatsApp', messages: msgs })).toContain('Evellin: [voice 0:20] (not transcribed)')
  })

  it('keeps text, other files and empty transcripts apart', () => {
    const m: Message = { ...voice('V3', '2026-11-25T09:00:00.000Z'), content: 'olha isso', attachments: [{ name: 'song.mp3', url: 'x', type: 'audio/mpeg', duration: 65 }, { name: 'print.png', url: 'y', type: 'image/png' }], voice: false }
    expect(attachmentsLine(m, () => '')).toBe('[audio 1:05] (no speech) [print.png]')
    const ctx = aiContext({ person, section: 'stores', data: null, channel: 'WhatsApp', messages: [m], transcriptOf: () => 'la la la' })
    expect(ctx).toContain('Evellin: olha isso [audio 1:05] la la la [print.png]')
  })

  it('a forwarded voice message carries its transcript to the AI', () => {
    const note = forwardedNote({ message: voice('V1', '2026-11-25T09:01:00.000Z'), from: 'Evellin', question: '', transcripts: ['Queria saber das taxas.'] })
    expect(note).toContain('Transcript of the audio: Queria saber das taxas.')
    expect(splitForwarded(note).forwarded?.from).toBe('Evellin')
  })
})

describe('voiceJobs', () => {
  const chats = [{ connId: 'wa', messages: [voice('OLD', '2026-10-01T00:00:00.000Z'), voice('A', '2026-11-24T10:00:00.000Z'), voice('MINE', '2026-11-25T10:00:00.000Z', true), voice('B', '2026-11-25T11:00:00.000Z'), text('T', '2026-11-25T11:30:00.000Z', 'oi')] }]

  it('their recent audio without a transcript, newest first; not mine, not old, not done', () => {
    expect(voiceJobs(chats, () => undefined, NOW).map((j) => j.key)).toEqual(['wa:B:0', 'wa:A:0'])
    const done: Record<string, AudioMeta> = { 'wa:B:0': { transcript: 'oi' } }
    expect(voiceJobs(chats, (k) => done[k], NOW).map((j) => j.key)).toEqual(['wa:A:0'])
  })

  it('a failed one waits a day, three tries at most', () => {
    const failed = (at: string, attempts: number): Record<string, AudioMeta> => ({ 'wa:B:0': { failed: at, attempts } })
    expect(voiceJobs(chats, (k) => failed('2026-11-25T11:00:00.000Z', 1)[k], NOW).map((j) => j.key)).toEqual(['wa:A:0'])
    expect(voiceJobs(chats, (k) => failed('2026-11-24T11:00:00.000Z', 1)[k], NOW).map((j) => j.key)).toEqual(['wa:B:0', 'wa:A:0'])
    expect(voiceJobs(chats, (k) => failed('2026-11-20T11:00:00.000Z', 3)[k], NOW).map((j) => j.key)).toEqual(['wa:A:0'])
  })
})

describe('VoiceQueue', () => {
  const fakeOs = { player: () => null, play: () => null, decode: async (_f: string, rate: number) => new Int16Array(rate * 2) }

  it('transcribes one at a time, at low priority, caches by message id, remembers what failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-voice-'))
    dirs.push(dir)
    let busy = 0, most = 0
    const lows: boolean[] = []
    const os = { ...fakeOs, decode: async (f: string, rate: number, _max?: number, low?: boolean) => { lows.push(!!low); return fakeOs.decode(f, rate) } }
    const audio = new AudioService({ dir, os, changed: () => {}, now: () => NOW, transcribe: async () => { busy++; most = Math.max(most, busy); await new Promise((r) => setTimeout(r, 5)); busy--; return 'texto' } })
    const chats = [{ connId: 'wa', messages: [voice('A', '2026-11-24T10:00:00.000Z'), voice('B', '2026-11-25T11:00:00.000Z'), voice('GONE', '2026-11-25T11:10:00.000Z')] }]
    const fetched: string[] = []
    const q = new VoiceQueue({ audio, chats: () => chats, gapMs: 0, now: () => NOW, fetch: async (url) => { fetched.push(url); return url.includes('GONE') ? null : `/tmp/${url}` } })
    expect(await q.run()).toBe(2)
    expect(most).toBe(1)
    expect(lows.every(Boolean)).toBe(true)
    expect(fetched.map((u) => u.split('/')[3]?.split('?')[0])).toEqual(['GONE', 'B', 'A'])
    expect(audio.meta(audioKey('wa', 'B', 0))?.transcript).toBe('texto')
    expect(audio.meta(audioKey('wa', 'GONE', 0))).toMatchObject({ attempts: 1 })
    // nothing left: another run does nothing
    expect(await q.run()).toBe(0)
  })

  it('a model still downloading is not a failure: it stops and comes back later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-voice-'))
    dirs.push(dir)
    const audio = new AudioService({ dir, os: fakeOs, changed: () => {}, now: () => NOW, transcribe: async () => { throw Object.assign(new Error('downloading'), { kind: 'wait' }) } })
    const q = new VoiceQueue({ audio, chats: () => [{ connId: 'wa', messages: [voice('A', '2026-11-25T10:00:00.000Z')] }], gapMs: 0, now: () => NOW, fetch: async () => '/tmp/a' })
    expect(await q.run()).toBe(0)
    expect(audio.meta(audioKey('wa', 'A', 0))?.failed).toBeUndefined()
    q.stop()
  })

  it('does nothing without speech to text', () => {
    const audio = new AudioService({ dir: tmpdir(), os: fakeOs, changed: () => {} })
    const q = new VoiceQueue({ audio, chats: () => [], fetch: async () => null })
    q.kick()
    expect((q as unknown as { timer: unknown }).timer).toBeNull()
  })
})
