import { describe, expect, it } from 'bun:test'
import { elapsedMs, isPaused, pauseSession, readSession, resumeSession, startSession } from '../lib/session'

describe('pausable session', () => {
  it('sums running segments and freezes while paused', () => {
    let s = startSession(1_000)
    expect(elapsedMs(s, 61_000)).toBe(60_000)
    s = pauseSession(s, 61_000)
    expect(isPaused(s)).toBe(true)
    expect(elapsedMs(s, 600_000)).toBe(60_000) // frozen however long the pause
    s = resumeSession(s, 600_000)
    expect(isPaused(s)).toBe(false)
    expect(elapsedMs(s, 630_000)).toBe(90_000)
    s = pauseSession(s, 640_000)
    s = resumeSession(s, 700_000)
    expect(elapsedMs(s, 710_000)).toBe(110_000) // 60 + 40 + 10 s
  })

  it('pause/resume are idempotent and never go negative', () => {
    const p = pauseSession(startSession(0), 5_000)
    expect(pauseSession(p, 9_000)).toBe(p)
    const r = resumeSession(p, 9_000)
    expect(resumeSession(r, 12_000)).toBe(r)
    expect(elapsedMs(startSession(10_000), 5_000)).toBe(0) // clock went backwards
  })

  it('reads stored sessions, including the old start-time-only format', () => {
    expect(readSession(123)).toEqual({ accMs: 0, runningSince: 123 })
    expect(readSession({ accMs: 5000, runningSince: null })).toEqual({ accMs: 5000, runningSince: null })
    expect(readSession({ accMs: 5000, runningSince: 99 })).toEqual({ accMs: 5000, runningSince: 99 })
    expect(readSession({ accMs: -1, runningSince: null })).toBeNull()
    expect(readSession({ accMs: 1, runningSince: 'x' })).toBeNull()
    expect(readSession('x')).toBeNull()
  })
})
