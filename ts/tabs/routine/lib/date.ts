/** Local-date helpers. Days roll over at local midnight. */

export function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseKey(key: string): Date {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() + n)
  return r
}

/** "HH:MM" -> minutes since midnight */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function fromMinutes(total: number): { hour: number; minute: number } {
  const t = ((Math.round(total) % 1440) + 1440) % 1440
  return { hour: Math.floor(t / 60), minute: t % 60 }
}

export function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Milliseconds until the next local midnight. */
export function msUntilMidnight(now = new Date()): number {
  return addDays(now, 1).getTime() - now.getTime()
}

/** Time of day, always 24-hour Brazilian style: "06:45", "22:30" (never AM/PM). */
export function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 24-hour clock time from an hour/minute pair. */
export function fmtClockHM(hour: number, minute: number): string {
  return fmtClock(new Date(2000, 0, 1, hour, minute))
}

/** 24-hour clock time from a stored "HH:MM" string. */
export function fmtHHMM(hhmm: string): string {
  const { hour, minute } = fromMinutes(toMinutes(hhmm))
  return fmtClockHM(hour, minute)
}

/** "6 cycles" when whole, else one decimal ("5.3"). */
export function fmtCycles(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}
