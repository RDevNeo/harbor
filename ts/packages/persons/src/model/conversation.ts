import type { Conversation, Attachment, Message } from './types.ts'
import { mergeStatus } from './msgStatus.ts'

/** Numeric order of Discord snowflakes (string compare breaks on different lengths). */
export function cmpSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Adds messages to a conversation: no duplicates (newer copies win), oldest first, capped. */
export function mergeMessages(conv: Conversation | undefined, msgs: Message[], channelId?: string | null, max = 2000): Conversation {
  const map = new Map((conv?.messages ?? []).map((m) => [m.id, m]))
  for (const m of msgs) {
    // newer copies win, but WhatsApp's ticks never go back (a late copy saying "sent" after "read")
    const prev = map.get(m.id)
    const st = mergeStatus(prev?.status, m.status)
    map.set(m.id, st && st !== m.status ? { ...m, status: st } : m)
  }
  // by time (emails have no snowflake ids), then id (Discord messages in the same millisecond)
  const messages = [...map.values()].sort((a, b) => (a.timestamp && b.timestamp && a.timestamp !== b.timestamp ? a.timestamp.localeCompare(b.timestamp) : cmpSnowflake(a.id, b.id))).slice(-max)
  return { channelId: channelId ?? conv?.channelId ?? msgs[0]?.channelId ?? null, messages }
}

export const lastMessage = (conv: Conversation | undefined): Message | null => conv?.messages.at(-1) ?? null

/** Text for a list preview: the content, or what it carries. */
export function preview(m: Message): string {
  if (m.content.trim()) return m.content
  if (m.voice) return '🎤 Voice message'
  if (m.attachments?.length === 1 && attachmentKind(m.attachments[0]!) === 'image') return '🖼 Image'
  if (m.attachments?.length === 1 && attachmentKind(m.attachments[0]!) === 'video') return '🎥 Video'
  if (m.attachments?.length) return m.attachments.length === 1 ? `📎 ${m.attachments[0]!.name}` : `📎 ${m.attachments.length} files`
  return m.embed ? 'Embed' : ''
}

const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto', style: 'short' })

/** "just now", "5 min. ago", "yesterday", "3 days ago", then a date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const minutes = Math.round((ts - now) / 60_000)
  if (Math.abs(minutes) < 1) return 'just now'
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 7) return rtf.format(days, 'day')
  return formatDate(iso)
}

const dateTime = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dateOnly = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** "Nov 22, 3:04 PM". */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso))
export const formatDate = (iso: string) => dateOnly.format(new Date(iso))

/** How to show an attachment: inline image, audio player, or a file chip. */
/** Video files Hub plays (in the chat as a poster with ▶, in the viewer on the PC and the phone). */
export const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v', '3gp', 'mkv']

export function attachmentKind(a: Attachment, voice?: boolean): 'image' | 'audio' | 'video' | 'file' {
  const t = (a.type ?? '').toLowerCase()
  const ext = (a.name ?? '').toLowerCase().split('.').pop() ?? ''
  if (voice || t.startsWith('audio/') || ['ogg', 'mp3', 'm4a', 'wav', 'opus', 'flac', 'aac'].includes(ext)) return 'audio'
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  if (t.startsWith('video/') || VIDEO_EXTS.includes(ext)) return 'video'
  return 'file'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Their messages since my last one: what's waiting for a reply ("unread" in the lists). */
export function unreadCount(conv: Conversation | undefined): number {
  const msgs = conv?.messages ?? []
  let n = 0
  for (let i = msgs.length - 1; i >= 0 && !msgs[i]!.fromMe; i--) n++
  return n
}

/** Pending = the newest message in the conversation is theirs (I haven't replied). */
export const isPending = (conv: Conversation | undefined) => { const m = lastMessage(conv); return !!m && !m.fromMe }

/** Compact "now", "5m ago", "1h ago", "3d ago", then "Nov 3". */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return formatDate(iso)
}

export interface MessageGroup {
  key: string
  fromMe: boolean
  authorId: string
  /** Time of the group's first message (shown in its header). */
  at: string
  messages: Message[]
}

/** Consecutive messages from the same side, less than `gapMs` apart, under one header (as chat apps do). */
export function groupMessages(msgs: Message[], gapMs = 7 * 60_000): MessageGroup[] {
  const out: MessageGroup[] = []
  for (const m of msgs) {
    const g = out.at(-1)
    const prev = g?.messages.at(-1)
    // a new email thread starts a new group (it gets a subject divider)
    if (g && prev && g.fromMe === m.fromMe && g.authorId === m.authorId && prev.threadId === m.threadId && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < gapMs) g.messages.push(m)
    else out.push({ key: m.id, fromMe: m.fromMe, authorId: m.authorId, at: m.timestamp, messages: [m] })
  }
  return out
}

/** Discord's voice waveform (base64, one byte 0–255 per sample) resampled to `n` bars between 0 and 1. */
export function waveformBars(b64: string | undefined, n: number): number[] | null {
  if (!b64) return null
  let bytes: number[]
  try { bytes = [...atob(b64)].map((c) => c.charCodeAt(0)) } catch { return null }
  if (!bytes.length) return null
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * bytes.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * bytes.length) / n))
    let peak = 0
    for (let j = a; j < b && j < bytes.length; j++) peak = Math.max(peak, bytes[j]!)
    return peak / 255
  })
}

/** "0:08", "1:23". */
export const formatDuration = (secs: number) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.floor(Math.max(0, secs) % 60)).padStart(2, '0')}`

/** Unread count of one chat (moved to readState; kept here for older imports). */
export { unreadSince } from './readState.ts'

/** What "seen" becomes when a chat is viewed: its newest message's time. */
export const seenMark = (conv: Conversation | undefined): string | undefined => conv?.messages.at(-1)?.timestamp
