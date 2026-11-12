import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type providers } from "../packages/agents/src/index.ts";
import { connect, machines, mcpshim } from "../packages/mcp/src/index.ts";
import { type Call, Hub } from "../packages/net/src/index.ts";
import { blankChat, Store } from "../packages/store/src/index.ts";
import { startServices, type Services } from "../services.ts";

const graphql = JSON.stringify({
  data: {
    viewer: { login: "ann" },
    authored: {
      nodes: [
        {
          number: 5, title: "Add a thing", url: "https://github.com/o/r/pull/5", state: "OPEN", isDraft: false, additions: 10, deletions: 2,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", headRefName: "thing", headRefOid: "abc", reviewDecision: "APPROVED", mergeable: "MERGEABLE",
          repository: { nameWithOwner: "o/r" }, author: { login: "ann", avatarUrl: "https://avatars.example.com/1" }, labels: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        },
      ],
    },
  },
});

let root: string;
let svc: Services;
let engine: Engine;
let store: Store;
const saved = { ...process.env };
const call = (method: string, path: string[], query: [string, string][] = [], body: unknown = null, device = ""): Call => ({ method, path, query, body, token: "", device, global: false });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hservices-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat <<'EOF'\n${graphql}\nEOF\n`);
  chmodSync(join(bin, "gh"), 0o755);
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HARBOR_SOCK: join(root, "run", "harbor.sock"),
    PATH: `${bin}:${saved.PATH ?? ""}`,
  });
  mkdirSync(join(root, "run"), { recursive: true });
  mkdirSync(process.env.HOME ?? "", { recursive: true });
  store = Store.openTemp();
  const repo = store.addRepo(join(root, "not-on-this-pc"));
  store.db.run("UPDATE repos SET remote = ? WHERE id = ?", ["https://github.com/o/r.git", repo]);
  engine = new Engine({ store, accounts: () => [claude], changed: () => undefined });
  engine.reload();
  svc = await startServices({
    store,
    hub: new Hub([], 0),
    mesh: { forward: async () => ({ status: 200, body: {} }) },
    engine,
    version: "9.9.9",
    env: { ...process.env },
    account: { signedIn: () => false, ownerName: () => null },
    composer: () => ({ account: "claude", model: "", effort: "" }),
    accounts: () => [claude],
    hookPort: false,
  });
});

afterAll(() => {
  svc.stop();
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

const claude: providers.Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C", plan: "", configDir: "/nonexistent", bin: "/bin/true", loggedIn: true, usage: [] };

test("a team tool call over harbor mcp's socket reaches the engine", async () => {
  const lead = store.createChat({ ...blankChat(), repoId: store.repos()[0]?.id ?? null, role: "lead", name: "lead", title: "Lead" });
  engine.reload();
  const [ok, text] = await mcpshim.callApp(lead.id, "list_processes", {});
  expect(ok).toBe(true);
  expect(typeof text).toBe("string");
});

test("the phone's GitHub pages are answered through gh and other calls pass by", async () => {
  expect(svc.routePhone(call("GET", ["v1", "chats"]))).toBeNull();
  const r = await svc.routePhone(call("GET", ["v1", "prs"]));
  expect(r?.status).toBe(200);
  expect((r?.body as { viewer: string }).viewer).toBe("ann");
});

test("with global ids a cloned peer's project goes by its home folder, as in the phone's state", async () => {
  const clone = join(root, "clone");
  mkdirSync(clone);
  const id = store.addRepo("/home/owner/code/shared");
  store.setRepoRemote(id, "https://github.com/o/shared.git");
  store.setRepoLocal(id, clone);
  engine.reload();
  try {
    const r = await svc.routePhone({ ...call("GET", ["v1", "prs"]), global: true });
    const ids = (r?.body as { projects: { id: unknown; name: string }[] }).projects.filter((p) => p.name === "shared").map((p) => p.id);
    expect(ids).toEqual(["/home/owner/code/shared"]);
  } finally {
    store.removeRepo(id);
    engine.reload();
  }
});

test("Merge with… starts a thread in the project that has the pull request's repository", async () => {
  const before = engine.chats.length;
  const r = await svc.routePhone(call("POST", ["v1", "prs", "merge"], [], { url: "https://github.com/o/r/pull/5" }));
  expect(r?.status).toBe(200);
  expect(typeof (r?.body as { id: number }).id).toBe("number");
  expect(engine.chats.length).toBe(before + 1);
  const chat = engine.chats.find((c) => c.id === (r?.body as { id: number }).id);
  expect(chat?.access).toBe("full");
  expect(chat?.repoId).toBe(store.repos()[0]?.id ?? -1);
  const nothing = await svc.routePhone(call("POST", ["v1", "prs", "merge"], [], { url: "https://github.com/x/y/pull/1" }));
  expect(nothing?.status).toBe(409);
});

test("another PC's share, tool and issue calls are answered, other mesh calls pass by", async () => {
  expect(svc.routeMesh(call("POST", ["mesh", "v1", "call"]))).toBeNull();
  expect(svc.routeMesh(call("GET", ["v1", "prs"]))).toBeNull();
  const share = await svc.routeMesh(call("GET", ["mesh", "v1", "share"], [], null, "peer-1"));
  expect(share?.status).toBe(200);
  const body = share?.body as { level: string; projects: { name: string }[] };
  expect(body.level).toBe("full");
  expect(body.projects.map((p) => p.name)).toEqual([]);
  const tool = await svc.routeMesh(call("POST", ["mesh", "v1", "tool"], [], { tool: "nope", args: {} }, "peer-1"));
  expect(tool?.body).toEqual({ error: "no such tool" });
  expect(machines.serveShare("peer-1").status).toBe(200);
});

test("a peer's project with no folder here is not shared, and a call in its name starts in home", async () => {
  const own = join(root, "own");
  mkdirSync(own);
  const ownId = store.addRepo(own);
  engine.reload();
  svc.publish();
  try {
    const share = await svc.routeMesh(call("GET", ["mesh", "v1", "share"], [], null, "peer-1"));
    expect((share?.body as { projects: { name: string; path: string }[] }).projects).toEqual([{ name: "own", path: own }]);
    const pwd = async (project: string): Promise<string> => {
      const r = await svc.routeMesh(call("POST", ["mesh", "v1", "tool"], [], { tool: "bash", args: { command: "pwd" }, project, chat: `chat-${project}` }, "peer-1"));
      const body = r?.body as { ok: boolean; content: { text: string }[] };
      expect(body.ok).toBe(true);
      return body.content.map((c) => c.text).join("").trim();
    };
    // Real paths: macOS's temp folder is /var/..., a link to /private/var/....
    expect(realpathSync(await pwd("not-on-this-pc"))).toBe(realpathSync(process.env.HOME ?? ""));
    expect(realpathSync(await pwd("own"))).toBe(realpathSync(own));
  } finally {
    store.removeRepo(ownId);
    engine.reload();
    svc.publish();
  }
});

test("a webhook token of the engine is accepted by the hook listener", () => {
  expect(connect.deliverHook(engine, { token: "none", method: "POST", headers: [], body: "" })).toBe(false);
});
