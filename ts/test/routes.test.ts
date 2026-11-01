import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictate } from "../packages/media/src/index.ts";
import { blankChat, dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";

const rustSrc = join(import.meta.dir, "..", "..", "src");

const ACTIONS: Record<string, string[]> = {
  "/v1/chats/{}/{}": ["send", "stop", "resume", "retire", "fork", "move", "move_pc", "slash", "stop_all", "continue", "cancel_limit", "continue_on", "clone", "run_on"],
  "/v1/apps/gmail/{}": ["code", "start", "finish", "default", "signout"],
  "/v1/apps/discord/{}": ["signin", "window", "cancel", "signout"],
  "/v1/chats/{}/queue/{}/{}": ["steer", "move"],
};

const SKIPPED = new Set(["POST /v1/chats/{}/slash | move | main", "POST /mesh/v1/pair", "POST /mesh/v1/enroll", "POST /mesh/v1/mint", "GET /mesh/v1/events", "GET /v1/events"]);

function rustRoutes(): string[] {
  const out = new Set<string>();
  const arm = /\(\s*"(GET|POST|PATCH|PUT|DELETE)"\s*,\s*\[([^\]]*)\]/g;
  for (const f of ["api.rs", "commits.rs", "ghapi.rs", "mesh.rs", "worktree.rs"]) {
    for (const m of readFileSync(join(rustSrc, f), "utf8").matchAll(arm)) {
      const toks = (m[2] ?? "").split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => s !== "..");
      if (!/^"(v1|mesh)"/.test(toks[0] ?? "")) continue;
      let paths: string[][] = [[]];
      for (const tk of toks) {
        const alt = tk.match(/^\w+ @ \((.*)\)$/);
        if (alt) {
          const vs = (alt[1] ?? "").split("|").map((s) => s.trim().replaceAll('"', ""));
          paths = paths.flatMap((p) => vs.map((v) => [...p, v]));
        } else paths = paths.map((p) => [...p, tk.startsWith('"') ? tk.replaceAll('"', "") : "{}"]);
      }
      for (const p of paths) out.add(`${m[1]} /${p.join("/")}`);
    }
  }
  const all = [...out].flatMap((r) => {
    const [method = "", path = ""] = r.split(" ");
    const acts = ACTIONS[path];
    return acts ? acts.map((a) => `${method} ${path.replace(/\/\{\}$/, "")}/${a}`.replace("/queue/{}/", "/queue/{}/")) : [r];
  });
  return [...new Set(all.map((r) => r.replace(/\/\{\}\/(steer|move)$/, "/{}/$1")))].filter((r) => !SKIPPED.has(r) && !/\{\}\/\{\}$/.test(r)).sort();
}

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
  "GET /v1/branches",
  "GET /v1/workspace",
  "POST /mesh/v1/adopt",
  "POST /mesh/v1/adopt/check",
  "POST /mesh/v1/preview",
  "POST /v1/branches",
  "POST /v1/chats/{}/clone",
  "POST /v1/chats/{}/move_pc",
  "POST /v1/chats/{}/run_on",
  "POST /v1/chats/{}/worktree",
  "POST /v1/chats/{}/worktree/rename",
];

test("every_route_the_rust_hub_answers_is_answered_by_the_ts_hub", async () => {
  if (!existsSync(rustSrc)) return;
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

test("a_phone_reads_a_message_to_mention_and_a_team_of_agents", async () => {
  const lead = h.store.createChat(blankChat({ title: "Lead", account: "claude", role: "lead", name: "lead" }));
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
  expect(team).toMatchObject({ lead: lead.id, agents: [{ id: sub.id, name: "worker", title: "Task", running: false, queued: 0, settled: false }], processes: [], wakeups: [], webhooks: [] });
  const [, usage] = await json("GET", "/v1/usage");
  expect(Object.keys(usage).sort()).toEqual(["accounts", "days", "projects"]);
  const [, versions] = await json("GET", "/v1/versions");
  expect(versions.pcs).toHaveLength(1);
});
