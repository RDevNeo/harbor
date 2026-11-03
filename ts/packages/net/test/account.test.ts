import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedMeshPeers,
  AccountFail,
  AccountService,
  accountDecide,
  b64urlDecode,
  b64urlEncode,
  directoryPcWorkspaces,
  isHarborToken,
  verifyHarborToken,
  type AccountDir,
  type AccountDirectory,
  type AccountKey,
  type AccountOptions,
  type AccountResult,
  type AccountSettingsSync,
  type HarborClaims,
} from "../src/account.ts";
import { MemKv } from "../src/kv.ts";
import { generateIdentity } from "../src/tls.ts";

const pair = () => generateKeyPairSync("ed25519");
type Pair = ReturnType<typeof pair>;

function keyOf(kp: Pair): AccountKey[] {
  return [["k1", Buffer.from(kp.publicKey.export({ format: "jwk" }).x ?? "", "base64url")]];
}

function mint(kp: Pair, claims: unknown): string {
  const h = b64urlEncode('{"alg":"EdDSA","typ":"JWT","kid":"k1"}');
  const p = b64urlEncode(JSON.stringify(claims));
  const input = `${h}.${p}`;
  return `${input}.${b64urlEncode(sign(null, Buffer.from(input), kp.privateKey))}`;
}

function claims(now: number): Record<string, unknown> {
  return { iss: "harbor-accounts", sub: "user_1", email: "sam@example.com", name: "Sam", ws: ["org_a"], dev: "phonefp", kind: "phone", iat: now - 10, exp: now + 3600 };
}

function must<T>(r: AccountResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
}

const ws = (id: string) => ({ id, name: "", role: "member" as const, personal: false });

describe("account.rs tests", () => {
  test("tokens_verify_offline", () => {
    const kp = pair();
    const keys = keyOf(kp);
    const now = 1_800_000_000;
    const t = mint(kp, claims(now));
    expect(isHarborToken(t)).toBe(true);
    const c = must(verifyHarborToken(t, keys, now));
    expect([c.sub, c.dev, c.ws]).toEqual(["user_1", "phonefp", ["org_a"]]);
    expect(verifyHarborToken(t, keys, now + 7200).ok).toBe(false);
    expect(verifyHarborToken(t, keyOf(pair()), now).ok).toBe(false);
    // A changed payload breaks the signature.
    const parts = t.split(".");
    parts[1] = b64urlEncode(JSON.stringify({ ...claims(now), ws: ["org_b"] }));
    expect(verifyHarborToken(parts.join("."), keys, now).ok).toBe(false);
    expect(verifyHarborToken(mint(kp, { ...claims(now), iss: "someone" }), keys, now).ok).toBe(false);
    expect(verifyHarborToken("abc", keys, now).ok).toBe(false);
    expect(isHarborToken("0123abcd")).toBe(false);
  });

  test("the_directory_says_each_pcs_workspace", () => {
    const pc = (id: string) => ({ fp: "", id, name: "", addrs: [], owner: "", owner_name: "", seen: 0, version: "" });
    const dir = (id: string, pcs: ReturnType<typeof pc>[]): AccountDir => ({ ...ws(id), members: [], pcs, devices: [], invites: [] });
    const d: AccountDirectory = { at: 0, peers: [], workspaces: [dir("a", [pc("ts:desk"), pc("")]), dir("b", [pc("ts:other")])] };
    const got = directoryPcWorkspaces(d);
    expect(got.size).toBe(2);
    expect([got.get("ts:desk"), got.get("ts:other")]).toEqual(["a", "b"]);
  });

  test("workspace_and_revocation", () => {
    const now = 1_800_000_000;
    const c = parsed(claims(now));
    const empty: AccountDirectory = { at: 0, peers: [], workspaces: [] };
    expect(accountDecide(c, "", empty)).not.toBeNull();
    expect(accountDecide(c, "org_b", empty)).not.toBeNull();
    expect(accountDecide(c, "org_a", empty)).toBeNull();
    const dir: AccountDirectory = { at: (now - 100) * 1000, peers: [], workspaces: [{ ...ws("org_a"), members: [], pcs: [], devices: [], invites: [] }] };
    const only = dir.workspaces[0];
    if (!only) throw new Error("no workspace");
    expect(accountDecide(c, "org_a", dir)).toBeNull();
    dir.at = (now + 100) * 1000;
    expect(accountDecide(c, "org_a", dir)).toBe("you were removed from this PC's workspace");
    only.members.push({ id: "user_1", name: "", email: "", role: "member" });
    expect(accountDecide(c, "org_a", dir)).toBe("this device was signed out of the account");
    only.devices.push("phonefp");
    expect(accountDecide(c, "org_a", dir)).toBeNull();
  });

  test("base64url_round_trip", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(b64urlDecode(b64urlEncode(b))).toEqual(b);
    }
    expect(b64urlDecode("a b")).toBeNull();
  });
});

function parsed(c: Record<string, unknown>): HarborClaims {
  const kp = pair();
  const now = 1_800_000_000;
  return must(verifyHarborToken(mint(kp, c), keyOf(kp), now));
}

const signing = pair();
const pubX = signing.publicKey.export({ format: "jwk" }).x ?? "";
const PHONE_FP = "ab".repeat(32);
const OTHER_FP = "cd".repeat(32);

interface Call {
  method: string;
  path: string;
  auth: string | null;
  text: string;
  json: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

function get(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
}

const nowSec = () => Math.floor(Date.now() / 1000);

interface World {
  session: { workspaces: { id: string; name: string; role: string; personal: boolean }[]; pc?: unknown; invites: unknown[] };
  directory: unknown;
  invites: unknown[];
  clerkRefuse: boolean;
  directoryStatus: number;
  pcsRefusal: unknown;
  accept: unknown;
  keys: unknown;
  challenge: string;
  proofs: boolean[];
  pcFp: string;
}

function newWorld(): World {
  return {
    session: { workspaces: [{ id: "org_personal", name: "Sam's workspace", role: "owner", personal: true }], invites: [] },
    directory: { at: 0, workspaces: [] },
    invites: [],
    clerkRefuse: false,
    directoryStatus: 200,
    pcsRefusal: null,
    accept: { ok: true, workspaces: [], joined: null },
    keys: { keys: [{ alg: "EdDSA", kid: "k1", x: pubX }, { alg: "RS256", kid: "r", x: "zzz" }] },
    challenge: "",
    proofs: [],
    pcFp: "",
  };
}

function proofOk(access: string, device: unknown): string | null {
  const spki = Buffer.from(String(get(device, "spki")), "base64");
  const ts = Number(get(device, "ts"));
  const sig = Buffer.from(String(get(device, "sig")), "base64");
  const msg = `harbor-device-v1\n${ts}\n${createHash("sha256").update(access).digest("hex")}`;
  const good = get(device, "kind") === "pc" && Math.abs(ts - nowSec()) < 600 && verify("sha256", Buffer.from(msg), createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
  return good ? createHash("sha256").update(spki).digest("hex") : null;
}

function clerkHandler(w: World): (c: Call) => Reply {
  return (c) => {
    if (c.method !== "POST" || c.path !== "/oauth/token") return { status: 404, body: { error: "no" } };
    const f = new URLSearchParams(c.text);
    if (f.get("client_id") !== "test-client") return { status: 400, body: { error: "invalid_client" } };
    if (f.get("grant_type") === "authorization_code") {
      if (w.clerkRefuse) return { status: 400, body: { error: "invalid_grant", error_description: "bad code" } };
      const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
      if (f.get("code") !== "abc" || challenge !== w.challenge) return { status: 400, body: { error: "invalid_grant", error_description: "pkce" } };
      return { status: 200, body: { access_token: "clerk-access-1", refresh_token: "refresh-1", expires_in: 3600 } };
    }
    if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "refresh-1") return { status: 200, body: { access_token: "clerk-access-2", expires_in: 3600 } };
    return { status: 400, body: { error: "invalid_grant" } };
  };
}

function serviceHandler(w: World): (c: Call) => Reply {
  return (c) => {
    const key = `${c.method} ${c.path}`;
    if (key === "GET /v1/keys") return { status: 200, body: w.keys };
    if (!c.auth) return { status: 401, body: { error: "no token", signin: true } };
    if (key === "POST /v1/session") {
      if (!c.auth.startsWith("clerk-access")) return { status: 401, body: { error: "not Clerk's", signin: true } };
      const fp = proofOk(c.auth, get(c.json, "device"));
      w.proofs.push(fp !== null);
      if (fp === null) return { status: 400, body: { error: "bad device proof" } };
      w.pcFp = fp;
      const now = nowSec();
      const token = mint(signing, { iss: "harbor-accounts", sub: "user_1", email: "sam@example.com", name: "Sam", ws: w.session.workspaces.map((x) => x.id), dev: fp, kind: "pc", iat: now, exp: now + 7 * 86400 });
      return {
        status: 200,
        body: {
          account: { id: "user_1", email: "sam@example.com", name: "Sam", image: "" },
          workspaces: w.session.workspaces,
          token,
          exp: now + 7 * 86400,
          device: { fp },
          invites: w.session.invites,
          joined: [],
          ...(w.session.pc === undefined ? {} : { pc: w.session.pc }),
        },
      };
    }
    if (c.auth.startsWith("clerk-access")) return { status: 401, body: { error: "Harbor token only", signin: true } };
    if (key === "POST /v1/pcs") return w.pcsRefusal ? { status: 403, body: w.pcsRefusal } : { status: 200, body: { ok: true } };
    if (key === "GET /v1/directory") return { status: w.directoryStatus, body: withPeers(w.directory) };
    if (key === "GET /v1/invites") return { status: 200, body: { invites: w.invites } };
    if (key === "GET /v1/settings") return { status: 200, body: { settings: { theme: { v: "dark", at: 5 } }, at: 5 } };
    if (key === "PUT /v1/settings") return { status: 200, body: { settings: get(c.json, "set"), at: 6 } };
    if (/^POST \/v1\/invites\/[^/]+\/(accept|decline)$/.test(key)) return { status: 200, body: w.accept };
    if (/^POST \/v1\/workspaces\/[^/]+\/invites$/.test(key)) return get(c.json, "email") === "bad" ? { status: 400, body: { error: "That address isn't valid." } } : { status: 200, body: { ok: true } };
    if (c.method === "DELETE") return { status: 200, body: { ok: true } };
    return { status: 404, body: { error: "no such call" } };
  };
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function fake(handler: (c: Call) => Reply, calls: Call[]): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = await req.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // A form body.
      }
      const call: Call = { method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null, text, json };
      calls.push(call);
      const r = handler(call);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port ?? 0}`, stop: () => void server.stop(true) };
}

const callPaths = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path}`);

interface Rig {
  svc: AccountService;
  kv: MemKv;
  world: World;
  calls: Call[];
  clerkCalls: Call[];
  service: { url: string; stop: () => void };
  stateDir: string;
  fp: string;
  env: Record<string, string | undefined>;
  opened: string[];
  browse: (url: string) => void;
  settings: { loads: number; signedIn: number; syncs: boolean[]; fail: AccountFail | null };
  make: (over?: Partial<AccountOptions>, env?: Record<string, string | undefined>) => AccountService;
}

/** What the system browser would do: Clerk sends it back to the loopback port with a code. */
function comeBack(url: string, world: World, query?: (state: string) => string): void {
  const u = new URL(url);
  world.challenge = u.searchParams.get("code_challenge") ?? "";
  const redirect = u.searchParams.get("redirect_uri") ?? "";
  const state = u.searchParams.get("state") ?? "";
  setTimeout(() => void fetch(`${redirect}?${query ? query(state) : `code=abc&state=${state}`}`).then((r) => r.text()), 0);
}

function rig(envOver: Record<string, string | undefined> = {}): Rig {
  const world = newWorld();
  const calls: Call[] = [];
  const clerkCalls: Call[] = [];
  const clerk = fake(clerkHandler(world), clerkCalls);
  const service = fake(serviceHandler(world), calls);
  const base = mkdtempSync(join(tmpdir(), "acct-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const stateDir = join(base, "state");
  const id = generateIdentity();
  const env = { HARBOR_CLERK_URL: clerk.url, HARBOR_ACCOUNTS_URL: service.url, HARBOR_CLERK_CLIENT_ID: "test-client", HARBOR_ACCOUNTS_KEYS: `k1:${pubX}`, ...envOver };
  const kv = new MemKv();
  const opened: string[] = [];
  const settings: Rig["settings"] = { loads: 0, signedIn: 0, syncs: [], fail: null };
  const stub: AccountSettingsSync = {
    load: () => void settings.loads++,
    signedIn: () => void settings.signedIn++,
    sync: async (_t, pull) => {
      settings.syncs.push(pull);
      if (settings.fail) throw settings.fail;
    },
  };
  const make: Rig["make"] = (over = {}, e = {}) =>
    new AccountService({
      kv,
      stateDir,
      identity: () => id,
      me: () => ({ id: "ts:desk", name: "Desk" }),
      addrs: () => ["10.0.0.9:47930"],
      version: "9.9.9",
      hostname: () => "test-pc",
      env: { ...env, ...e },
      open: (url) => {
        opened.push(url);
        r.browse(url);
      },
      settings: stub,
      loopMs: 20,
      syncPauseMs: 1,
      ...over,
    });
  const r: Rig = {
    svc: make(),
    kv,
    world,
    calls,
    clerkCalls,
    service,
    stateDir,
    fp: id.fp,
    env,
    opened,
    browse: (url) => comeBack(url, world),
    settings,
    make,
  };
  cleanups.push(() => r.svc.stop());
  return r;
}

async function until(f: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function signedIn(r: Rig): Promise<void> {
  await r.svc.signIn();
  expect(r.svc.status().error).toBe("");
  expect(r.svc.signedIn()).toBe(true);
  r.calls.length = 0;
  r.clerkCalls.length = 0;
}

/** As the service answers: without `peers` given, the PCs of the directory's workspaces (their owners share them). */
function withPeers(d: unknown): unknown {
  if (typeof d !== "object" || d === null || "peers" in d || !Array.isArray((d as { workspaces?: unknown }).workspaces)) return d;
  const ws = (d as { workspaces: { name?: string; pcs?: unknown[] }[] }).workspaces;
  return { ...d, peers: ws.flatMap((w) => (Array.isArray(w.pcs) ? w.pcs : []).map((p) => ({ ...(p as object), via: [w.name ?? ""] }))) };
}

function workspaceDir(r: Rig, over: Partial<AccountDir> = {}): AccountDir {
  const d: AccountDir = {
    id: "org_personal",
    name: "Sam's workspace",
    role: "owner",
    personal: true,
    members: [{ id: "user_1", name: "Sam", email: "sam@example.com", role: "owner" }],
    pcs: [
      { fp: r.fp, id: "ts:desk", name: "Desk", addrs: ["10.0.0.1:47930"], owner: "user_1", owner_name: "Sam", seen: 5, version: "9.9.9" },
      { fp: OTHER_FP, id: "ts:laptop", name: "Laptop", addrs: ["10.0.0.2:47930"], owner: "user_1", owner_name: "Sam", seen: 6, version: "9.9.9" },
    ],
    devices: [PHONE_FP, r.fp, OTHER_FP],
    invites: [],
  };
  return { ...d, ...over };
}

function secrets(r: Rig): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(join(r.stateDir, "account.json"), "utf8"));
  return v as Record<string, unknown>;
}

describe("sign-in through Clerk", () => {
  test("signs in with PKCE on the loopback, proves the device key and registers the PC", async () => {
    const r = rig();
    await r.svc.signIn();
    expect(r.svc.status()).toMatchObject({ signingIn: false, error: "", expired: false, url: "", pick: false });
    const url = new URL(r.opened[0] ?? "");
    expect(url.origin + url.pathname).toBe(`${new URL(r.env.HARBOR_CLERK_URL ?? "").origin}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "test-client",
      scope: "openid profile email offline_access",
      code_challenge_method: "S256",
      prompt: "login",
    });
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(r.world.proofs).toEqual([true]);
    expect(r.world.pcFp).toBe(r.fp);
    expect(callPaths(r.calls)).toEqual(["POST /v1/session", "POST /v1/pcs"]);
    expect(r.calls[0]?.auth).toBe("clerk-access-1");
    expect(get(r.calls[0]?.json, "app")).toBe("9.9.9");
    expect(get(get(r.calls[0]?.json, "device"), "name")).toBe("test-pc");
    expect(r.calls[1]?.auth).toBe(String(secrets(r).token));
    expect(r.calls[1]?.json).toEqual({ ws: "org_personal", id: "ts:desk", name: "Desk", addrs: ["10.0.0.9:47930"], version: "9.9.9" });
    expect(r.calls[1]?.text).toBe(`{"addrs":["10.0.0.9:47930"],"id":"ts:desk","name":"Desk","version":"9.9.9","ws":"org_personal"}`);
    expect(Object.keys(get(r.calls[0]?.json, "device") as object)).toEqual(["kind", "name", "sig", "spki", "ts"]);

    expect(r.svc.account()?.email).toBe("sam@example.com");
    expect(r.svc.workspace()).toBe("org_personal");
    expect(r.svc.ownerName()).toBe("Sam");
    expect(r.kv.get("account_ws")).toBe("org_personal");
    expect(r.kv.get("account")).toBe('{"id":"user_1","email":"sam@example.com","name":"Sam","image":"","workspaces":[{"id":"org_personal","name":"Sam\'s workspace","role":"owner","personal":true}]}');
    expect(r.settings.signedIn).toBe(1);
    expect(r.svc.takeEnable()).toBe(true);
    expect(r.svc.takeEnable()).toBe(false);

    const file = join(r.stateDir, "account.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(r.stateDir).mode & 0o777).toBe(0o700);
    expect(Object.keys(secrets(r))).toEqual(["access", "refresh", "access_exp", "token", "token_exp", "token_at"]);
    expect(secrets(r)).toMatchObject({ access: "clerk-access-1", refresh: "refresh-1" });
    expect(r.kv.get("account")).not.toContain("clerk-access");
  });

  test("the callback page says what happened and escapes the error", async () => {
    const r = rig();
    let page = "";
    r.browse = (url) => {
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri") ?? "";
      setTimeout(() => void fetch(`${redirect}?state=wrong&error_description=${encodeURIComponent("<b>no</b>")}`).then(async (res) => void (page = await res.text())), 0);
    };
    await r.svc.signIn();
    expect(r.svc.status().error).toBe("Sign-in failed: <b>no</b>");
    await until(() => page !== "", "the page");
    expect(page).toContain("Sign-in didn&#39;t finish".replace("&#39;", "'"));
    expect(page).toContain("&lt;b&gt;no&lt;/b&gt;. Go back to Harbor and try again.");
    expect(r.svc.signedIn()).toBe(false);
    expect(existsSync(join(r.stateDir, "account.json"))).toBe(false);
  });

  test("a state that does not match fails the sign-in", async () => {
    const r = rig();
    r.browse = (url) => comeBack(url, r.world, () => "code=abc&state=forged");
    await r.svc.signIn();
    expect(r.svc.status().error).toBe("Sign-in failed: state mismatch");
    expect(r.clerkCalls).toEqual([]);
  });

  test("a stray request on another path or without a query is not the callback", async () => {
    const r = rig();
    r.browse = (url) => {
      const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
      const origin = new URL(redirect).origin;
      setTimeout(() => {
        void fetch(`${origin}/callback`).then((res) => expect(res.status).toBe(404));
        void fetch(`${origin}/favicon.ico?x=1`).catch(() => {});
        setTimeout(() => comeBack(url, r.world), 30);
      }, 0);
    };
    await signedIn(r);
  });

  test("cancelling stops the wait", async () => {
    const r = rig();
    r.browse = () => setTimeout(() => r.svc.cancelSignIn(), 5);
    await r.svc.signIn();
    expect(r.svc.status()).toMatchObject({ signingIn: false, error: "Sign-in was cancelled." });
    expect(r.svc.signedIn()).toBe(false);
  });

  test("no browser answer in time times out", async () => {
    const r = rig();
    r.svc = r.make({ signInTimeoutMs: 30 });
    r.browse = () => {};
    await r.svc.signIn();
    expect(r.svc.status().error).toBe("Sign-in timed out.");
  });

  test("Clerk refusing the code is told with its words", async () => {
    const r = rig();
    r.world.clerkRefuse = true;
    await r.svc.signIn();
    expect(r.svc.status().error).toBe("Clerk refused the sign-in: bad code");
    expect(r.calls).toEqual([]);
  });

  test("a PC in someone else's workspace gets nothing (Option A)", async () => {
    const r = rig();
    r.world.session.pc = { ws: "org_theirs", ws_name: "Their space", owner: "Alex", member: false };
    await r.svc.signIn();
    expect(r.svc.status().error).toBe("This PC belongs to “Their space” (Alex). Signing in here gives you nothing without an invite: ask its owner to invite sam@example.com, then sign in again.");
    expect(r.svc.signedIn()).toBe(false);
    expect(existsSync(join(r.stateDir, "account.json"))).toBe(false);
    expect(r.kv.get("account")).toBeNull();
    expect(callPaths(r.calls)).toEqual(["POST /v1/session"]);
  });

  test("several workspaces and none chosen: the user picks", async () => {
    const r = rig();
    r.world.session.workspaces = [
      { id: "org_a", name: "A", role: "owner", personal: true },
      { id: "org_b", name: "B", role: "member", personal: false },
    ];
    await signedIn(r);
    expect(r.svc.workspace()).toBe("");
    expect(r.svc.status().pick).toBe(true);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r, { id: "org_a" }), workspaceDir(r, { id: "org_b" })] };
    await r.svc.chooseWorkspace("org_b");
    expect(r.svc.workspace()).toBe("org_b");
    expect(r.svc.status()).toMatchObject({ pick: false, error: "", busy: false });
    expect(r.kv.get("account_ws")).toBe("org_b");
    expect(get(r.calls.find((c) => c.path === "/v1/pcs")?.json, "ws")).toBe("org_b");
  });

  test("a PC already in one of the account's workspaces stays in it", async () => {
    const r = rig();
    r.world.session.workspaces = [
      { id: "org_a", name: "A", role: "owner", personal: true },
      { id: "org_b", name: "B", role: "member", personal: false },
    ];
    r.world.session.pc = { ws: "org_b", ws_name: "B", owner: "Sam", member: true };
    await signedIn(r);
    expect(r.svc.workspace()).toBe("org_b");
    expect(r.svc.status().pick).toBe(false);
  });

  test("signing in again keeps the PC's workspace when the account is still in it", async () => {
    const r = rig();
    r.world.session.workspaces = [
      { id: "org_a", name: "A", role: "owner", personal: true },
      { id: "org_b", name: "B", role: "member", personal: false },
    ];
    r.kv.set("account_ws", "org_b");
    r.svc.load();
    await signedIn(r);
    expect(r.svc.workspace()).toBe("org_b");
  });

  test("a registration refused for someone else's workspace says so", async () => {
    const r = rig();
    r.world.pcsRefusal = { error: "This PC belongs to another workspace.", ws: "org_x", ws_name: "X", owner: "Alex" };
    await r.svc.signInFlow();
    expect(r.svc.status().error).toBe("This PC belongs to another workspace.");
    expect(r.svc.signedIn()).toBe(true);
  });

  test("a sign-in already waiting is left alone", async () => {
    const r = rig();
    const first = r.svc.signIn();
    await r.svc.signIn();
    await first;
    expect(r.opened.length).toBe(1);
    expect(r.svc.signedIn()).toBe(true);
  });

  test("signing out keeps the PC in its workspace and its cache", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: 1, workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    r.svc.signOut();
    expect(r.svc.signedIn()).toBe(false);
    expect(r.svc.ownerName()).toBeNull();
    expect(r.svc.workspace()).toBe("org_personal");
    expect(r.kv.get("account")).toBe("");
    expect(r.kv.get("account_ws")).toBe("org_personal");
    expect(existsSync(join(r.stateDir, "account.json"))).toBe(false);
    expect(r.svc.meshPeers().map((p) => p.fp)).toEqual([OTHER_FP]);
    expect(r.svc.invites()).toEqual([]);
    const before = r.calls.length;
    await r.svc.tick(true);
    expect(r.calls.length).toBe(before);
  });

  test("the sign-in gate", () => {
    const r = rig();
    expect(r.svc.gate()).toBe(true);
    expect(r.make({}, { HARBOR_TEST_NO_SIGNIN: "1" }).gate()).toBe(false);
    expect(r.make({}, { HARBOR_CLERK_URL: "https://clerk.harbor.example" }).configured()).toBe(false);
    expect(r.make({}, { HARBOR_ACCOUNTS_URL: "https://accounts.harbor.example/" }).configured()).toBe(false);
    expect(r.make({}, { HARBOR_ACCOUNTS_URL: " http://x.test/// " }).serviceUrl()).toBe("http://x.test");
  });
});

describe("the account loop", () => {
  test("registers the PC, fetches the directory and the invitations, and caches the directory", async () => {
    const r = rig();
    await signedIn(r);
    const dir: AccountDirectory = { at: Date.now(), workspaces: [workspaceDir(r)], peers: [] };
    r.world.directory = dir;
    r.world.invites = [{ id: "inv_1", ws: "org_x", ws_name: "X", inviter_name: "Pat", email: "sam@example.com", at: 7 }];
    await r.svc.tick(true);
    expect(callPaths(r.calls)).toEqual(["POST /v1/pcs", "GET /v1/directory", "GET /v1/invites"]);
    expect(r.kv.get("account_dir")).toBe(JSON.stringify(dir));
    expect(r.svc.directory()).toEqual(dir);
    expect(r.svc.myDir()?.name).toBe("Sam's workspace");
    expect(r.svc.status()).toMatchObject({ offlineSince: 0, expired: false });
    expect(r.svc.status().syncedAt).toBeGreaterThan(0);
    expect(r.svc.invites().map((i) => i.id)).toEqual(["inv_1"]);
    expect(r.settings.syncs).toEqual([true]);
    await r.svc.tick();
    expect(r.settings.syncs).toEqual([true, false]);
    expect(callPaths(r.calls).length).toBe(3);
  });

  test("the workspace's other PCs become allowed entries; known devices are its keys", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    expect(r.svc.meshPeers()).toEqual([{ node: "", name: "Laptop", fp: OTHER_FP, id: "ts:laptop", addrs: ["10.0.0.2:47930"] }]);
    expect(r.svc.knownDevice(PHONE_FP)).toBe(true);
    expect(r.svc.knownDevice(OTHER_FP)).toBe(true);
    expect(r.svc.knownDevice("ee".repeat(32))).toBe(false);
  });

  test("trust is the directory's peers alone: a co-member's PC elsewhere is in, a PC it doesn't list is out", async () => {
    const r = rig();
    await signedIn(r);
    const far = "ef".repeat(32);
    const peer = { fp: far, id: "ts:far", name: "Far", addrs: ["10.0.0.9:47930"], owner: "user_2", owner_name: "Pat", seen: 1, version: "9.9.9", via: ["Sam's workspace"] };
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)], peers: [peer] };
    await r.svc.tick(true);
    expect(r.svc.meshPeers()).toEqual([{ node: "", name: "Far", fp: far, id: "ts:far", addrs: ["10.0.0.9:47930"] }]);
    expect(r.svc.knownDevice(far)).toBe(true);
    expect(cachedMeshPeers(r.kv, r.fp).map((p) => p.fp)).toEqual([far]);
    r.world.directory = { at: Date.now() + 1000, workspaces: [workspaceDir(r)], peers: [] };
    await r.svc.tick(true);
    expect(r.svc.meshPeers()).toEqual([]);
  });

  test("phones are admitted by their token, the workspace and the cached directory", async () => {
    const r = rig();
    await signedIn(r);
    const now = nowSec();
    const phone = (over: Record<string, unknown> = {}) => mint(signing, { ...claims(now), ws: ["org_personal"], dev: PHONE_FP, iat: now - 5, exp: now + 600, ...over });
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    expect(must(r.svc.admit(phone(), PHONE_FP)).sub).toBe("user_1");
    expect(r.svc.admit(phone(), OTHER_FP)).toEqual({ ok: false, error: "this sign-in belongs to another device" });
    expect(r.svc.admit(phone({ kind: "pc" }), PHONE_FP)).toEqual({ ok: false, error: "not a phone's sign-in" });
    expect(r.svc.admit(phone({ ws: ["org_other"] }), PHONE_FP).ok).toBe(false);
    expect(r.svc.admit(phone({ exp: now - 1 }), PHONE_FP).ok).toBe(false);
    expect(r.svc.admit(mint(pair(), claims(now)), "phonefp")).toEqual({ ok: false, error: "the account service didn't sign this token" });
    // The phone was signed out after its token was made.
    r.world.directory = { at: Date.now() + 5000, workspaces: [workspaceDir(r, { devices: [r.fp] })] };
    await r.svc.tick(true);
    expect(r.svc.admit(phone(), PHONE_FP)).toEqual({ ok: false, error: "this device was signed out of the account" });
    // Removed from the workspace.
    r.world.directory = { at: Date.now() + 6000, workspaces: [workspaceDir(r, { members: [] })] };
    await r.svc.tick(true);
    expect(r.svc.admit(phone(), PHONE_FP)).toEqual({ ok: false, error: "you were removed from this PC's workspace" });
  });

  test("phoneAuth gives api.ts the token check, a throwing admit and the known keys", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    const auth = r.svc.phoneAuth();
    const now = nowSec();
    const t = mint(signing, { ...claims(now), ws: ["org_personal"], dev: PHONE_FP, iat: now - 5, exp: now + 600 });
    expect(auth.isToken(t)).toBe(true);
    expect(auth.isToken("0123abcd")).toBe(false);
    expect(auth.admit(t, PHONE_FP).sub).toBe("user_1");
    expect(() => auth.admit(t, OTHER_FP)).toThrow("this sign-in belongs to another device");
    expect(auth.knownDevice(PHONE_FP)).toBe(true);
    expect(auth.knownDevice("ee".repeat(32))).toBe(false);
  });

  test("a PC in no workspace admits nobody", () => {
    const r = rig();
    const now = nowSec();
    const t = mint(signing, { ...claims(now), dev: PHONE_FP });
    expect(r.svc.admit(t, PHONE_FP)).toEqual({ ok: false, error: "this PC isn't in a workspace: sign in on it first" });
  });

  test("HARBOR_ACCOUNTS_KEYS lists the trusted keys; a key of the wrong size is left out", () => {
    const r = rig();
    const svc = r.make({}, { HARBOR_ACCOUNTS_KEYS: `k1:${pubX}, bad:AAAA ,nocolon, k2:${pubX}` });
    expect(svc.keys().map(([k]) => k)).toEqual(["k1", "k2"]);
    expect(r.make({}, { HARBOR_ACCOUNTS_KEYS: "" }).keys()).toEqual([]);
    expect(r.make({}, { HARBOR_ACCOUNTS_KEYS: undefined }).keys().map(([k]) => k)).toEqual(["k1"]);
  });

  test("a build without shipped keys fetches the service's, keeps them in kv and uses them", async () => {
    const r = rig({ HARBOR_ACCOUNTS_KEYS: undefined });
    r.kv.set("account_ws", "org_personal");
    const svc = r.make({ keys: [] });
    svc.load();
    const now = nowSec();
    const t = mint(signing, { ...claims(now), ws: ["org_personal"], dev: PHONE_FP });
    expect(svc.admit(t, PHONE_FP).ok).toBe(false);
    await svc.tick();
    expect(callPaths(r.calls)).toEqual(["GET /v1/keys"]);
    expect(r.kv.get("account_keys")).toBe(JSON.stringify([["k1", pubX]]));
    expect(must(svc.admit(t, PHONE_FP)).sub).toBe("user_1");
    const again = r.make({ keys: [] });
    again.load();
    expect(must(again.admit(t, PHONE_FP)).sub).toBe("user_1");
  });

  test("a new Harbor token is asked for once a day, refreshing Clerk's access token", async () => {
    const r = rig();
    await signedIn(r);
    const old = secrets(r);
    writeFileSync(join(r.stateDir, "account.json"), JSON.stringify({ ...old, access_exp: 0, token_at: nowSec() - 90_000 }));
    await r.svc.tick(true);
    expect(r.clerkCalls.length).toBe(1);
    expect(new URLSearchParams(r.clerkCalls[0]?.text).get("grant_type")).toBe("refresh_token");
    expect(callPaths(r.calls)[0]).toBe("POST /v1/session");
    expect(r.calls[0]?.auth).toBe("clerk-access-2");
    expect(secrets(r)).toMatchObject({ access: "clerk-access-2", refresh: "refresh-1" });
    expect(secrets(r).token_at).toBeGreaterThan(nowSec() - 5);
  });

  test("a session Clerk ended is marked expired, and nothing else stops", async () => {
    const r = rig();
    await signedIn(r);
    writeFileSync(join(r.stateDir, "account.json"), JSON.stringify({ ...secrets(r), refresh: "revoked", access_exp: 0, token_at: nowSec() - 90_000 }));
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    expect(r.svc.status().expired).toBe(true);
    expect(r.svc.signedIn()).toBe(true);
    expect(callPaths(r.calls)).toContain("GET /v1/directory");
    expect(r.svc.meshPeers().length).toBe(1);
  });

  test("with no refresh token the sign-in is expired", async () => {
    const r = rig();
    await signedIn(r);
    writeFileSync(join(r.stateDir, "account.json"), JSON.stringify({ ...secrets(r), refresh: "", access_exp: 0, token_at: 1 }));
    await r.svc.tick(true);
    expect(r.svc.status().expired).toBe(true);
  });

  test("the service not answering is remembered since when, and clears when it answers", async () => {
    const r = rig();
    r.svc = r.make({ settings: undefined });
    await signedIn(r);
    r.world.directoryStatus = 503;
    await r.svc.tick(true);
    const since = r.svc.status().offlineSince;
    expect(since).toBeGreaterThan(0);
    await r.svc.tick(true);
    expect(r.svc.status().offlineSince).toBe(since);
    r.world.directoryStatus = 200;
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    expect(r.svc.status().offlineSince).toBe(0);
  });

  test("a service that is gone is offline, not an error", async () => {
    const r = rig();
    r.svc = r.make({ settings: undefined });
    await signedIn(r);
    r.service.stop();
    await r.svc.tick(true);
    expect(r.svc.status().offlineSince).toBeGreaterThan(0);
    expect(r.svc.status().error).toBe("");
    expect(r.svc.signedIn()).toBe(true);
  });

  test("a 401 from the service asks for a new Harbor token at the next turn", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directoryStatus = 401;
    await r.svc.tick(true);
    expect(callPaths(r.calls)).not.toContain("POST /v1/session");
    await r.svc.tick();
    expect(callPaths(r.calls)).toContain("POST /v1/session");
  });

  test("an odd directory is not cached", async () => {
    const r = rig();
    r.svc = r.make({ settings: undefined });
    await signedIn(r);
    r.world.directory = { at: "yesterday", workspaces: [] };
    await r.svc.tick(true);
    expect(r.kv.get("account_dir")).toBe("");
    expect(r.svc.status().offlineSince).toBeGreaterThan(0);
  });

  test("a workspace the directory no longer lists takes the PC out of it", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [] };
    await r.svc.tick(true);
    expect(r.svc.workspace()).toBe("");
    expect(r.kv.get("account_ws")).toBe("");
    expect(r.svc.account()?.workspaces).toEqual([]);
    await r.svc.tick();
    expect(callPaths(r.calls)).toContain("POST /v1/session");
  });

  test("joining a workspace elsewhere updates the account and renews the token", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r), workspaceDir(r, { id: "org_team", name: "Team", role: "member", personal: false })] };
    await r.svc.tick(true);
    expect(r.svc.workspaces().map((w) => w.id)).toEqual(["org_personal", "org_team"]);
    expect(JSON.parse(r.kv.get("account") ?? "").workspaces.length).toBe(2);
    r.world.session.workspaces = r.svc.workspaces();
    await r.svc.tick();
    expect(callPaths(r.calls)).toContain("POST /v1/session");
  });

  test("the loop follows the account in kv when a terminal signs in", async () => {
    const r = rig();
    await signedIn(r);
    const other = r.make();
    other.load();
    expect(other.signedIn()).toBe(true);
    r.kv.set("account", "");
    await other.tick();
    expect(other.signedIn()).toBe(false);
    r.kv.set("account", JSON.stringify(r.svc.account()));
    r.kv.set("account_ws", "org_other");
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r, { id: "org_other" })] };
    await other.tick();
    expect(other.signedIn()).toBe(true);
    expect(other.workspace()).toBe("org_other");
    expect(other.takeEnable()).toBe(true);
    expect(r.settings.loads).toBeGreaterThan(1);
  });

  test("the settings sync failing offline marks the service as down", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    r.settings.fail = AccountFail.offline("timeout");
    await r.svc.tick(true);
    expect(r.svc.status().offlineSince).toBeGreaterThan(0);
  });

  test("settings calls go to /v1/settings with the Harbor token", async () => {
    const r = rig();
    await signedIn(r);
    const token = String(secrets(r).token);
    expect(await r.svc.settingsCall(token)).toEqual({ settings: { theme: { v: "dark", at: 5 } }, at: 5 });
    expect(await r.svc.settingsCall(token, { set: { theme: { v: "light", at: 9 } } })).toEqual({ settings: { theme: { v: "light", at: 9 } }, at: 6 });
    expect(callPaths(r.calls)).toEqual(["GET /v1/settings", "PUT /v1/settings"]);
    expect(r.calls[1]?.auth).toBe(token);
    await expect(r.svc.settingsCall("clerk-access-9")).rejects.toBeInstanceOf(AccountFail);
  });

  test("start loads the cache and runs the loop until stopped; a poke runs everything now", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    const loop = r.make();
    loop.start();
    loop.start();
    expect(loop.signedIn()).toBe(true);
    await until(() => callPaths(r.calls).includes("GET /v1/directory"), "the first directory");
    const dirs = () => callPaths(r.calls).filter((c) => c === "GET /v1/directory").length;
    expect(dirs()).toBe(1);
    loop.poke();
    await until(() => dirs() === 2, "the poked directory");
    loop.pokeSync();
    await until(() => r.settings.syncs.length >= 3, "a settings turn");
    await loop.stop();
    const n = r.calls.length;
    await new Promise((res) => setTimeout(res, 60));
    expect(r.calls.length).toBe(n);
  });
});

describe("actions from Settings", () => {
  async function ready(): Promise<Rig> {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    return r;
  }

  test("inviting posts the address, tells it once and fetches the directory again", async () => {
    const r = await ready();
    await r.svc.invite("org_personal", " pat@example.com ");
    expect(callPaths(r.calls)).toEqual(["POST /v1/workspaces/org_personal/invites", "GET /v1/directory", "GET /v1/invites"]);
    expect(r.calls[0]?.json).toEqual({ email: "pat@example.com" });
    expect(r.svc.takeNotice()).toBe("Invited pat@example.com: they'll see it in Harbor when they sign in with that Google account.");
    expect(r.svc.takeNotice()).toBeNull();
    expect(r.svc.status()).toMatchObject({ busy: false, error: "" });
  });

  test("a refusal shows the service's sentence", async () => {
    const r = await ready();
    await r.svc.invite("org_personal", "bad");
    expect(r.svc.status().error).toBe("That address isn't valid.");
    expect(r.svc.status().expired).toBe(false);
  });

  test("without a Harbor token the sign-in is expired", async () => {
    const r = rig();
    await r.svc.invite("org_personal", "pat@example.com");
    expect(r.svc.status().expired).toBe(true);
    expect(r.calls).toEqual([]);
  });

  test("accepting joins, drops the invitation, tells it and renews the token", async () => {
    const r = await ready();
    r.world.invites = [{ id: "inv_1", ws: "org_x", ws_name: "Team", inviter_name: "Pat", email: "sam@example.com", at: 1 }];
    await r.svc.tick(true);
    expect(r.svc.invites().length).toBe(1);
    r.world.invites = [];
    r.world.accept = { ok: true, workspaces: [], joined: { id: "org_x", name: "Team", role: "member", personal: false } };
    r.calls.length = 0;
    await r.svc.acceptInvite("inv_1");
    expect(r.calls[0]).toMatchObject({ method: "POST", path: "/v1/invites/inv_1/accept" });
    expect(r.svc.invites()).toEqual([]);
    expect(r.svc.takeNotice()).toBe("You joined Team. Its PCs and chats reach you on your phone; to move this PC there, use Settings › Account.");
    await r.svc.tick();
    expect(callPaths(r.calls)).toContain("POST /v1/session");
  });

  test("declining says nothing", async () => {
    const r = await ready();
    await r.svc.declineInvite("inv_9");
    expect(r.calls[0]).toMatchObject({ method: "POST", path: "/v1/invites/inv_9/decline" });
    expect(r.svc.takeNotice()).toBeNull();
  });

  test("cancelling an invitation, removing a member and signing a device out", async () => {
    const r = await ready();
    await r.svc.cancelInvite("org_personal", "inv_2");
    await r.svc.removeMember("org_personal", "user_2");
    await r.svc.removeDevice(PHONE_FP);
    const deletes = r.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/v1/workspaces/org_personal/invites/inv_2", "/v1/workspaces/org_personal/members/user_2", `/v1/devices/${PHONE_FP}`]);
    await r.svc.tick();
    expect(callPaths(r.calls)).toContain("POST /v1/session");
  });
});

describe("cache and command line", () => {
  test("load reads who is signed in, the workspace, the directory and whether to pick", () => {
    const r = rig();
    const user = { id: "user_1", email: "e", name: "N", image: "", workspaces: [ws("a"), ws("b")] };
    r.kv.set("account", JSON.stringify(user));
    r.kv.set("account_dir", JSON.stringify({ at: 3, workspaces: [workspaceDir(r)] }));
    r.svc.load();
    expect(r.svc.account()?.id).toBe("user_1");
    expect(r.svc.workspace()).toBe("");
    expect(r.svc.status().pick).toBe(true);
    expect(r.svc.directory().at).toBe(3);
    expect(r.settings.loads).toBe(1);
    r.kv.set("account", "{not json");
    r.svc.load();
    expect(r.svc.signedIn()).toBe(false);
    r.kv.set("account", JSON.stringify({ ...user, id: "" }));
    r.svc.load();
    expect(r.svc.signedIn()).toBe(false);
  });

  test("account status prints the service, the account, the workspace and its PCs", async () => {
    const r = rig();
    await signedIn(r);
    r.world.directory = { at: Date.now(), workspaces: [workspaceDir(r)] };
    await r.svc.tick(true);
    const out: string[] = [];
    const err: string[] = [];
    const code = await r.make().cli([], { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      `service:   ${r.service.url}`,
      "account:   Sam <sam@example.com> (user_1)",
      "workspace: Sam's workspace (org_personal)",
      "members:   Sam <sam@example.com> owner",
      `pc:        Desk ${r.fp.slice(0, 4)} ${r.fp.slice(4, 8)} ${r.fp.slice(8, 12)} ${r.fp.slice(12, 16)} 10.0.0.1:47930`,
      `pc:        Laptop ${OTHER_FP.slice(0, 4)} ${OTHER_FP.slice(4, 8)} ${OTHER_FP.slice(8, 12)} ${OTHER_FP.slice(12, 16)} 10.0.0.2:47930`,
      "devices:   3",
      `this pc:   ${r.fp}`,
    ]);
  });

  test("account status when nobody is signed in", async () => {
    const r = rig();
    const out: string[] = [];
    await r.svc.cli(["status"], { out: (l) => out.push(l), err: () => {} });
    expect(out.slice(1)).toEqual(["account:   not signed in", "workspace: none", `this pc:   ${r.fp}`]);
  });

  test("account login signs in from the terminal, logout keeps the workspace, anything else is usage", async () => {
    const r = rig();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await r.svc.cli(["login"], io)).toBe(0);
    expect(out).toContain("Signed in as Sam <sam@example.com>.");
    expect(r.svc.signedIn()).toBe(true);
    expect(await r.svc.cli(["logout"], io)).toBe(0);
    expect(out.at(-1)).toBe("Signed out. This PC stays in its workspace.");
    expect(r.kv.get("account_ws")).toBe("org_personal");
    expect(await r.svc.cli(["bogus"], io)).toBe(2);
    expect(err.at(-1)).toBe("usage: harbor account [status|login|logout]\nOr sign in and out in Harbor › Settings › Account.");
    r.world.clerkRefuse = true;
    expect(await r.svc.cli(["login"], io)).toBe(1);
    expect(err.at(-1)).toBe("harbor: Clerk refused the sign-in: bad code");
  });

  test("the failure texts", () => {
    expect(AccountFail.expired().text()).toBe("Your sign-in ran out: sign in again.");
    expect(AccountFail.refused("No.").text()).toBe("No.");
    expect(AccountFail.offline("HTTP 503").text()).toBe("The account service didn't answer (HTTP 503).");
  });
});
