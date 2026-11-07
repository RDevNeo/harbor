import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, type Identity } from "../src/tls.ts";
import { LEASE_TTL, Vault, type VaultLocal, type VaultSource } from "../src/vault.ts";
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
  notices: string[];
  account: string;
  sync(): Promise<void>;
}

function pc(svc: FakeVaultService, account: string, name: string, keep?: { id: Identity; dir: string; files: Mem; keys: Mem }): Pc {
  const id = keep?.id ?? generateIdentity();
  const dir = keep?.dir ?? mkdtempSync(join(tmpdir(), "hvault-"));
  if (!keep) dirs.push(dir);
  const files = keep?.files ?? new Mem("f:");
  const keys = keep?.keys ?? new Mem("s:");
  const notices: string[] = [];
  const vault = new Vault({ stateDir: dir, identity: () => id, name: () => name, sources: () => [files, keys], clock, log: process.env.VDBG ? (l) => console.log(name, l) : undefined, notice: (title, body) => notices.push(`${title}: ${body}`) });
  svc.signIn(account, id.fp, name);
  const p: Pc = { id, dir, files, keys, vault, notices, account, sync: () => vault.sync(p.account, svc.call(p.account, id.fp)) };
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
  test("a new PC of the account gets every item once another of its PCs shares the key; the service sees only ciphertext", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "user_sam", "desk");
    a.files.set("f:gmail.accounts/sam@example.com.json", '{"access_token":"ya29.SECRET-ACCESS","refresh_token":"1//SECRET-REFRESH"}');
    a.files.set("f:github/hosts.yml", "github.com:\n    oauth_token: gho_SECRETGH\n");
    a.keys.set("s:OPENAI_KEY", '{"name":"OPENAI_KEY","value":"sk-SECRETVALUE"}');
    await a.sync();
    expect(a.vault.status().state).toBe("open");
    expect(a.vault.status().code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(a.vault.status().fresh).toBe(true);
    expect(a.vault.status().items).toBe(3);

    // Sam signs in on a new laptop.
    const b = pc(svc, "user_sam", "laptop");
    await b.sync();
    expect(b.vault.status().state).toBe("locked");
    expect(b.files.m.size).toBe(0);
    await a.sync(); // the desk wraps the key for the laptop
    expect(a.notices.some((n) => n.includes("laptop"))).toBe(true);
    await b.sync();
    expect(b.vault.status().state).toBe("open");
    expect(b.files.dump()).toEqual(a.files.dump());
    expect(b.keys.dump()).toEqual(a.keys.dump());
    expect(b.vault.status().code).toBe(a.vault.status().code);
    expect(b.vault.status().fresh).toBe(false);

    // Nothing readable reached the service: no item name, no value, no recovery code.
    const stored = JSON.stringify(svc.all("user_sam"));
    for (const s of ["SECRET", "sam@example.com", "gmail", "hosts.yml", "OPENAI", "sk-", a.vault.status().code ?? "x"]) expect(stored.includes(s)).toBe(false);
    for (const r of svc.all("user_sam")) expect(r.id === "meta" || /^(i|lease):[0-9a-f]{40}$/.test(r.id) || /^(key|req):([0-9a-f]{64}|recovery)$/.test(r.id)).toBe(true);
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

  test("with every other PC off, the recovery code opens the vault on a new PC; a wrong code doesn't", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.keys.set("s:BOAT_API_KEY", "boat");
    await a.sync();
    const code = a.vault.status().code ?? "";
    const c = pc(svc, "u", "new-pc");
    await c.sync();
    expect(c.vault.status().state).toBe("locked");
    await expect(c.vault.unlock("not a code")).rejects.toThrow(/isn't a recovery code/);
    await expect(c.vault.unlock("00000-00000-00000-00000-00000")).rejects.toThrow(/doesn't open/);
    // Typed loosely: lower case, no dashes, O for 0.
    await c.vault.unlock(code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o"));
    expect(c.vault.status().state).toBe("open");
    expect(c.keys.get("s:BOAT_API_KEY")).toBe("boat");
    // It wrapped the key for itself: a restart opens without the code.
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

  test("the key goes only to the account's own PCs, asking with their own TLS key", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    await a.sync();
    const b = pc(svc, "u", "b");
    await b.sync();
    // b is removed from the account before a's round: no key for it.
    svc.devices.get("u")?.delete(b.id.fp);
    await a.sync();
    expect(svc.all("u").some((r) => r.id === `key:${b.id.fp}`)).toBe(false);
    // A request for c's fingerprint signed with another key: refused too.
    const c = pc(svc, "u", "c");
    await c.sync();
    const rows = svc.rows.get("u");
    const req = rows?.get(`req:${c.id.fp}`);
    const other = generateIdentity();
    if (req?.v) {
      const r = JSON.parse(req.v) as Record<string, string>;
      const forged = { ...r, spki: Buffer.from(other.der).toString("base64") };
      rows?.set(req.id, { ...req, v: JSON.stringify(forged), seq: req.seq + 1 });
    }
    await a.sync();
    expect(svc.all("u").some((r) => r.id === `key:${c.id.fp}`)).toBe(false);
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
    // The new key went out before the copies went: another PC has it.
    const b = pc(svc, "u", "b");
    await rounds([b]);
    const back = pc(svc, "u", "a", { id: a.id, dir: a.dir, files: a.files, keys: a.keys });
    expect(b.vault.status().state).toBe("locked"); // no PC with the key ran since b asked…
    await rounds([back]); // …a signs in again: its own wrapped key opens it at once, and it shares with b
    expect(back.vault.status().state).toBe("open");
    expect(back.keys.get("s:NEW")).toBe("made just before signing out");
    expect(back.files.get("f:gmail.accounts/x.json")).toBe("tok");
    await b.sync();
    expect(b.keys.get("s:NEW")).toBe("made just before signing out");
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

  test("a vault reset on one PC: the others join the new one with what they have", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "u", "a");
    a.files.set("f:x.json", "x");
    await a.sync();
    const b = pc(svc, "u", "b");
    await rounds([b, a, b]);
    expect(b.files.get("f:x.json")).toBe("x");
    b.files.set("f:only-b.json", "b");
    await a.vault.reset();
    const code = a.vault.status().code;
    await rounds([b, a, b, a, b]);
    expect(b.vault.status().state).toBe("open");
    expect(b.vault.status().code).toBe(code);
    expect(a.files.get("f:only-b.json")).toBe("b");
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
