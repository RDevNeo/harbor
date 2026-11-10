/**
 * A cache bounded by the bytes its values hold rather than by how many there are: a count cap lets a few
 * large values (a long streamed reply, a decoded photo) hold as much as they like, and a small one throws
 * away many cheap values for nothing.
 *
 * - `budget`: the bytes all entries may hold together; past it the least recently used go first.
 * - `maxEntry`: a value larger than this isn't kept at all (the caller still uses what it computed).
 * - `pinned`: entries that must stay whatever the budget (being loaded, on screen); they still count.
 * - `size`: an estimate of what a value retains (bytes of its pixels, ~2 per character of a string).
 *
 * Map order is the recency: `get` moves an entry to the end, eviction walks from the start.
 */
export interface ByteLruOptions<K, V> {
  budget: number;
  maxEntry?: number;
  size: (value: V, key: K) => number;
  pinned?: (key: K, value: V) => boolean;
  /** Told about each entry dropped to fit the budget (not those `delete`d or replaced). */
  evicted?: (key: K, value: V) => void;
}

export class ByteLru<K, V> {
  private map = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(private opts: ByteLruOptions<K, V>) {}

  /** The bytes held, by the estimate. */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  get budget(): number {
    return this.opts.budget;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** The value, now the most recently used. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** The value, its recency left as it is. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * Keeps `value` as the most recently used and evicts down to the budget. False when it's over `maxEntry`
   * and so not kept (an older value under `key` goes too: it's stale). Also call it again after changing a
   * value in place, so its size is measured again.
   */
  set(key: K, value: V): boolean {
    const size = Math.max(0, this.opts.size(value, key));
    this.delete(key);
    if (this.opts.maxEntry !== undefined && size > this.opts.maxEntry) return false;
    this.map.set(key, { value, size });
    this.total += size;
    this.trim();
    return true;
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    if (e === undefined) return false;
    this.map.delete(key);
    this.total -= e.size;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  /** Least recently used first, unpinned ones, until the total fits the budget. Pinned ones never go. */
  trim(): void {
    if (this.total <= this.opts.budget) return;
    const pinned = this.opts.pinned;
    for (const [k, e] of this.map) {
      if (this.total <= this.opts.budget) break;
      if (pinned?.(k, e.value)) continue;
      this.map.delete(k);
      this.total -= e.size;
      this.opts.evicted?.(k, e.value);
    }
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [k, e] of this.map) yield [k, e.value];
  }
}

/** About what a JS string retains: two bytes a character (UTF-16) and its header. */
export function stringBytes(s: string): number {
  return 2 * s.length + 32;
}
