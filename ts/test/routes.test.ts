import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictate } from "../packages/media/src/index.ts";
import { blankChat, dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";

// The routes the last Rust hub (0.109.0) answered, read from its src/*.rs before Rust was removed:
// phones in the field still call them.
const rustRoutes = (): string[] => JSON.parse(readFileSync(join(import.meta.dir, "rust-routes.json"), "utf8")) as string[];


let root: string;
let h: RunningHub;
let port = 0;
let chat = 0;
const saved = { ...process.env };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-routes-"));
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
    HARBOR_MESH_LOOPBACK: "1",
  });
  for (const d of ["home", "run", "state"]) mkdirSync(join(root, d), { recursive: true });
  port = await freePort();
  const store = Store.open(dataDir());
  store.set("api_port", String(port));
  store.set("api_enabled", "1");
  store.set("mesh_enabled", "1");
  store.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  chat = store.addRepo(join(root, "home"));
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store });
});

afterAll(async () => {
  dictate.takeDirty();
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body = ""): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () =>
      c.write(`${method} ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Id: pc:probe\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`),
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

const ABSENT = new Set(["no such call", "unknown call", "not found", "unknown mesh call", "unknown action"]);

async function answered(route: string): Promise<boolean> {
  const [method = "", template = ""] = route.split(" ");
  let n = 0;
  const own = h.store.createChat(blankChat({ title: "Probe", account: "claude", role: "lead", name: "lead", repoId: chat }));
  const path = template.replace(/\{\}/g, () => (n++ === 0 && template.includes("/chats/") ? String(own.id) : "1"));
  const [status, body] = await call(method, path, method === "GET" ? "" : "{}");
  if (status !== 404) return true;
  let error = "";
  try {
    error = (JSON.parse(body) as { error?: string }).error ?? "";
  } catch {
    error = body;
  }
  return !ABSENT.has(error);
}

const PENDING: string[] = [
];

test("every_route_the_rust_hub_answers_is_answered_by_the_ts_hub", async () => {
  const routes = rustRoutes();
  expect(routes.length).toBeGreaterThan(80);
  const missing: string[] = [];
  for (const r of routes) if (!(await answered(r))) missing.push(r);
  const fresh = missing.filter((r) => !PENDING.includes(r));
  const stale = PENDING.filter((r) => !missing.includes(r));
  console.log(`unanswered (${missing.length}):\n${missing.join("\n")}`);
  expect({ fresh, stale }).toEqual({ fresh: [], stale: [] });
}, 120000);

async function json(method: string, path: string, body: unknown = {}): Promise<[number, Record<string, unknown>]> {
  const [status, text] = await call(method, path, method === "GET" ? "" : JSON.stringify(body));
  return [status, text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)];
}

test("a_chat_is_snoozed_woken_settled_and_retitled_from_a_phone", async () => {
  const c = h.store.createChat(blankChat({ title: "Plain", account: "claude", role: "lead", name: "lead", repoId: chat }));
  h.engine.reload();
  const id = `/v1/chats/${c.id}`;
  expect((await json("POST", `${id}/snooze`, { text: "soon" }))[0]).toBe(400);
  const [st, set] = await json("POST", `${id}/snooze`, { text: "5h", off: 0 });
  expect(st).toBe(200);
  expect(typeof set.snoozed_until_ms).toBe("number");
  expect(set.snoozed_label).toEqual(expect.any(String));
  const [, sheet] = await json("GET", `/v1/snooze?chat=${c.id}&off=0&text=18:00`);
  expect((sheet.presets as unknown[]).length).toBe(4);
  expect(sheet.snoozed).toEqual(expect.stringMatching(/^until /));
  expect(sheet.preview).toEqual(expect.stringMatching(/^until /));
  expect((await json("DELETE", `${id}/snooze`))[1]).toEqual({ ok: true, snoozed_until_ms: null, snoozed_label: null });
  expect((await json("GET", `/v1/snooze?chat=${c.id}`))[1].snoozed).toBeNull();
  const [, patched] = await json("PATCH", id, { title: "  New title  ", settled: true });
  expect(patched.chat).toMatchObject({ title: "New title", settled: true });
  expect((await json("PATCH", id, { title: "  " }))[0]).toBe(400);
  const [, main] = await json("POST", `${id}/main`);
  expect(main).toMatchObject({ ok: true, chat: { settled: false } });
});

test("a_phone_moves_a_chat_to_a_workspace_only_when_the_account_has_some", async () => {
  const c = h.store.createChat(blankChat({ title: "Placed", account: "claude", role: "lead", name: "lead", repoId: chat }));
  h.engine.reload();
  const [st, menu] = await json("GET", `/v1/chats/${c.id}/workspaces`);
  expect(st).toBe(200);
  expect(menu).toEqual({ why: expect.stringMatching(/Sign in/), items: [] });
  expect((await json("POST", `/v1/chats/${c.id}/workspace`, { workspace: "org_x" }))[0]).toBe(400);
  expect((await json("POST", `/v1/chats/${c.id}/workspace`, { workspace: 5 }))[0]).toBe(400);
  // Clearing is always fine; the phone's chat JSON says where it was moved ("": its PC's).
  expect((await json("POST", `/v1/chats/${c.id}/workspace`, { workspace: "" }))[1]).toMatchObject({ ok: true, workspace: "" });
  h.store.setChatWorkspace(c.id, "org_b");
  const [, state] = await json("GET", "/v1/state");
  expect((state.chats as { id: unknown; workspace: unknown }[]).find((x) => x.id === c.id)?.workspace).toBe("org_b");
  expect((state.projects as { id: unknown; workspace: unknown }[]).find((p) => p.id === chat)?.workspace).toBe("");
  h.store.setChatWorkspace(c.id, "");
});

test("a_phone_reads_a_message_to_mention_and_a_team_of_agents", async () => {
  const lead = h.store.createChat(blankChat({ title: "Lead", account: "claude", role: "lead", name: "lead", repoId: chat }));
  const sub = h.store.createChat(blankChat({ title: "Task", account: "claude", role: "sub", parent: lead.id, name: "worker" }));
  h.store.saveItems(lead.id, [
    { kind: "user", text: "do it", files: [], at: 5, mentions: [], sender: "", intent: "" },
    { kind: "text", text: "Done and dusted.", at: 6 },
  ]);
  h.engine.reload();
  const [, m] = await json("GET", `/v1/chats/${lead.id}/mention?seq=1`);
  expect(m.mention).toEqual({ item: 1, from: "Claude", at: 6, text: "Done and dusted.", len: 16 });
  const [, part] = await json("POST", `/v1/chats/${lead.id}/mention`, { seq: 1, text: "dusted" });
  expect(part.mention).toMatchObject({ excerpt: true, text: "dusted", len: 6 });
  expect((await json("GET", `/v1/chats/${lead.id}/mention?seq=9`))[0]).toBe(404);
  const [, team] = await json("GET", `/v1/chats/${sub.id}/team`);
  expect(team).toMatchObject({ lead: lead.id, project_id: chat, agents: [{ id: sub.id, name: "worker", title: "Task", running: false, queued: 0, settled: false }], processes: [], wakeups: [], webhooks: [] });
  h.store.addWebhook(chat, "deploys", "tok123", "Vercel");
  h.engine.reload();
  const [, withHooks] = await json("GET", `/v1/chats/${lead.id}/team`);
  expect((withHooks.webhooks as { name: string; url: unknown; public: boolean }[]).map((w) => [w.name, typeof w.url, w.public])).toEqual([["deploys", "string", false]]);
  const [, usage] = await json("GET", "/v1/usage");
  expect(Object.keys(usage).sort()).toEqual(["accounts", "days", "limits", "projects"]);
  expect(Array.isArray(usage.limits)).toBe(true);
  const [, versions] = await json("GET", "/v1/versions");
  expect(versions.pcs).toHaveLength(1);
});

test("a_phone_creates_a_project_on_the_pc_and_starts_its_main_chat", async () => {
  const [, rows] = await json("POST", "/v1/projects/rows", { step: "new", query: "fresh" });
  expect((rows.rows as { act: unknown }[]).map((r) => r.act)).toEqual([
    { kind: "create", name: "fresh", git: true },
    { kind: "create", name: "fresh", git: false },
  ]);
  const [st, made] = await json("POST", "/v1/projects", { act: { kind: "create", name: "fresh", git: false } });
  expect(st).toBe(200);
  const dir = join(root, "home", "Projects", "fresh");
  expect(made).toMatchObject({ ok: true, path: dir, name: "fresh", git: false });
  const [, state] = await json("GET", "/v1/state");
  expect((state.projects as { id: unknown; path: string }[]).find((p) => p.path === dir)?.id).toBe(made.id);
  expect((await json("POST", "/v1/projects", { act: { kind: "create", name: "fresh", git: false } }))[1]).toEqual({ error: "~/Projects/fresh already exists" });
});

test("a_phone_opens_a_projects_menu_and_removes_it", async () => {
  const [, made] = await json("POST", "/v1/projects", { act: { kind: "create", name: "menued", git: false } });
  const pid = made.id as number;
  const c = h.store.createChat(blankChat({ title: "The main one", account: "claude", role: "lead", name: "lead", repoId: pid }));
  h.store.setMainChat(pid, c.id);
  h.engine.reload();
  const [st, menu] = await json("POST", "/v1/projects/menu", { project: pid });
  expect(st).toBe(200);
  expect(menu).toMatchObject({ id: pid, name: "menued", main: { id: c.id, title: "The main one" }, remote: null, github: null });
  expect((menu.items as { label: string }[]).map((i) => i.label)).toEqual(["Open terminal", "Rename main chat", "Settle main chat", "Refresh icon", "Choose icon…", "Move to workspace…", "Settle project", "Move to PC…", "Remove from Harbor"]);
  // Not signed in: greyed with why, and nothing to pick.
  expect((menu.items as { act: string }[]).find((i) => i.act === "move_workspace")).toMatchObject({ enabled: false, desc: expect.stringMatching(/Sign in/) });
  expect(menu.workspaces).toEqual({ why: expect.stringMatching(/Sign in/), items: [] });
  expect((await json("POST", "/v1/projects/do", { project: pid, act: "workspace", workspace: "org_x" }))[0]).toBe(400);
  const [gone] = await json("POST", "/v1/projects/do", { project: pid, act: "remove" });
  expect(gone).toBe(200);
  const [, state] = await json("GET", "/v1/state");
  expect((state.projects as { id: unknown }[]).some((p) => p.id === pid)).toBe(false);
  expect((await json("POST", "/v1/projects/menu", { project: pid }))[0]).toBe(404);
});

test("a_settled_project_leaves_the_phones_drawer_for_settled", async () => {
  const [, made] = await json("POST", "/v1/projects", { act: { kind: "create", name: "settling", git: false } });
  const pid = made.id as number;
  const c = h.store.createChat(blankChat({ title: "Its work", account: "claude", role: "lead", name: "lead", repoId: pid }));
  h.engine.reload();
  expect((await json("POST", "/v1/projects/do", { project: pid, act: "settle_project" }))[0]).toBe(200);
  const [, st] = await json("GET", "/v1/state");
  const tree = st.tree as { projects: { id: unknown }[]; settled: unknown[]; settled_projects: unknown[] };
  expect(tree.projects.some((p) => p.id === pid)).toBe(false);
  expect(tree.settled_projects).toContain(pid);
  expect(tree.settled).toContain(c.id);
  expect((st.projects as { id: unknown; settled: boolean }[]).find((p) => p.id === pid)?.settled).toBe(true);
  expect((st.chats as { id: unknown; settled: boolean }[]).find((x) => x.id === c.id)?.settled).toBe(true);
  // A new chat in it brings it back.
  h.store.createChat(blankChat({ title: "Next", account: "claude", role: "lead", name: "lead", repoId: pid }));
  h.engine.reload();
  const [, again] = await json("GET", "/v1/state");
  expect((again.tree as { projects: { id: unknown }[] }).projects.some((p) => p.id === pid)).toBe(true);
  expect((again.tree as { settled_projects: unknown[] }).settled_projects).not.toContain(pid);
});
