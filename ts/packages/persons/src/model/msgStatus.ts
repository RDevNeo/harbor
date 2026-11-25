import type { MessageStatus } from './types.ts'

/** Order of WhatsApp's ticks (same as the shell's whatsapp-core.cjs `mergeStatus`). */
export const STATUS_RANK: Record<MessageStatus, number> = { error: 0, pending: 1, sent: 2, delivered: 3, read: 4 }

/**
 * A message's status only moves forward (read never goes back to delivered). An error replaces only
 * pending / sent; a later delivered / read wins over an error (it got there).
 */
export function mergeStatus(prev: MessageStatus | undefined, next: MessageStatus | undefined): MessageStatus | undefined {
  if (!next || !(next in STATUS_RANK)) return prev
  if (!prev || !(prev in STATUS_RANK)) return next
  if (next === 'error') return prev === 'pending' || prev === 'sent' ? 'error' : prev
  if (prev === 'error') return STATUS_RANK[next] >= STATUS_RANK.delivered ? next : prev
  return STATUS_RANK[next] > STATUS_RANK[prev] ? next : prev
}

/** What the ticks say, for screen readers and tooltips. */
export const STATUS_LABEL: Record<MessageStatus, string> = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', error: 'Not sent' }
