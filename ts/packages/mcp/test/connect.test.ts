import "./sandbox.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@harbor/agents";
import { Store, blankChat } from "@harbor/store";
import { connect, deliverHook } from "../src/connect.ts";
import { askSocket } from "../src/mcpshim.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function setup(): { engine: Engine; store: Store; repo: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hconn-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = Store.openTemp();
  const project = join(dir, "proj");
  const repo = store.addRepo(project);
  const engine = new Engine({ store, accounts: () => [], changed: () => undefined });
  engine.repos = store.repos();
  return { engine, store, repo, dir };
}

test("a team tool call from an agent reaches the engine and its answer comes back", async () => {
  const { engine, store, repo, dir } = setup();
  const lead = store.createChat({ ...blankChat(), repoId: repo, role: "lead", name: "lead", title: "Lead" });
  engine.chats = store.chats();
  const path = join(dir, "h.sock");
  const c = connect({ engine, socket: path, hooks: 47960 });
  cleanup.push(() => c.stop());
  const ok = JSON.parse(await askSocket(path, JSON.stringify({ chat: lead.id, tool: "list_processes", args: {} }))) as { ok: boolean; text: string };
  expect(ok.ok).toBe(true);
  expect(typeof ok.text).toBe("string");
  const bad = JSON.parse(await askSocket(path, JSON.stringify({ chat: 9999, tool: "list_processes", args: {} }))) as { ok: boolean; text: string };
  expect(bad).toEqual({ ok: false, text: "unknown agent" });
  store.addWebhook(repo, "ci", "tok-2", "");
  engine.webhooks = store.webhooks();
  expect(engine.hookPort).toBeGreaterThanOrEqual(47960);
  const res = await fetch(`http://127.0.0.1:${engine.hookPort}/hooks/tok-2`, { method: "POST", body: "{}" });
  expect(res.status).toBe(202);
  expect((await fetch(`http://127.0.0.1:${engine.hookPort}/hooks/nope`, { method: "POST", body: "{}" })).status).toBe(404);
});

test("a webhook hit is noted in the lead's chat and starts a turn there", () => {
  const { engine, store, repo } = setup();
  const lead = store.createChat({ ...blankChat(), repoId: repo, role: "lead", name: "lead", title: "Lead" });
  engine.chats = store.chats();
  store.addWebhook(repo, "ci", "tok-1", "builds");
  engine.webhooks = store.webhooks();
  const started: string[] = [];
  engine.trigger = (id, prompt, auto) => void started.push(`${id} ${auto} ${prompt.split("\n")[0]}`);
  const hit = { token: "tok-1", method: "POST", headers: [["x-github-event", "push"]] as [string, string][], body: '{"a":1}' };
  expect(deliverHook(engine, hit)).toBe(true);
  expect(started).toEqual([`${lead.id} true [webhook ci] POST request received.`]);
  expect(engine.webhooks[0]?.hits).toBe(1);
  expect(deliverHook(engine, { ...hit, token: "nope" })).toBe(false);
});
