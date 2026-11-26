// SpokPay's active site requests for the SpokPay section's "Site requests" list (Headquarters' Home list; Person Hub's
// views/spokpay/siteRequestStore.ts), held by the engine so the PC window and the phone show the same list: read every
// minute (Headquarters' minute poll, convex/spokpay/siteRequestPoll.ts), again at once when the key changes or a
// proposal opens a request. A failed read keeps the rows of the last good one. Also the store icons (SpokPay's store
// list, a day each), the seen marks (Headquarters' siteRequestSeen) and the last list read (shown at once on the next
// start, and by the offline screenshot rig), in <dir>/spokpay-board.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "@harbor/store";
import { normalizeRef, readRow, readThread, SpokpayError, type ImageBytes, type SrRow, type SrThread } from "./spokpay-core.ts";
import type { SpLinks, Spokpay } from "./spokpay.ts";
import { spError } from "./spokpay-view.ts";
import { paneView, relativeEnglish, srAiContext, type PaneView } from "./srpane.ts";
import { ACTIVE_LIMIT, failedAgain, listNotices, listRows, sweepSeen, type ListProblem, type ListRow, type Notice } from "./srlist.ts";

const POLL_MS = 60_000;
const ICON_TTL = 24 * 3_600_000;
const READS_PER_POLL = 5;
/** The requests whose last read is kept (opened offline, or while SpokPay fails, the pane shows it). */
const THREADS_KEPT = 12;
/** An open pane asks a refused permission again at most this often (the pane reads every 30 s). */
const PERMS_RECHECK_MS = 60_000;

type Icon = { url: string | null; at: number };

export interface BoardView {
  rows: ListRow[];
  notices: Notice[];
  /** One waits on SpokPay: the heading's amber dot. */
  waits: boolean;
  /** Store icon URLs by slug (null: none, initials). */
  icons: Record<string, string | null>;
}

export class SiteRequestBoard {
  private rows: SrRow[] | null = null;
  private problem: ListProblem = { kind: "none" };
  private truncated = false;
  private seen: Record<string, number> = {};
  private icons: Record<string, Icon> = {};
  private threads: Record<string, { at: number; t: SrThread }> = {};
  private reading: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(
    private readonly sp: Spokpay,
    dir: string,
    private readonly touch: () => void,
  ) {
    this.file = join(dir, "spokpay-board.json");
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { seen?: unknown; icons?: unknown; rows?: unknown; threads?: unknown };
      if (j.threads && typeof j.threads === "object")
        for (const [ref, v] of Object.entries(j.threads as Record<string, { at?: unknown; t?: unknown }>)) {
          try {
            if (typeof v.at === "number") this.threads[ref] = { at: v.at, t: readThread(v.t) };
          } catch {
            // a bad one is read again
          }
        }
      if (j.seen && typeof j.seen === "object") this.seen = j.seen as Record<string, number>;
      if (j.icons && typeof j.icons === "object") this.icons = j.icons as Record<string, Icon>;
      if (Array.isArray(j.rows)) {
        this.rows = j.rows.flatMap((x) => {
          try {
            return [readRow(x)];
          } catch {
            return [];
          }
        });
        this.truncated = this.rows.length >= ACTIVE_LIMIT;
      }
    } catch {
      // none yet
    }
  }

  /** Reads now and then every minute. */
  start(): void {
    if (this.timer) return;
    void this.reload();
    this.timer = setInterval(() => void this.reload(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reload(): Promise<void> {
    if (this.reading) return this.reading;
    if (!this.sp.status().connected) {
      this.set(() => {
        this.rows = null;
        this.problem = { kind: "not-connected" };
        this.truncated = false;
      });
      return Promise.resolve();
    }
    this.reading = (async () => {
      try {
        const list = await this.sp.active();
        this.set(() => {
          this.rows = list;
          this.problem = { kind: "none" };
          this.truncated = list.length >= ACTIVE_LIMIT;
          this.seen = sweepSeen(this.seen, list, this.truncated);
        });
        this.save();
        void this.readIcons(list);
      } catch (e) {
        const err = spError(e);
        this.set(() => {
          if (err.code === "NOT_CONNECTED") {
            this.rows = null;
            this.problem = { kind: "not-connected" };
            this.truncated = false;
          } else this.problem = failedAgain(this.problem, err.message, Date.now());
        });
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  /** The user opened the request with its last activity at `activityAt`: what the store wrote is read, here only. */
  markSeen(ref: string, activityAt: number): void {
    if (!ref || !Number.isFinite(activityAt) || (this.seen[ref] ?? 0) >= activityAt) return;
    this.seen = { ...this.seen, [ref]: activityAt };
    this.save();
    this.touch();
  }

  // ---------- a request's pane (SpokPay's admin request page, in Hub) ----------

  /**
   * The request read now (the whole thread SpokPay sends, its newest 100 messages): opened, so what the store wrote is
   * read here (the list's "Store replied" clears).
   */
  async pane(ref: string, imageRoute: (url: string) => string): Promise<PaneView> {
    const { t, note } = await this.read(ref);
    // a permission added on spokpay.com/admin since the last ask clears the pane's notice now, not after a restart
    if (!note) await this.sp.recheck(PERMS_RECHECK_MS).catch(() => {});
    const h = t.siteRequest;
    this.markSeen(h.ref, h.lastActivityAt);
    if (!note) this.save();
    return paneView(t, { note, now: Date.now(), ...this.known(h.ref), permissions: this.sp.status().permissions, imageRoute });
  }

  /** The request as a note to the AI carries it (srpane.ts srAiContext): read now, or its last read. */
  async aiContext(ref: string, url: string): Promise<{ context: string; ref: string; store: string; storeSlug: string | null; owner: string }> {
    const { t } = await this.read(ref);
    const k = this.known(t.siteRequest.ref);
    const v = paneView(t, { now: Date.now(), ...k });
    return { context: srAiContext(t, { now: Date.now(), url, ...(k.ownerEmail ? { owner: k.ownerEmail } : {}), ...(k.summary ? { summary: k.summary } : {}) }), ref: v.ref, store: v.store, storeSlug: v.storeSlug, owner: v.owner };
  }

  /** Which person / Persons store is which SpokPay store (spokpay-links.json). */
  links(): SpLinks {
    return this.sp.links();
  }

  /** The proposal Hub opened as this request (whose person asked for it), if any. */
  openedBy(ref: string): string | null {
    return this.sp.proposals().find((p) => p.state.kind === "opened" && p.state.ref === ref)?.personId ?? null;
  }

  /** What Hub knows of a request beyond the thread: the owner's address (the active list) and the summary it opened. */
  private known(ref: string): { ownerEmail?: string; summary?: string } {
    const row = this.rows?.find((x) => x.ref === ref);
    const opened = this.sp.proposals().find((p) => p.state.kind === "opened" && p.state.ref === ref);
    return { ...(row?.ownerEmail ? { ownerEmail: row.ownerEmail } : {}), ...(opened ? { summary: opened.shown.details } : {}) };
  }

  /** The thread read now (kept for later), or, when SpokPay fails, its last read with a note saying so. */
  private async read(ref: string): Promise<{ t: SrThread; note: string | null }> {
    const r = normalizeRef(ref);
    if (!r) throw new SpokpayError(400, "INVALID_INPUT", "Not a site request ref (SR-…)");
    try {
      const t = await this.sp.thread(r);
      this.threads = Object.fromEntries(
        Object.entries({ ...this.threads, [r]: { at: Date.now(), t } })
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, THREADS_KEPT),
      );
      return { t, note: null };
    } catch (e) {
      const kept = this.threads[r];
      if (!kept) throw e;
      return { t: kept.t, note: `Not read now (${spError(e).message}). Shown as read ${relativeEnglish(kept.at, Date.now())}.` };
    }
  }

  /** The user's Send: their words (and pictures) to the store as SpokPay; the list is read again. */
  async reply(ref: string, text: string, images: ImageBytes[], key?: string): Promise<void> {
    await this.sp.reply(ref, { text, images }, key);
    void this.reload();
  }

  /** The status menu's move (SpokPay's admin moves only); the list is read again. */
  async move(ref: string, to: string): Promise<void> {
    await this.sp.setStatus(ref, to);
    void this.reload();
  }

  view(): BoardView {
    const rows = listRows(this.rows ?? [], this.seen);
    const icons: Record<string, string | null> = {};
    for (const r of rows) if (r.storeSlug) icons[r.storeSlug] = this.icons[r.storeSlug]?.url ?? null;
    return { rows, notices: listNotices(this.problem, this.rows !== null || this.problem.kind !== "none", this.truncated), waits: rows.some((r) => r.waiting), icons };
  }

  private set(f: () => void): void {
    const before = JSON.stringify([this.rows, this.problem, this.truncated, this.seen]);
    f();
    if (JSON.stringify([this.rows, this.problem, this.truncated, this.seen]) !== before) this.touch();
  }

  private save(): void {
    try {
      writePrivate(this.file, JSON.stringify({ seen: this.seen, icons: this.icons, rows: this.rows ?? [], threads: this.threads }));
    } catch {
      // the marks stay in memory
    }
  }

  /** Headquarters' storeIcons: SpokPay's store list carries each store's icon, searched by name, a few per poll. */
  private async readIcons(rows: SrRow[]): Promise<void> {
    const now = Date.now();
    const want = new Map<string, string>();
    for (const r of rows) {
      const had = r.storeSlug ? this.icons[r.storeSlug] : undefined;
      if (r.storeSlug && !want.has(r.storeSlug) && !(had && now - had.at < ICON_TTL)) want.set(r.storeSlug, r.storeName);
    }
    const fresh: Record<string, Icon> = {};
    await Promise.all(
      [...want].slice(0, READS_PER_POLL).map(async ([slug, name]) => {
        try {
          const found = await this.sp.stores(name || slug);
          const hit = found.find((s) => s.slug === slug) ?? (name !== slug ? (await this.sp.stores(slug)).find((s) => s.slug === slug) : undefined);
          fresh[slug] = { url: hit?.iconUrl ?? null, at: now };
        } catch (e) {
          // a key without stores:read keeps the initials until tomorrow; anything else is read again next time
          if (spError(e).code === "NOT_AUTHORIZED") fresh[slug] = { url: null, at: now };
        }
      }),
    );
    if (!Object.keys(fresh).length) return;
    this.icons = { ...this.icons, ...fresh };
    this.save();
    this.touch();
  }
}
