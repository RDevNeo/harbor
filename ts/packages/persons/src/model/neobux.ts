// Neobux: the user's own Robux store, a section like Creators. It has no logins of its own to start with: it writes
// through Creators' (the same Gmail, WhatsApp, Discord and Instagram), shared with `also` as Personal shares the Stores
// ones. Connecting one of its own in Neobux (the section's + menu › Connect …) takes that kind over: the Creators one of
// that kind stops serving Neobux. Disconnecting it hands the kind back to Creators'. Pure, so it is unit tested.
import { KINDS, type ConnMeta } from './accounts.ts'

/** The connections with Neobux in place (run at start and after a connection is added or removed); the same array when
 *  nothing changes. */
export function neobuxShares<T extends ConnMeta>(metas: T[]): T[] {
  let out = metas
  const set = (m: T, on: boolean): T => {
    const rest = (m.also ?? []).filter((s) => s !== 'neobux')
    const also = on ? [...rest, 'neobux' as const] : rest
    const next = { ...m } as T
    if (also.length) next.also = also
    else delete next.also
    return next
  }
  for (const kind of KINDS) {
    const of = out.filter((m) => m.kind === kind)
    // its own login of that kind: no other one serves Neobux
    if (of.some((m) => m.section === 'neobux')) out = out.map((m) => (m.kind === kind && m.section !== 'neobux' && m.also?.includes('neobux') ? set(m, false) : m))
    // none serves it (a share set by hand in connections.json is kept): every Creators one of that kind does
    else if (!of.some((m) => m.also?.includes('neobux'))) out = out.map((m) => (m.kind === kind && m.section === 'creators' ? set(m, true) : m))
  }
  return out.every((m, i) => m === metas[i]) ? metas : out
}
