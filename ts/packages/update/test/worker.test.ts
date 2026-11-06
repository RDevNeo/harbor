import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { ReleaseHub, newer, parseVersion, releasePing, releaseWait, tagFrom, type ReleaseEnv, type Storage } from "../../../../worker/src/release.js";

const realFetch = globalThis.fetch;
const stub = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(fn, { preconnect: () => undefined });

class Github {
  latest: string | null = "1.0.0";
  ready = true;
  reads = 0;
  hits: string[] = [];

  install(): void {
    globalThis.fetch = stub(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      this.hits.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/releases/latest")) {
        this.reads++;
        return this.latest === null ? new Response(null, { status: 302, headers: { location: "https://github.com/o/r/releases" } }) : new Response(null, { status: 302, headers: { location: `https://github.com/o/r/releases/tag/v${this.latest}` } });
      }
      if (url.endsWith("/harbor-app.json.minisig")) return new Response(null, { status: this.ready ? 302 : 404 });
      return new Response("unexpected", { status: 500 });
    });
  }
}

class Memory implements Storage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get(k: string): Promise<unknown> {
    return this.data.get(k);
  }
  async put(k: string, v: unknown): Promise<void> {
    this.data.set(k, v);
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
}

let gh: Github;
beforeEach(() => {
  gh = new Github();
  gh.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const env = (over: ReleaseEnv = {}): ReleaseEnv => ({ RELEASE_REPO: "o/r", RELEASE_WAIT_MS: "60", ...over });
const hub = (storage = new Memory(), e: ReleaseEnv = env()) => ({ hub: new ReleaseHub({ storage }, e), storage });
const body = async (r: Response): Promise<{ version?: string }> => (await r.json()) as { version?: string };
const ping = (h: ReleaseHub, claim = "9.9.9"): Promise<Response> => h.fetch(new Request("https://release/refresh", { method: "POST", body: JSON.stringify({ version: claim }) }));
const waitFor = (h: ReleaseHub, have: string, signal?: AbortSignal): Promise<Response> => h.wait(have, signal);

test("versions and the release address", () => {
  expect(parseVersion("v1.2.3")).toEqual([1, 2, 3, 1]);
  expect(parseVersion("1.2.3-rc.1")).toEqual([1, 2, 3, 0]);
  expect(parseVersion("1.2")).toEqual([1, 2, 0, 1]);
  expect(parseVersion("junk")).toBeNull();
  expect(newer("0.2.0", "0.1.9")).toBe(true);
  expect(newer("0.2.0", "0.2.0-rc.1")).toBe(true);
  expect(newer("0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("garbage", "0.1.0")).toBe(false);
  expect(tagFrom("https://github.com/o/r/releases/tag/v1.2.3")).toBe("1.2.3");
  expect(tagFrom("https://github.com/o/r/releases")).toBeNull();
  expect(tagFrom("https://github.com/o/r/releases/tag/nightly")).toBeNull();
  expect(tagFrom(null)).toBeNull();
});

test("a PC that comes back behind is answered at once, from what GitHub says", async () => {
  const { hub: h } = hub();
  gh.latest = "1.3.0";
  const r = await waitFor(h, "1.0.0");
  expect(r.status).toBe(200);
  expect((await body(r)).version).toBe("1.3.0");
  expect(gh.reads).toBe(1);
});

test("a PC that is up to date is held, and every waiting PC is answered when a ping finds a newer release", async () => {
  const { hub: h } = hub(new Memory(), env({ RELEASE_WAIT_MS: "5000" }));
  gh.latest = "1.0.0";
  const a = waitFor(h, "1.0.0");
  const b = waitFor(h, "1.0.0");
  const behind = waitFor(h, "0.9.0");
  expect((await behind).status).toBe(200);
  await new Promise((r) => setTimeout(r, 20));
  expect(h.waiters.size).toBe(2);
  gh.latest = "1.1.0";
  h.readAt = 0;
  const p = await ping(h);
  expect((await body(p)).version).toBe("1.1.0");
  expect((await body(await a)).version).toBe("1.1.0");
  expect((await body(await b)).version).toBe("1.1.0");
  expect(h.waiters.size).toBe(0);
});

test("the ping is never believed: what its body claims does not matter", async () => {
  const { hub: h } = hub();
  gh.latest = "1.0.0";
  await waitFor(h, "1.0.0").then(() => undefined);
  const claimed = await ping(h, "9.9.9");
  expect((await body(claimed)).version).toBe("1.0.0");
  expect(h.version).toBe("1.0.0");
});

test("a ping naming a release GitHub doesn't show yet keeps reading GitHub until it does, then stops", async () => {
  const { hub: h, storage } = hub(new Memory(), env({ RELEASE_WAIT_MS: "5000" }));
  await h.refresh(true);
  const w = waitFor(h, "1.0.0");
  storage.alarm = null;
  h.readAt = 0;
  await ping(h, "1.1.0");
  expect(h.version).toBe("1.0.0");
  expect(storage.alarm).not.toBeNull();
  gh.latest = "1.1.0";
  h.readAt = 0;
  await h.alarm();
  expect((await body(await w)).version).toBe("1.1.0");
  expect(h.hint).toBeNull();
});

test("with PCs waiting, the alarm keeps the quick reread a lagging GitHub needs instead of the 10-minute one", async () => {
  const { hub: h, storage } = hub(new Memory(), env({ RELEASE_WAIT_MS: "5000" }));
  await h.refresh(true);
  const w = waitFor(h, "1.0.0");
  h.readAt = 0;
  await ping(h, "1.1.0");
  for (let i = 0; i < 3; i++) {
    h.readAt = 0;
    await h.alarm();
    expect(storage.alarm).not.toBeNull();
    expect(storage.alarm! - Date.now()).toBeLessThan(60_000);
  }
  gh.latest = "1.1.0";
  h.readAt = 0;
  await h.alarm();
  expect((await body(await w)).version).toBe("1.1.0");
});

test("a ping whose release never shows stops the quick rereads after a few minutes", async () => {
  const { hub: h, storage } = hub();
  await h.refresh(true);
  h.readAt = 0;
  await ping(h, "1.1.0");
  for (let i = 0; i < 60; i++) {
    storage.alarm = null;
    h.readAt = 0;
    await h.refresh(true);
  }
  expect(storage.alarm).toBeNull();
  expect(h.hint).toBeNull();
  expect(h.version).toBe("1.0.0");
});

test("POST /v1/release passes the version it names to the object as a hint", async () => {
  const { hub: h } = hub();
  await h.refresh(true);
  h.readAt = 0;
  const r = await releasePing(new Request("https://w/v1/release", { method: "POST", body: JSON.stringify({ version: "1.2.0" }) }), routed(h));
  expect((await body(r)).version).toBe("1.0.0");
  expect(h.hint).toBe("1.2.0");
});

test("no news within the wait answers 204 so the PC reconnects", async () => {
  const { hub: h } = hub();
  const r = await waitFor(h, "1.0.0");
  expect(r.status).toBe(204);
  expect(h.waiters.size).toBe(0);
});

test("a PC that goes away stops being held", async () => {
  const { hub: h } = hub(new Memory(), env({ RELEASE_WAIT_MS: "5000" }));
  const ac = new AbortController();
  const p = waitFor(h, "1.0.0", ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(h.waiters.size).toBe(1);
  ac.abort();
  expect((await p).status).toBe(204);
  expect(h.waiters.size).toBe(0);
});

test("pings close together read GitHub once and the rest are served by the alarm", async () => {
  const { hub: h, storage } = hub();
  await ping(h);
  await ping(h);
  await ping(h);
  expect(gh.reads).toBe(1);
  expect(storage.alarm).not.toBeNull();
  gh.latest = "1.2.0";
  h.readAt = 0;
  await h.alarm();
  expect(h.version).toBe("1.2.0");
});

test("a release whose files are not up yet is not announced, and is once they are", async () => {
  const { hub: h, storage } = hub(new Memory(), env({ RELEASE_WAIT_MS: "5000" }));
  await h.refresh(true);
  expect(h.version).toBe("1.0.0");
  const w = waitFor(h, "1.0.0");
  gh.latest = "1.1.0";
  gh.ready = false;
  h.readAt = 0;
  await ping(h);
  expect(h.version).toBe("1.0.0");
  expect(storage.alarm).not.toBeNull();
  gh.ready = true;
  h.readAt = 0;
  await h.alarm();
  expect((await body(await w)).version).toBe("1.1.0");
  expect(await storage.get("version")).toBe("1.1.0");
});

test("a release that never gets the update files (an old release) is never announced", async () => {
  const { hub: h } = hub();
  await h.refresh(true);
  gh.latest = "0.9.0";
  gh.ready = false;
  for (let i = 0; i < 50; i++) {
    h.readAt = 0;
    await h.alarm();
  }
  expect(h.version).toBe("1.0.0");
});

test("the news survives the object being thrown away: a new one answers from storage without asking GitHub", async () => {
  const storage = new Memory();
  const first = new ReleaseHub({ storage }, env());
  await first.refresh(true);
  const reads = gh.reads;
  const second = new ReleaseHub({ storage }, env());
  const r = await waitFor(second, "0.5.0");
  expect((await body(r)).version).toBe("1.0.0");
  expect(gh.reads).toBe(reads);
});

test("GitHub being unreachable leaves the old news and tries again later", async () => {
  const { hub: h, storage } = hub();
  await h.refresh(true);
  globalThis.fetch = stub(async () => {
    throw new Error("network");
  });
  h.readAt = 0;
  expect(await h.refresh(true)).toBe("1.0.0");
  expect(storage.alarm).not.toBeNull();
});

test("too many waiting PCs are told to come back later", async () => {
  const { hub: h } = hub(new Memory(), env({ RELEASE_WAIT_MS: "100" }));
  await h.refresh(true);
  const held = Array.from({ length: 1000 }, () => waitFor(h, "1.0.0"));
  await new Promise((r) => setTimeout(r, 20));
  const over = await waitFor(h, "1.0.0");
  expect(over.status).toBe(503);
  expect(over.headers.get("retry-after")).toBe("30");
  await Promise.all(held);
});

function routed(h: ReleaseHub): ReleaseEnv {
  return {
    RELEASES: {
      idFromName: (n) => n,
      get: () => ({ fetch: (url, init) => h.fetch(new Request(url, init)) }),
    },
  };
}

test("POST /v1/release answers 202 and asks GitHub; GET /v1/release/wait checks its question", async () => {
  const { hub: h } = hub();
  const e = routed(h);
  const r = await releasePing(new Request("https://w/v1/release", { method: "POST", body: "{}" }), e);
  expect(r.status).toBe(202);
  expect(await body(r)).toEqual({ ok: true, version: "1.0.0" } as { version?: string });
  const missing = await releaseWait(new Request("https://w/v1/release/wait"), e);
  expect(missing.status).toBe(400);
  const junk = await releaseWait(new Request("https://w/v1/release/wait?have=banana"), e);
  expect(junk.status).toBe(400);
  const behind = await releaseWait(new Request("https://w/v1/release/wait?have=0.1.0"), e);
  expect((await body(behind)).version).toBe("1.0.0");
  const current = await releaseWait(new Request("https://w/v1/release/wait?have=1.0.0"), e);
  expect(current.status).toBe(204);
});

test("the Durable Object only answers its two paths", async () => {
  const { hub: h } = hub();
  expect((await h.fetch(new Request("https://release/other"))).status).toBe(404);
  expect((await h.fetch(new Request("https://release/wait", { method: "POST" }))).status).toBe(404);
});

test("the worker routes the two endpoints and leaves the rest alone", async () => {
  const path = resolve(dirname(new URL(import.meta.url).pathname), "../../../../worker/src/index.js");
  const mod: unknown = await import(path);
  const worker = (mod as { default: { fetch: (req: Request, env: ReleaseEnv) => Promise<Response> }; ReleaseHub: unknown }).default;
  expect((mod as { ReleaseHub: unknown }).ReleaseHub).toBe(ReleaseHub);
  const { hub: h } = hub();
  const e = routed(h);
  const ping = await worker.fetch(new Request("https://w/v1/release", { method: "POST" }), e);
  expect(ping.status).toBe(202);
  const wait = await worker.fetch(new Request("https://w/v1/release/wait?have=0.0.1"), e);
  expect((await body(wait)).version).toBe("1.0.0");
  const wrong = await worker.fetch(new Request("https://w/v1/release", { method: "GET" }), e);
  expect(wrong.status).toBe(404);
  const other = await worker.fetch(new Request("https://w/v1/nothing"), e);
  expect(other.status).toBe(404);
});
