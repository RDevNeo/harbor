/**
 * Code Harbor can swap while it runs. A unit is a module the app calls through `unit.now` instead of a
 * static import, so a dev build of it (ui/src/hotdev.ts, `harbor hot on`) can take its place between
 * two calls: nothing restarts, open chats, running turns and drafts stay as they are.
 *
 * Shared modules are the running app's own instances of modules that hold state (a table, a cache, a
 * native addon): a fresh build of a unit uses those rather than copies of its own.
 */

export interface Unit<T extends object> {
  readonly name: string;
  /** The module's file, relative to `ts/` ("packages/ui/src/cards.ts"). */
  readonly entry: string;
  /** The module's current exports. */
  readonly now: T;
  /** 0 for the one Harbor started with, then one more for each swap. */
  readonly version: number;
}

interface Slot {
  name: string;
  entry: string;
  now: object;
  version: number;
}

const units = new Map<string, Slot>();
const shared = new Map<string, object>();
const listeners = new Set<(name: string) => void>();

/** `mod`, under `name`, until a newer build of `entry` is swapped in. */
export function unit<T extends object>(name: string, entry: string, mod: T): Unit<T> {
  const had = units.get(name);
  if (had) return had as unknown as Unit<T>;
  const slot: Slot = { name, entry, now: mod, version: 0 };
  units.set(name, slot);
  return slot as unknown as Unit<T>;
}

export function all(): readonly Unit<object>[] {
  return [...units.values()] as unknown as Unit<object>[];
}

/** Why `next` can't stand in for `prev`: an export the app uses missing or no longer a function; null when it can. */
export function mismatch(prev: object, next: object): string | null {
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in next)) return `it no longer exports ${k}`;
    const w = (next as Record<string, unknown>)[k];
    if (typeof v === "function" && typeof w !== "function") return `${k} is no longer a function`;
  }
  return null;
}

/** Puts `mod` in place of unit `name`'s exports; throws (and keeps the old ones) when it can't stand in for them. */
export function swap(name: string, mod: object): number {
  const slot = units.get(name);
  if (!slot) throw new Error(`no reloadable unit ${name}`);
  const why = mismatch(slot.now, mod);
  if (why !== null) throw new Error(`${slot.entry}: ${why}`);
  slot.now = mod;
  slot.version += 1;
  for (const l of listeners) {
    try {
      l(name);
    } catch (e) {
      console.error(`hot: a listener of ${name} failed`, e);
    }
  }
  return slot.version;
}

/** Called after each swap with the unit's name. */
export function onSwap(l: (name: string) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The running app's instance of `key`: a package ("@harbor/net", "slint-ui") or a file relative to `ts/`. */
export function share(key: string, ns: object): void {
  shared.set(key, ns);
}

export function sharedOf(key: string): object | undefined {
  return shared.get(key);
}

export function sharedKeys(): string[] {
  return [...shared.keys()];
}

// A fresh build reaches the shared instances through this global: it's a separate module.
(globalThis as Record<string, unknown>).__harborHot = { shared: sharedOf };
