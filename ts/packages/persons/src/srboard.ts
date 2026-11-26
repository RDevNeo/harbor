// SpokPay's active site requests for the SpokPay section's "Site requests" list (Headquarters' Home list; Person Hub's
// views/spokpay/siteRequestStore.ts), held by the engine so the PC window and the phone show the same list: read every
// minute (Headquarters' minute poll, convex/spokpay/siteRequestPoll.ts), again at once when the key changes or a
// proposal opens a request. A failed read keeps the rows of the last good one. Also the store icons (SpokPay's store
// list, a day each), the seen marks (Headquarters' siteRequestSeen) and the last list read (shown at once on the next
// start, and by the offline screenshot rig), in <dir>/spokpay-board.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "@harbor/store";
import { readRow, type SrRow } from "./spokpay-core.ts";
import type { Spokpay } from "./spokpay.ts";
import { spError } from "./spokpay-view.ts";
import { ACTIVE_LIMIT, failedAgain, listNotices, listRows, sweepSeen, type ListProblem, type ListRow, type Notice } from "./srlist.ts";

const POLL_MS = 60_000;
const ICON_TTL = 24 * 3_600_000;
const READS_PER_POLL = 5;

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
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { seen?: unknown; icons?: unknown; rows?: unknown };
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
      writePrivate(this.file, JSON.stringify({ seen: this.seen, icons: this.icons, rows: this.rows ?? [] }));
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
