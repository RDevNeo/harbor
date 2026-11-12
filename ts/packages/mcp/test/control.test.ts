import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hook, HOOK_RATE_LIMIT, type Incoming, Rate, funnelHooksPort, serveHook, signatureOk, startHooks, startSocket } from "../src/control.ts";
import { askSocket } from "../src/mcpshim.ts";
import { expectPerm } from "../../../test/perm.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hctl-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const tag = (token: string, body: string): string => createHmac("sha256", token).update(body).digest("hex");

test("github_signatures: github signatures", () => {
  const t = tag("tok", "{}");
  expect(signatureOk("tok", "{}", `sha256=${t}`)).toBe(true);
  expect(signatureOk("tok", "{ }", `sha256=${t}`)).toBe(false);
  expect(signatureOk("other", "{}", `sha256=${t}`)).toBe(false);
  expect(signatureOk("tok", "{}", "sha1=00") || signatureOk("tok", "{}", "sha256=zz")).toBe(false);
});

test("funnel_hooks_target_port: funnel hooks target port", () => {
  const st = "# Funnel on:\n#     - https://pc.example.ts.net\n\nhttps://pc.example.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:3000\n|-- /hooks proxy http://127.0.0.1:47920/hooks\n";
  expect(funnelHooksPort(st)).toBe(47920);
  expect(funnelHooksPort("https://pc.example.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:3000\n")).toBeUndefined();
});

test("webhooks_are_rate_limited_per_token: webhooks are rate limited per token", () => {
  const r = new Rate();
  const t = 1_000_000;
  for (let i = 0; i < HOOK_RATE_LIMIT; i++) expect(r.allow("a", t)).toBe(true);
  expect(r.allow("a", t + 30_000)).toBe(false);
  expect(r.allow("b", t)).toBe(true);
  expect(r.allow("a", t + 61_000)).toBe(true);
});

test("the socket is private and relays a tool call, a focus request and a preview", async () => {
  const path = join(root, "harbor.sock");
  const seen: string[] = [];
  const l = startSocket<never, never, string>({
    path,
    raise: () => true,
    previewReceived: (v) => (v === "bad" ? "refused" : { here: true, offer: "o1" }),
    send(i: Incoming<never, never, string>) {
      seen.push(i.kind);
      if (i.kind === "tool") i.call.reply(i.call.tool === "ok", `${i.call.chatId}:${JSON.stringify(i.call.args)}`);
    },
  });
  expect(l).toBeDefined();
  expectPerm(path, 0o600);
  expect(JSON.parse(await askSocket(path, JSON.stringify({ chat: 7, tool: "ok", args: { a: 1 } })))).toEqual({ ok: true, text: '7:{"a":1}' });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ chat: 7, tool: "no", args: null })))).toEqual({ ok: false, text: "7:null" });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ focus: true })))).toEqual({ ok: true });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ preview: "bad" })))).toEqual({ ok: false, text: "refused" });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ preview: {} })))).toEqual({ ok: true, restarting: true, text: "" });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ preview_back: true, off: true })))).toEqual({ ok: true });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ quit: true })))).toEqual({ ok: true });
  expect(await askSocket(path, "not json")).toBe("");
  expect(seen).toEqual(["tool", "tool", "focus", "preview", "previewBack", "quit"]);
  l?.stop();
});

test("a new socket replaces a stale file", async () => {
  const path = join(root, "harbor.sock");
  const a = startSocket({ path, send: () => undefined });
  a?.stop();
  const b = startSocket({ path, send: (i) => i.kind === "tool" && i.call.reply(true, "up") });
  expect(JSON.parse(await askSocket(path, JSON.stringify({ tool: "x" })))).toEqual({ ok: true, text: "up" });
  b?.stop();
});

test("webhooks: known tokens only, signed when signed, body and headers handed on", async () => {
  const got: Hook[] = [];
  const tokens = new Set(["tok1"]);
  const server = startHooks(tokens, (h) => got.push(h), 47990);
  expect(server).toBeDefined();
  const base = `http://127.0.0.1:${server?.port}`;
  expect((await fetch(`${base}/hooks/nope`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(`${base}/other`, { method: "POST", body: "{}" })).status).toBe(404);
  const body = '{"a":1}';
  const bad = await fetch(`${base}/hooks/tok1`, { method: "POST", body, headers: { "X-Hub-Signature-256": "sha256=00" } });
  expect(bad.status).toBe(401);
  const ok = await fetch(`${base}/hooks/tok1/`, {
    method: "POST",
    body,
    headers: { "X-Hub-Signature-256": `sha256=${tag("tok1", body)}`, "X-GitHub-Event": "push", Authorization: "secret", "Content-Type": "application/json" },
  });
  expect(ok.status).toBe(202);
  expect(await ok.json()).toEqual({ ok: true });
  expect(got).toHaveLength(1);
  expect(got[0]?.token).toBe("tok1");
  expect(got[0]?.method).toBe("POST");
  expect(got[0]?.body).toBe(body);
  const names = got[0]?.headers.map(([k]) => k) ?? [];
  expect(names).toContain("x-github-event");
  expect(names).toContain("content-type");
  expect(names).not.toContain("authorization");
  expect(names).not.toContain("x-hub-signature-256");
  got.length = 0;
  const big = await fetch(`${base}/hooks/tok1`, { method: "POST", body: "x".repeat((1 << 20) + 5) });
  expect(big.status).toBe(202);
  expect(got[0]?.body).toHaveLength(1 << 20);
  server?.stop();
});

test("a webhook past its minute budget gets 429", async () => {
  let now = 5_000_000;
  const rate = new Rate();
  const ctx = { tokens: new Set(["t"]), send: () => undefined, rate, now: () => now };
  const hit = (): Promise<Response> => serveHook(new Request("http://x/hooks/t", { method: "POST", body: "{}" }), ctx);
  for (let i = 0; i < HOOK_RATE_LIMIT; i++) expect((await hit()).status).toBe(202);
  const limited = await hit();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  now += 61_000;
  expect((await hit()).status).toBe(202);
});

test("a chunked webhook body past 1 MB is refused", async () => {
  const chunk = new TextEncoder().encode("x".repeat(1 << 19));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 3; i++) c.enqueue(chunk);
      c.close();
    },
  });
  const req = new Request("http://x/hooks/t", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect((await serveHook(req, { tokens: new Set(["t"]), send: () => undefined })).status).toBe(413);
});

test("a chunked webhook body is read", async () => {
  const got: Hook[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("ab"));
      c.enqueue(new TextEncoder().encode("cd"));
      c.close();
    },
  });
  const req = new Request("http://x/hooks/t", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  const res = await serveHook(req, { tokens: new Set(["t"]), send: (h) => got.push(h) });
  expect(res.status).toBe(202);
  expect(got[0]?.body).toBe("abcd");
});

test("harbor quit: asks the running Harbor, then sees its lock and socket go", async () => {
  const { quitRunning, lockHeld, socketListening, acquire, release } = await import("../../store/src/single.ts");
  const env = { HARBOR_SOCK: join(root, "q.sock") };
  expect(await quitRunning(env)).toBe(false);
  expect(lockHeld(env)).toBe(false);
  let quit = 0;
  const l = startSocket({ path: env.HARBOR_SOCK, send: (i) => void (i.kind === "quit" && quit++) });
  expect(await acquire(env)).toBe(true);
  expect(lockHeld(env)).toBe(true);
  expect(await socketListening(env)).toBe(true);
  expect(await quitRunning(env)).toBe(true);
  expect(quit).toBe(1);
  l?.stop();
  release();
  expect(lockHeld(env)).toBe(false);
  expect(await socketListening(env)).toBe(false);
});

test("harbor api: a call reaches the running Harbor's own API and its answer comes back; a recording goes as wav", async () => {
  const { apiCall } = await import("../../store/src/single.ts");
  const env = { HARBOR_SOCK: join(root, "api.sock") };
  const seen: unknown[] = [];
  const l = startSocket({
    path: env.HARBOR_SOCK,
    send: () => undefined,
    api: async (method, path, body, wav) => {
      seen.push([method, path, body, wav === null ? null : wav.length]);
      return path === "v1/missing" ? { status: 404, body: { error: "no such call" } } : { status: 200, body: { echo: path } };
    },
  });
  expect(await apiCall({ method: "patch", path: "v1/chats/3", body: { device: "pc:x" } }, env)).toEqual({ ok: true, status: 200, body: { echo: "v1/chats/3" } });
  expect(await apiCall({ method: "GET", path: "v1/missing" }, env)).toEqual({ ok: false, status: 404, body: { error: "no such call" } });
  expect(await apiCall({ method: "POST", path: "v1/transcribe", wav: Buffer.from("RIFF1234").toString("base64") }, env)).toMatchObject({ ok: true });
  expect(seen).toEqual([["PATCH", "v1/chats/3", { device: "pc:x" }, null], ["GET", "v1/missing", null, null], ["POST", "v1/transcribe", null, 8]]);
  l?.stop();
  expect(await apiCall({ method: "GET", path: "v1/state" }, env, 2000)).toBeNull();
});
