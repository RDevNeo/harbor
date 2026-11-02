import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountFile,
  accountsIn,
  applyToken,
  blankCred,
  claudeServers,
  codexArgs,
  dec,
  endpoints,
  googleAuthUrl,
  googleSaveCode,
  integrate,
  isCode,
  listenCallback,
  localFor,
  migrateIn,
  missingScopes,
  ownClient,
  parseGoogleClient,
  phoneRedirectOk,
  pickClient,
  resetLocalsCache,
  sha256,
  signIn,
  writePrivate,
} from "../src/mcp.ts";
import * as mcp from "../src/mcp.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
let root: string;
const saved = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hmcp-"));
  process.env.HOME = root;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_RUNTIME_DIR = root;
  process.env.HARBOR_SOCK = join(root, "none.sock");
  delete process.env.CODEX_HOME;
  delete process.env.HARBOR_GOOGLE_CLIENT_ID;
  delete process.env.HARBOR_GOOGLE_CLIENT_SECRET;
  resetLocalsCache();
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

test("dec_survives_non_ascii_after_percent: dec survives non-ascii after percent", () => {
  expect(dec("%1\u{e9}")).toBe("%1\u{e9}");
  expect(dec("%\u{e9}")).toBe("%\u{e9}");
  expect(dec("a%41+b%2")).toBe("aA b%2");
  expect(dec("%C3%A9")).toBe("\u{e9}");
});

test("sha256_matches_known_vectors: sha256 matches known vectors", () => {
  expect(hex(sha256(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(hex(sha256("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hex(sha256(new Uint8Array(1000).fill(0x61)))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
});

test("google_client_from_fields_or_json: google client from fields or json", () => {
  const id = "123-abc.apps.googleusercontent.com";
  expect(parseGoogleClient(` ${id} `, " s3cret ")).toEqual({ id, secret: "s3cret" });
  expect(parseGoogleClient(id, "")).toBeUndefined();
  expect(parseGoogleClient("not-a-client", "s")).toBeUndefined();
  const file = `{"installed":{"client_id":"${id}","client_secret":"from-file","redirect_uris":["http://localhost"]}}`;
  expect(parseGoogleClient(file, "")).toEqual({ id, secret: "from-file" });
});

test("google_client_choice: google client choice", () => {
  const builtin = { id: "harbor.apps.googleusercontent.com", secret: "harbor-secret" };
  const own = { id: "mine.apps.googleusercontent.com", secret: "my-secret" };
  const none = { id: "", secret: "" };
  expect(pickClient(own, builtin)).toEqual(own);
  expect(pickClient(none, builtin)).toEqual(builtin);
  expect(pickClient(own, undefined)).toEqual(own);
  expect(pickClient(none, undefined)).toBeUndefined();
  expect(ownClient(builtin, builtin)).toEqual(none);
  expect(ownClient(own, builtin)).toEqual(own);
  expect(ownClient(own, undefined)).toEqual(own);
});

test("google_accounts_migrate_and_order: google accounts migrate and order", () => {
  const base = join(root, "base");
  mkdirSync(base);
  const old = join(base, "gmail.json");
  const builtin = { id: "harbor.apps.googleusercontent.com", secret: "s" };
  const c = blankCred({ access_token: "a1", refresh_token: "r1", client_id: builtin.id, account: "Ana@Example.com" });
  writePrivate(old, JSON.stringify(c));
  migrateIn(base, "gmail", builtin);
  expect(existsSync(old)).toBe(false);
  const moved = accountsIn(base, "gmail");
  expect(moved).toHaveLength(1);
  expect([moved[0]?.account, moved[0]?.refresh_token]).toEqual(["Ana@Example.com", "r1"]);
  expect(moved[0]?.added ?? 0).toBeGreaterThan(0);
  expect(existsSync(join(base, "gmail.accounts/ana@example.com.json"))).toBe(true);
  migrateIn(base, "gmail", builtin);
  expect(accountsIn(base, "gmail")).toHaveLength(1);
  const own = blankCred({ access_token: "a2", client_id: "mine.apps.googleusercontent.com", client_secret: "x", account: "bo@example.com", added: 1 });
  writePrivate(old, JSON.stringify(own));
  migrateIn(base, "gmail", builtin);
  const kept = JSON.parse(readFileSync(old, "utf8")) as { client_id: string; access_token: string };
  expect([kept.client_id, kept.access_token]).toEqual(["mine.apps.googleusercontent.com", ""]);
  const names = (): string[] => accountsIn(base, "gmail").map((x) => x.account);
  expect(names()).toEqual(["bo@example.com", "Ana@Example.com"]);
  writePrivate(join(base, "gmail.accounts/default"), "ana@example.com");
  expect(names()).toEqual(["Ana@Example.com", "bo@example.com"]);
  writePrivate(join(base, "gmail.accounts/x.json"), '{"access_token":"","account":"x@example.com"}');
  expect(names()).toHaveLength(2);
});

test("google_account_files_and_phone_redirects: google account files and phone redirects", () => {
  expect(accountFile(" Ana.B+x@Example.com ")).toBe("ana.b+x@example.com.json");
  expect(accountFile("../../etc/passwd")).toBe(".._.._etc_passwd.json");
  expect(phoneRedirectOk("http://127.0.0.1:43123/")).toBe(true);
  expect(phoneRedirectOk("http://127.0.0.1:43123/x") || phoneRedirectOk("https://evil.example/") || phoneRedirectOk("http://127.0.0.1:0/")).toBe(false);
  const u = googleAuthUrl("cid", "http://127.0.0.1:1/", "s1 s2", "v", "st");
  expect(u).toContain("prompt=select_account%20consent");
  expect(u).toContain("access_type=offline");
  expect(u).toContain("state=st");
});

test("google_scopes_granted: google scopes granted", () => {
  const asked = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
  expect(missingScopes(asked, undefined)).toEqual([]);
  expect(missingScopes(asked, asked)).toEqual([]);
  expect(missingScopes(asked, "https://www.googleapis.com/auth/gmail.settings.basic openid")).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
});

test("token_answers_keep_the_refresh_token: token answers keep the refresh token", () => {
  const c = blankCred({ refresh_token: "r1" });
  applyToken(c, 200, { access_token: "a2", expires_in: 3599, scope: "x", token_type: "Bearer" });
  expect([c.access_token, c.refresh_token]).toEqual(["a2", "r1"]);
  expect(c.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
  expect(() => applyToken(c, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })).toThrow("expired or revoked");
  expect(c.access_token).toBe("a2");
});

test("device_codes_and_names: device codes and names", () => {
  expect(isCode("62FA-3B18") && isCode("(VZGR-TRNQ)") && !isCode("https://x")).toBe(true);
  expect(localFor("Roblox Studio")?.id).toBe("robloxstudio");
  expect(localFor("blender-mcp")?.id).toBe("blender");
  expect(localFor("convex") === undefined && localFor("github") === undefined).toBe(true);
  expect(dec("a%20b+c%3D")).toBe("a b c=");
});

test("agents get the local servers from the user's config and the signed-in apps", async () => {
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ mcpServers: { "Roblox Studio": { command: "rbx" }, other: { command: "x" } } }));
  mcp.saveKey("context7", "k-1");
  const m = await claudeServers();
  expect(m["Roblox Studio"]).toEqual({ command: "rbx" });
  expect(m.other).toBeUndefined();
  expect(m.playwright).toBeDefined();
  expect(m.context7).toEqual({ type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "k-1" } });
  mcp.toggleOff("robloxstudio");
  resetLocalsCache();
  expect((await claudeServers())["Roblox Studio"]).toBeUndefined();
  const args = await codexArgs();
  expect(args).toContain('mcp_servers.context7.url="https://mcp.context7.com/mcp"');
  expect(args).toContain('mcp_servers.context7.env_http_headers={CONTEXT7_API_KEY="HARBOR_TOKEN_CONTEXT7"}');
});

test("a Google code is exchanged and saved as an account", async () => {
  const token = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = new URLSearchParams(await req.text());
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("http://127.0.0.1:9/");
      return Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.modify" });
    },
  });
  endpoints.googleToken = `http://127.0.0.1:${token.port}/token`;
  integrate({ profileEmail: async (t) => (t === "acc" ? "Zed@example.com" : "") });
  const email = await googleSaveCode("gmail", "https://www.googleapis.com/auth/gmail.modify", { id: "c.apps.googleusercontent.com", secret: "s" }, "the-code", "http://127.0.0.1:9/", "v");
  expect(email).toBe("Zed@example.com");
  expect(mcp.googleAccounts("gmail")).toEqual(["Zed@example.com"]);
  expect(mcp.signedIn("gmail")).toBe(true);
  expect(await mcp.freshTokenFor("gmail", "zed@example.com", false)).toBe("acc");
  void token.stop(true);
  endpoints.googleToken = "https://oauth2.googleapis.com/token";
});

test("the sign-in callback takes the code and refuses a wrong state", async () => {
  const cb = listenCallback();
  const refused = cb.wait("/", "st", new AbortController().signal).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  const bad = await fetch(`${cb.base}?code=x&state=other`);
  expect(bad.status).toBe(200);
  expect(await bad.text()).toContain("Sign-in didn't finish");
  expect(await refused).toContain("Sign-in failed");
  const again = cb.wait("/cb", "s2", new AbortController().signal);
  expect((await fetch(`${cb.base}other?code=x&state=s2`)).status).toBe(404);
  const good = await fetch(`${cb.base}cb?code=the-code&state=s2`);
  expect(await good.text()).toContain("You're signed in");
  expect(await again).toBe("the-code");
  cb.close();
});

test("a sign-in for an app that signs in with a key fails without side effects", async () => {
  signIn("context7");
  await Bun.sleep(20);
  expect(mcp.error("context7")).toBe("This app signs in with a key.");
  mcp.dismiss("context7");
  expect(mcp.error("context7")).toBeUndefined();
  expect(mcp.pending("context7")).toBeUndefined();
});
