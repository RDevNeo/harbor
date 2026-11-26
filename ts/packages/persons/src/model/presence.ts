// Presence (Discord status, WhatsApp online / last seen): merging the shell's events and the text
// the chat header shows under the name. Pure, so it's unit tested.
import type { PresenceStatus } from './types.ts'

/** Which status wins when several accounts see the same person (online first, as Discord ranks). */
export const PRESENCE_RANK: Record<PresenceStatus, number> = { online: 4, dnd: 3, idle: 2, offline: 1, invisible: 1 }

/** Applies a presence event: null removes (not known any more). Returns `prev` when nothing changed. */
export function mergePresence(prev: Record<string, PresenceStatus>, patch: Record<string, PresenceStatus | null>): Record<string, PresenceStatus> {
  let next: Record<string, PresenceStatus> | null = null
  for (const [id, st] of Object.entries(patch)) {
    if ((prev[id] ?? null) === st) continue
    next ??= { ...prev }
    if (st == null) delete next[id]
    else next[id] = st
  }
  return next ?? prev
}

/** The color of a status (Discord's own): online green, idle yellow, do not disturb red, else muted. */
export type StatusTone = 'online' | 'idle' | 'dnd' | 'muted'
const TONE: Record<PresenceStatus, StatusTone> = { online: 'online', idle: 'idle', dnd: 'dnd', offline: 'muted', invisible: 'muted' }

/** What a row shows: the dot on the avatar (none for WhatsApp away) and one short line under the name. */
export interface RowStatus { dot?: PresenceStatus; text: string; tone: StatusTone }

/**
 * A person's row status from every account that sees them: the best Discord status of their ids, or
 * online when WhatsApp says so (online wins); else WhatsApp's last seen (no dot: WhatsApp has no
 * offline dot). Undefined when nothing is known (the row shows no line).
 */
export function rowStatus(discord: (PresenceStatus | undefined)[], whatsapp: { status?: PresenceStatus; lastSeen?: number }[], now: number = Date.now()): RowStatus | undefined {
  let best: PresenceStatus | undefined
  for (const s of discord) if (s && (!best || PRESENCE_RANK[s] > PRESENCE_RANK[best])) best = s
  if (best !== 'online' && whatsapp.some((w) => w.status === 'online')) return { dot: 'online', text: 'online', tone: 'online' }
  if (best) return { dot: best, text: DISCORD_TEXT[best], tone: TONE[best] }
  const seen = Math.max(0, ...whatsapp.map((w) => w.lastSeen ?? 0))
  return seen ? { text: lastSeenShort(seen, now), tone: 'muted' } : undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** WhatsApp's "last seen today at 14:32" / "yesterday at 09:10" / "12 Nov" (+ year when not this one). */
export function lastSeenText(at: number, now: number = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const days = Math.round((dayStart(n) - dayStart(d)) / 86_400_000)
  if (days <= 0) return `last seen today at ${hhmm(d)}`
  if (days === 1) return `last seen yesterday at ${hhmm(d)}`
  return `last seen ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ''}`
}

/** A row's short form: "last seen 14:32" (today), "last seen yesterday", "last seen 12 Nov". */
export function lastSeenShort(at: number, now: number = Date.now()): string {
  const d = new Date(at)
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000)
  if (days <= 0) return `last seen ${hhmm(d)}`
  if (days === 1) return 'last seen yesterday'
  return `last seen ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

const DISCORD_TEXT: Record<PresenceStatus, string> = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Offline' }

/**
 * The status line under the name in a chat header, in words: "Online on Discord", "Idle on
 * Discord"…; WhatsApp "online", "online · typing…", "last seen today at 14:32". Typing (or recording)
 * shows on both. Undefined when nothing is known.
 */
export function headerStatus(kind: 'discord' | 'gmail' | 'whatsapp' | 'instagram', status: PresenceStatus | undefined, lastSeen: number | undefined, typing?: 'typing' | 'recording', now: number = Date.now()): { text: string; tone: StatusTone } | undefined {
  const act = typing === 'recording' ? 'recording audio…' : typing ? 'typing…' : ''
  if (kind === 'discord') {
    if (act) return { text: act, tone: 'online' }
    return status ? { text: status === 'dnd' ? 'Do not disturb on Discord' : `${DISCORD_TEXT[status]} on Discord`, tone: TONE[status] } : undefined
  }
  if (kind === 'whatsapp') {
    if (status === 'online') return { text: act ? `online · ${act}` : 'online', tone: 'online' }
    if (act) return { text: act, tone: 'online' }
    return lastSeen ? { text: lastSeenText(lastSeen, now), tone: 'muted' } : undefined
  }
  return act ? { text: act, tone: 'online' } : undefined
}

/** Text color classes of a tone (Discord's colors). */
export const TONE_CLASS: Record<StatusTone, string> = { online: 'text-[#23a55a]', idle: 'text-[#f0b232]', dnd: 'text-[#f23f43]', muted: 'text-muted-foreground' }
