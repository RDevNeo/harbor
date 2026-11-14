// A chat that is syncing: while its newest version isn't here yet, or is on its way to or from another PC, nothing
// that changes what syncs may touch it (a message, a rename, a settle, a delete, a move, an account or PC pick…):
// such a change would race the sync, be overwritten by it, split the chat, or land on a stale copy.
//
// A chat is syncing while
//   1. something holds it (`hold`): its carried session and work are being fetched and put in place
//      (continuehere.ts), it is being handed to another PC or taken from one (failover.ts `handoff`/`claim`);
//   2. a newer version of it is known in the workspace cloud and isn't applied here yet (`behind`, from chatcloud.ts
//      after each read of the workspaces);
//   3. Harbor just started, the PC woke up, or the account just signed in, and the first read of the workspace cloud
//      hasn't finished (`boot` … `pulled`): every chat that lives in the cloud (a copy, or this PC's chat published
//      there) waits for it; chats that are only this PC's don't.
// Each is bounded: a hold, a newer version that doesn't come, or a first read that doesn't finish ends after
// SYNC_MS / BOOT_MS (the cloud is unreachable, a step hung), with a quiet notice (`late`), never a lasting lock.
// The cloud's ordinary rounds every few seconds hold nothing: only a chat they actually change is syncing, for as
// long as that change takes to apply.

/** A hold, or a newer version not applied yet, keeps a chat syncing at most this long. */
export const SYNC_MS = 30_000;
/** After a start, a wake or a sign-in, the cloud's chats wait at most this long for the first read. */
export const BOOT_MS = 30_000;
/** The clock moved this much further than the ticks did: the PC slept (or the process was stopped). */
const WAKE_GAP_MS = 60_000;
const TICK_MS = 5_000;

export interface SyncingOptions {
  clock?: (() => number) | undefined;
  /** A chat lives in the workspace cloud (a copy of another PC's, or this PC's own published there). */
  inCloud: (chat: number) => boolean;
  /** The workspace cloud is on here (an account is signed in): only then do a start or a wake hold chats. */
  cloudOn: () => boolean;
  /** A chat's syncing state changed (null: several chats' at once). */
  changed: (chat: number | null) => void;
  /** Something took too long and its chat opens again anyway (null: the first read after a start or wake). */
  late?: ((chat: number | null, why: string) => void) | undefined;
  /** The PC woke up (or the account came back): the cloud should be read now. */
  woke?: (() => void) | undefined;
  /** Tests: no timer (call `tick` by hand). */
  manual?: boolean | undefined;
  syncMs?: number | undefined;
  bootMs?: number | undefined;
}

interface Hold {
  why: string;
  until: number;
}

interface Behind {
  /** The version it waits for (the cloud row's hash): a version that timed out doesn't hold the chat again. */
  key: string;
  since: number;
  why: string;
}

export class Syncing {
  private readonly o: SyncingOptions;
  private readonly holds = new Map<number, Map<number, Hold>>();
  private behindNow = new Map<number, Behind>();
  /** Versions that took too long, by chat: they don't hold it again. */
  private readonly gaveUp = new Map<number, string>();
  /** While the first read after a start or wake runs: until when (0: not now). */
  private bootUntil = 0;
  private bootWhy = "";
  private readonly waiters = new Map<number, (() => void)[]>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick: number;
  /** Told too when something took too long (the window's toast). */
  readonly lates = new Set<(chat: number | null, why: string) => void>();

  constructor(o: SyncingOptions) {
    this.o = o;
    this.lastTick = this.now();
    if (o.manual !== true) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  private get syncMs(): number {
    return this.o.syncMs ?? SYNC_MS;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Harbor started, the PC woke or the account signed in: the cloud's chats wait for the next read of it. */
  boot(why = "the first sync after start"): void {
    this.bootUntil = this.now() + (this.o.bootMs ?? BOOT_MS);
    this.bootWhy = why;
    this.o.changed(null);
  }

  /** The workspace cloud was read and what it had applied (or there's no cloud to read): the start's wait ends. */
  pulled(): void {
    if (this.bootUntil === 0) return;
    this.bootUntil = 0;
    this.settle(null);
  }

  /** Whether the first read after a start or wake is still awaited. */
  booting(): boolean {
    return this.bootUntil !== 0 && this.now() < this.bootUntil && this.o.cloudOn();
  }

  /** Chat `chat` syncs (`why`, a few words) until the returned release is called, or `ms` at most. */
  hold(chat: number, why: string, ms = this.syncMs): () => void {
    const token = ++this.seq;
    let m = this.holds.get(chat);
    if (!m) {
      m = new Map();
      this.holds.set(chat, m);
    }
    m.set(token, { why, until: this.now() + ms });
    this.o.changed(chat);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const h = this.holds.get(chat);
      if (!h?.delete(token)) return;
      if (h.size === 0) this.holds.delete(chat);
      this.settle(chat);
    };
  }

  /** Drops every hold of `chat` (it became another PC's: what held it here is over). */
  drop(chat: number): void {
    if (!this.holds.delete(chat)) return;
    this.settle(chat);
  }

  /**
   * The chats a newer version of which is known in the cloud and isn't applied here yet, each with that version's
   * key and a few words on it (chatcloud.ts after each read and each apply). Replaces the last list.
   */
  behind(list: ReadonlyMap<number, { key: string; why: string }>): void {
    const t = this.now();
    const next = new Map<number, Behind>();
    for (const [chat, v] of list) {
      if (this.gaveUp.get(chat) === v.key) continue;
      const had = this.behindNow.get(chat);
      next.set(chat, had && had.key === v.key ? had : { key: v.key, since: t, why: v.why });
    }
    // A version given up on that isn't listed any more is forgotten (a later one holds again).
    for (const [chat, key] of [...this.gaveUp]) if (list.get(chat)?.key !== key) this.gaveUp.delete(chat);
    const changed = new Set<number>([...this.behindNow.keys(), ...next.keys()].filter((c) => this.behindNow.get(c)?.key !== next.get(c)?.key));
    this.behindNow = next;
    for (const c of changed) this.settle(c);
  }

  /** Why chat `chat` is syncing (a few words), or null when it isn't. */
  why(chat: number, inCloud?: boolean): string | null {
    const t = this.now();
    const h = this.holds.get(chat);
    if (h) for (const x of h.values()) if (t < x.until) return x.why;
    const b = this.behindNow.get(chat);
    if (b && t - b.since < this.syncMs) return b.why;
    if (this.bootUntil !== 0 && t < this.bootUntil && this.o.cloudOn() && (inCloud ?? this.o.inCloud(chat))) return this.bootWhy;
    return null;
  }

  is(chat: number): boolean {
    return this.why(chat) !== null;
  }

  /** The chats syncing now, besides those only the start's wait holds (those are every chat in the cloud). */
  held(): number[] {
    return [...new Set([...this.holds.keys(), ...this.behindNow.keys()])].filter((c) => this.is(c));
  }

  /** Runs `f` once `chat` isn't syncing (now, when it isn't). */
  after(chat: number, f: () => void): void {
    if (!this.is(chat)) {
      f();
      return;
    }
    const list = this.waiters.get(chat) ?? [];
    list.push(f);
    this.waiters.set(chat, list);
  }

  /** Waits until `chat` isn't syncing. */
  until(chat: number): Promise<void> {
    return new Promise((r) => this.after(chat, r));
  }

  /** Timeouts end what took too long; a jump of the clock means the PC slept. */
  tick(): void {
    const t = this.now();
    const gap = t - this.lastTick;
    this.lastTick = t;
    if (gap > WAKE_GAP_MS + TICK_MS && this.o.cloudOn()) {
      this.boot("the first sync after waking up");
      this.o.woke?.();
    }
    for (const [chat, h] of [...this.holds]) {
      let gone = false;
      for (const [token, x] of [...h]) {
        if (t < x.until) continue;
        h.delete(token);
        gone = true;
        this.late(chat, x.why);
      }
      if (h.size === 0) this.holds.delete(chat);
      if (gone) this.settle(chat);
    }
    for (const [chat, b] of [...this.behindNow]) {
      if (t - b.since < this.syncMs) continue;
      this.behindNow.delete(chat);
      this.gaveUp.set(chat, b.key);
      this.late(chat, b.why);
      this.settle(chat);
    }
    if (this.bootUntil !== 0 && t >= this.bootUntil) {
      this.bootUntil = 0;
      if (this.o.cloudOn()) this.late(null, this.bootWhy);
      this.settle(null);
    }
  }

  private late(chat: number | null, why: string): void {
    this.o.late?.(chat, why);
    for (const f of this.lates) f(chat, why);
  }

  /** Something ended: the window and phones redraw, and what waited for a chat that stopped syncing runs. */
  private settle(chat: number | null): void {
    this.o.changed(chat);
    const ids = chat === null ? [...this.waiters.keys()] : [chat];
    for (const id of ids) {
      if (this.is(id)) continue;
      const list = this.waiters.get(id);
      if (!list) continue;
      this.waiters.delete(id);
      for (const f of list) {
        try {
          f();
        } catch {
          // one waiter's failure doesn't keep the others
        }
      }
    }
  }
}
