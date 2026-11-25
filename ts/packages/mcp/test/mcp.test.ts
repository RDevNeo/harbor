import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { noderuntime, providers } from "@harbor/agents";
import { nodedist, env as osEnv } from "@harbor/os";
import {
  accountFile,
  accountsIn,
  applyToken,
  blankCred,
  claudeConfig,
  claudeServers,
  codexArgs,
  dec,
  endpoints,
  googleAuthUrl,
  googleSaveCode,
  integrate,
  integrations,
  isCode,
  listenCallback,
  localFor,
  migrateIn,
  missingScopes,
  ownClient,
  parseGoogleClient,
  phoneRedirectOk,
  pickClient,
  playwrightArgs,
  resetLocalsCache,
  sha256,
  signIn,
  writePrivate,
} from "../src/mcp.ts";
import * as mcp from "../src/mcp.ts";
import type { Json } from "../src/json.ts";

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
  noderuntime.resetForTests();
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

/** An `npx` on PATH (a folder of its own), for the built-in Playwright; Windows finds it as npx.cmd. */
function fakeNpx(): string {
  const bin = join(root, "npxbin");
  mkdirSync(bin, { recursive: true });
  const name = osEnv.execSuffixes().includes(".cmd") ? "npx.cmd" : "npx";
  writeFileSync(join(bin, name), name === "npx.cmd" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  return bin;
}

test("a .claude.json read while Claude Code rewrites it (half written) keeps the servers it named last; one that's gone has none", async () => {
  const f = join(root, ".claude.json");
  const roblox = { type: "stdio", command: "/opt/roblox-mcp", args: [] };
  writeFileSync(f, JSON.stringify({ mcpServers: { "Roblox Studio": roblox } }));
  expect((await mcp.claudeServers())["Roblox Studio"]).toEqual(roblox);
  writeFileSync(f, JSON.stringify({ mcpServers: { "Roblox Studio": roblox } }).slice(0, 25));
  resetLocalsCache();
  expect((await mcp.claudeServers())["Roblox Studio"]).toEqual(roblox);
  // Read whole again without it: removed for real.
  writeFileSync(f, JSON.stringify({ mcpServers: {} }));
  resetLocalsCache();
  expect((await mcp.claudeServers())["Roblox Studio"]).toBeUndefined();
  writeFileSync(f, JSON.stringify({ mcpServers: { "Roblox Studio": roblox } }));
  resetLocalsCache();
  expect((await mcp.claudeServers())["Roblox Studio"]).toEqual(roblox);
  rmSync(f);
  resetLocalsCache();
  expect((await mcp.claudeServers())["Roblox Studio"]).toBeUndefined();
});

test("the built-in Playwright is offered only where npx is installed", () => {
  const bin = fakeNpx();
  process.env.PATH = [bin, process.env.PATH ?? ""].join(delimiter);
  resetLocalsCache();
  expect(mcp.locals().find((l) => l.local.id === "playwright")?.def).toEqual(["playwright", { type: "stdio", command: "npx", args: playwrightArgs() }]);
  // Without npx anywhere (an empty PATH; the OS's own tool folders may still have one): no entry that can't start.
  process.env.PATH = join(root, "empty");
  resetLocalsCache();
  const none = mcp.locals().find((l) => l.local.id === "playwright");
  if (providers.which("npx") === null) expect(none?.def).toBeUndefined();
  // The user's own entry still counts with no npx.
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ mcpServers: { playwright: { command: "/opt/pw" } } }));
  resetLocalsCache();
  expect(mcp.locals().find((l) => l.local.id === "playwright")?.def).toEqual(["playwright", { command: "/opt/pw" }]);
});

test("the built-in Playwright is offered once Hub's own Node (and its npx) is installed", () => {
  process.env.PATH = join(root, "empty");
  noderuntime.resetForTests();
  resetLocalsCache();
  if (providers.which("npx") !== null) return; // the OS's own tool folders have one: nothing to show here
  expect(mcp.locals().find((l) => l.local.id === "playwright")?.def).toBeUndefined();
  const dist = nodedist.distFor();
  if (dist === null) return;
  const bin = noderuntime.binOf(noderuntime.runtimesDir(), dist);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, dist.node), "", { mode: 0o755 });
  writeFileSync(join(bin, osEnv.execSuffixes().includes(".cmd") ? "npx.cmd" : "npx"), "", { mode: 0o755 });
  noderuntime.resetForTests();
  resetLocalsCache();
  expect(mcp.locals().find((l) => l.local.id === "playwright")?.def?.[1]).toEqual({ type: "stdio", command: "npx", args: playwrightArgs() });
  expect(mcp.localNote("playwright")).toBeNull();
  expect(mcp.localNote("discord")).toBeNull();
  noderuntime.resetForTests();
});

test("agents get the local servers from the user's config and the signed-in apps", async () => {
  process.env.PATH = [fakeNpx(), process.env.PATH ?? ""].join(delimiter);
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
  expect(args).toHaveLength(2);
  expect(args[1]).toContain('context7={url="https://mcp.context7.com/mcp",env_http_headers={CONTEXT7_API_KEY="HARBOR_TOKEN_CONTEXT7"},enabled=true}');
});

/** The one `mcp_servers={…}` override, read back as TOML. */
function overrides(args: string[]): Record<string, Record<string, unknown>> {
  expect(args.filter((a) => a.startsWith("mcp_servers"))).toHaveLength(1);
  const a = args[args.indexOf("-c") + 1] ?? "";
  return (Bun.TOML.parse(a) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers;
}

test("Codex: servers that are off go off in one override (a key with a space too), the rest stays as the user has it", async () => {
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), '[mcp_servers."Roblox Studio"]\ncommand = "rbx"\n\n[mcp_servers.node_repl]\ncommand = "repl"\n\n[mcp_servers.Omarchy]\ncommand = "hypr"\n');
  mcp.toggleOff("robloxstudio");
  const m = overrides(await codexArgs());
  expect(m).toEqual({ "Roblox Studio": { enabled: false }, node_repl: { enabled: false }, Omarchy: { enabled: false } });
});

test("the dropped Omarchy server: never started, and it leaves the saved off list", async () => {
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ mcpServers: { Omarchy: { command: "hypr" }, "Roblox Studio": { command: "rbx" } } }));
  mcp.writePrivate(mcp.offPath(), JSON.stringify(["omarchy", "robloxstudio"]));
  resetLocalsCache();
  expect(localFor("Omarchy")).toBeUndefined();
  expect(mcp.locals().map((l) => l.local.id)).not.toContain("omarchy");
  expect(await claudeServers()).not.toHaveProperty("Omarchy");
  expect(mcp.isOff("robloxstudio") && !mcp.isOff("omarchy")).toBe(true);
  expect(JSON.parse(readFileSync(mcp.offPath(), "utf8"))).toEqual(["robloxstudio"]);
  // Codex: the user's own entry is turned off for Harbor's turns.
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), '[mcp_servers.Omarchy]\ncommand = "hypr"\n');
  expect(overrides(await codexArgs()).Omarchy).toEqual({ enabled: false });
});

test("Codex: with a grant, stdio servers are the bridge's and Codex gets their URLs, the token from its environment", async () => {
  mkdirSync(join(root, ".codex"));
  writeFileSync(
    join(root, ".codex", "config.toml"),
    [
      'model = "x"',
      '[mcp_servers."Roblox Studio"]',
      'command = "/bin/rbx"',
      "args = []",
      "[mcp_servers.Blender]",
      'command = "/bin/blend"',
      "startup_timeout_sec = 20",
      "[mcp_servers.Blender.tools.desktop]",
      'approval_mode = "approve"',
      "[mcp_servers.Blender.env]",
      'A = "1"',
      // Its own folder: the bridge can't run it so; Codex keeps starting it.
      "[mcp_servers.discord]",
      'command = "/bin/disc"',
      'cwd = "/tmp"',
      // The lowercase twin is taken: no free name.
      "[mcp_servers.playwright]",
      'command = "npx"',
      "[mcp_servers.Playwright]",
      "enabled = false",
      'command = "npx"',
      "[mcp_servers.convex]",
      'command = "npx"',
      "",
    ].join("\n"),
  );
  const lazy: mcp.CodexLazy = { servers: {}, base: "http://127.0.0.1:${HARBOR_BRIDGE_PORT}/", tokenVar: "HARBOR_BRIDGE_TOKEN" };
  const team: Json = { type: "stdio", command: "/bin/harbor", args: ["mcp", "--chat", "7", "--role", "lead"], env: { HARBOR_SOCK: "/run/h.sock" } };
  const m = overrides(await codexArgs(7, [["harbor", team]], lazy));
  const at = (name: string): Record<string, unknown> => ({ url: `http://127.0.0.1:\${HARBOR_BRIDGE_PORT}/${name}`, bearer_token_env_var: "HARBOR_BRIDGE_TOKEN", enabled: true });
  expect(m["Roblox Studio"]).toEqual({ enabled: false });
  expect(m.Roblox_Studio).toEqual(at("Roblox_Studio"));
  expect(m.Blender).toEqual({ enabled: false });
  expect(m.blender).toEqual({ ...at("blender"), startup_timeout_sec: 20, tools: { desktop: { approval_mode: "approve" } } });
  expect(m.harbor).toEqual(at("harbor"));
  expect(m.discord).toBeUndefined();
  expect(m.playwright).toBeUndefined();
  expect(m.convex).toEqual({ enabled: false });
  expect(lazy.servers).toEqual({
    Roblox_Studio: { type: "stdio", command: "/bin/rbx", args: [] },
    blender: { type: "stdio", command: "/bin/blend", args: [], env: { A: "1" } },
    harbor: team,
  });
  // Nothing secret on the command line.
  expect(JSON.stringify(m)).not.toContain("h.sock");
});

test("Codex: an app whose name the user's own stdio entry has stays a stdio entry", async () => {
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), '[mcp_servers.hub]\ncommand = "/bin/other"\n');
  const lazy: mcp.CodexLazy = { servers: {}, base: "http://127.0.0.1:9/", tokenVar: "T" };
  const team: Json = { type: "stdio", command: "/bin/harbor", args: ["mcp"], env: { HARBOR_SOCK: "/run/h.sock" } };
  const m = overrides(await codexArgs(7, [["harbor", team]], lazy));
  expect(m.harbor).toEqual({ command: "/bin/harbor", args: ["mcp"], env: { HARBOR_SOCK: "/run/h.sock" }, enabled: true });
  expect(lazy.servers).toEqual({});
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

test("the sign-in callback takes the code and ignores a wrong state", async () => {
  const cb = listenCallback();
  const ac = new AbortController();
  const first = cb.wait("/", "st", ac.signal).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  const bad = await fetch(`${cb.base}?code=x&state=other`);
  expect(bad.status).toBe(200);
  expect(await bad.text()).toContain("Not this sign-in");
  ac.abort();
  expect(await first).toBe("Sign-in was cancelled.");
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

test("Hub's own apps learn which chat runs them: Discord shows that chat a captcha its call hits", async () => {
  const was = integrations.discord;
  integrations.discord = { signedIn: () => true, accountName: () => "Ana", signOut: () => {}, login: async () => {} };
  try {
    const p = await claudeConfig(42, [], true);
    const m = (JSON.parse(readFileSync(p, "utf8")) as { mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }> }).mcpServers;
    expect(m.discord?.args).toEqual(["app", "discord"]);
    expect(m.discord?.env).toEqual({ HARBOR_CHAT_ID: "42" });
  } finally {
    if (was === undefined) delete integrations.discord;
    else integrations.discord = was;
  }
});

test("on a bridge grant, stdio servers become its URLs and only the team server goes there for a chat from another PC", async () => {
  const was = integrations.discord;
  integrations.discord = { signedIn: () => true, accountName: () => "Ana", signOut: () => {}, login: async () => {} };
  try {
    const team: [string, Json] = ["harbor", { type: "stdio", command: "harbor", args: ["mcp", "--chat", "42", "--role", "lead"], env: { HARBOR_SOCK: "/run/h.sock" } }];
    const own: [string, Json] = ["mine", { type: "stdio", command: "x", args: ["--chat", "${HARBOR_CHAT_ID}"] }];
    const web: [string, Json] = ["web", { type: "http", url: "https://example.com/mcp" }];
    const lazy = { servers: {} as Record<string, Json>, base: "http://127.0.0.1:47940/tok/" };
    const read = async (apps: boolean, l: typeof lazy): Promise<Record<string, Json>> =>
      (JSON.parse(readFileSync(await claudeConfig(42, [team, own, web], apps, l), "utf8")) as { mcpServers: Record<string, Json> }).mcpServers;
    const m = await read(true, lazy);
    expect(m.discord).toEqual({ type: "http", url: "http://127.0.0.1:47940/tok/discord" });
    expect(m.harbor).toEqual({ type: "http", url: "http://127.0.0.1:47940/tok/harbor" });
    expect(lazy.servers.discord).toMatchObject({ args: ["app", "discord"], env: { HARBOR_CHAT_ID: "42" } });
    expect(lazy.servers.hub).toEqual(team[1]);
    // Entries Claude Code expands itself, and http ones, stay as they are.
    expect(m.mine).toEqual(own[1]);
    expect(m.web).toEqual(web[1]);
    const guest = { servers: {} as Record<string, Json>, base: "http://127.0.0.1:47940/t2/" };
    const g = await read(false, guest);
    expect(Object.keys(guest.servers)).toEqual(["harbor"]);
    expect(g.harbor).toEqual({ type: "http", url: "http://127.0.0.1:47940/t2/harbor" });
  } finally {
    if (was === undefined) delete integrations.discord;
    else integrations.discord = was;
  }
});

test("Playwright's Chromium is wanted only for Hub's own entry on it, while it's on", () => {
  process.env.PATH = [fakeNpx(), process.env.PATH ?? ""].join(delimiter);
  resetLocalsCache();
  expect(mcp.needsPlaywrightChromium()).toBe(playwrightArgs().includes("chromium"));
  // A user's own entry is theirs, even one on Playwright's Chromium: Harbor installs nothing for it.
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--browser", "chromium"] } } }));
  resetLocalsCache();
  expect(mcp.needsPlaywrightChromium()).toBe(false);
  mcp.toggleOff("playwright");
  resetLocalsCache();
  expect(mcp.needsPlaywrightChromium()).toBe(false);
});
