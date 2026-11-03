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
let ids: { plain: Chat; failing: Chat; lead: Chat; sub: Chat; other: Chat; limited: Chat; nofolder: Chat };

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
    limited: mk({ title: "Limited", account: "claude2" }),
    nofolder: mk({ title: "No folder", repoId: store.addRepo(join(root, "gone")) }),
  };
  writeFileSync(join(dataDir(), "harbor-android.apk"), "apk");
  writeFileSync(join(dataDir(), "harbor-android.version"), "10842");
  store.set("owner_suggested", JSON.stringify({ me: { owner: "Ana Souza", github: "anasouza", confidence: "high", why: "git user.name and gh login on this PC" }, peers: {}, by: "rules", at: 1, sig: "x" }));
  const until = Math.floor(Date.now() / 1000) + 3 * 3600 + 17 * 60;
  store.set("limits", JSON.stringify({ blocks: { claude2: { until, kind: "five_hour", known: true, tries: 1, cap: null } }, paused: { [ids.limited.id]: { account: "claude2", resume: true, at: until + 600, timer: null } }, pending: {}, quota: {} }));
  store.set("chat_prs", JSON.stringify({ [lead.id]: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", title: "Add it", branch: "add-it" } }));
  const account: providers.Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C1", plan: "", configDir: null, bin, loggedIn: true, usage: [] };
  const second: providers.Account = { ...account, id: "claude2", name: "Claude 2", email: "two@example.com", badge: "C2", configDir: join(root, "home", ".claude2") };
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store, engine: (host) => new Engine({ ...host, store, accounts: () => [account, second] }) });
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

type Bars = { working: { since_ms: number; subagents: number; text: string } | null; waiting: { agents: { name: string; title: string }[]; queued: number } | null; agents: { title: string; rows: { name: string; task: string; model: string; badge: string; doing: string }[] } | null; limit: { text: string; can_cancel: boolean; targets: { id: string; name: string }[] } | null; folder: { text: string; cloning: boolean; owner: unknown; action: string } | null };

async function bars(c: Chat): Promise<Bars> {
  const [, body] = await call("GET", `/v1/chats/${c.id}/items?since=0`);
  return (JSON.parse(body) as { status: Bars }).status;
}

test("the_bars_under_a_transcript_say_a_usage_limit_and_a_project_folder_that_is_not_here", async () => {
  const limited = await bars(ids.limited);
  expect(limited.limit?.text).toMatch(/^Usage limit · continuing at .* \(in 3h \d+m\)$/);
  expect([limited.limit?.can_cancel, limited.limit?.targets]).toEqual([true, [{ id: "claude", name: "Claude · C1 · " }]]);
  expect((await bars(ids.plain)).limit).toBeNull();
  const lost = await bars(ids.nofolder);
  expect([lost.folder?.text, lost.folder?.cloning, lost.folder?.owner, lost.folder?.action]).toEqual([`gone's folder (${join(root, "gone")}) isn't on this PC.`, false, null, "Use a folder here"]);
  expect((await bars(ids.plain)).folder).toBeNull();
});

test("a_lead_s_bars_count_its_running_sub_agents_while_it_waits_and_while_it_works", async () => {
  await send(ids.sub, "hold on");
  await until("the sub-agent running", async () => (await rows()).get(ids.sub.id)?.running === true);
  let b = await bars(ids.lead);
  expect(b.working).toBeNull();
  expect(b.waiting?.agents.map((a) => [a.name, a.title])).toEqual([["worker", "Sub"]]);
  expect(b.agents?.title).toBe("1 agent working");
  expect(b.agents?.rows.map((r) => [r.name, r.task, r.model, r.badge])).toEqual([["worker", "Sub", "Default", "C1"]]);
  expect((await bars(ids.sub)).working).toEqual({ since_ms: expect.any(Number), subagents: 0, text: "Working…" });
  await send(ids.lead, "hold lead");
  await until("the lead running", async () => (await rows()).get(ids.lead.id)?.running === true);
  b = await bars(ids.lead);
  expect([b.working?.subagents, b.working?.text, b.waiting]).toEqual([1, "Working…  ·  1 sub-agent running", null]);
  await until("the rest", async () => {
    const r = await rows();
    return r.get(ids.sub.id)?.running === false && r.get(ids.lead.id)?.running === false;
  }, 15000);
  b = await bars(ids.lead);
  expect([b.working, b.waiting, b.agents]).toEqual([null, null, null]);
}, 30000);

test("the_state_carries_the_app_s_version_code_and_the_owner_question_until_it_is_answered", async () => {
  const [, body] = await call("GET", "/v1/state");
  const st = JSON.parse(body) as { app: unknown; profile_check: unknown; hub_name: string };
  expect(st.app).toEqual({ version_code: 10842, url: "/app.apk" });
  expect(st.profile_check).toEqual({
    key: "Ana Souza|anasouza",
    title: "Is this you?",
    body: "Harbor detected Ana Souza · GitHub anasouza as this PC's owner. git user.name and gh login on this PC. Agents and your other PCs see it.",
  });
  expect(st.hub_name).not.toBe("");
  h.store.set("owner_name", "Ana Souza");
  const [, again] = await call("GET", "/v1/state");
  expect((JSON.parse(again) as { profile_check: unknown }).profile_check).toBeNull();
  h.store.set("owner_name", "");
});
