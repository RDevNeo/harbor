import { KEYS, classOf } from "./settingsync.ts";

/** What wssettings needs of the store. */
export interface Kv {
  get(k: string): string | null;
  setQuiet(k: string, v: string): void;
}

/**
 * Settings that are one value for the whole workspace (settingsync `workspace` keys, like `voice_cleanup`): every
 * PC keeps the value and when it last changed (kv `ws_settings_at`), tells the PCs it links with (mesh hello, each
 * chats list, and a push when it changes here), and takes a peer's value when it is newer. A PC that never changed
 * one has time 0, so the first change anywhere wins everywhere.
 */
export const SHARED: readonly string[] = KEYS.filter(([, c]) => c === "workspace").map(([k]) => k);

const STAMPS = "ws_settings_at";
const MAX_VALUE = 4 << 10;

const listeners = new WeakMap<Kv, () => void>();

/** `f` runs when a workspace setting of this store changed, so the mesh tells its peers at once. One per store:
 *  another hub's store (tests run several in one process) never calls it. */
export function onChanged(kv: Kv, f: () => void): void {
  listeners.set(kv, f);
}

function stamps(kv: Kv): Record<string, number> {
  try {
    const v: unknown = JSON.parse(kv.get(STAMPS) ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  } catch {
    return {};
  }
}

/** `Store.set` of a key: a workspace setting whose value changed gets this moment as its time, and peers hear of it. */
export function changed(kv: Kv, key: string, before: string | null, after: string, at = Date.now()): void {
  if (classOf(key) !== "workspace" || before === after) return;
  const s = stamps(kv);
  s[key] = Math.max(at, (s[key] ?? 0) + 1);
  kv.setQuiet(STAMPS, JSON.stringify(s));
  try {
    listeners.get(kv)?.();
  } catch (e) {
    console.error(`harbor: telling the other PCs of ${key} failed: ${String(e)}`);
  }
}

/** This PC's workspace settings for its peers: {key: [value, ms]}; keys never set aren't in it. */
export function snapshot(kv: Kv): Record<string, [string, number]> {
  const s = stamps(kv);
  const out: Record<string, [string, number]> = {};
  for (const k of SHARED) {
    const v = kv.get(k);
    if (v !== null) out[k] = [v, s[k] ?? 0];
  }
  return out;
}

/** A peer's snapshot: the values newer than this PC's are taken (not sent on as changes of this PC). The keys taken. */
export function adopt(kv: Kv, peer: unknown): string[] {
  if (typeof peer !== "object" || peer === null || Array.isArray(peer)) return [];
  const s = stamps(kv);
  const took: string[] = [];
  for (const k of SHARED) {
    const e: unknown = Reflect.get(peer, k);
    if (!Array.isArray(e) || e.length !== 2) continue;
    const [v, t] = e as [unknown, unknown];
    if (typeof v !== "string" || typeof t !== "number" || !Number.isFinite(t) || v.length > MAX_VALUE) continue;
    if (t <= (s[k] ?? 0)) continue;
    s[k] = t;
    if (kv.get(k) !== v) {
      kv.setQuiet(k, v);
      took.push(k);
    }
  }
  if (took.length > 0 || JSON.stringify(s) !== JSON.stringify(stamps(kv))) kv.setQuiet(STAMPS, JSON.stringify(s));
  return took;
}
