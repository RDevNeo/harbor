import "./sandbox.ts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "@harbor/net";
import { type Grant, PORT, SUBSCRIPTION, close, enc, end, forwardedPort, grant, port, remoteConfig, resume, revoke, save, serving, setSlash, token, waits } from "../src/bridge.ts";
import type { Json } from "../src/json.ts";
import { forAccess } from "../src/workspace.ts";

waits.wait = 2000;
waits.tool = 4000;

afterAll(close);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A client on the bridge's port that keeps what it receives. */
class Client {
  readonly s: Socket;
  data = "";
  over = false;
  private wake: (() => void) | null = null;

  constructor(p: number) {
    this.s = connect(p, "127.0.0.1");
    this.s.setEncoding("utf8");
    this.s.on("data", (d: string) => {
      this.data += d;
      this.poke();
    });
    this.s.on("error", () => {});
    this.s.on("close", () => {
      this.over = true;
      this.poke();
    });
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  write(t: string): this {
    this.s.write(t);
    return this;
  }

  /** The end of the agent's input, as ssh passes on a client that gave up. */
  leave(): this {
    this.s.end();
    return this;
  }

  /** Waits for `ok` on what came so far; false after `ms`. */
  async until(ok: (d: string) => boolean, ms = 8000): Promise<boolean> {
    const stop = Date.now() + ms;
    while (!ok(this.data)) {
      if (this.over || Date.now() > stop) return ok(this.data);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
    return true;
  }

  /** Everything, once the bridge closes the connection; null if it doesn't within `ms`. */
  async all(ms = 8000): Promise<string | null> {
    await this.until(() => false, ms);
    return this.over ? this.data : null;
  }
}

function post(p: number, path: string, body: string, accept = "application/json, text/event-stream"): Client {
  return new Client(p).write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: ${accept}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function call(p: number, path: string, body: string): Promise<[number, string]> {
  const out = (await post(p, path, body).all()) ?? "";
  return [Number(out.split(" ")[1] ?? 0), out.split("\r\n\r\n").slice(1).join("\r\n\r\n")];
}

async function raw(p: number, req: string): Promise<string> {
  return (await new Client(p).write(req).all()) ?? "";
}

const base = (over: Partial<Grant> = {}): Grant => ({ token: token(), chat_id: 1, cwd: tmpdir(), servers: {}, commands: false, workspace: [], machines: null, ...over });
const parse = (s: string): { [k: string]: Json } => JSON.parse(s) as { [k: string]: Json };

/** Whether the bridge's end of the connection from local port `peer` sits in CLOSE_WAIT: the agent left and the bridge never closed (what kept a device's ssh open). */
function closeWait(bridgePort: number, peer: number): boolean {
  const want = `0100007F:${bridgePort.toString(16).toUpperCase().padStart(4, "0")} 0100007F:${peer.toString(16).toUpperCase().padStart(4, "0")} 08`;
  return readFileSync("/proc/net/tcp", "utf8")
    .split("\n")
    .some((l) => l.trim().split(/\s+/).slice(1, 4).join(" ") === want);
}

async function waitFor(what: string, ok: () => boolean): Promise<void> {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > 5000) throw new Error(what);
    await sleep(50);
  }
}

let work = "";
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "harbor-bridge-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("the port is not the phone API's", () => {
  expect(PORT).not.toBe(DEFAULT_PORT);
});

test("finds_the_forwarded_port: finds the forwarded port", () => {
  writeFileSync(join(work, "cmd.json"), JSON.stringify({ program: "ssh", args: ["-o", "BatchMode=yes", "-R", "127.0.0.1:31234:127.0.0.1:47931", "host", "cmd"] }));
  expect(forwardedPort(work)).toBe(47931);
  writeFileSync(join(work, "cmd.json"), JSON.stringify({ program: "claude", args: ["-p"] }));
  expect(forwardedPort(work)).toBeNull();
  expect(forwardedPort(join(work, "nowhere"))).toBeNull();
});

test("resume_drops_a_grant_whose_forward_port_is_taken: resume drops a grant whose forward port is taken", async () => {
  // Someone else holds the port the turn's ssh forwards to: its token isn't served.
  const squat: Server = createServer();
  await new Promise<void>((r) => squat.listen(0, "127.0.0.1", r));
  const p = (squat.address() as { port: number }).port;
  writeFileSync(join(work, "cmd.json"), JSON.stringify({ args: ["ssh", "-R", `127.0.0.1:20001:127.0.0.1:${p}`, "host"] }));
  const g = base({ commands: true });
  save(work, g);
  await resume(work);
  expect(serving(g.token)).toBe(false);
  // Free, it is served there again.
  await new Promise<void>((r) => squat.close(() => r()));
  await resume(work);
  expect(serving(g.token)).toBe(true);
  const there = await call(p, `/${g.token}/origin`, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
  expect(there[0]).toBe(200);
  revoke(g.token);
});

test("a saved grant reads back as written, and a Rust-shaped file with defaults too", async () => {
  const g = base({ servers: { s: { command: "x" } }, workspace: ["read"], machines: { chat: "c", project: "p", tools: ["read"], commander: "", memory_id: "" } });
  save(work, g);
  expect(JSON.parse(readFileSync(join(work, "bridge.json"), "utf8"))).toEqual(g);
  expect(readdirSync(work)).toEqual(["bridge.json"]);
  writeFileSync(join(work, "bridge.json"), JSON.stringify({ token: "t", chat_id: 2, cwd: "/p", servers: {}, commands: true, machines: null }));
  await resume(work);
  expect(serving("t")).toBe(true);
  end(work);
  expect(serving("t")).toBe(false);
  writeFileSync(join(work, "bridge.json"), "not json");
  await resume(work);
  end(work);
});

test("serves_stdio_and_origin_and_refuses_unknown_tokens: serves stdio and origin and refuses unknown tokens", async () => {
  // A stdio "server" that answers every request line with its own id.
  const echo = `while read -r l; do id=$(printf '%s' "$l" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p'); [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\\n' "$id"; done`;
  const g = base({ commands: true, servers: { echo: { type: "stdio", command: "sh", args: ["-c", echo] } } });
  const p = (await grant(g)) as number;
  let [code, body] = await call(p, `/${g.token}/echo`, '{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
  expect(code).toBe(200);
  expect(parse(body).id).toBe(7);
  [code] = await call(p, `/${g.token}/echo`, '{"jsonrpc":"2.0","method":"notifications/initialized"}');
  expect(code).toBe(202);
  [, body] = await call(p, `/${g.token}/origin`, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo hi"}}}');
  const text = (parse(body).result as { content: { text: string }[] }).content[0]?.text ?? "";
  expect(text.startsWith("hi\n")).toBe(true);
  expect((await call(p, "/nope/echo", "{}"))[0]).toBe(404);
  // Read only: no run_command (and no workspace tools that write or run).
  const ro = base({ token: token(), commands: false, workspace: forAccess("plan", false), servers: g.servers });
  await grant(ro);
  [, body] = await call(p, `/${ro.token}/origin`, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
  const names = ((parse(body).result as { tools: { name: string }[] }).tools).map((t) => t.name);
  expect(names).toEqual(["read", "glob", "grep"]);
  [, body] = await call(p, `/${ro.token}/origin`, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo hi"}}}');
  expect((parse(body).result as { isError: boolean }).isError).toBe(true);
  revoke(ro.token);
  revoke(g.token);
  expect((await call(p, `/${g.token}/echo`, "{}"))[0]).toBe(404);
  const cfg = remoteConfig(g, 50000) as { mcpServers: Record<string, { url: string; type: string }> };
  expect(cfg.mcpServers.origin).toEqual({ type: "http", url: `http://127.0.0.1:50000/${g.token}/origin` });
  expect(Object.keys(cfg.mcpServers)).toEqual(["echo", "origin"]);
  expect(decodeURIComponent(enc("Roblox Studio/x+y"))).toBe("Roblox Studio/x+y");
  expect(enc("Roblox Studio")).toBe("Roblox%20Studio");
});

test("origin tells who it is, offers the workspace and answers what it does not know", async () => {
  const g = base({ commands: true, workspace: ["read"] });
  const p = (await grant(g)) as number;
  const ask = async (m: Json): Promise<{ [k: string]: Json }> => parse((await call(p, `/${g.token}/origin`, JSON.stringify(m)))[1]);
  const init = (await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { [k: string]: Json } };
  expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "origin" } });
  expect(String(init.result.instructions)).toContain("your workspace is there");
  expect((await ask({ jsonrpc: "2.0", id: 2, method: "nope" })).error).toEqual({ code: -32601, message: "method not found" });
  expect((await ask({ jsonrpc: "2.0", id: 3, method: "ping" })).result).toEqual({});
  const list = (await ask({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((t) => t.name)).toEqual(["read", "run_command"]);
  writeFileSync(join(work, "f.txt"), "one\n");
  const read = (await ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read", arguments: { file_path: join(work, "f.txt") } } })) as { result: { content: Json[]; isError: boolean } };
  expect(read.result).toEqual({ content: [{ type: "text", text: "     1\tone\n" }], isError: false });
  const other = (await ask({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bash", arguments: { command: "true" } } })) as { result: { isError: boolean } };
  expect(other.result.isError).toBe(true);
  expect((await ask({ jsonrpc: "2.0", id: 7, method: "prompts/get", params: { name: "x" } })).error).toEqual({ code: -32602, message: "no prompt x" });
  revoke(g.token);
});

test("prompts come from the user's commands and skills", async () => {
  const home = process.env.HOME;
  process.env.HOME = work;
  setSlash({
    scan: (b) => {
      expect(b).toBe(join(work, ".claude"));
      return [
        { name: "a:b c", description: "A command", body: "Do $ARGUMENTS", skill: null },
        { name: "deploy", description: "A skill", body: "Steps", skill: "/skills/ship" },
      ];
    },
    withArgs: (body, args) => body.replace("$ARGUMENTS", args),
  });
  try {
    const g = base();
    const p = (await grant(g)) as number;
    const ask = async (m: Json): Promise<{ result: { [k: string]: Json } }> => parse((await call(p, `/${g.token}/origin`, JSON.stringify(m)))[1]) as { result: { [k: string]: Json } };
    const list = await ask({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(list.result.prompts).toEqual([
      { name: "a_b_c", description: "A command", arguments: [{ name: "arguments", description: "What to pass to it ($ARGUMENTS)", required: false }] },
      { name: "skill_ship", description: "A skill", arguments: [{ name: "arguments", description: "What to pass to it ($ARGUMENTS)", required: false }] },
    ]);
    const got = await ask({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "a_b_c", arguments: { arguments: "the thing" } } });
    expect(got.result).toEqual({ description: "A command", messages: [{ role: "user", content: { type: "text", text: "Do the thing" } }] });
    const skill = await ask({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "skill_ship" } });
    expect(JSON.stringify(skill.result)).toContain("Follow this skill. Its other files are on the Harbor PC in /skills/ship");
    revoke(g.token);
  } finally {
    setSlash(null);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test("bounds_requests: bounds requests", async () => {
  const g = base();
  const p = (await grant(g)) as number;
  // A chunk size alone allocates nothing: unknown token first, then too large.
  expect(await raw(p, "POST /nope/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n100000000000\r\n")).toStartWith("HTTP/1.1 404");
  expect(await raw(p, `POST /${g.token}/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n100000000000\r\n`)).toStartWith("HTTP/1.1 413");
  expect(await raw(p, `POST /${g.token}/origin HTTP/1.1\r\nContent-Length: ${64 << 20}\r\n\r\n`)).toStartWith("HTTP/1.1 413");
  expect(await raw(p, `POST /${g.token}/origin HTTP/1.1\r\nX: ${"a".repeat(9000)}\r\n\r\n`)).toStartWith("HTTP/1.1 431");
  // Chunked still works.
  const body = '{"jsonrpc":"2.0","id":4,"method":"ping"}';
  const out = await raw(p, `POST /${g.token}/origin HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
  expect(out.startsWith("HTTP/1.1 200") && out.includes('"id":4')).toBe(true);
  revoke(g.token);
});

test("answers the other methods and bad bodies as the transport asks", async () => {
  const g = base();
  const p = (await grant(g)) as number;
  expect(await raw(p, `DELETE /${g.token}/origin HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 200");
  const get = await raw(p, `GET /${g.token}/origin HTTP/1.1\r\n\r\n`);
  expect(get).toStartWith("HTTP/1.1 405");
  expect(get).toContain("Allow: POST, DELETE");
  expect((await call(p, `/${g.token}/origin`, "{nope"))[1]).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}');
  expect(await raw(p, "garbage\r\n\r\n")).toStartWith("HTTP/1.1 400");
  const batch = await call(p, `/${g.token}/origin`, '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"ping"}]');
  expect((JSON.parse(batch[1]) as { id: number }[]).map((r) => r.id)).toEqual([1, 2]);
  expect((await call(p, `/${g.token}/origin`, '[{"jsonrpc":"2.0","method":"notifications/initialized"}]'))[0]).toBe(202);
  expect((await call(p, `/${g.token}/unknown-server`, "{}"))[0]).toBe(404);
  revoke(g.token);
});

test("a_stdio_server_that_never_answers_holds_up_nothing: a stdio server that never answers holds up nothing", async () => {
  const pids = join(work, "pids");
  const log = join(work, "log");
  // Answers everything but `hang`; a listen gets only its acknowledgement, as a server of the 2026-07-28 protocol does.
  const script = `echo $$ >> '${pids}'
while read -r l; do
  printf '%s\\n' "$l" >> '${log}'
  id=$(printf '%s' "$l" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  m=$(printf '%s' "$l" | sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
  case "$m" in
    hang) ;;
    subscriptions/listen) printf '{"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"_meta":{"${SUBSCRIPTION}":%s}}}\\n' "$id" ;;
    *) [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\\n' "$id" ;;
  esac
done`;
  const g = base({ servers: { slow: { type: "stdio", command: "sh", args: ["-c", script] } } });
  const p = (await grant(g)) as number;
  const path = `/${g.token}/slow`;
  let [code, body] = await call(p, path, '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}');
  expect([code, parse(body).id]).toEqual([200, 0]);

  // A request it never answers doesn't hold up the next one (the agent's ids come back).
  const hung = post(p, path, '{"jsonrpc":"2.0","id":"a-1","method":"hang"}');
  await sleep(300);
  let t = Date.now();
  [code, body] = await call(p, path, '{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
  expect([code, parse(body).id]).toEqual([200, 7]);
  expect(Date.now() - t).toBeLessThan(1000);

  // The agent hangs up as ssh passes it on (an end of input, no reset): the bridge closes its side at once (no CLOSE_WAIT holding the ssh session open) and the server hears the request is off.
  const peer = (hung.s.localPort ?? 0) as number;
  t = Date.now();
  hung.leave();
  expect(await hung.all()).toBe("");
  expect(Date.now() - t).toBeLessThan(2000);
  expect(closeWait(p, peer)).toBe(false);
  await waitFor("the server hears of the cancel", () => readFileSync(log, "utf8").includes("notifications/cancelled"));

  // A listen streams its acknowledgement, under the agent's own id, and stays open (past any request's wait) until the agent leaves.
  const listen = post(p, path, '{"jsonrpc":"2.0","id":42,"method":"subscriptions/listen","params":{"notifications":{}}}');
  expect(await listen.until((d) => d.includes("data: "))).toBe(true);
  expect(listen.data.startsWith("HTTP/1.1 200") && listen.data.includes("text/event-stream")).toBe(true);
  expect(listen.data).toContain(`"${SUBSCRIPTION}":42`);
  const before = listen.data;
  await sleep(waits.wait + 500);
  expect(listen.over).toBe(false);
  expect(listen.data).toBe(before);
  const peer2 = (listen.s.localPort ?? 0) as number;
  listen.leave();
  expect(await listen.all()).not.toBeNull();
  expect(closeWait(p, peer2)).toBe(false);

  // Still connected, an unanswered request ends with an error after its time; a server that said nothing at all meanwhile is stopped, and the next request starts it again.
  t = Date.now();
  const out = (await post(p, path, '{"jsonrpc":"2.0","id":9,"method":"hang"}', "application/json").all()) ?? "";
  expect(Date.now() - t).toBeGreaterThanOrEqual(waits.wait - 50);
  expect(out).toContain('"id":9');
  expect(out).toContain("didn't answer");
  [, body] = await call(p, path, '{"jsonrpc":"2.0","id":10,"method":"tools/list"}');
  expect((parse(body).result as { ok: boolean }).ok).toBe(true);
  expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(2);
  // It came back initialized, as the agent left it.
  expect(readFileSync(log, "utf8").split('"method":"initialize"').length - 1).toBe(2);
  revoke(g.token);
}, 40_000);

test("ending_a_turn_waits_for_nothing_and_leaves_the_next_ones_grant: ending a turn waits for nothing and leaves the next one's grant", async () => {
  // A stopped turn whose server never answers a request still pending, and the chat's next turn, already running.
  const servers = { slow: { type: "stdio", command: "sh", args: ["-c", "while read -r l; do :; done"] } };
  const a = base({ chat_id: 3, servers });
  const b = { ...a, token: token() };
  const root = join(work, "turns");
  const [da, db] = [join(root, "3-1"), join(root, "3-2")];
  for (const [d, g] of [[da, a], [db, b]] as const) {
    mkdirSync(d, { recursive: true });
    save(d, g);
    await grant(g);
  }
  const p = (await port()) as number;
  const pending = post(p, `/${a.token}/slow`, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}');
  await sleep(300);
  const t = Date.now();
  end(da);
  expect(Date.now() - t).toBeLessThan(1000);
  // Its request hears that the server is gone.
  expect(await pending.all()).toContain("exited");
  expect((await call(p, `/${a.token}/slow`, "{}"))[0]).toBe(404);
  const [code, body] = await call(p, `/${b.token}/origin`, '{"jsonrpc":"2.0","id":2,"method":"ping"}');
  expect([code, parse(body).id]).toEqual([200, 2]);
  end(db);
});

describe("http servers", () => {
  test("a server's answer, status and kept headers reach the agent, and its tokens stay here", async () => {
    const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const web = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ method: req.method, url: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
        return new Response('{"ok":1}', { status: 201, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess", "X-Other": "dropped" } });
      },
    });
    try {
      const g = base({ servers: { web: { type: "http", url: `http://127.0.0.1:${web.port}/mcp`, headers: { Authorization: "Bearer secret" } } } });
      const p = (await grant(g)) as number;
      const out = (await post(p, `/${g.token}/web`, '{"hello":1}').all()) ?? "";
      expect(out).toStartWith("HTTP/1.1 201 X\r\n");
      expect(out.toLowerCase()).toContain("content-type: application/json");
      expect(out.toLowerCase()).toContain("mcp-session-id: sess");
      expect(out.toLowerCase()).not.toContain("x-other");
      expect(out).toContain("Connection: close");
      expect(out.endsWith('{"ok":1}')).toBe(true);
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.url).toBe("/mcp");
      expect(seen[0]?.body).toBe('{"hello":1}');
      expect(seen[0]?.headers.authorization).toBe("Bearer secret");
      expect(seen[0]?.headers["content-type"]).toBe("application/json");
      revoke(g.token);
    } finally {
      await web.stop(true);
    }
  });

  test("a head without kept headers still ends properly", async () => {
    const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("plain", { status: 200, headers: { "Content-Type": "" } }) });
    try {
      const g = base({ servers: { web: { type: "http", url: `http://127.0.0.1:${web.port}/` } } });
      const p = (await grant(g)) as number;
      const out = (await post(p, `/${g.token}/web`, "{}").all()) ?? "";
      const [head, body] = out.split("\r\n\r\n");
      expect(head?.split("\r\n")[0]).toBe("HTTP/1.1 200 X");
      expect(body).toBe("plain");
      revoke(g.token);
    } finally {
      await web.stop(true);
    }
  });

  test("a server that cannot be reached is a 502", async () => {
    const dead: Server = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const g = base({ servers: { web: { type: "http", url: `http://127.0.0.1:${deadPort}/` } } });
    const p = (await grant(g)) as number;
    expect((await call(p, `/${g.token}/web`, "{}"))[0]).toBe(502);
    revoke(g.token);
  });

  test("a_silent_http_stream_ends_when_its_agent_leaves: a silent http stream ends when its agent leaves", async () => {
    // An http server that never answers the first request, and opens an event stream for the second that goes silent after a first comment.
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const sport = (server.address() as { port: number }).port;
    let nth = 0;
    let came!: () => void;
    let cameP = new Promise<void>((r) => (came = r));
    const left: (() => void)[] = [];
    const leftP: Promise<void>[] = [0, 1].map(() => new Promise<void>((r) => left.push(r)));
    server.on("connection", (c) => {
      const mine = nth++;
      c.on("data", () => {
        came();
        if (mine === 1) c.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: hi\n\n");
      });
      c.on("close", () => left[mine]?.());
      c.on("error", () => {});
    });
    const g = base({ servers: { web: { type: "http", url: `http://127.0.0.1:${sport}/mcp` } } });
    const p = (await grant(g)) as number;
    const open = (): Client => new Client(p).write(`GET /${g.token}/web HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n`);
    const leave = async (c: Client, i: number): Promise<void> => {
      const peer = (c.s.localPort ?? 0) as number;
      const t = Date.now();
      c.leave();
      expect(await c.all()).not.toBeNull();
      expect(closeWait(p, peer)).toBe(false);
      await Promise.race([leftP[i], sleep(3000).then(() => Promise.reject(new Error("the request to the server was not stopped")))]);
      expect(Date.now() - t).toBeLessThan(3000);
    };
    // Gone before the server said anything.
    const first = open();
    await Promise.race([cameP, sleep(10_000)]);
    cameP = new Promise<void>((r) => (came = r));
    await leave(first, 0);
    // Gone while the stream is quiet.
    const second = open();
    expect(await second.until((d) => d.startsWith("HTTP/1.1 200"))).toBe(true);
    await leave(second, 1);
    revoke(g.token);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

test("tools of the machines server are served when the grant has it", async () => {
  const g = base({ machines: { chat: "g", project: "p", tools: ["read"], commander: "", memory_id: "" } });
  const p = (await grant(g)) as number;
  const [code, body] = await call(p, `/${g.token}/machines`, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  expect(code).toBe(200);
  expect(((parse(body).result as { tools: { name: string }[] }).tools).map((t) => t.name)).toEqual(["list", "read"]);
  const plain = base();
  await grant(plain);
  expect((await call(p, `/${plain.token}/machines`, "{}"))[0]).toBe(404);
  const cfg = remoteConfig(g, 1) as { mcpServers: Record<string, Json> };
  expect(Object.keys(cfg.mcpServers)).toEqual(["origin", "machines"]);
  revoke(g.token);
  revoke(plain.token);
});
