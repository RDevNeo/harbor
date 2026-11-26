// A WhatsApp chat's older messages from Hub's own WhatsApp store (the agents' WhatsApp app: <hub data>/apps/whatsapp,
// mcp/src/whatsappstore.ts), read only. Persons' WhatsApp is a linked device of its own that keeps only the chats of
// people in Persons at the time (and the history WhatsApp sent once when it was linked), so someone added later
// (Personal › Add contact) has no past there. The agents' store keeps every chat of the account: when it is the same
// account (its linked.json says so), a chat's page comes from it, as the raw messages the engine handed over.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Raw = Record<string, unknown>;
const digitsOf = (jid: string): string => (jid.split("@")[0] ?? "").split(":")[0] ?? "";

export interface StoredPage {
  /** Raw messages (Baileys' WebMessageInfo as stored), newest last. */
  raws: Raw[];
  /** More before the first one. */
  more: boolean;
}

export class AgentWaStore {
  private db: Database | null = null;
  private account: string | null | undefined;

  constructor(private readonly dir: string) {}

  /** The account (phone digits) the store belongs to, null when unknown. */
  accountDigits(): string | null {
    if (this.account !== undefined) return this.account;
    try {
      const j = JSON.parse(readFileSync(join(this.dir, "linked.json"), "utf8")) as { jid?: unknown };
      this.account = typeof j.jid === "string" ? digitsOf(j.jid) || null : null;
    } catch {
      this.account = null;
    }
    return this.account;
  }

  private open(): Database | null {
    if (this.db) return this.db;
    const f = join(this.dir, "wa.db");
    if (!existsSync(f)) return null;
    try {
      this.db = new Database(f, { readonly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  /**
   * The page of `digits`' direct chat before `beforeSec` (seconds; none: the newest), `limit` messages, for account
   * `me` (phone digits): nothing when the store is another account's or missing.
   */
  page(me: string, digits: string | string[], beforeSec: number | null, limit = 50): StoredPage {
    const all = (Array.isArray(digits) ? digits : [digits]).filter(Boolean);
    if (!me || !all.length || this.accountDigits() !== me) return { raws: [], more: false };
    const db = this.open();
    if (!db) return { raws: [], more: false };
    try {
      const jids = this.jidsOf(db, all);
      const marks = jids.map(() => "?").join(",");
      const rows = db
        .query(`SELECT raw FROM messages WHERE chat IN (${marks}) AND deleted = 0 AND ts < ? ORDER BY ts DESC LIMIT ?`)
        .all(...jids, beforeSec ?? Number.MAX_SAFE_INTEGER, limit + 1) as { raw: string }[];
      const raws: Raw[] = [];
      for (const r of rows.slice(0, limit)) {
        try {
          raws.push(JSON.parse(r.raw) as Raw);
        } catch {
          // a row that isn't JSON: skipped
        }
      }
      return { raws: raws.reverse(), more: rows.length > limit };
    } catch {
      return { raws: [], more: false };
    }
  }

  /** A number's chat jids in the store: each form's phone jid and the lids WhatsApp gave it. */
  private jidsOf(db: Database, digits: string[]): string[] {
    const out: string[] = [];
    for (const d of digits) {
      const pn = `${d}@s.whatsapp.net`;
      out.push(pn, ...db.query("SELECT lid FROM lids WHERE pn = ?").all(pn).map((r) => String((r as { lid: string }).lid)));
    }
    return out;
  }

  /**
   * Which of a number's forms (`digits`: with and without a Brazilian mobile's 9th digit) the account has talked to:
   * the one with a chat or messages in the store, else null (another account's store, or none).
   */
  known(me: string, digits: string[]): string | null {
    if (!me || this.accountDigits() !== me) return null;
    const db = this.open();
    if (!db) return null;
    try {
      for (const d of digits) {
        const jids = this.jidsOf(db, [d]);
        const marks = jids.map(() => "?").join(",");
        const hit = db.query(`SELECT 1 FROM chats WHERE jid IN (${marks}) UNION SELECT 1 FROM messages WHERE chat IN (${marks}) LIMIT 1`).get(...jids, ...jids);
        if (hit) return d;
      }
    } catch {
      // unreadable: unknown
    }
    return null;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
