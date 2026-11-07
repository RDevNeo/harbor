// The account service's `/v1/vault` (worker/src/vault.js) in memory, by its rules: rows per
// account, the newest `at` wins (ties by the writer's key), `prev` for compare-and-swap, `since`
// by the service's rising `seq`, PCs of the account only. Tests can read every row it stores.
import type { VaultCall } from "../src/vault.ts";

export interface FakeRow {
  id: string;
  v: string | null;
  at: number;
  by: string;
  seq: number;
}

export class FakeVaultService {
  rows = new Map<string, Map<string, FakeRow>>();
  /** account → its PCs (fp → name). */
  devices = new Map<string, Map<string, string>>();
  clock: () => number;
  private lastSeq = 0;
  /** Off: every call fails as the network would. */
  up = true;
  /** Writes that announced themselves (not leases). */
  told = 0;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  signIn(account: string, fp: string, name: string): void {
    const m = this.devices.get(account) ?? new Map<string, string>();
    m.set(fp, name);
    this.devices.set(account, m);
  }

  remove(account: string, fp: string): void {
    this.devices.get(account)?.delete(fp);
    this.rows.get(account)?.delete(`key:${fp}`);
    this.rows.get(account)?.delete(`req:${fp}`);
  }

  all(account: string): FakeRow[] {
    return [...(this.rows.get(account)?.values() ?? [])];
  }

  /** The call a PC with key `fp` signed in to `account` makes. */
  call(account: string, fp: string): VaultCall {
    return async (method, path, body) => {
      if (!this.up) throw new Error("offline");
      if (!this.devices.get(account)?.has(fp)) throw new Error("This PC is no longer signed in to this account.");
      const rows = this.rows.get(account) ?? new Map<string, FakeRow>();
      this.rows.set(account, rows);
      if (method === "GET") {
        const since = Number(new URL(path, "http://x").searchParams.get("since") ?? 0);
        const items = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
        const seq = Math.max(0, ...[...rows.values()].map((r) => r.seq));
        return { now: this.clock(), seq, items: items.map((r) => ({ ...r })), devices: [...(this.devices.get(account) ?? new Map()).entries()].map(([f, n]) => ({ fp: f, name: n, seen: 0 })) };
      }
      if (method === "DELETE") {
        rows.clear();
        return { ok: true };
      }
      const set = (body as { set: { id: string; v: string | null; at: number; prev?: number }[] }).set;
      const results = [];
      for (const e of set) {
        const old = rows.get(e.id);
        const win = e.prev !== undefined ? (old ? old.seq : 0) === e.prev : !old || e.at > old.at || (e.at === old.at && fp > old.by);
        if (!win) {
          results.push({ id: e.id, ok: false, cur: old ? { ...old } : null });
          continue;
        }
        const seq = Math.max(this.clock(), this.lastSeq + 1);
        this.lastSeq = seq;
        rows.set(e.id, { id: e.id, v: e.v, at: e.at, by: fp, seq });
        if (!e.id.startsWith("lease:")) this.told++;
        results.push({ id: e.id, ok: true, seq });
      }
      return { now: this.clock(), results };
    };
  }
}
