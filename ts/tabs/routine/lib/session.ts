/**
 * Pausable stopwatch math (time goals and GPS rides). Elapsed = sum of the running segments:
 * `accMs` holds the finished segments, `runningSince` the start of the current one (null = paused).
 * Only timestamps are stored, so it survives restarts and the screen being off.
 */
export interface Session {
  accMs: number
  runningSince: number | null
}

export const startSession = (now: number): Session => ({ accMs: 0, runningSince: now })

export const isPaused = (s: Session) => s.runningSince == null

export function elapsedMs(s: Session, now: number): number {
  return s.accMs + (s.runningSince == null ? 0 : Math.max(0, now - s.runningSince))
}

export function pauseSession(s: Session, now: number): Session {
  return s.runningSince == null ? s : { accMs: elapsedMs(s, now), runningSince: null }
}

export function resumeSession(s: Session, now: number): Session {
  return s.runningSince == null ? { ...s, runningSince: now } : s
}

/** Read a stored session; v1–v7 stored a running stopwatch as just its start time. */
export function readSession(v: unknown): Session | null {
  if (typeof v === 'number' && Number.isFinite(v)) return startSession(v)
  if (!v || typeof v !== 'object') return null
  const { accMs, runningSince } = v as Record<string, unknown>
  if (typeof accMs !== 'number' || !Number.isFinite(accMs) || accMs < 0) return null
  if (runningSince !== null && (typeof runningSince !== 'number' || !Number.isFinite(runningSince))) return null
  return { accMs, runningSince }
}
