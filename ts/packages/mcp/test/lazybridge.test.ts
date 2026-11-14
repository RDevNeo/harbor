import "./sandbox.ts";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Grant, close, grant, parsePortFile, portFile, resumeWait, revoke, token, waits } from "../src/bridge.ts";
import type { Json } from "../src/json.ts";
import { dead, initialized, limits, markDead, resetCache, serverKey } from "../src/lazy.ts";
import { tools } from "../src/mcpshim.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const saved = { ...limits };
const savedWaits = { ...waits };

afterAll(close);

let work = "";
let fake = "";
let log = "";
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "harbor-lazy-"));
  resetCache(join(work, "mcp-cache.json"));
  log = join(work, "log");
  fake = join(work, "fake.ts");
  // A stdio MCP server that writes down when it starts and what it hears; FAKE_DELAY holds its first answer back.
  writeFileSync(
    fake,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = process.env.FAKE_LOG ?? "";
appendFileSync(log, "start " + process.pid + " " + Date.now() + "\\n");
// FAKE_HANG: while that file is there, it never answers (an app that isn't running).
if (process.env.FAKE_HANG && existsSync(process.env.FAKE_HANG)) await new Promise(() => {});
// FAKE_DELAY_FILE: how long it holds its first answer back, read at its start.
if (process.env.FAKE_DELAY_FILE) await Bun.sleep(Number(readFileSync(process.env.FAKE_DELAY_FILE, "utf8")));
await Bun.sleep(Number(process.env.FAKE_DELAY ?? "0"));
const listens = [];
const SUB = "io.modelcontextprotocol/subscriptionId";
for await (const line of console) {
  const m = JSON.parse(line);
  appendFileSync(log, "got " + m.method + "\\n");
  if (m.id === undefined) continue;
  if (m.method === "subscriptions/listen") {
    listens.push(m.id);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: { tools: true }, _meta: { [SUB]: m.id } } }) + "\\n");
    continue;
  }
  if (m.method === "tools/call") for (const l of listens) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUB]: l } } }) + "\\n");
  let result;
  if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" }, instructions: "be nice" };
  else if (m.method === "tools/list") result = { tools: [{ name: "hello", inputSchema: { type: "object" } }] };
  else if (m.method === "tools/call") result = { content: [{ type: "text", text: "pid " + process.pid + " chat " + (process.env.HARBOR_CHAT_ID ?? "") }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\\n"); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
}
`,
  );
});
afterEach(() => {
  Object.assign(limits, saved);
  Object.assign(waits, savedWaits);
  delete process.env.HARBOR_EXE;
  rmSync(work, { recursive: true, force: true });
});

const server = (env: Record<string, string> = {}): Json => ({ type: "stdio", command: process.execPath, args: [fake], env: { FAKE_LOG: log, ...env } });
const base = (over: Partial<Grant> = {}): Grant => ({ token: token(), chat_id: 1, cwd: tmpdir(), servers: {}, commands: false, workspace: [], machines: null, ...over });

async function rpc(p: number, path: string, msg: Json, headers = ""): Promise<{ [k: string]: Json } | null> {
  const body = JSON.stringify(msg);
  const out = await new Promise<string>((resolve) => {
    let data = "";
    const s = connect(p, "127.0.0.1");
    s.setEncoding("utf8");
    s.on("data", (d: string) => (data += d));
    s.on("error", () => resolve(data));
    s.on("close", () => resolve(data));
    s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\n${headers}Content-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  const text = out.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return text === "" ? null : (JSON.parse(text) as { [k: string]: Json });
}

const lines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const startsSeen = (): string[] => lines().filter((l) => l.startsWith("start "));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error(what);
    await sleep(25);
  }
}

/** What Claude Code sends to every server when a turn starts. */
async function handshake(p: number, path: string): Promise<{ init: Json; list: Json }> {
  expect((await rpc(p, path, { jsonrpc: "2.0", id: 9, method: "server/discover", params: {} }))?.error).toMatchObject({ code: -32601 });
  const init = await rpc(p, path, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } });
  expect(await rpc(p, path, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  const list = await rpc(p, path, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return { init: init?.result ?? null, list: list?.result ?? null };
}

test("a server answers the handshake from the cache, starts only for a tool call and stops when unused", async () => {
  limits.idle = 400;
  // The first turn ever fills the cache: the server starts once.
  const first = base({ servers: { fake: server() } });
  const p = (await grant(first)) as number;
  const fresh = await handshake(p, `/${first.token}/fake`);
  expect(fresh.init).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "fake" }, instructions: "be nice" });
  expect(startsSeen()).toHaveLength(1);
  const pid = Number(startsSeen()[0]?.split(" ")[1]);
  // Unused, it stops.
  await until("the idle server stops", () => !alive(pid));
  revoke(first.token);

  // Next turns: the same answers, and nothing starts.
  const next = base({ servers: { fake: server() } });
  await grant(next);
  const again = await handshake(p, `/${next.token}/fake`);
  expect(again).toEqual(fresh);
  const second = base({ servers: { fake: server() } });
  await grant(second);
  await handshake(p, `/${second.token}/fake`);
  expect(startsSeen()).toHaveLength(1);
  revoke(second.token);
  const before = 1;

  // A tool call starts it, initialized as the agent left it, and the tool list is asked again.
  const t = Date.now();
  const called = await rpc(p, `/${next.token}/fake`, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "hello", arguments: {} } });
  expect(Date.now() - t).toBeLessThan(5000);
  expect(JSON.stringify(called?.result)).toContain("pid ");
  expect(called?.id).toBe(9);
  expect(startsSeen()).toHaveLength(before + 1);
  const heard = lines().slice(lines().lastIndexOf(startsSeen().at(-1) ?? ""));
  expect(heard.slice(1, 3)).toEqual(["got initialize", "got notifications/initialized"]);
  expect(heard).toContain("got tools/call");
  await until("the cache is asked again", () => lines().slice(lines().lastIndexOf(startsSeen().at(-1) ?? "")).includes("got tools/list"));
  const pid2 = Number(startsSeen().at(-1)?.split(" ")[1]);
  // The turn ends: its server stops at once.
  revoke(next.token);
  await until("the turn's server stops", () => !alive(pid2));
}, 30_000);

test("Harbor's own app servers are one process for the turns with the same entry, until unused", async () => {
  limits.idle = 500;
  const exe = join(work, "harbor");
  writeFileSync(exe, `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`);
  chmodSync(exe, 0o755);
  process.env.HARBOR_EXE = exe;
  const def = (chat: string): Json => ({ type: "stdio", command: exe, args: ["app", "gmail"], env: { FAKE_LOG: log, HARBOR_CHAT_ID: chat } });
  const a = base({ servers: { gmail: def("7") } });
  const b = base({ servers: { gmail: def("7") } });
  const c = base({ servers: { gmail: def("8") } });
  const p = (await grant(a)) as number;
  await grant(b);
  await grant(c);
  const ask = (g: Grant, id: number): Promise<{ [k: string]: Json } | null> => rpc(p, `/${g.token}/gmail`, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "hello" } });
  await handshake(p, `/${a.token}/gmail`);
  const [ra, rb] = await Promise.all([ask(a, 1), ask(b, 2)]);
  expect(JSON.stringify(ra?.result)).toBe(JSON.stringify(rb?.result));
  expect(JSON.stringify(ra?.result)).toContain("chat 7");
  // Another chat's Discord-like entry is a process of its own (its chat differs).
  expect(JSON.stringify((await ask(c, 3))?.result)).toContain("chat 8");
  const pids = new Set(startsSeen().map((l) => Number(l.split(" ")[1])));
  expect(pids.size).toBe(2);
  // The turns end: the shared one keeps running until unused for a while, then stops.
  revoke(a.token);
  revoke(b.token);
  revoke(c.token);
  expect([...pids].some(alive)).toBe(true);
  await until("shared servers stop once unused", () => ![...pids].some(alive));
}, 30_000);

test("at most `limits.starts` servers start at once", async () => {
  limits.starts = 1;
  const gs = [0, 1, 2].map((i) => base({ servers: { [`s${i}`]: server({ FAKE_DELAY: "300", N: String(i) }) } }));
  let p = 0;
  for (const g of gs) p = (await grant(g)) as number;
  await Promise.all(gs.map((g, i) => rpc(p, `/${g.token}/s${i}`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } })));
  const at = startsSeen()
    .map((l) => Number(l.split(" ")[2]))
    .sort((x, y) => x - y);
  expect(at).toHaveLength(3);
  for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
  for (const g of gs) revoke(g.token);
}, 30_000);

test("the team server is served without a process, as the chat and role it was given", async () => {
  const sock = join(work, "harbor.sock");
  const heard: string[] = [];
  const listener = Bun.listen<undefined>({
    unix: sock,
    socket: {
      data(s, d) {
        const line = d.toString("utf8").trim();
        heard.push(line);
        const v = JSON.parse(line) as { chat: number; tool: string };
        s.write(`${JSON.stringify({ ok: true, text: `chat ${v.chat} ran ${v.tool}` })}\n`);
        s.end();
      },
    },
  });
  try {
    // The command doesn't exist: anything spawned would fail.
    const g = base({ chat_id: 12, servers: { harbor: { type: "stdio", command: join(work, "no-such-harbor"), args: ["mcp", "--chat", "12", "--role", "sub"], env: { HARBOR_SOCK: sock } } } });
    const p = (await grant(g)) as number;
    const { init, list } = await handshake(p, `/${g.token}/harbor`);
    expect(init).toMatchObject({ serverInfo: { name: "harbor" }, capabilities: { tools: {} } });
    expect((list as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(tools("sub").map((t) => String(t.name)));
    const r = await rpc(p, `/${g.token}/harbor`, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_agents", arguments: {} } });
    expect(r?.result).toEqual({ content: [{ type: "text", text: "chat 12 ran list_agents" }], isError: false });
    expect(heard).toEqual(['{"chat":12,"tool":"list_agents","args":{}}']);
    revoke(g.token);
  } finally {
    listener.stop(true);
  }
});

/** An open request whose answer streams in. */
function stream(p: number, path: string, msg: Json): { data: () => string; leave: () => void } {
  const body = JSON.stringify(msg);
  let data = "";
  const s = connect(p, "127.0.0.1");
  s.setEncoding("utf8");
  s.on("data", (d: string) => (data += d));
  s.on("error", () => {});
  s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return { data: () => data, leave: () => s.end() };
}

test("an open listen doesn't start the server or keep it up, and hears its events while it runs", async () => {
  limits.idle = 400;
  const listen = (id: string): Json => ({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { notifications: { tools: true } } });
  // First turn ever: the server starts once to learn its acknowledgement, then stops though the listen stays open.
  const a = base({ servers: { s: server() } });
  const p = (await grant(a)) as number;
  await handshake(p, `/${a.token}/s`);
  const la = stream(p, `/${a.token}/s`, listen("L1"));
  await until("the first acknowledgement", () => la.data().includes("acknowledged"));
  const pid = Number(startsSeen()[0]?.split(" ")[1]);
  await until("the idle server stops under an open listen", () => !alive(pid));
  la.leave();
  revoke(a.token);

  // Next turn: the acknowledgement under its own id, and nothing starts.
  const b = base({ servers: { s: server() } });
  await grant(b);
  await handshake(p, `/${b.token}/s`);
  const lb = stream(p, `/${b.token}/s`, listen("L2"));
  await until("the cached acknowledgement", () => lb.data().includes("acknowledged"));
  expect(lb.data()).toContain('"io.modelcontextprotocol/subscriptionId":"L2"');
  await sleep(200);
  expect(startsSeen()).toHaveLength(1);
  // A tool call starts it: the listen reaches it and its events reach the agent, without a second acknowledgement.
  await rpc(p, `/${b.token}/s`, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hello" } });
  await until("the event", () => lb.data().includes("list_changed"));
  expect(startsSeen()).toHaveLength(2);
  expect(lb.data().split("acknowledged").length - 1).toBe(1);
  expect(lb.data()).toContain('"notifications/tools/list_changed","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":"L2"}}');
  lb.leave();
  revoke(b.token);
}, 30_000);

// Codex's entries: the server's name in the path, the token as a bearer from its environment.
test("a grant is reached with its token as a bearer, and a wrong one is refused", async () => {
  resumeWait.window = 0;
  const g = base({ servers: { fake: server() } });
  const p = (await grant(g)) as number;
  expect(parsePortFile(readFileSync(portFile(), "utf8"))?.port).toBe(p);
  const call = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "hello" } };
  expect(JSON.stringify((await rpc(p, "/fake", call, `Authorization: Bearer ${g.token}\r\n`))?.result)).toContain("pid ");
  // A 404 (its body isn't JSON).
  await expect(rpc(p, "/fake", call, "Authorization: Bearer nope\r\n")).rejects.toThrow();
  await expect(rpc(p, "/fake", call)).rejects.toThrow();
  revoke(g.token);
}, 30_000);

// Shortly after a restart a turn's request may come before Harbor has picked the turn up again.
test("a request for a grant served a moment later waits for it", async () => {
  resumeWait.window = 60_000;
  resumeWait.ms = 3000;
  const g = base({ servers: { fake: server() } });
  const other = base();
  const p = (await grant(other)) as number;
  const asked = rpc(p, `/${g.token}/fake`, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "hello" } });
  await sleep(300);
  await grant(g);
  expect(JSON.stringify((await asked)?.result)).toContain("pid ");
  revoke(g.token);
  revoke(other.token);
}, 30_000);

test("a share-safe server (Roblox Studio's) is one process for every turn with the same entry; others stay a turn's own", async () => {
  limits.idle = 500;
  const rbx = join(work, "robloxstudio-mcp-ws");
  writeFileSync(rbx, `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`);
  chmodSync(rbx, 0o755);
  const roblox: Json = { type: "stdio", command: rbx, args: [], env: { FAKE_LOG: log } };
  // Codex's entry has no type and the same command line: the same server.
  const codexRoblox: Json = { command: rbx, args: [], env: { FAKE_LOG: log } };
  const a = base({ chat_id: 1, servers: { "Roblox Studio": roblox, own: server({ N: "1" }) } });
  const b = base({ chat_id: 2, cwd: work, servers: { Roblox_Studio: codexRoblox, own: server({ N: "1" }) } });
  const p = (await grant(a)) as number;
  await grant(b);
  const ask = (g: Grant, name: string, id: number): Promise<{ [k: string]: Json } | null> => rpc(p, `/${g.token}/${encodeURIComponent(name)}`, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "hello" } });
  const ra = await ask(a, "Roblox Studio", 1);
  const rb = await ask(b, "Roblox_Studio", 2);
  expect(JSON.stringify(ra?.result)).toBe(JSON.stringify(rb?.result));
  expect(startsSeen()).toHaveLength(1);
  // Not on the list: each turn's own.
  const [oa, ob] = await Promise.all([ask(a, "own", 3), ask(b, "own", 4)]);
  expect(JSON.stringify(oa?.result)).not.toBe(JSON.stringify(ob?.result));
  expect(startsSeen()).toHaveLength(3);
  const shared = Number(startsSeen()[0]?.split(" ")[1]);
  // One turn ends: the shared one stays for the other.
  revoke(a.token);
  await sleep(100);
  expect(alive(shared)).toBe(true);
  expect(JSON.stringify((await ask(b, "Roblox_Studio", 5))?.result)).toBe(JSON.stringify(ra?.result));
  revoke(b.token);
  await until("the shared server stops once unused", () => !alive(shared));
}, 30_000);

test("a server that never answers holds up one turn, not every one: later turns get a failed handshake at once, it's tried again in the background and served once it answers", async () => {
  waits.wait = 600;
  limits.deadAfter = 300;
  limits.retry = [1500, 1500];
  const hang = join(work, "hang");
  writeFileSync(hang, "");
  const def = server({ FAKE_HANG: hang });
  const discover = { jsonrpc: "2.0", id: 9, method: "server/discover", params: {} };
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } };
  // The first turn waits for it, as before (Claude Code gives up at 30 s; here `waits.wait`).
  const g1 = base({ servers: { s: def } });
  const p = (await grant(g1)) as number;
  let t = Date.now();
  expect(JSON.stringify((await rpc(p, `/${g1.token}/s`, discover))?.error)).toContain("didn't answer");
  expect(Date.now() - t).toBeGreaterThanOrEqual(550);
  expect(dead(serverKey(def as { [k: string]: Json }, tmpdir()))?.fails).toBe(1);
  expect(startsSeen()).toHaveLength(1);
  t = Date.now();
  expect(JSON.stringify((await rpc(p, `/${g1.token}/s`, init))?.error)).toContain("Harbor tries it again in the background");
  expect(Date.now() - t).toBeLessThan(400);
  revoke(g1.token);
  // The next turn: both answered at once, and nothing starts before its time comes.
  const g2 = base({ servers: { s: def } });
  await grant(g2);
  t = Date.now();
  expect((await rpc(p, `/${g2.token}/s`, discover))?.error).toMatchObject({ code: -32601 });
  expect((await rpc(p, `/${g2.token}/s`, init))?.error).toMatchObject({ code: -32000 });
  expect(Date.now() - t).toBeLessThan(400);
  revoke(g2.token);
  expect(startsSeen()).toHaveLength(1);
  // Its time came, and the app runs now: a turn still fails at once, but the server is tried again meanwhile...
  await sleep(1600);
  rmSync(hang);
  const g3 = base({ servers: { s: def } });
  await grant(g3);
  t = Date.now();
  expect((await rpc(p, `/${g3.token}/s`, discover))?.error).toMatchObject({ code: -32601 });
  expect((await rpc(p, `/${g3.token}/s`, init))?.error).toMatchObject({ code: -32000 });
  expect(Date.now() - t).toBeLessThan(400);
  revoke(g3.token);
  await until("the background start answers", () => initialized(serverKey(def as { [k: string]: Json }, tmpdir())));
  expect(dead(serverKey(def as { [k: string]: Json }, tmpdir()))).toBeNull();
  // ...and the next turn gets its handshake and tools as from any other server, without starting it.
  const g4 = base({ servers: { s: def } });
  await grant(g4);
  await until("the tool list is cached", () => lines().includes("got server/discover"));
  const n = startsSeen().length;
  const h = await handshake(p, `/${g4.token}/s`);
  expect(h.init).toMatchObject({ serverInfo: { name: "fake" } });
  expect(h.list).toMatchObject({ tools: [{ name: "hello" }] });
  expect(startsSeen()).toHaveLength(n);
  revoke(g4.token);
}, 30_000);

test("a slow first start taken for dead is lifted once it answers: the next turn gets its handshake and tools from the cache", async () => {
  waits.wait = 4000;
  limits.deadAfter = 300;
  const def = server({ FAKE_DELAY: "1200" });
  const key = serverKey(def as { [k: string]: Json }, tmpdir());
  const discover = { jsonrpc: "2.0", id: 9, method: "server/discover", params: {} };
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } };
  const g1 = base({ servers: { s: def } });
  const p = (await grant(g1)) as number;
  // The first turn's client gives up on it (Claude Code at 30 s; here 600 ms): it hangs up.
  const body = JSON.stringify(discover);
  const sock = connect(p, "127.0.0.1");
  sock.on("error", () => {});
  sock.write(`POST /${g1.token}/s HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  await sleep(600);
  sock.destroy();
  // Silent past `deadAfter`: taken for dead, so a turn now isn't held up; its start goes on.
  expect(dead(key)?.fails).toBe(1);
  const g2 = base({ servers: { s: def } });
  await grant(g2);
  const t = Date.now();
  expect((await rpc(p, `/${g2.token}/s`, discover))?.error).toMatchObject({ code: -32601 });
  expect((await rpc(p, `/${g2.token}/s`, init))?.error).toMatchObject({ code: -32000 });
  expect(Date.now() - t).toBeLessThan(400);
  revoke(g2.token);
  // It answers (1.2 s): no longer dead, and its handshake, tools and discover answer are cached.
  await until("it's lifted", () => dead(key) === null && initialized(key), 8000);
  await until("its tools are cached", () => lines().includes("got tools/list") && lines().filter((l) => l === "got server/discover").length >= 2, 8000);
  revoke(g1.token);
  const g3 = base({ servers: { s: def } });
  await grant(g3);
  const n = startsSeen().length;
  const h = await handshake(p, `/${g3.token}/s`);
  expect(h.init).toMatchObject({ serverInfo: { name: "fake" } });
  expect(h.list).toMatchObject({ tools: [{ name: "hello" }] });
  expect(startsSeen()).toHaveLength(n);
  revoke(g3.token);
}, 30_000);

test("a server slow on its first start, within `deadAfter`, isn't taken for dead", async () => {
  waits.wait = 3000;
  const def = server({ FAKE_DELAY: "800" });
  const g = base({ servers: { s: def } });
  const p = (await grant(g)) as number;
  const r = await rpc(p, `/${g.token}/s`, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  expect(r?.result).toMatchObject({ serverInfo: { name: "fake" } });
  expect(dead(serverKey(def as { [k: string]: Json }, tmpdir()))).toBeNull();
  revoke(g.token);
}, 30_000);

test("a dead server's next try: overlapping failed starts are one failure, only a failed try again waits longer", () => {
  limits.retry = [1000, 5000];
  markDead("k", false, 100);
  markDead("k", false, 900);
  expect(dead("k")).toEqual({ since: 100, fails: 1, next: 1100 });
  markDead("k", true, 1200);
  expect(dead("k")).toEqual({ since: 100, fails: 2, next: 6200 });
  markDead("k", true, 7000);
  expect(dead("k")).toEqual({ since: 100, fails: 3, next: 12000 });
});

test("a try again gives up waiting at `deadAfter` (the next try is set), but an answer later is still cached", async () => {
  waits.wait = 3000;
  limits.deadAfter = 300;
  limits.retry = [200, 200];
  const delay = join(work, "delay");
  writeFileSync(delay, "100000");
  const def = server({ FAKE_DELAY_FILE: delay });
  const key = serverKey(def as { [k: string]: Json }, tmpdir());
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } };
  const g1 = base({ servers: { s: def } });
  const p = (await grant(g1)) as number;
  void rpc(p, `/${g1.token}/s`, init);
  await until("taken for dead", () => dead(key) !== null);
  revoke(g1.token);
  // From now on it starts slowly (700 ms): the try again a turn starts is past `deadAfter` when it answers.
  writeFileSync(delay, "700");
  await sleep(250);
  const g2 = base({ servers: { s: def } });
  await grant(g2);
  expect((await rpc(p, `/${g2.token}/s`, init))?.error).toMatchObject({ code: -32000 });
  revoke(g2.token);
  await until("the try again's silence counted", () => (dead(key)?.fails ?? 0) >= 2);
  await until("its late answer cached", () => initialized(key) && dead(key) === null);
}, 30_000);
