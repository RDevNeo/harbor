import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact, parse } from "../src/json.ts";
import * as oauth from "../src/oauth.ts";
import { home } from "../src/paths.ts";
import { installHint, installScript } from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-oauth-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = (): string => {
  const d = join(base, String(n++));
  mkdirSync(d, { recursive: true });
  return d;
};

function creds(d: string, expiresAt: number): string {
  const p = join(d, ".credentials.json");
  writeFileSync(p, compact({ claudeAiOauth: { accessToken: "sk-ant-oat01-old", refreshToken: "sk-ant-ort01-old", expiresAt, scopes: ["user:inference"], subscriptionType: "max" }, mcpOAuth: {} }));
  return p;
}

const read = (p: string): Record<string, Record<string, unknown>> => parse(readFileSync(p, "utf8")) as Record<string, Record<string, unknown>>;
const NOW = 1_700_000_000_000;

test("fresh token is used as is", () => {
  const d = dir();
  let called = false;
  const p = creds(d, NOW + 3_600_000);
  expect(
    oauth.tokenAt(p, NOW, () => {
      called = true;
      return null;
    }),
  ).toBe("sk-ant-oat01-old");
  expect(called).toBe(false);
  // A credentials file in seconds (older CLIs) means the same.
  expect(oauth.tokenAt(creds(d, (NOW + 3_600_000) / 1000), NOW, () => null)).toBe("sk-ant-oat01-old");
  expect(oauth.credentialsPath(null)).toBe(join(home(), ".claude/.credentials.json"));
  expect(oauth.credentialsPath("/x/.claude2")).toBe("/x/.claude2/.credentials.json");
});

test("expiring token is refreshed and written back", () => {
  const d = dir();
  // Four minutes left: within the skew.
  const p = creds(d, NOW + 4 * 60_000);
  const t = oauth.tokenAt(p, NOW, (rt) => {
    expect(rt).toBe("sk-ant-ort01-old");
    return { access_token: "sk-ant-oat01-new", refresh_token: "sk-ant-ort01-new", expires_in: 28800, token_type: "Bearer" };
  });
  expect(t).toBe("sk-ant-oat01-new");
  const v = read(p);
  const login = v.claudeAiOauth ?? {};
  expect(login.accessToken).toBe("sk-ant-oat01-new");
  expect(login.refreshToken).toBe("sk-ant-ort01-new");
  expect(login.expiresAt).toBe(NOW + 28_800_000);
  // The rest of the file survives the rewrite.
  expect(login.subscriptionType).toBe("max");
  expect(typeof v.mcpOAuth).toBe("object");
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(existsSync(join(d, ".credentials.json.lock"))).toBe(true);
  expect(existsSync(join(d, ".credentials.json.tmp"))).toBe(false);
  // Written as serde's pretty printer does: keys sorted, two spaces, a newline at the end.
  expect(readFileSync(p, "utf8")).toStartWith('{\n  "claudeAiOauth": {\n    "accessToken": "sk-ant-oat01-new",\n    "expiresAt": ');
  expect(readFileSync(p, "utf8")).toEndWith("}\n");
});

test("failed refresh keeps the stale token", () => {
  const d = dir();
  const p = creds(d, NOW - 1);
  expect(oauth.tokenAt(p, NOW, () => null)).toBe("sk-ant-oat01-old");
  // An answer without a token changes nothing either.
  expect(oauth.tokenAt(p, NOW, () => ({ error: "invalid_grant" }))).toBe("sk-ant-oat01-old");
  expect(read(p).claudeAiOauth?.refreshToken).toBe("sk-ant-ort01-old");
});

test("not signed in means no token", () => {
  const d = dir();
  const p = join(d, ".credentials.json");
  expect(oauth.tokenAt(p, 0, () => null)).toBeNull();
  writeFileSync(p, '{"claudeAiOauth":{"accessToken":""}}');
  expect(oauth.tokenAt(p, 0, () => null)).toBeNull();
  writeFileSync(p, '{"mcpOAuth":{}}');
  expect(oauth.tokenAt(p, 0, () => null)).toBeNull();
  // A token that wouldn't survive one `read` line is not sent.
  writeFileSync(p, '{"claudeAiOauth":{"accessToken":"a\\nb"}}');
  expect(oauth.tokenAt(p, 0, () => null)).toBeNull();
});

test("refresh answer defaults", () => {
  const v: Record<string, unknown> = { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1 } };
  const login = (): Record<string, unknown> => v.claudeAiOauth as Record<string, unknown>;
  // No rotated refresh token, no expires_in: the old refresh token stays, 8 h.
  expect(oauth.apply(v, { access_token: "b" }, 1000)).toBe("b");
  expect(login().refreshToken).toBe("r");
  expect(login().expiresAt).toBe(1000 + 28_800_000);
  expect(oauth.apply(v, { access_token: "c", refresh_token: "r2", expires_in: 60, refresh_token_expires_in: 120 }, 1000)).toBe("c");
  expect(login().refreshToken).toBe("r2");
  expect(login().expiresAt).toBe(61_000);
  expect(login().refreshTokenExpiresAt).toBe(121_000);
  expect(oauth.epochMs(1_700_000_000)).toBe(1_700_000_000_000);
  expect(oauth.epochMs("1700000000000")).toBe(1_700_000_000_000);
  expect(oauth.epochMs(null)).toBe(0);
});

test("a lent login is the access token alone", () => {
  const d = dir();
  const acct = join(d, "acct");
  const overlay = join(d, "overlay");
  mkdirSync(acct);
  mkdirSync(overlay);
  creds(acct, 1_700_003_600_000);
  oauth.lend(overlay, acct, "sk-ant-oat01-old");
  const p = join(overlay, ".credentials.json");
  const text = readFileSync(p, "utf8");
  expect(text).not.toContain("sk-ant-ort01");
  expect(text).not.toContain("refresh");
  expect(text).not.toContain("mcpOAuth");
  let login = read(p).claudeAiOauth ?? {};
  expect(login.accessToken).toBe("sk-ant-oat01-old");
  expect(login.expiresAt).toBe(1_700_003_600_000);
  expect(login.scopes).toEqual(["user:inference"]);
  expect(login.subscriptionType).toBe("max");
  expect(statSync(p).mode & 0o777).toBe(0o600);
  // A token that isn't the file's (refreshed meanwhile): its expiry and kind aren't known.
  oauth.lend(overlay, acct, "sk-ant-oat01-other");
  login = read(p).claudeAiOauth ?? {};
  expect(login).toEqual({ accessToken: "sk-ant-oat01-other", scopes: ["user:inference"] });
  oauth.unlend(overlay);
  expect(existsSync(p)).toBe(false);
  // The account's own login is untouched.
  expect(readFileSync(join(acct, ".credentials.json"), "utf8")).toContain("sk-ant-ort01-old");
});

test("npm install needs node", () => {
  expect(installScript("Claude")).toBe(installHint("Claude"));
  const s = installScript("Codex");
  expect(s.startsWith("if ! command -v npm")).toBe(true);
  expect(s).toContain("Node.js");
  expect(s).toContain("npm i -g @openai/codex ||");
  // Runs as a script: without npm on PATH it explains instead of failing on npm.
  const out = Bun.spawnSync(["/bin/sh", "-c", s], { env: { PATH: "/nonexistent" }, stdout: "pipe" });
  expect(out.success).toBe(false);
  expect(out.stdout.toString()).toContain("Codex installs with npm");
});
