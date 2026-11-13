import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mcp from "../src/mcp.ts";

let root: string;
const saved = { ...process.env };
const opened: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hsign-"));
  process.env.HOME = root;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.HARBOR_SOCK = join(root, "none.sock");
  opened.length = 0;
  mcp.setOpener((u) => opened.push(u));
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

test("an MCP OAuth sign-in discovers, registers, follows the redirect and saves the tokens", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const base = u.origin;
      seen.push(`${req.method} ${u.pathname}`);
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ authorization_servers: [base], resource: `${base}/mcp`, scopes_supported: ["read", "write"] });
      if (u.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, token_endpoint_auth_methods_supported: ["none"] });
      }
      if (u.pathname === "/register") {
        const reg = (await req.json()) as { token_endpoint_auth_method: string; scope: string; redirect_uris: string[] };
        expect(reg.token_endpoint_auth_method).toBe("none");
        expect(reg.scope).toBe("read write");
        return Response.json({ client_id: "cid-1" });
      }
      if (u.pathname === "/token") {
        const b = new URLSearchParams(await req.text());
        expect(b.get("grant_type")).toBe("authorization_code");
        expect(b.get("code")).toBe("c0de");
        expect(b.get("client_id")).toBe("cid-1");
        expect(b.get("resource")).toBe(`${base}/mcp`);
        return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      }
      return new Response(null, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  let authUrl = "";
  const done = mcp.oauthLogin("vercel", url, new AbortController().signal, (p) => {
    authUrl = p.url ?? "";
    const q = new URL(authUrl).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("client_id")).toBe("cid-1");
    void fetch(`${q.get("redirect_uri")}?code=c0de&state=${q.get("state")}`);
  });
  await done;
  expect(opened).toEqual([authUrl]);
  const c = JSON.parse(readFileSync(join(process.env.XDG_DATA_HOME ?? "", "harbor/apps/vercel.json"), "utf8")) as Record<string, string | number>;
  expect(c.access_token).toBe("at-1");
  expect(c.refresh_token).toBe("rt-1");
  expect(c.client_id).toBe("cid-1");
  expect(c.token_endpoint).toBe(`http://127.0.0.1:${server.port}/token`);
  expect(mcp.signedIn("vercel")).toBe(true);
  expect(await mcp.freshToken("vercel", false)).toBe("at-1");
  expect(seen).toContain("POST /register");
  mcp.signOut("vercel");
  expect(mcp.signedIn("vercel")).toBe(false);
  void server.stop(true);
});

test("Cloudflare signs in with OAuth on its API server and asks for every scope its consent screen can narrow", async () => {
  const cf = mcp.app("cloudflare");
  expect(cf).toMatchObject({ label: "Cloudflare", auth: { kind: "oauth" }, mcp: { kind: "http", url: "https://mcp.cloudflare.com/mcp" }, scopes: "all" });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const base = u.origin;
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ authorization_servers: [base], resource: `${base}/mcp`, scopes_supported: ["user:read", "account:read"] });
      if (u.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          scopes_supported: ["offline_access", "user:read", "account:read", "d1.write", "workers-observability.read"],
        });
      }
      if (u.pathname === "/register") return Response.json({ client_id: "cid-cf" });
      if (u.pathname === "/token") return Response.json({ access_token: "at-cf", refresh_token: "rt-cf", expires_in: 3600 });
      return new Response(null, { status: 404 });
    },
  });
  let scope = "";
  await mcp.oauthLogin("cloudflare", `http://127.0.0.1:${server.port}/mcp`, new AbortController().signal, (p) => {
    const q = new URL(p.url ?? "").searchParams;
    scope = q.get("scope") ?? "";
    void fetch(`${q.get("redirect_uri")}?code=c&state=${q.get("state")}`);
  }, true);
  expect(scope).toBe("offline_access user:read account:read d1.write workers-observability.read");
  expect(mcp.signedIn("cloudflare")).toBe(true);
  void server.stop(true);
});

test("an expiring OAuth token is refreshed and the new one saved", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const b = new URLSearchParams(await req.text());
      expect(b.get("grant_type")).toBe("refresh_token");
      expect(b.get("refresh_token")).toBe("rt-1");
      return Response.json({ access_token: "at-2", expires_in: 3600 });
    },
  });
  const dir = join(process.env.XDG_DATA_HOME ?? "", "harbor/apps");
  mkdirSync(dir, { recursive: true });
  const old = mcp.blankCred({ access_token: "at-1", refresh_token: "rt-1", expires_at: 1, client_id: "cid", token_endpoint: `http://127.0.0.1:${server.port}/t` });
  mcp.save("linear", old);
  expect(await mcp.freshToken("linear", false)).toBe("at-2");
  expect(mcp.load("linear")?.refresh_token).toBe("rt-1");
  expect(mcp.load("linear")?.access_token).toBe("at-2");
  void server.stop(true);
});

test("a gh device login shows the code and the page, then signs in", async () => {
  const bin = join(root, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\necho "! First copy your one-time code: 62FA-3B18" >&2\necho "Open this URL to continue in your web browser: https://github.com/login/device" >&2\nsleep 0.2\nmkdir -p "$GH_CONFIG_DIR"\nprintf 'github.com:\\n    oauth_token: tok-1\\n    user: octo\\n' > "$GH_CONFIG_DIR/hosts.yml"\n`,
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  const steps: mcp.Pending[] = [];
  mcp.signIn("github", () => {
    const p = mcp.pending("github");
    if (p) steps.push(p);
  });
  for (let i = 0; i < 100 && mcp.pending("github") !== undefined; i++) await Bun.sleep(50);
  expect(mcp.error("github")).toBeUndefined();
  expect(steps.some((p) => p.code === "62FA-3B18")).toBe(true);
  expect(opened).toEqual(["https://github.com/login/device"]);
  expect(mcp.signedIn("github")).toBe(true);
  expect(mcp.account("github")).toBe("octo");
  const env = await mcp.agentEnv();
  const get = (k: string): string | undefined => env.find(([n]) => n === k)?.[1];
  expect(get("GH_TOKEN")).toBeUndefined();
  expect(env.some(([n, v]) => n === "GH_TOKEN" && v === undefined)).toBe(true);
  expect(get("GH_CONFIG_DIR")).toBe(join(process.env.XDG_DATA_HOME ?? "", "harbor/apps/github"));
  expect(get("GIT_CONFIG_VALUE_3")).toContain("auth git-credential");
  mcp.signOut("github");
  expect(mcp.signedIn("github")).toBe(false);
});

test("signed out, agents get a placeholder gh config and a refusing git helper", async () => {
  const env = await mcp.agentEnvAs(false);
  const get = (k: string): string | undefined => env.find(([n]) => n === k)?.[1];
  expect(get("GH_CONFIG_DIR")).toBe(join(process.env.XDG_DATA_HOME ?? "", "harbor/apps/github-signed-out"));
  expect(readFileSync(join(get("GH_CONFIG_DIR") ?? "", "hosts.yml"), "utf8")).toContain("sign-in-to-github-in-harbor");
  expect(get("GIT_CONFIG_VALUE_3")).toContain("Harbor: GitHub is not signed in");
  expect(get("CONVEX_OVERRIDE_ACCESS_TOKEN")).toBe("sign-in-to-convex-in-harbor");
  expect(get("SUPABASE_ACCESS_TOKEN")).toBe("sign-in-to-supabase-in-harbor");
});

test("a cancelled sign-in stops waiting", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const base = u.origin;
      if (u.pathname.startsWith("/.well-known/oauth-authorization-server")) return Response.json({ authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t`, registration_endpoint: `${base}/r` });
      if (u.pathname === "/r") return Response.json({ client_id: "x" });
      return new Response(null, { status: 404 });
    },
  });
  const ac = new AbortController();
  const p = mcp.oauthLogin("sentry", `http://127.0.0.1:${server.port}/mcp`, ac.signal, () => ac.abort()).then(
    () => "ok",
    (e: Error) => e.message,
  );
  expect(await p).toBe("Sign-in was cancelled.");
  void server.stop(true);
});
