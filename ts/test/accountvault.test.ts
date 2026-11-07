import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSource, secretSource, SingleHost, type SingleApp } from "../accountvault.ts";
import { remotehost } from "../packages/mcp/src/index.ts";
import { generateIdentity, LEASE_TTL, Vault } from "../packages/net/src/index.ts";
import { FakeVaultService } from "../packages/net/test/fakevault.ts";
import { secrets } from "../packages/store/src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "hav-"));
let t = 1_900_000_000_000;
const clock = () => t;

describe("vault sources", () => {
  test("files: only the integrations' sign-ins, written owner-only, never outside their folder", () => {
    const root = tmp();
    mkdirSync(join(root, "gmail.accounts"), { recursive: true });
    mkdirSync(join(root, "github"), { recursive: true });
    writeFileSync(join(root, "gmail.accounts", "sam@example.com.json"), "g");
    writeFileSync(join(root, "github", "hosts.yml"), "gh");
    writeFileSync(join(root, "linear.json"), "l");
    writeFileSync(join(root, "mcp-cache.json"), "cache, not a sign-in");
    writeFileSync(join(root, "bridge-port"), "1");
    mkdirSync(join(root, "whatsapp"));
    writeFileSync(join(root, "whatsapp", "wa.db"), "x");
    const src = fileSource(() => root);
    expect((src.list() ?? []).map((i) => i.id).sort()).toEqual(["f:github/hosts.yml", "f:gmail.accounts/sam@example.com.json", "f:linear.json"]);
    src.write("f:convex/.convex/config.json", new Uint8Array(Buffer.from('{"accessToken":"c"}')));
    expect(readFileSync(join(root, "convex", ".convex", "config.json"), "utf8")).toContain("accessToken");
    for (const bad of ["f:../escape.json", "f:gmail.accounts/../../x", "f:whatsapp/wa.db", "f:/etc/x", "f:random.txt"]) src.write(bad, new Uint8Array([1]));
    expect(existsSync(join(root, "..", "escape.json"))).toBe(false);
    expect(readFileSync(join(root, "whatsapp", "wa.db"), "utf8")).toBe("x");
    expect(existsSync(join(root, "random.txt"))).toBe(false);
    src.write("f:linear.json", null);
    expect(existsSync(join(root, "linear.json"))).toBe(false);
  });

  test("saved keys: written as they came (its time too), so the next look sends nothing back", () => {
    const p = join(tmp(), "secrets.json");
    secrets.save("OPENAI_KEY", "sk-abcdef", "for the docs bot", p);
    const a = secretSource(p);
    const item = (a.list() ?? [])[0];
    expect(item?.id).toBe("s:OPENAI_KEY");
    const q = join(tmp(), "secrets.json");
    const b = secretSource(q);
    if (item) b.write(item.id, item.data);
    expect(Buffer.from((b.list() ?? [])[0]?.data ?? []).equals(Buffer.from(item?.data ?? []))).toBe(true);
    expect(secrets.load(q)[0]).toMatchObject({ name: "OPENAI_KEY", value: "sk-abcdef", description: "for the docs bot" });
    b.write("s:OPENAI_KEY", null);
    expect(secrets.load(q)).toEqual([]);
    b.write("s:not a name", new Uint8Array(Buffer.from("{}")));
    expect(secrets.load(q)).toEqual([]);
  });
});

/** A single-host integration of files only: linked.json + auth/, a host that "runs" when started. */
function fakeApp(root: string): SingleApp & { up: boolean; starts: number; calls: string[] } {
  const a = {
    name: "fakewa",
    up: false,
    starts: 0,
    calls: [] as string[],
    root: () => root,
    linkedHere: () => existsSync(join(root, "linked.json")),
    accountHere: () => (existsSync(join(root, "linked.json")) ? readFileSync(join(root, "linked.json"), "utf8") : ""),
    sessionFiles: () => ["auth/creds.json", "linked.json"].filter((f) => existsSync(join(root, f))),
    running: async () => a.up,
    stop: async () => void (a.up = false),
    wipe: (extra: boolean) => {
      rmSync(join(root, "auth"), { recursive: true, force: true });
      rmSync(join(root, "linked.json"), { force: true });
      if (extra) rmSync(join(root, "wa.db"), { force: true });
    },
    request: async (req: Record<string, unknown>) => {
      a.calls.push(String(req.op));
      return { ran: req.op, on: root };
    },
    ops: ["status", "call", "signout"],
    gapMs: 1000,
  };
  return a;
}

function link(root: string, who: string, creds: string): void {
  mkdirSync(join(root, "auth"), { recursive: true });
  writeFileSync(join(root, "auth", "creds.json"), creds);
  writeFileSync(join(root, "linked.json"), who);
}

function pc(svc: FakeVaultService, name: string) {
  const id = generateIdentity();
  const root = tmp();
  const app = fakeApp(root);
  let single: SingleHost | null = null;
  const vault = new Vault({ stateDir: tmp(), identity: () => id, clock, sources: () => single?.sources() ?? [] });
  single = new SingleHost({ vault, me: () => ({ id: `ts:${name}`, name }), dest: (pid, fp) => ({ addr: `${pid}:47930`, fp }), clock }, [app]);
  vault.afterSync.push(() => single?.tick() ?? Promise.resolve());
  vault.beforeLeave.push(() => (single as unknown as { leaving(): Promise<void> }).leaving());
  vault.afterLeave.push(() => (single as unknown as { left(): Promise<void> }).left());
  svc.signIn("sam", id.fp, name);
  return { id, root, app, vault, single, sync: async () => { t += 1000; await vault.sync("sam", svc.call("sam", id.fp)); } };
}

describe("single-host integrations", () => {
  test("one PC runs it, the others reach it there; a sign-out hands it to the next PC with the newest session", async () => {
    const svc = new FakeVaultService(clock);
    const desk = pc(svc, "desk");
    link(desk.root, "Sam (+1 555 0100)", "keys v1");
    desk.app.up = true;
    await desk.sync();
    await desk.sync(); // the lease is taken after the round that opened the vault, the session goes out on the next
    expect(desk.vault.lease("fakewa")).toMatchObject({ mine: true, valid: true, account: "Sam (+1 555 0100)" });

    const laptop = pc(svc, "laptop");
    link(laptop.root, "Sam (old link)", "stale keys"); // linked there before the vault: must not run beside the desk
    laptop.app.up = true;
    await laptop.sync();
    await desk.sync();
    await laptop.sync();
    expect(laptop.vault.isOpen()).toBe(true);
    expect(laptop.single?.mayRun("fakewa")).toBe(false);
    expect(laptop.app.up).toBe(false); // stopped: the desk runs it
    const r = remotehost.remoteOf(laptop.root, t);
    expect(r).toMatchObject({ pc: { id: "ts:desk", name: "desk", dest: { fp: desk.id.fp } }, account: "Sam (+1 555 0100)" });

    // The desk answers the laptop's tools, nobody else's, and only while it runs it.
    expect((await desk.single?.serveMesh(laptop.id.fp, { app: "fakewa", req: { op: "call", name: "send" } }))?.body).toMatchObject({ ok: true, result: { ran: "call" } });
    expect((await desk.single?.serveMesh(generateIdentity().fp, { app: "fakewa", req: { op: "call" } }))?.status).toBe(403);
    expect((await desk.single?.serveMesh(laptop.id.fp, { app: "fakewa", req: { op: "stop" } }))?.status).toBe(400);
    expect((await laptop.single?.serveMesh(desk.id.fp, { app: "fakewa", req: { op: "status" } }))?.status).toBe(409);

    // Its keys changed while it ran (WhatsApp's do with use); then Sam signs out of the desk.
    t += 5000;
    writeFileSync(join(desk.root, "auth", "creds.json"), "keys v2");
    await desk.vault.leave();
    expect(desk.app.up).toBe(false);
    expect(desk.app.linkedHere()).toBe(false); // the session left the desk with Sam
    await laptop.sync();
    expect(laptop.vault.lease("fakewa")?.mine).toBe(true);
    expect(laptop.single?.mayRun("fakewa")).toBe(true);
    expect(readFileSync(join(laptop.root, "auth", "creds.json"), "utf8")).toBe("keys v2"); // the newest, not its own stale ones
    expect(remotehost.remoteOf(laptop.root, t)).toBeUndefined();
  });

  test("a host PC that goes away: after the lease's time another takes over with the session the vault has; a new link takes it back", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "a");
    link(a.root, "Sam", "keys from a");
    await a.sync();
    await a.sync();
    const b = pc(svc, "b");
    await b.sync();
    await a.sync();
    await b.sync();
    expect(b.single?.mayRun("fakewa")).toBe(false);
    // a is switched off: no renewals.
    t += LEASE_TTL + 5000;
    await b.sync();
    expect(b.vault.lease("fakewa")?.mine).toBe(true);
    expect(readFileSync(join(b.root, "auth", "creds.json"), "utf8")).toBe("keys from a");
    // a comes back: b runs it now, so a doesn't.
    a.app.up = true;
    await a.sync();
    expect(a.app.up).toBe(false);
    expect(a.single?.mayRun("fakewa")).toBe(false);
    // Linking again on a (a new QR there) takes it back at once, and keeps it while the user scans.
    a.app.wipe(false);
    await a.single?.claimHere("fakewa");
    expect(a.single?.mayRun("fakewa")).toBe(true);
    await b.sync();
    expect(b.single?.mayRun("fakewa")).toBe(false);
    await a.sync();
    await a.sync();
    expect(a.vault.lease("fakewa")?.mine).toBe(true);
    link(a.root, "Sam", "a's new link");
    await a.sync();
    await a.sync();
    await b.sync();
    expect(existsSync(join(b.root, "vault-session.bin"))).toBe(true);
    expect(readFileSync(join(b.root, "vault-session.bin")).includes(Buffer.from("a's new link"))).toBe(true);
  });

  test("unlinking on the host signs every PC out of it", async () => {
    const svc = new FakeVaultService(clock);
    const a = pc(svc, "a");
    link(a.root, "Sam", "k");
    await a.sync();
    await a.sync();
    const b = pc(svc, "b");
    await b.sync();
    await a.sync();
    await b.sync();
    expect(existsSync(join(b.root, "vault-session.bin"))).toBe(true);
    a.app.wipe(false); // the host's signout removes its keys
    await a.sync();
    await a.sync();
    expect(a.vault.lease("fakewa")).toBeNull();
    await b.sync();
    expect(existsSync(join(b.root, "vault-session.bin"))).toBe(false);
    expect(remotehost.remoteOf(b.root, t)).toBeUndefined();
    expect(b.single?.mayRun("fakewa")).toBe(true);
  });
});
