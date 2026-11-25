import { migrate } from './store'
/** Schedule Fixer's key prefix: Routine keeps its keys (`schedule-fixer:data`…). */
export const ROUTINE_PREFIX = 'schedule-fixer:'

/**
 * Moving Schedule Fixer's data into Routine. Schedule Fixer's "Export data" (Goals tab, bottom) makes
 * one JSON of every `schedule-fixer:*` Preferences value, as stored (strings), so it restores 1:1:
 *   {"app":"schedule-fixer","kind":"export","v":1,"exportedAt":"…","items":{"schedule-fixer:data":"{…}", …}}
 * Main path, a one-time code (nothing to juggle on the phone): Schedule Fixer gzips that JSON, encrypts
 * it (AES-GCM, key derived from a 12-letter code it shows) and parks it ≤ 1 h at the hub's
 * /api/transfer under an id also derived from the code, so the relay never sees the data or the code.
 * Routine downloads it with the code. Offline fallback: the copied text (the JSON itself, or `SFX1:` +
 * base64 of the gzipped JSON) pasted here, or a .json file. The Harbor pairing token and flag of the
 * old Coach are never exported (and ignored here). The crypto helpers are the same file in both repos.
 */
export const EXPORT_APP = 'schedule-fixer'
export const PACKED_PREFIX = 'SFX1:'
const DATA_KEY = `${ROUTINE_PREFIX}data`
const SKIP = new Set([`${ROUTINE_PREFIX}harbor-token`, `${ROUTINE_PREFIX}harbor-pair-asked`])
const MAX_BYTES = 50 * 1024 * 1024
export const TRANSFER_URL = 'https://creators-hub-snowy.vercel.app/api/transfer'
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export interface ExportBundle {
  app: typeof EXPORT_APP
  kind: 'export'
  v: 1
  exportedAt: string
  items: Record<string, string>
}

export interface ImportSummary {
  goals: number
  days: number
  entries: number
  rides: number
  coachMessages: number
  walkingDays: number
  /** Latest wake-up time ("HH:MM") from the sleep settings, to offer a new alarm. */
  wakeBy: string
  exportedAt: string
}

export class ImportError extends Error {}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0))

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

// ---------- one-time code (same helpers as Schedule Fixer's src/lib/transfer.ts) ----------

const enc = new TextEncoder()
const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

/** "abcd-efgh-jkmn" (any case, spaces, O→0, I/L→1) → canonical 12 letters; null when it can't be a code. */
export function normCode(s: string): string | null {
  const c = s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return c.length === 12 && [...c].every((x) => ALPHABET.includes(x)) ? c : null
}
export const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`

export async function keysFor(code: string) {
  const id = hex(await sha(`sf-transfer-id:${code}`))
  const key = await crypto.subtle.importKey('raw', await sha(`sf-transfer-key:${code}`), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

/** Decrypt a downloaded blob (base64url of iv ‖ AES-GCM(gzip(JSON))) → the JSON text. */
export async function openSealed(code: string, blob: string): Promise<string> {
  const { key } = await keysFor(code)
  const b = unb64url(blob)
  let zipped: Uint8Array
  try {
    zipped = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)))
  } catch {
    throw new ImportError('That code doesn’t open this export. Check the code.')
  }
  return gunzip(zipped)
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** Download the export parked under a code (all its parts) and decrypt it → the JSON text. */
export async function fetchByCode(input: string, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<string> {
  const code = normCode(input)
  if (!code) throw new ImportError('A code is 12 letters and digits, like ABCD-EFGH-JKMN.')
  const { id } = await keysFor(code)
  const get = async (part: number) => {
    let r: Response
    try {
      r = await fetchFn(`${TRANSFER_URL}?id=${id}&part=${part}`, { cache: 'no-store' })
    } catch {
      throw new ImportError('No connection. Try again online, or use “paste” below.')
    }
    if (r.status === 404) throw new ImportError('No export with this code (wrong, or older than an hour). Export again in Schedule Fixer.')
    if (!r.ok) throw new ImportError(`Download failed (${r.status}). Try again.`)
    return (await r.json()) as { total: number; blob: string }
  }
  const head = await get(0)
  let blob = head.blob
  for (let i = 1; i < head.total; i++) blob += (await get(i)).blob
  return openSealed(code, blob)
}

/** Code → validated bundle + summary. */
export async function readByCode(code: string, fetchFn?: Fetch): Promise<{ bundle: ExportBundle; summary: ImportSummary }> {
  const bundle = parseBundle(await fetchByCode(code, fetchFn))
  return { bundle, summary: summarize(bundle) }
}

/** File or pasted text → the bundle's JSON text (unpacks SFX1:). */
export async function unpack(text: string): Promise<string> {
  const t = text.trim()
  if (t.startsWith(PACKED_PREFIX)) {
    try {
      return await gunzip(b64ToBytes(t.slice(PACKED_PREFIX.length)))
    } catch {
      throw new ImportError('The copied data is incomplete or damaged. Copy it again in Schedule Fixer.')
    }
  }
  return t
}

/** Validate an export: shape, keys, and that its main data reads as Schedule Fixer data. */
export function parseBundle(json: string): ExportBundle {
  if (json.length > MAX_BYTES) throw new ImportError('This file is too large to be a Schedule Fixer export.')
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    throw new ImportError('Not a Schedule Fixer export (not JSON).')
  }
  const b = v as Partial<ExportBundle> | null
  if (!b || typeof b !== 'object' || b.app !== EXPORT_APP || b.kind !== 'export') throw new ImportError('Not a Schedule Fixer export.')
  if (b.v !== 1) throw new ImportError('This export is from a newer Schedule Fixer. Update Person Hub first.')
  if (!b.items || typeof b.items !== 'object' || Array.isArray(b.items)) throw new ImportError('The export has no data.')
  const items: Record<string, string> = {}
  for (const [k, val] of Object.entries(b.items)) {
    if (!k.startsWith(ROUTINE_PREFIX) || SKIP.has(k)) continue
    if (typeof val !== 'string') throw new ImportError(`Damaged export (${k}).`)
    items[k] = val
  }
  const data = items[DATA_KEY]
  if (!data) throw new ImportError('The export has no goals data.')
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    throw new ImportError('Damaged export (goals data).')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { goals?: unknown }).goals)) throw new ImportError('Damaged export (no goals list).')
  return { app: EXPORT_APP, kind: 'export', v: 1, exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '', items }
}

const count = (json: string | undefined, pick: (v: Record<string, unknown>) => number): number => {
  try {
    return json ? pick(JSON.parse(json) as Record<string, unknown>) : 0
  } catch {
    return 0
  }
}

/** What the import brings, for the confirm step (read through the normal migration). */
export function summarize(b: ExportBundle): ImportSummary {
  const data = migrate(JSON.parse(b.items[DATA_KEY] ?? '{}'))
  const all = Object.values(data.entries).flat()
  return {
    goals: data.goals.filter((g) => !g.archived).length,
    days: Object.values(data.entries).filter((l) => l?.length).length,
    entries: all.length,
    rides: all.filter((e) => e.ride).length,
    coachMessages: count(b.items[`${ROUTINE_PREFIX}coach`], (v) => (Array.isArray(v.messages) ? v.messages.length : 0)),
    walkingDays: count(b.items[`${ROUTINE_PREFIX}walking`], (v) => (v.days && typeof v.days === 'object' ? Object.keys(v.days).length : 0)),
    wakeBy: data.sleep.wakeBy,
    exportedAt: b.exportedAt,
  }
}

/** File or pasted text → validated bundle + summary. */
export async function readExport(text: string): Promise<{ bundle: ExportBundle; summary: ImportSummary }> {
  const bundle = parseBundle(await unpack(text))
  return { bundle, summary: summarize(bundle) }
}

/**
 * Replace Routine's data with the export: every `schedule-fixer:*` key is written as it was; keys
 * Routine had that the export doesn't are removed (so the result is exactly Schedule Fixer's state).
 * `items` is the engine's key-value map, changed in place.
 */
export function restore(b: ExportBundle, items: Record<string, string>): number {
  for (const k of Object.keys(items)) if (k.startsWith(ROUTINE_PREFIX) && !SKIP.has(k) && !(k in b.items)) delete items[k]
  const order = Object.keys(b.items).sort((a, c) => Number(a === DATA_KEY) - Number(c === DATA_KEY))
  for (const k of order) items[k] = b.items[k]!
  return order.length
}
