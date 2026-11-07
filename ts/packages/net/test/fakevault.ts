// The account service's `/v1/vault` (worker/src/vault.js) in memory, by its rules: rows per
// account, the newest `at` wins (ties by the writer's key), `prev` for compare-and-swap, `since`
// by the service's rising `seq`, PCs of the account only; the account's key made on the first ask
// (`/v1/vault/key`, with the `meta` row only the service writes), or handed over by a PC of a vault
// made by Harbor 0.162-0.164. Tests can read every row and key it stores.
import { randomBytes } from "node:crypto";
import type { VaultCall } from "../src/vault.ts";
import { keyCheck, newVaultKey } from "../src/vaultcrypto.ts";

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
  /** account → the vault's key the service keeps, and its epoch. */
  keys = new Map<string, { vk: Uint8Array; epoch: string }>();

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
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(this.clock(), this.lastSeq + 1);
    return this.lastSeq;
  }

  private meta(account: string): { epoch: string; check: string } | null {
    const v = this.rows.get(account)?.get("meta")?.v;
    return v ? (JSON.parse(v) as { epoch: string; check: string }) : null;
  }

  /** A vault as Harbor 0.162-0.164 made it: a meta row for a key only its PCs have, and their wraps (tests). */
  legacy(account: string, vk: Uint8Array, epoch: string, by: string): void {
    const rows = this.rows.get(account) ?? new Map<string, FakeRow>();
    this.rows.set(account, rows);
    const at = this.clock();
    rows.set("meta", { id: "meta", v: JSON.stringify({ epoch, check: keyCheck(vk, epoch), at }), at, by, seq: this.nextSeq() });
    rows.set(`key:${by}`, { id: `key:${by}`, v: "{}", at, by, seq: this.nextSeq() });
    rows.set("key:recovery", { id: "key:recovery", v: "{}", at, by, seq: this.nextSeq() });
  }

  /** The service starts the vault over (an old one nobody handed the key of for a week): rows and key go. */
  startOver(account: string): void {
    this.rows.get(account)?.clear();
    this.keys.delete(account);
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
        const m = this.meta(account);
        const held = m === null || this.keys.get(account)?.epoch === m.epoch;
        if (path === "/v1/vault/key") {
          const k = this.keys.get(account);
          if (m && k && k.epoch === m.epoch) return { key: Buffer.from(k.vk).toString("base64"), epoch: k.epoch, check: m.check };
          if (m) return { key: null };
          const vk = newVaultKey();
          const epoch = randomBytes(8).toString("hex");
          const at = this.clock();
          this.keys.set(account, { vk, epoch });
          rows.set("meta", { id: "meta", v: JSON.stringify({ epoch, check: keyCheck(vk, epoch), at }), at, by: "", seq: this.nextSeq() });
          this.told++;
          return { key: Buffer.from(vk).toString("base64"), epoch, check: keyCheck(vk, epoch) };
        }
        return { now: this.clock(), seq, held, items: items.map((r) => ({ ...r })), devices: [...(this.devices.get(account) ?? new Map()).entries()].map(([f, n]) => ({ fp: f, name: n, seen: 0 })) };
      }
      if (path === "/v1/vault/key") {
        const b = body as { key: string; epoch: string };
        const vk = new Uint8Array(Buffer.from(b.key, "base64"));
        const m = this.meta(account);
        if (!m || m.epoch !== b.epoch || keyCheck(vk, b.epoch) !== m.check) throw new Error("409: That key isn't this account's vault's.");
        this.keys.set(account, { vk, epoch: b.epoch });
        for (const id of [...rows.keys()]) if (id.startsWith("key:") || id.startsWith("req:")) rows.delete(id);
        this.told++;
        return { ok: true };
      }
      const set = (body as { set: { id: string; v: string | null; at: number; prev?: number }[] }).set;
      const results = [];
      for (const e of set) {
        if (e.id.startsWith("key:") || e.id.startsWith("req:")) {
          results.push({ id: e.id, ok: true });
          continue;
        }
        const old = rows.get(e.id);
        if (e.id === "meta") {
          results.push({ id: e.id, ok: false, cur: old ? { ...old } : null });
          continue;
        }
        const win = e.prev !== undefined ? (old ? old.seq : 0) === e.prev : !old || e.at > old.at || (e.at === old.at && fp > old.by);
        if (!win) {
          results.push({ id: e.id, ok: false, cur: old ? { ...old } : null });
          continue;
        }
        const seq = this.nextSeq();
        rows.set(e.id, { id: e.id, v: e.v, at: e.at, by: fp, seq });
        if (!e.id.startsWith("lease:")) this.told++;
        results.push({ id: e.id, ok: true, seq });
      }
      return { now: this.clock(), results };
    };
  }
}
