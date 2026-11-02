/** Sends a phone may repeat: it retries a POST whose answer it didn't get (the connection dropped
 *  on the way back, it timed out, it asked another PC of the workspace), and each copy carries the
 *  same client id. The first copy runs; the others get its answer, also while it still runs.
 *
 *  Only an accepted send is remembered: one that failed (the chat's home PC off, a bad upload)
 *  may be tried again with the same id. */
export class Once<T extends { status: number }> {
  private seen = new Map<string, { at: number; reply: Promise<T> }>();

  constructor(
    private ttl = 10 * 60_000,
    private max = 2000,
    private now: () => number = () => Date.now(),
  ) {}

  /** f's answer for the first call with this key; the same answer for every repeat within ttl. */
  run(key: string, f: () => Promise<T>): Promise<T> {
    const t = this.now();
    const was = this.seen.get(key);
    if (was && t - was.at < this.ttl) return was.reply;
    this.sweep(t);
    const reply = f();
    const entry = { at: t, reply };
    this.seen.set(key, entry);
    const forget = () => {
      if (this.seen.get(key) === entry) this.seen.delete(key);
    };
    reply.then((r) => {
      if (r.status < 200 || r.status >= 300) forget();
    }, forget);
    return reply;
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(t: number): void {
    if (this.seen.size < this.max) return;
    for (const [k, v] of this.seen) if (t - v.at >= this.ttl) this.seen.delete(k);
    // Still full: the oldest go (a Map keeps insertion order).
    for (const k of this.seen.keys()) {
      if (this.seen.size < this.max) break;
      this.seen.delete(k);
    }
  }
}

/** The key a send's copies share: its chat and the client id the phone gave it (`client_id`,
 *  8 to 80 letters, digits, `-` or `_`); null when it has none (older phones, the desktop). */
export function sendKey(chat: string, body: Record<string, unknown>): string | null {
  const id = body.client_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  return `${chat}\n${id}`;
}
