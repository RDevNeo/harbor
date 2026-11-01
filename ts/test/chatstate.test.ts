import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type providers } from "../packages/agents/src/index.ts";
import { blankChat, dataDir, Store, type Chat } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";

let root: string;
let h: RunningHub;
let port = 0;
const saved = { ...process.env };
let ids: { plain: Chat; failing: Chat; lead: Chat; sub: Chat; other: Chat };

const fakeClaude = `#!/usr/bin/env bun
const a = process.argv;
const sid = a[a.indexOf("--session-id") + 1] ?? a[a.indexOf("--resume") + 1] ?? "s";
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [] });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const text = JSON.parse(buf.slice(0, i)).message.content.at(-1).text;
    buf = buf.slice(i + 1);
    out({ type: "user", isReplay: true, message: { content: [{ type: "text", text }] } });
    if (text.includes("boom")) process.exit(1);
    if (text.includes("hold") && !text.includes("echo:")) await Bun.sleep(2500);
    out({ type: "assistant", message: { content: [{ type: "text", text: "echo: " + text }] } });
    out({ type: "result", subtype: "success", total_cost_usd: 0, duration_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  }
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-chatstate-"));
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HARBOR_SOCK: join(root, "run", "harbor.sock"),
    HARBOR_LISTEN: "127.0.0.1",
    HARBOR_NO_DISCOVERY: "1",
    HARBOR_TEST_NO_SIGNIN: "1",
  });
  for (const d of ["home", "run", "state"]) mkdirSync(join(root, d), { recursive: true });
  const bin = join(root, "claude");
  writeFileSync(bin, fakeClaude);
  chmodSync(bin, 0o755);
  port = await freePort();
  const store = Store.open(dataDir());
  store.set("api_port", String(port));
  store.set("api_enabled", "1");
  store.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  const mk = (over: Partial<Chat>): Chat => store.createChat(blankChat({ account: "claude", ...over }));
  const lead = mk({ title: "Lead", role: "lead", name: "lead" });
  ids = {
    plain: mk({ title: "Plain" }),
    failing: mk({ title: "Failing" }),
    lead,
    sub: mk({ title: "Sub", role: "sub", parent: lead.id, name: "worker" }),
    other: mk({ title: "Other" }),
  };
  store.set("chat_prs", JSON.stringify({ [lead.id]: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", title: "Add it", branch: "add-it" } }));
  const account: providers.Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "CL", plan: "", configDir: null, bin, loggedIn: true, usage: [] };
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store, engine: (host) => new Engine({ store, accounts: () => [account], ...host }) });
});

afterAll(async () => {
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body = ""): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () =>
      c.write(`${method} ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`),
    );
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    c.on("error", reject);
    c.on("close", () => {
      const t = out.toString("latin1");
      const i = t.indexOf("\r\n\r\n");
      resolve([Number(t.slice(9, 12)), i < 0 ? "" : out.subarray(i + 4).toString()]);
    });
  });
}

type Row = { id: number; pr: unknown; unread: boolean; failed: boolean; working: boolean; running: boolean; queued: number };

async function rows(): Promise<Map<number, Row>> {
  const [, body] = await call("GET", "/v1/state");
  return new Map((JSON.parse(body) as { chats: Row[] }).chats.map((c) => [c.id, c]));
}

async function until(what: string, f: () => Promise<boolean>, ms = 10000): Promise<void> {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const send = (c: Chat, text: string) => call("POST", `/v1/chats/${c.id}/send`, JSON.stringify({ text }));

test("a_chat_row_says_its_pull_request_from_the_lead_s_branch_and_nothing_for_the_rest", async () => {
  const r = await rows();
  const pr = { number: 7, state: "open", label: "PR #7 · Open", title: "Add it", url: "https://github.com/o/r/pull/7" };
  expect(r.get(ids.lead.id)?.pr).toEqual(pr);
  expect(r.get(ids.sub.id)?.pr).toEqual(pr);
  expect(r.get(ids.plain.id)?.pr).toBeNull();
  expect(h.prs.of(ids.lead)?.branch).toBe("add-it");
});

test("a_finished_turn_nobody_watched_is_unread_and_a_failed_one_says_so_until_a_phone_opens_it", async () => {
  expect([(await send(ids.plain, "hello"))[0], (await send(ids.failing, "boom"))[0], (await send(ids.other, "hello"))[0]]).toEqual([200, 200, 200]);
  await until("the turns' end", async () => {
    const r = await rows();
    return [ids.plain, ids.failing, ids.other].every((c) => r.get(c.id)?.unread === true && r.get(c.id)?.running === false);
  });
  let r = await rows();
  expect([r.get(ids.plain.id)?.failed, r.get(ids.failing.id)?.failed, r.get(ids.other.id)?.failed]).toEqual([false, true, false]);
  const [st] = await call("GET", `/v1/chats/${ids.failing.id}/items?since=0`);
  expect(st).toBe(200);
  r = await rows();
  expect([r.get(ids.failing.id)?.unread, r.get(ids.failing.id)?.failed]).toEqual([false, false]);
  expect([r.get(ids.plain.id)?.unread, r.get(ids.other.id)?.unread]).toEqual([true, true]);
});

test("a_lead_works_while_a_sub_agent_runs_though_its_own_turn_is_idle", async () => {
  let r = await rows();
  expect([r.get(ids.lead.id)?.working, r.get(ids.sub.id)?.working]).toEqual([false, false]);
  await send(ids.sub, "hold on");
  await until("the sub-agent running", async () => (await rows()).get(ids.sub.id)?.running === true);
  await call("POST", `/v1/chats/${ids.sub.id}/send`, JSON.stringify({ text: "later", mode: "queue" }));
  r = await rows();
  expect([r.get(ids.sub.id)?.queued, r.get(ids.lead.id)?.queued]).toEqual([1, 0]);
  const [, items] = await call("GET", `/v1/chats/${ids.sub.id}/items?since=0`);
  expect((JSON.parse(items) as { queued: number }).queued).toBe(1);
  expect([r.get(ids.sub.id)?.working, r.get(ids.lead.id)?.running, r.get(ids.lead.id)?.working, r.get(ids.plain.id)?.working]).toEqual([true, false, true, false]);
  await until("the sub-agent's end", async () => (await rows()).get(ids.sub.id)?.running === false);
  await until("the lead's rest", async () => (await rows()).get(ids.lead.id)?.running === false);
  r = await rows();
  expect(r.get(ids.lead.id)?.working).toBe(false);
}, 20000);
