import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";


let root: string;
let h: RunningHub;
let port = 0;
let repoId = 0;
let repoDir = "";
const saved = { ...process.env };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hts-worktree-"));
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
    HARBOR_PROFILE_RULES: "1",
  });
  repoDir = join(root, "home", "proj");
  for (const d of ["run", "state", repoDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repoDir, "a.txt"), "a");
  sh(repoDir, "init", "-q", "-b", "main");
  sh(repoDir, "add", "-A");
  sh(repoDir, "commit", "-q", "-m", "one");
  sh(repoDir, "branch", "feature");
  port = await freePort();
  const store = Store.open(dataDir());
  store.set("api_port", String(port));
  store.set("api_enabled", "1");
  store.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  repoId = store.addRepo(repoDir);
  h = await startHub({ version: "9.9.9", hookPort: await freePort(), store });
});

afterAll(async () => {
  await h.stop();
  h.store.close();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body = ""): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () => c.write(`${method} ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
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

async function json(method: string, path: string, body: unknown = {}): Promise<[number, Record<string, unknown>]> {
  const [status, text] = await call(method, path, method === "GET" ? "" : JSON.stringify(body));
  return [status, text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)];
}

test("a_chat_moves_to_a_worktree_is_renamed_there_and_the_worktree_goes_with_the_chat", async () => {
  const [, made] = await json("POST", "/v1/chats", { project_id: repoId, title: "Fix the login bug" });
  const id = made.id as number;
  const base = `/v1/chats/${id}`;
  const [, before] = await json("GET", `/v1/workspace?chat=${id}`);
  expect(before).toMatchObject({ git: true, mode: "checkout", branch: "main", can_move: true, can_rename: false });
  const [, moved] = await json("POST", `${base}/worktree`);
  const dir = moved.path as string;
  expect(moved.ok).toBe(true);
  expect(existsSync(dir)).toBe(true);
  expect(h.store.get(`worktree:${id}`)).toBe(dir);
  expect((await json("POST", `${base}/worktree`))[1].error).toBe("it already has its own worktree");
  const [, after] = await json("GET", `/v1/workspace?chat=${id}`);
  expect(after).toMatchObject({ mode: "worktree", can_move: false, can_rename: true, can_rename_folder: true, name: basename(dir) });
  const [, renamed] = await json("POST", `${base}/worktree/rename`, { branch: "harbor/renamed", remote: false });
  expect(renamed).toMatchObject({ ok: true, branch: "harbor/renamed", name: "proj-renamed", folder_waits: null });
  expect(existsSync(join(dirname(dir), "proj-renamed"))).toBe(true);
  expect(h.engine.takeNote(id, "next")).toContain("renamed this worktree's branch");
  expect(h.engine.takeNote(id, "next")).toBe("");
  expect((await json("POST", `${base}/worktree/rename`, { folder: "a/b" }))[0]).toBe(409);
  const [, folder] = await json("POST", `${base}/worktree/rename`, { folder: "my-folder" });
  expect(folder).toMatchObject({ ok: true, name: "my-folder" });
  expect(h.store.get(`worktree:${id}`)).toBe(join(dirname(dir), "my-folder"));
  await json("DELETE", base);
  for (let i = 0; i < 100 && existsSync(join(dirname(dir), "my-folder")); i++) await Bun.sleep(50);
  expect(existsSync(join(dirname(dir), "my-folder"))).toBe(false);
});

test("a_new_chat_can_start_in_a_new_worktree_and_branches_are_listed_created_and_switched", async () => {
  const [st, made] = await json("POST", "/v1/chats", { project_id: repoId, title: "Add a thing", worktree: true });
  expect(st).toBe(200);
  const dir = h.store.get(`worktree:${made.id}`) ?? "";
  expect(dir).not.toBe("");
  expect(existsSync(dir)).toBe(true);
  expect(h.store.items(made.id as number).some((i) => i.kind === "notice" && i.text.startsWith("Working in a new worktree"))).toBe(true);
  const [, list] = await json("GET", `/v1/branches?project=${repoId}&q=fea`);
  expect((list.branches as { name: string }[]).map((b) => b.name)).toEqual(["feature"]);
  expect((await json("POST", "/v1/branches", { project: repoId, create: "topic" }))[1]).toMatchObject({ ok: true, branch: "topic" });
  expect((await json("POST", "/v1/branches", { project: repoId, switch: "main" }))[1]).toMatchObject({ ok: true, branch: "main" });
  expect((await json("POST", "/v1/branches", {}))[0]).toBe(400);
  expect((await json("GET", "/v1/workspace?chat=99999"))[0]).toBe(404);
});
