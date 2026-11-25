import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictate } from "../packages/media/src/index.ts";
import { blankChat, dataDir, secrets, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";
import { parseSpan } from "../secrettools.ts";

// Person Hub's engine: the secret tools' cards, patches to trust and the team's actions, through the phone API.
let root: string;
let h: RunningHub;
let port = 0;
let repo = 0;
const saved = { ...process.env };

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-secrets-"));
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
  for (const d of ["home", "run", "state", "home/proj"]) mkdirSync(join(root, d), { recursive: true });
  port = await freePort();
  const store = Store.open(dataDir());
  store.set("hub_api_port", String(port));
  store.set("api_enabled", "1");
  store.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  repo = store.addRepo(join(root, "home", "proj"));
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store });
});

afterAll(async () => {
  dictate.takeDirty();
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

function json(method: string, path: string, body: unknown = {}): Promise<[number, Record<string, unknown>]> {
  const text = method === "GET" || method === "DELETE" ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () =>
      c.write(`${method} ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Id: pc:probe\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`),
    );
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    c.on("error", reject);
    c.on("close", () => {
      const t = out.toString("utf8");
      const i = t.indexOf("\r\n\r\n");
      const b = i < 0 ? "" : t.slice(i + 4);
      resolve([Number(t.slice(9, 12)), b === "" ? {} : (JSON.parse(b) as Record<string, unknown>)]);
    });
  });
}

/** Answers reach the agent as messages: a retired chat takes none (no turn starts in a test). */
const quiet = (id: number, on: boolean): void => {
  const c = h.engine.chat(id);
  if (c) c.retired = on;
};

test("spans_from_a_card's_answer", () => {
  expect(parseSpan({ kind: "minutes", minutes: 5 })).toEqual({ kind: "minutes", minutes: 5 });
  expect(parseSpan({ kind: "minutes", minutes: 99999 })).toEqual({ kind: "minutes", minutes: secrets.MAX_MINUTES });
  expect(parseSpan({ kind: "not" })).toEqual({ kind: "not" });
  expect(parseSpan({ kind: "minutes" })).toBeNull();
  expect(parseSpan("5")).toBeNull();
});

test("a_key_asked_for_is_answered_through_the_api_and_used_hidden", async () => {
  const lead = h.store.createChat(blankChat({ title: "Keys", account: "claude", role: "lead", name: "lead", repoId: repo }));
  h.engine.reload();
  expect(await h.engine.tool(lead.id, "list_secrets", {})).toContain("No keys saved");
  expect(await h.engine.tool(lead.id, "request_secret", { name: "boat-key", reason: "To deploy", how_to_get: "https://example.com", env_file: ".env.local" })).toContain("BOAT_KEY");
  const [st, got] = await json("GET", `/v1/secrets/asks?chat=${lead.id}`);
  expect(st).toBe(200);
  const asks = got.asks as Record<string, unknown>[];
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ chat: lead.id, kind: "value", names: ["BOAT_KEY"], reason: "To deploy", agent: "lead", minutes: 15, how_to_get: "https://example.com", env_file: ".env.local", env_var: "BOAT_KEY" });
  expect((asks[0]?.spans as { kind: string }[]).map((s) => s.kind)).toEqual(["minutes", "minutes", "not"]);
  const id = String(asks[0]?.id);
  quiet(lead.id, true);
  expect((await json("POST", `/v1/secrets/asks/${id}`, { value: "ab" }))[0]).toBe(400);
  expect(await json("POST", `/v1/secrets/asks/${id}`, { value: "boat_secret_value_123", span: { kind: "minutes", minutes: 5 } })).toEqual([200, { ok: true }]);
  expect((await json("POST", `/v1/secrets/asks/${id}`, { value: "x" }))[0]).toBe(404);
  expect((await json("GET", `/v1/secrets/asks?chat=${lead.id}`))[1]).toEqual({ asks: [] });
  expect(readFileSync(join(root, "home", "proj", ".env.local"), "utf8")).toBe("BOAT_KEY=boat_secret_value_123\n");
  quiet(lead.id, false);
  expect(await h.engine.tool(lead.id, "list_secrets", {})).toContain("BOAT_KEY: To deploy [you may use it until");
  expect(await h.engine.tool(lead.id, "request_secret_access", { names: ["BOAT_KEY"], reason: "again" })).toContain("already");
  const out = await h.engine.tool(lead.id, "run_with_secrets", { command: 'echo "k=$BOAT_KEY"', secrets: ["BOAT_KEY"] });
  expect(out).toContain("k=[hidden: BOAT_KEY]");
  expect(out).not.toContain("boat_secret_value_123");
  // Another chat may not use it until the user says so; saying no ends the card.
  const other = h.store.createChat(blankChat({ title: "Other", account: "claude", role: "lead", name: "lead", repoId: repo }));
  h.engine.reload();
  await expect(h.engine.tool(other.id, "run_with_secrets", { command: "true", secrets: ["BOAT_KEY"] })).rejects.toThrow("not allowed now");
  await h.engine.tool(other.id, "request_secret_access", { names: ["BOAT_KEY"], reason: "tests", minutes: 30 });
  const ask = ((await json("GET", "/v1/secrets/asks"))[1].asks as { id: string; chat: number; kind: string }[]).find((a) => a.chat === other.id);
  expect(ask?.kind).toBe("use");
  quiet(other.id, true);
  expect(await json("POST", `/v1/secrets/asks/${ask?.id}`, { deny: true })).toEqual([200, { ok: true }]);
  quiet(other.id, false);
  await expect(h.engine.tool(other.id, "run_with_secrets", { command: "true", secrets: ["BOAT_KEY"] })).rejects.toThrow("not allowed now");
});

test("patches_to_trust_and_the_team's_actions", async () => {
  const lead = h.store.createChat(blankChat({ title: "Team", account: "claude", role: "lead", name: "lead", repoId: repo }));
  const dir = join(root, "home", "proj", ".hub", "patches");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hello.ts"), 'export default { actions: [{ title: "Site", url: "http://localhost:1" }, { title: "Where", run: "echo here-$((40+2))" }] };\n');
  const wake = h.store.addTimer(lead.id, Math.floor(Date.now() / 1000) + 3600, "later");
  h.store.addWebhook(repo, "deploys", "tok123", "");
  h.engine.reload();
  const [, list] = await json("GET", `/v1/chats/${lead.id}/patches/untrusted`);
  const pt = (list.patches as { id: string; title: string; state: string }[])[0];
  expect(pt).toMatchObject({ title: "hello", state: "untrusted" });
  expect(await json("POST", `/v1/chats/${lead.id}/patches/${pt?.id}/trust`, { trust: true })).toEqual([200, { ok: true }]);
  expect((await json("GET", `/v1/chats/${lead.id}/patches/untrusted`))[1]).toEqual({ patches: [] });
  const [, shelf] = await json("GET", `/v1/chats/${lead.id}/patches`);
  expect(shelf).toMatchObject({ links: [{ title: "Site", url: "http://localhost:1" }], untrusted: [], buttons: [{ title: "Where", kind: "command", desc: "Runs echo here-$((40+2))" }] });
  const button = (shelf.buttons as { id: string }[])[0]?.id ?? "";
  expect(button).toMatch(/^[A-Za-z0-9_.:-]{1,120}$/);
  expect(await json("POST", `/v1/chats/${lead.id}/patches/buttons/${button}`)).toEqual([200, { ok: true, text: "here-42\n" }]);
  expect((await json("POST", `/v1/chats/${lead.id}/patches/buttons/nope`))[0]).toBe(404);
  const [, team] = await json("GET", `/v1/chats/${lead.id}/team`);
  expect((team.wakeups as { id: number }[]).map((w) => w.id)).toEqual([wake]);
  const hook = (team.webhooks as { id: number }[])[0]?.id;
  expect(team.actions).toEqual(["stop_process", "cancel_wakeup", "wake_now", "delete_webhook", "settle_agent"]);
  expect(await json("POST", `/v1/chats/${lead.id}/team/wakeups/${wake}/cancel`)).toEqual([200, { ok: true }]);
  expect(await json("DELETE", `/v1/chats/${lead.id}/team/webhooks/${hook}`)).toEqual([200, { ok: true }]);
  expect((await json("DELETE", `/v1/chats/${lead.id}/team/wakeups/${wake}`))[0]).toBe(404);
  expect((await json("POST", `/v1/chats/${lead.id}/team/processes/12345/stop`))[0]).toBe(404);
  const [, after] = await json("GET", `/v1/chats/${lead.id}/team`);
  expect([after.wakeups, after.webhooks]).toEqual([[], []]);
});

test("order_of_projects_and_chats_and_settling_a_sub_agent", async () => {
  const second = h.store.addRepo(join(root, "home", "second"));
  const a = h.store.createChat(blankChat({ title: "A", account: "claude", role: "lead", name: "lead", repoId: second }));
  const b = h.store.createChat(blankChat({ title: "B", account: "claude", role: "lead", name: "lead", repoId: second }));
  const sub = h.store.createChat(blankChat({ title: "Sub", account: "claude", role: "sub", parent: a.id, name: "worker" }));
  h.engine.reload();
  const [, before] = await json("GET", "/v1/state");
  expect(before.reorder).toBe(true);
  expect(await json("POST", "/v1/order", { projects: [second, repo] })).toEqual([200, { ok: true }]);
  expect(await json("POST", "/v1/order", { project: second, chats: [a.id, b.id] })).toEqual([200, { ok: true }]);
  const [, st] = await json("GET", "/v1/state");
  const projects = (st.tree as { projects: { id: number; chats: number[] }[] }).projects;
  expect(projects.map((p) => p.id).slice(0, 2)).toEqual([second, repo]);
  const chats = projects.find((p) => p.id === second)?.chats ?? [];
  expect(chats.filter((c) => c === a.id || c === b.id)).toEqual([a.id, b.id]);
  expect((await json("POST", "/v1/order", {}))[0]).toBe(400);
  expect((await json("PATCH", `/v1/chats/${sub.id}`, { settled: true }))[0]).toBe(200);
  const [, team] = await json("GET", `/v1/chats/${a.id}/team`);
  expect((team.agents as { id: number; settled: boolean }[]).find((x) => x.id === sub.id)?.settled).toBe(true);
});
