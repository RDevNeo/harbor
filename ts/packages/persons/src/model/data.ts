import { DATA_VERSION } from './types.ts'
import type { AppData, ChannelUser, Identity, Person, PersonList, Store } from './types.ts'
import { normalizeSocials, parseSocialUrl, type SocialTarget } from '../socials.ts'

export const STORE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#8b5cf6', '#0ea5e9']

/** Lists every dataset starts with (version 3 added them). */
/** In sidebar order (after Stores). Version 3 had only SpokPay; version 4 added Creators. */
export const DEFAULT_LISTS: PersonList[] = [{ id: 'creators', name: 'Creators', accountId: 'gmail' }, { id: 'spokpay', name: 'SpokPay', accountId: 'spokpay' }]
const ACCOUNT_IDS = ['stores', 'spokpay', 'gmail'] as const

export function emptyData(now = new Date().toISOString()): AppData {
  return { version: DATA_VERSION, people: [], stores: [], lists: DEFAULT_LISTS.map((l) => ({ ...l })), updatedAt: now }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * Accepts anything (version 1 with groups, hand edits, partial files) and returns valid version 2 data.
 * Version 1 → 2: groups become stores (same ids, names and colors), groupIds become storeIds, and
 * templates / send history / settings move to `legacy` untouched. 2 → 3: the SpokPay list is added
 * (people get listIds), and stores may carry a picture. 3 → 4: every list gets the Discord account it
 * uses (SpokPay → spokpay, others → stores) and the Creators list is added before SpokPay.
 * 4 → 5: Creators gets its own Discord login (accountId creators). 5 → 6: Creators moves to Gmail
 * (accountId gmail) and people may have an email. 6 → 7: people may be settled per section (`settled`).
 */
export function normalizeData(raw: unknown): AppData {
  const base = emptyData()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const now = base.updatedAt

  const rawStores = Array.isArray(r.stores) ? r.stores : Array.isArray(r.groups) ? r.groups : []
  const stores: Store[] = rawStores
    .map((x): Store => {
      const g = obj(x)
      const s: Store = { id: str(g.id) ?? '', name: (str(g.name) ?? '').trim() }
      if (str(g.color)) s.color = str(g.color)!
      if (str(g.ownerId)) s.ownerId = str(g.ownerId)!
      if (str(g.image) && /^img_[a-z0-9]{6,40}\.(png|jpg|gif|webp)$/.test(str(g.image)!)) s.image = str(g.image)!
      return s
    })
    .filter((s) => s.id && s.name)
  const storeIds = new Set(stores.map((s) => s.id))
  const version = typeof r.version === 'number' ? r.version : 1
  let lists: PersonList[] = Array.isArray(r.lists)
    ? r.lists.map((x): PersonList => {
      const l = obj(x)
      const id = str(l.id) ?? ''
      let acc = str(l.accountId) as PersonList['accountId'] | 'creators' | undefined
      if (acc === 'creators') acc = 'gmail' // 5 → 6
      return { id, name: (str(l.name) ?? '').trim(), accountId: acc && (ACCOUNT_IDS as readonly string[]).includes(acc) ? acc : id === 'spokpay' ? 'spokpay' : 'stores' }
    }).filter((l) => l.id && l.name)
    : DEFAULT_LISTS.map((l) => ({ ...l }))
  // version 4 adds the Creators list (once: a later removal is kept)
  if (version < 4 && !lists.some((l) => l.id === 'creators')) lists = [{ ...DEFAULT_LISTS[0]! }, ...lists]
  // version 5: Creators talks through its own Discord login
  // version 5 gave Creators its own Discord login; version 6 moved Creators to Gmail
  if (version < 6) lists = lists.map((l) => (l.id === 'creators' && l.accountId === 'stores' ? { ...l, accountId: 'gmail' } : l))
  const listIds = new Set(lists.map((l) => l.id))

  const people: Person[] = (Array.isArray(r.people) ? r.people : [])
    .map((x): Person => {
      const p = obj(x)
      const person: Person = {
        id: str(p.id) ?? '',
        name: (str(p.name) ?? '').trim(),
        discordId: (str(p.discordId) ?? '').trim(),
        storeIds: [...new Set(strArr(p.storeIds ?? p.groupIds))].filter((id) => storeIds.has(id)),
        listIds: [...new Set(strArr(p.listIds))].filter((id) => listIds.has(id)),
        createdAt: str(p.createdAt) ?? now,
        updatedAt: str(p.updatedAt) ?? now,
      }
      const username = str(p.discordUsername)?.trim()
      if (username) person.discordUsername = username
      const email = str(p.email)?.trim().toLowerCase()
      if (email && isEmail(email)) person.email = email
      const ids = (Array.isArray(p.identities) ? p.identities : []).map((x): Identity | null => {
        const i = obj(x)
        const kind = str(i.kind), section = str(i.section)
        let value = (str(i.value) ?? '').trim()
        if (kind === 'gmail') value = value.toLowerCase()
        if (kind === 'whatsapp') value = value.replace(/\D/g, '')
        const ok = kind === 'discord' ? isDiscordId(value) : kind === 'gmail' ? isEmail(value) : kind === 'whatsapp' ? value.length >= 8 && value.length <= 15 : false
        if (!ok || !section || !['stores', 'creators', 'spokpay'].includes(section)) return null
        const id: Identity = { kind: kind as Identity['kind'], value, section: section as Identity['section'] }
        if (str(i.username)) id.username = str(i.username)!
        if (str(i.displayName)) id.displayName = str(i.displayName)!
        if (typeof i.avatar === 'string' || i.avatar === null) id.avatar = i.avatar as string | null
        if (str(i.profileAt)) id.profileAt = str(i.profileAt)!
        return id
      }).filter((x): x is Identity => !!x)
      // one identity per (kind, section)
      const uniq = ids.filter((x, n) => ids.findIndex((y) => y.kind === x.kind && y.section === x.section) === n)
      if (uniq.length) person.identities = uniq
      const seen = obj(p.seen)
      const seenOk = Object.fromEntries(Object.entries(seen).filter(([k, v]) => SEEN_KEY.test(k) && typeof v === 'string' && Number.isFinite(Date.parse(v))))
      if (Object.keys(seenOk).length) person.seen = seenOk as Record<string, string>
      const settled = Object.fromEntries(Object.entries(obj(p.settled)).filter(([k, v]) => SETTLE_SECTIONS.includes(k) && typeof v === 'string' && Number.isFinite(Date.parse(v))))
      if (Object.keys(settled).length) person.settled = settled as Record<string, string>
      const wa = (str(p.whatsapp) ?? '').replace(/\D/g, '')
      if (wa.length >= 8 && wa.length <= 15) person.whatsapp = wa
      const display = str(p.displayName)?.trim()
      if (display) person.displayName = display
      if (typeof p.avatar === 'string' || p.avatar === null) person.avatar = p.avatar as string | null
      if (str(p.profileAt)) person.profileAt = str(p.profileAt)!
      const https = (v: unknown) => { const u = str(v); return u && /^https:\/\//.test(u) ? u : undefined }
      if (https(p.photo)) person.photo = https(p.photo)!
      if (str(p.photoAt)) person.photoAt = str(p.photoAt)!
      if (typeof p.photoFull === 'boolean') person.photoFull = p.photoFull
      if (https(p.socialPhoto)) person.socialPhoto = https(p.socialPhoto)!
      if (str(p.socialPhotoAt)) person.socialPhotoAt = str(p.socialPhotoAt)!
      if (str(p.socialPhotoOf)) person.socialPhotoOf = str(p.socialPhotoOf)!
      const notes = str(p.notes)
      if (notes) person.notes = notes
      const socials = normalizeSocials(p.socials)
      if (socials.length) person.socials = socials
      const tags = strArr(p.tags)
      if (tags.length) person.tags = tags
      return person
    })
    .filter((p) => p.id && (p.name || p.discordId || p.discordUsername || p.email || p.whatsapp))
  const personIds = new Set(people.map((p) => p.id))
  for (const s of stores) if (s.ownerId && !personIds.has(s.ownerId)) delete s.ownerId

  // read state starts at the file's last save for existing data (stable across loads): older messages are read unless the platform says otherwise
  const out: AppData = { version: DATA_VERSION, people, stores, lists, readSince: str(r.readSince) ?? str(r.updatedAt) ?? now, updatedAt: str(r.updatedAt) ?? now }
  const legacy: Record<string, unknown> = { ...obj(r.legacy) }
  for (const k of ['templates', 'sends', 'settings'] as const) if (r[k] !== undefined && !(Array.isArray(r[k]) && !(r[k] as unknown[]).length)) legacy[k] = r[k]
  if (Object.keys(legacy).length) out.legacy = legacy
  return out
}

const SETTLE_SECTIONS = ['stores', 'creators', 'spokpay']
const ms = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : NaN }

/**
 * Whether `p` is settled in `section`: settled there, and no message in that section's chats since
 * (`lastAt`, either side). Harbor's rule: a message to a settled chat makes it active again.
 */
export function isSettled(p: Person, section: string, lastAt: string | undefined): boolean {
  const mark = p.settled?.[section]
  if (!mark) return false
  return !(lastAt && ms(lastAt) > ms(mark))
}

/** `p` settled in `section` (at `at`, or at their last message when that's later: clocks differ). */
export function settlePerson(p: Person, section: string, lastAt: string | undefined, at = new Date().toISOString()): Person {
  const mark = lastAt && ms(lastAt) > ms(at) ? new Date(ms(lastAt)).toISOString() : at
  return { ...p, settled: { ...p.settled, [section]: mark }, updatedAt: at }
}

/**
 * `p` renamed by the user (the name shown everywhere). Syncs from Discord / Gmail / WhatsApp only
 * fill an empty name, so this one sticks. Unchanged for an empty or identical name.
 */
export function renamePerson(p: Person, name: string, at = new Date().toISOString()): Person {
  const n = name.trim()
  if (!n || n === p.name) return p
  return { ...p, name: n, updatedAt: at }
}

/** `p` back in `section`'s list. */
export function unsettlePerson(p: Person, section: string, at = new Date().toISOString()): Person {
  if (!p.settled?.[section]) return p
  const { [section]: _gone, ...rest } = p.settled
  const next: Person = { ...p, updatedAt: at }
  if (Object.keys(rest).length) next.settled = rest
  else delete next.settled
  return next
}

/**
 * Unsettles everyone with a message in a section's chats since they were settled there
 * (`lastAt(p, section)`). Returns the same object when nothing changes.
 */
export function wakeSettled(d: AppData, lastAt: (p: Person, section: string) => string | undefined, at = new Date().toISOString()): AppData {
  let changed = false
  const people = d.people.map((p) => {
    let n = p
    for (const section of Object.keys(p.settled ?? {})) if (!isSettled(n, section, lastAt(p, section))) n = unsettlePerson(n, section, at)
    if (n !== p) changed = true
    return n
  })
  return changed ? { ...d, people } : d
}

/** Discord snowflakes are 17–20 digit numbers. */
/**
 * A read-state key: "<connection id>:<identifier>" (Discord id, email, WhatsApp number), or a
 * connection id alone (before per-identity read state). The ":<identifier>" part used to be rejected
 * here, so every load threw the read state away and the badges came back.
 */
export const SEEN_KEY = /^[\w-]{1,60}(:\S{1,254})?$/
export const isDiscordId = (s: string) => /^\d{15,21}$/.test(s.trim())

export const cleanUsername = (s: string) => s.trim().replace(/^@/, '')

export function matchesQuery(p: Person, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^@/, '')
  if (!needle) return true
  const hay = [p.name, p.displayName ?? '', p.discordUsername ?? '', p.discordId, p.email ?? '', p.whatsapp ?? '', p.notes ?? '', ...(p.identities ?? []).flatMap((i) => [i.value, i.username ?? '', i.displayName ?? ''])].join('\n').toLowerCase()
  return needle.split(/\s+/).every((w) => hay.includes(w))
}

const CDN = 'https://cdn.discordapp.com'

/** The person's Discord avatar (their own or Discord's default one), or undefined without a Discord id. */
export function avatarUrl(p: { discordId?: string; id?: string; avatar?: string | null }, size = 128): string | undefined {
  const id = p.discordId ?? p.id
  if (!id || !isDiscordId(id)) return undefined
  if (p.avatar) return `${CDN}/avatars/${id}/${p.avatar}.${p.avatar.startsWith('a_') ? 'gif' : 'png'}?size=${size}`
  if (p.avatar === null) return defaultAvatar(id)
  return undefined
}

/** The person's WhatsApp number (default identity, else one of their per-section ones). */
export const whatsappOf = (p: Person): string | undefined => p.whatsapp || p.identities?.find((i) => i.kind === 'whatsapp')?.value || undefined

/** Every email address of a person (default + per-section Gmail identities). */
export const emailsOf = (p: Person): string[] => [...new Set([...(p.email ? [p.email] : []), ...(p.identities ?? []).filter((i) => i.kind === 'gmail').map((i) => i.value)])]

/** Photos are looked up weekly, and again once Google contacts are granted. */
/** Lookups before this missed Google profile photos (only "other contacts" letter tiles were read). */
const PHOTO_PROFILE_FIX = Date.parse('2026-11-25T15:00:00Z')

export function photoStale(p: Person, contacts: boolean, now = Date.now()): boolean {
  if (!emailsOf(p).length) return false
  if (!p.photoAt) return true
  if (contacts && !p.photoFull) return true
  const at = Date.parse(p.photoAt)
  if (!p.photo && at < PHOTO_PROFILE_FIX) return true
  return now - at > (p.photo ? 7 : 1) * 24 * 3600_000 // no photo yet: try again daily
}

export function applyPhoto(p: Person, photo: string | undefined, contacts: boolean, at: string): Person {
  const next: Person = { ...p, photoAt: at, photoFull: contacts }
  if (photo) next.photo = photo
  else delete next.photo
  return next
}

/** The saved profiles a picture is read from, in order: the first YouTube, then the first TikTok. */
export function socialPhotoSources(p: Pick<Person, 'socials'>): SocialTarget[] {
  const ts = (p.socials ?? []).map((u) => parseSocialUrl(u)).filter((t): t is SocialTarget => !!t)
  return (['youtube', 'tiktok'] as const).map((pl) => ts.find((t) => t.platform === pl)).filter((t): t is SocialTarget => !!t)
}

/** Which profiles a read covered (changes when they add or remove a YouTube / TikTok profile). */
export const socialPhotoKey = (p: Pick<Person, 'socials'>) => socialPhotoSources(p).map((t) => t.url).join(' ')

/**
 * Whether their social picture should be read again: never read, a day old (TikTok's signed URLs
 * expire), their YouTube / TikTok profiles changed since, or still set after those were removed.
 */
export function socialPhotoStale(p: Person, now = Date.now()): boolean {
  const key = socialPhotoKey(p)
  if (!key) return !!(p.socialPhoto || p.socialPhotoAt || p.socialPhotoOf)
  if (!p.socialPhotoAt || p.socialPhotoOf !== key) return true
  return !(now - Date.parse(p.socialPhotoAt) < 24 * 3600_000)
}

/** Stores a read (the picture, or none when no profile had one); clears it when they have no profiles left. */
export function applySocialPhoto(p: Person, photo: string | null | undefined, at: string): Person {
  const next: Person = { ...p }
  delete next.socialPhoto; delete next.socialPhotoAt; delete next.socialPhotoOf
  const key = socialPhotoKey(p)
  if (!key) return next
  next.socialPhotoAt = at
  next.socialPhotoOf = key
  if (photo && /^https:\/\//.test(photo)) next.socialPhoto = photo
  return next
}

export function defaultAvatar(id: string): string {
  let n = 0
  try { n = Number((BigInt(id) >> 22n) % 6n) } catch { n = 0 }
  return `${CDN}/embed/avatars/${n}.png`
}

export const personLabel = (p: Person) => p.name || p.displayName || p.discordUsername || p.email || p.discordId || 'No name'

export const isEmail = (s: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s.trim())

/** Profile fields from a Discord user; returns the same person when nothing changed. */
export function applyDiscordUser(p: Person, u: ChannelUser, now = new Date().toISOString()): Person {
  const next: Person = { ...p, discordId: p.discordId || u.id, avatar: u.avatar ?? null, profileAt: now }
  const uname = u.username || p.discordUsername
  if (uname) next.discordUsername = uname
  if (u.globalName) next.displayName = u.globalName
  else delete next.displayName
  if (!next.name) next.name = u.globalName || u.username
  const same = p.discordId === next.discordId && p.discordUsername === next.discordUsername && p.avatar === next.avatar && p.displayName === next.displayName && p.name === next.name
  if (same) return p.profileAt && Date.parse(now) - Date.parse(p.profileAt) < 3600_000 ? p : { ...p, profileAt: now }
  return { ...next, updatedAt: now }
}

/** Profiles older than this get refreshed from Discord. */
export const PROFILE_STALE_MS = 24 * 3600_000

export function staleProfiles(people: Person[], now = Date.now()): Person[] {
  return people.filter((p) => (p.discordId || p.discordUsername) && (!p.profileAt || now - Date.parse(p.profileAt) > PROFILE_STALE_MS))
}

/** A sidebar view: a store or a list. */
export type Scope = { kind: 'all' } | { kind: 'store'; id: string } | { kind: 'list'; id: string }

export function inScope(p: Person, s: Scope): boolean {
  if (s.kind === 'all') return true
  return s.kind === 'store' ? p.storeIds.includes(s.id) : p.listIds.includes(s.id)
}

/** Adds a person to a store or list (no-op when already in it). */
export function joinScope(p: Person, s: Scope, at = new Date().toISOString()): Person {
  if (s.kind === 'all' || inScope(p, s)) return p
  return s.kind === 'store' ? { ...p, storeIds: [...p.storeIds, s.id], updatedAt: at } : { ...p, listIds: [...p.listIds, s.id], updatedAt: at }
}

/** A new person from a Discord user (lookup result). */
export function personFromDiscord(u: ChannelUser, id: string, now = new Date().toISOString()): Person {
  const p: Person = { id, name: u.globalName || u.username, discordId: u.id, discordUsername: u.username, avatar: u.avatar ?? null, profileAt: now, storeIds: [], listIds: [], createdAt: now, updatedAt: now }
  if (u.globalName) p.displayName = u.globalName
  return p
}

