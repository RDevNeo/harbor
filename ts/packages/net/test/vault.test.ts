import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, type Identity } from "../src/tls.ts";
import { LEASE_TTL, Vault, type VaultLocal, type VaultSource } from "../src/vault.ts";
import { encodeItem, hashOf, newVaultKey, rowId, seal } from "../src/vaultcrypto.ts";
import { FakeVaultService } from "./fakevault.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let t = 1_800_000_000_000;
const clock = () => t;
const enc = (s: string) => new Uint8Array(Buffer.from(s));
const dec = (b: Uint8Array | undefined) => (b === undefined ? undefined : Buffer.from(b).toString());

/** Items in memory, as a PC's files would be. */
class Mem implements VaultSource {
  m = new Map<string, { data: Uint8Array; at: number }>();
  part = true;
  mark: string | null = null;
  stamp = { get: () => this.mark, set: (v: string) => void (this.mark = v) };
  constructor(readonly prefix: string) {}
  list(): VaultLocal[] | null {
    return this.part ? [...this.m].map(([id, v]) => ({ id, data: v.data, at: v.at })) : null;
  }
  all(): VaultLocal[] {
    return [...this.m].map(([id, v]) => ({ id, data: v.data, at: v.at }));
  }
  write(id: string, data: Uint8Array | null): void {
    if (data === null) this.m.delete(id);
    else this.m.set(id, { data, at: t });
  }
  set(id: string, text: string, at = t): void {
    this.m.set(id, { data: enc(text), at });
  }
  get(id: string): string | undefined {
    return dec(this.m.get(id)?.data);
  }
  dump(): Record<string, string> {
    return Object.fromEntries([...this.m].map(([k, v]) => [k, Buffer.from(v.data).toString()]));
  }
}

interface Pc {
  id: Identity;
  dir: string;
  files: Mem;
  keys: Mem;
  vault: Vault;
  account: string;
  sync(): Promise<void>;
}

function pc(svc: FakeVaultService, account: string, name: string, keep?: { id: Identity; dir: string; files: Mem; keys: Mem }): Pc {
  const id = keep?.id ?? generateIdentity();
  const dir = keep?.dir ?? mkdtempSync(join(tmpdir(), "hvault-"));
  if (!keep) dirs.push(dir);
  const files = keep?.files ?? new Mem("f:");
  const keys = keep?.keys ?? new Mem("s:");
  const vault = new Vault({ stateDir: dir, identity: () => id, sources: () => [files, keys], clock, log: process.env.VDBG ? (l) => console.log(name, l) : undefined });
  svc.signIn(account, id.fp, name);
  const p: Pc = { id, dir, files, keys, vault, account, sync: () => vault.sync(p.account, svc.call(p.account, id.fp)) };
  return p;
}

/** Rounds on every PC, `n` times, a second apart. */
async function rounds(pcs: Pc[], n = 2): Promise<void> {
  for (let i = 0; i < n; i++)
    for (const p of pcs) {
      t += 1000;
      await p.sync();
    }
}

describe("account vault", () => {
  test("a new PC of the account gets every item on its first round, with no other PC on; the service sees only ciphertext", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "user_sam", "desk");
    a.files.set("f:gmail.accounts/sam@example.com.json", '{"access_token":"ya29.SECRET-ACCESS","refresh_token":"1//SECRET-REFRESH"}');
    a.files.set("f:github/hosts.yml", "github.com:\n    oauth_token: gho_SECRETGH\n");
    a.keys.set("s:OPENAI_KEY", '{"name":"OPENAI_KEY","value":"sk-SECRETVALUE"}');
    a.files.set("f:whatsapp-session.bin", "linked-device keys");
    await a.sync();
    expect(a.vault.status().state).toBe("open");
    expect(a.vault.status().items).toBe(4);
    expect(svc.keys.has("user_sam")).toBe(true);

    // The desk is off for good (never syncs again); Sam signs in on a new laptop.
    const b = pc(svc, "user_sam", "laptop");
    await b.sync();
    expect(b.vault.status().state).toBe("open");
    expect(b.files.dump()).toEqual(a.files.dump());
    expect(b.keys.dump()).toEqual(a.keys.dump());
    // And a third, the same.
    const c = pc(svc, "user_sam", "spare");
    await c.sync();
    expect(c.keys.get("s:OPENAI_KEY")).toContain("sk-SECRETVALUE");

    // Nothing readable in the rows: no item name, no value; only hashes and the service's meta row.
    const stored = JSON.stringify(svc.all("user_sam"));
    for (const s of ["SECRET", "sam@example.com", "gmail", "hosts.yml", "OPENAI", "sk-", "linked-device"]) expect(stored.includes(s)).toBe(false);
    for (const r of svc.all("user_sam")) expect(r.id === "meta" || /^(i|lease):[0-9a-f]{40}$/.test(r.id)).toBe(true);
    // Nothing of the old per-PC key pair is made any more.
    for (const p of [a, b, c]) expect(existsSync(join(p.dir, "vault-device.json"))).toBe(false);
  });

  test("a vault made by Harbor 0.162-0.164 (its key on its PCs only): a PC that has the key hands it over on its own, and the new PC opens", async () => {
    const svc = new FakeVaultService(clock);
    const vk = newVaultKey();
    const epoch = "00112233aabbccdd";
    const a = pc(svc, "u", "desk");
    svc.legacy("u", vk, epoch, a.id.fp);
    // The desk's state as the old Harbor left it: the key in vault.json, its X25519 pair beside it, a synced key and the recovery code's item.
    const row = rowId(vk, "s:OLD_KEY");
    const rec = rowId(vk, "~recovery");
    const now = t;
    svc.rows.get("u")?.set(row, { id: row, v: seal(vk, row, epoch, encodeItem({ id: "s:OLD_KEY", data: enc("old value") })), at: now, by: a.id.fp, seq: now + 10 });
    svc.rows.get("u")?.set(rec, { id: rec, v: seal(vk, rec, epoch, encodeItem({ id: "~recovery", data: enc("AAAAA-BBBBB") })), at: now, by: a.id.fp, seq: now + 11 });
    a.keys.set("s:OLD_KEY", "old value", now);
    const saved = { account: "u", epoch, vk: Buffer.from(vk).toString("base64"), cursor: 0, rows: { [row]: { id: "s:OLD_KEY", h: hashOf(enc("old value")), at: now }, [rec]: { id: "~recovery", h: "x", at: now } }, fresh: true };
    writeFileSync(join(a.dir, "vault.json"), JSON.stringify(saved));
    writeFileSync(join(a.dir, "vault-device.json"), JSON.stringify({ pub: "p", key: "k" }));
    a.keys.mark = `u:${epoch}`;
    const desk = pc(svc, "u", "desk", { id: a.id, dir: a.dir, files: a.files, keys: a.keys });
    expect(existsSync(join(a.dir, "vault-device.json"))).toBe(false);

    // A new laptop first, while the desk is still off: it waits, and makes no vault of its own over the old one.
    const b = pc(svc, "u", "laptop");
    await b.sync();
    expect(b.vault.status().state).toBe("locked");
    expect(svc.keys.has("u")).toBe(false);
    // The desk (updated) runs: it hands its key over; the old wraps and the recovery code's item go.
    await desk.sync();
    expect(svc.keys.get("u")?.epoch).toBe(epoch);
    expect(svc.all("u").some((r) => r.id.startsWith("key:"))).toBe(false);
    expect(svc.rows.get("u")?.get(rec)?.v).toBeNull();
    expect(desk.keys.get("s:OLD_KEY")).toBe("old value");
    // The laptop opens on its next round, with the desk off again.
    await b.sync();
    expect(b.vault.status().state).toBe("open");
    expect(b.keys.get("s:OLD_KEY")).toBe("old value");
    expect(b.vault.status().items).toBe(1);
    // And a change on the laptop reaches the desk: same key, same vault.
    t += 1000;
    b.keys.set("s:NEW_KEY", "from the laptop");
    await rounds([b, desk]);
    expect(desk.keys.get("s:NEW_KEY")).toBe("from the laptop");
  });

  test("the newest change of an item wins everywhere; a refreshed token and a sign-out of an integration follow", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:gmail.accounts/x.json", "token v1");
    a.files.set("f:linear.json", "linear key");
    await a.sync();
    const b = pc(svc, "u", "b");
    await rounds([b, a, b]);
    expect(b.files.get("f:gmail.accounts/x.json")).toBe("token v1");

    // A refresh on b (its token file changes) reaches a.
    t += 5000;
    b.files.set("f:gmail.accounts/x.json", "token v2 refreshed");
    await rounds([b, a]);
    expect(a.files.get("f:gmail.accounts/x.json")).toBe("token v2 refreshed");

    // Both change it: the later change wins on both.
    t += 1000;
    a.files.set("f:gmail.accounts/x.json", "from a");
    await a.sync();
    t += 1000;
    b.files.set("f:gmail.accounts/x.json", "from b, later");
    await rounds([b, a, b]);
    expect(a.files.get("f:gmail.accounts/x.json")).toBe("from b, later");
    expect(b.files.get("f:gmail.accounts/x.json")).toBe("from b, later");

    // Signed out of Linear on a: gone on b too, and it stays gone.
    a.files.m.delete("f:linear.json");
    await rounds([a, b, a, b]);
    expect(b.files.get("f:linear.json")).toBeUndefined();
    expect(a.files.get("f:linear.json")).toBeUndefined();
  });

  test("joining a vault: each item takes the newer side (a file's change time stands for it the first time)", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:one.json", "a's newer", t);
    a.files.set("f:two.json", "a's older", t - 60_000);
    await a.sync();
    const b = pc(svc, "u", "b");
    b.files.set("f:one.json", "b's older", t - 120_000);
    b.files.set("f:two.json", "b's newer", t);
    b.files.set("f:three.json", "only b");
    await rounds([b, a, b, a]);
    for (const p of [a, b]) {
      expect(p.files.get("f:one.json")).toBe("a's newer");
      expect(p.files.get("f:two.json")).toBe("b's newer");
      expect(p.files.get("f:three.json")).toBe("only b");
    }
  });

  test("a restart keeps the vault open; a wiped data folder rejoins and deletes nothing anywhere", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.keys.set("s:BOAT_API_KEY", "boat");
    await a.sync();
    const c = pc(svc, "u", "new-pc");
    await c.sync();
    expect(c.keys.get("s:BOAT_API_KEY")).toBe("boat");
    const again = pc(svc, "u", "new-pc", { id: c.id, dir: c.dir, files: c.files, keys: c.keys });
    await again.sync();
    expect(again.vault.status().state).toBe("open");
    expect(again.keys.get("s:BOAT_API_KEY")).toBe("boat");
    // Its data folder wiped (the state folder kept): the items come back, and nothing is deleted anywhere.
    const wiped = pc(svc, "u", "new-pc", { id: c.id, dir: c.dir, files: new Mem("f:"), keys: new Mem("s:") });
    await wiped.sync();
    expect(wiped.keys.get("s:BOAT_API_KEY")).toBe("boat");
    await a.sync();
    expect(a.keys.get("s:BOAT_API_KEY")).toBe("boat");
  });

  test("a PC no longer signed in to the account gets nothing", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.keys.set("s:K", "v");
    await a.sync();
    const b = pc(svc, "u", "b");
    svc.remove("u", b.id.fp);
    await b.sync();
    expect(b.vault.status().state).not.toBe("open");
    expect(b.vault.status().error).toContain("no longer signed in");
    expect(b.keys.m.size).toBe(0);
  });

  test("signing out takes this PC's copies away once the vault has them; signing in again brings them back", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:gmail.accounts/x.json", "tok");
    a.keys.set("s:K", "v");
    await a.sync();
    a.keys.set("s:NEW", "made just before signing out");
    await a.vault.leave();
    expect(a.files.m.size).toBe(0);
    expect(a.keys.m.size).toBe(0);
    expect(a.vault.status().state).toBe("off");
    // The new key went out before the copies went: another PC has it at once.
    const b = pc(svc, "u", "b");
    await rounds([b]);
    expect(b.keys.get("s:NEW")).toBe("made just before signing out");
    // a signs in again: everything comes back.
    const back = pc(svc, "u", "a", { id: a.id, dir: a.dir, files: a.files, keys: a.keys });
    await rounds([back]);
    expect(back.vault.status().state).toBe("open");
    expect(back.keys.get("s:NEW")).toBe("made just before signing out");
    expect(back.files.get("f:gmail.accounts/x.json")).toBe("tok");
  });

  test("a sign-out that can't reach the vault keeps everything; another account signing in then finds it set aside, not in its vault", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "sam", "shared-pc");
    a.keys.set("s:SAMS_KEY", "sam's");
    await a.sync();
    a.keys.set("s:SAMS_OTHER", "not sent yet");
    svc.up = false;
    await a.vault.leave();
    expect(a.keys.get("s:SAMS_OTHER")).toBe("not sent yet"); // nothing lost
    svc.up = true;
    a.account = "ana";
    svc.signIn("ana", a.id.fp, "shared-pc");
    await rounds([a]);
    expect(a.keys.m.size).toBe(0);
    expect(JSON.stringify(svc.all("ana"))).not.toContain("SAMS");
    expect(a.vault.status().items).toBe(0);
    const aside = join(a.dir, "vault-left");
    expect(existsSync(aside)).toBe(true);
    expect(readdirSync(join(aside, readdirSync(aside)[0] ?? "")).length).toBe(2);
  });

  test("leases: one PC holds a single-host integration; another takes it only once it's free or by a new sign-in", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    await a.sync();
    const b = pc(svc, "u", "b");
    await rounds([b, a, b]);
    const who = (n: string) => ({ id: `ts:${n}`, name: n, account: "Sam (+1 555 0100)" });
    expect(await a.vault.claim("whatsapp", who("a"))).toBe(true);
    await b.sync();
    expect(b.vault.lease("whatsapp")).toMatchObject({ name: "a", mine: false, valid: true, account: "Sam (+1 555 0100)" });
    expect(await b.vault.claim("whatsapp", who("b"))).toBe(false);
    // a stops renewing (off): after the lease's time b takes it.
    t += LEASE_TTL + 1000;
    await b.sync();
    expect(b.vault.lease("whatsapp")?.valid).toBe(false);
    expect(await b.vault.claim("whatsapp", who("b"))).toBe(true);
    await a.sync();
    expect(a.vault.lease("whatsapp")).toMatchObject({ name: "b", mine: false, valid: true });
    // A new link on a takes it back at once.
    expect(await a.vault.claim("whatsapp", who("a"), true)).toBe(true);
    await b.sync();
    expect(b.vault.lease("whatsapp")?.mine).toBe(false);
    await a.vault.release("whatsapp");
    await b.sync();
    expect(b.vault.lease("whatsapp")).toBeNull();
    // Lease renewals don't wake the account's other PCs.
    const told = svc.told;
    await a.vault.claim("whatsapp", who("a"));
    expect(svc.told).toBe(told);
  });

  test("a vault the service started over: every PC joins the new one with what it has", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:x.json", "x");
    await a.sync();
    const b = pc(svc, "u", "b");
    await rounds([b]);
    expect(b.files.get("f:x.json")).toBe("x");
    b.files.set("f:only-b.json", "b");
    svc.startOver("u");
    await rounds([b, a, b, a]);
    expect(a.vault.status().state).toBe("open");
    expect(b.vault.status().state).toBe("open");
    expect(a.files.get("f:only-b.json")).toBe("b");
    expect(b.files.get("f:x.json")).toBe("x");
  });

  test("a single-host source another PC runs sends nothing and deletes nothing", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:x.json", "x");
    await a.sync();
    a.files.part = false; // as a session another PC runs
    a.files.m.clear();
    await rounds([a]);
    const b = pc(svc, "u", "b");
    await rounds([b, a, b]);
    expect(b.files.get("f:x.json")).toBe("x");
  });
});
