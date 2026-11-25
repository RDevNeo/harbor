import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioService, audioKey, BARS, sampleBars, waveBars } from '../src/audio.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hub-audio-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A stand-in for @harbor/os audio: records plays, ends them on demand, decodes to a ramp. */
function fakeOs() {
  const plays: { file: string; at: number; speed: number; stopped: boolean; end: (e?: string) => void }[] = []
  let decodes = 0
  return {
    plays,
    decodes: () => decodes,
    os: {
      player: () => 'ffmpeg+pw-cat',
      play: (file: string, at: number, speed: number, onEnd: (e?: string) => void) => {
        const p = { file, at, speed, stopped: false, end: onEnd }
        plays.push(p)
        return { stop: () => { p.stopped = true } }
      },
      decode: async (_file: string, rate: number) => {
        decodes++
        return Int16Array.from({ length: rate * 40 }, (_, i) => (i % 100) * (i < rate * 20 ? 10 : 100)) // 40 s, louder second half
      },
    },
  }
}

describe('bars', () => {
  it('scales a platform waveform to its loudest byte (WhatsApp 0–100 and Discord 0–255 alike)', () => {
    const wa = waveBars(Buffer.from([0, 50, 100, 25]).toString('base64'), 4)
    const dc = waveBars(Buffer.from([0, 127, 255, 63]).toString('base64'), 4)
    expect(wa).toEqual([0, 0.5, 1, 0.25])
    expect(dc![2]).toBe(1)
    expect(waveBars(undefined)).toBeNull()
    expect(waveBars('')).toBeNull()
  })

  it('measures bars from samples', () => {
    const b = sampleBars(Int16Array.from({ length: 1000 }, (_, i) => (i < 500 ? 100 : 1000)), 4)
    expect(b).toEqual([0.1, 0.1, 1, 1])
    expect(sampleBars(new Int16Array(0), 3)).toEqual([0, 0, 0])
  })
})

describe('AudioService', () => {
  it('plays one at a time, marks it played, measures it once and keeps that in audio.json', async () => {
    const dir = tmp()
    const f = fakeOs()
    let now = 1_000_000
    let changes = 0
    const a = new AudioService({ dir, os: f.os, now: () => now, changed: () => changes++ })
    const k1 = audioKey('wa', 'MSG1', 0), k2 = audioKey('wa', 'MSG2', 0)
    // the length measured from the file wins over the platform's
    const s = await a.play(k1, '/x/1.ogg', null, null, 20)
    expect(s).toMatchObject({ key: k1, playing: true, pos: 0, speed: 1, duration: 40 })
    expect(a.meta(k1)?.played).toBeDefined()
    expect(a.meta(k1)?.bars).toHaveLength(BARS)
    expect(f.decodes()).toBe(1)
    // 3 s later the position moved; another one starts: the first stops
    now += 3000
    expect(a.state().pos).toBeCloseTo(3)
    await a.play(k2, '/x/2.ogg', null, 2, 10)
    expect(f.plays[0]!.stopped).toBe(true)
    expect(a.state()).toMatchObject({ key: k2, playing: true, speed: 2 })
    // its end: back to the start, paused, the window told
    const before = changes
    f.plays[1]!.end()
    expect(a.state()).toMatchObject({ key: k2, playing: false, pos: 0 })
    expect(changes).toBeGreaterThan(before)
    // a late end of the stopped one changes nothing
    f.plays[0]!.end()
    expect(a.state().key).toBe(k2)
    a.close()
    const saved = JSON.parse(readFileSync(join(dir, 'audio.json'), 'utf8'))
    expect(Object.keys(saved.items).sort()).toEqual([k1, k2])
    // known now: not measured again
    const b = new AudioService({ dir, os: f.os, changed: () => {} })
    await b.play(k1, '/x/1.ogg', null, null, null)
    expect(f.decodes()).toBe(2)
    expect(b.state().duration).toBe(40)
  })

  it('pauses where it is and goes on from there; seeks; a play at the end starts over', async () => {
    const f = fakeOs()
    let now = 0
    const a = new AudioService({ dir: tmp(), os: f.os, now: () => now, changed: () => {} })
    const k = audioKey('dc', '123', 1)
    await a.play(k, '/x/a.ogg', 2, 1.5, 30)
    now += 4000
    expect(a.pause()).toMatchObject({ playing: false, pos: 8 })
    await a.play(k, '/x/a.ogg', null, null, 30)
    expect(f.plays.at(-1)).toMatchObject({ at: 8, speed: 1.5 })
    a.pause()
    a.seek(k, 39.99, 40)
    await a.play(k, '/x/a.ogg', null, null, 30)
    expect(f.plays.at(-1)!.at).toBe(0)
    expect(a.stop()).toMatchObject({ key: null, playing: false })
    expect(f.plays.at(-1)!.stopped).toBe(true)
  })

  it('says so when this PC has no player', async () => {
    const f = fakeOs()
    const a = new AudioService({ dir: tmp(), os: { ...f.os, play: () => null, player: () => null }, changed: () => {} })
    expect(a.canPlay()).toBe(false)
    const s = await a.play('wa:x:0', '/x', null, null, 5)
    expect(s.playing).toBe(false)
    expect(s.error).toContain('No audio player')
  })

  it('transcribes once (16 kHz samples), caches the text, and shares a transcription under way', async () => {
    const f = fakeOs()
    let calls = 0
    const a = new AudioService({ dir: tmp(), os: f.os, changed: () => {}, transcribe: async (s) => { calls++; expect(s.length).toBe(16_000 * 40); return ' Oi, tudo bem? ' } })
    const k = audioKey('wa', 'V', 0)
    const [x, y] = await Promise.all([a.transcribe(k, '/x'), a.transcribe(k, '/x')])
    expect(x).toBe('Oi, tudo bem?')
    expect(y).toBe(x)
    expect(await a.transcribe(k, '/x')).toBe(x)
    expect(calls).toBe(1)
    expect(a.meta(k)?.transcript).toBe('Oi, tudo bem?')
  })

  it('has no Transcribe without speech to text', async () => {
    const a = new AudioService({ dir: tmp(), os: fakeOs().os, changed: () => {} })
    expect(a.canTranscribe()).toBe(false)
    await expect(a.transcribe('k', '/x')).rejects.toThrow('Speech to text')
  })
})
