import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { mcpshim } from "../packages/mcp/src/index.ts";
import { newPeer } from "../packages/net/src/index.ts";
import { blankChat, type Chat, dataDir, Store } from "../packages/store/src/index.ts";
import { type RunningHub, startHub } from "../hub.ts";

let root: string;
let h: RunningHub;
let port = 0;
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
  root = mkdtempSync(join(tmpdir(), "hts-hub-"));
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
  port = await freePort();
  const seed = Store.open(dataDir());
  seed.set("api_port", String(port));
  seed.set("api_enabled", "1");
  seed.set("api_tokens", JSON.stringify([{ token: "tok", name: "Pixel", created: 0, group: "", fp: "" }]));
  seed.close();
  h = await startHub({ version: "9.9.9", hookPort: await freePort() });
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

test("the hub starts offline on its own folders: engine, phone api, control socket", async () => {
  expect(h.engine).toBeDefined();
  expect(h.hub.port).toBe(port);
  const [st, body] = await call("GET", "/v1/state");
  expect(st).toBe(200);
  expect(JSON.parse(body)).toHaveProperty("rev");
  const lead = h.store.createChat({ ...blankChat(), role: "lead", name: "lead", title: "Lead" });
  h.engine.reload();
  const [ok, text] = await mcpshim.callApp(lead.id, "list_processes", {}, { path: process.env.HARBOR_SOCK ?? "" });
  expect([ok, text]).toEqual([true, "No processes."]);
});

test("a phone changes a chat's run settings through the desktop's rules", async () => {
  const c = h.store.createChat({ ...blankChat(), role: "lead", name: "lead", title: "Run", account: "claude", model: "claude-opus-5-5", access: "full" });
  h.engine.reload();
  let [st, body] = await call("PATCH", `/v1/chats/${c.id}`, JSON.stringify({ access: "root" }));
  expect(st).toBe(400);
  expect(body).toContain("no access level root");
  [st] = await call("PATCH", `/v1/chats/${c.id}`, JSON.stringify({ access: "plan", fast: true }));
  expect(st).toBe(200);
  expect(h.engine.chat(c.id)?.access).toBe("plan");
  expect(h.engine.fast).toBe(true);
  expect(h.store.get("fast_mode")).toBe("1");
});

test("a phone gets a reply's image from the hub", async () => {
  const img = join(root, "home", "shot.png");
  writeFileSync(img, await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer());
  const [st] = await call("GET", `/v1/image?path=${encodeURIComponent(img)}`);
  expect(st).toBe(200);
  const [missing] = await call("GET", `/v1/media?path=${encodeURIComponent(join(root, "nope.mp4"))}`);
  expect(missing).toBe(404);
});

test("every turn gets the machines server while the mesh has other PCs, on this PC and on a device", () => {
  const lead = h.store.createChat({ ...blankChat(), role: "lead", name: "lead", title: "Mesh", access: "full" });
  const chat = h.store.createChat({ ...blankChat(), title: "Plan", access: "plan" });
  h.engine.reload();
  const ctx = (c: Chat, remote: boolean) => h.engine.host.turnContext?.(c, remote) ?? null;
  expect(ctx(lead, false)?.machines ?? null).toBeNull();
  h.hub.mesh.on = true;
  h.hub.mesh.peers.set("pc-2", newPeer({ id: "pc-2", name: "Laptop", online: true }));
  try {
    for (const remote of [false, true]) {
      expect(ctx(lead, remote)?.machines).toEqual({ chat: lead.gid, project: "", tools: ["bash", "read", "glob", "grep"], commander: "", memory_id: "" });
      expect(ctx(chat, remote)?.machines).toEqual({ chat: chat.gid, project: "", tools: ["read", "glob", "grep"], commander: "", memory_id: "" });
      expect(ctx(lead, remote)?.note).toContain("mcp__machines__");
    }
    h.engine.host.adopt?.(lead.id, { peer: "pc-2", name: "Laptop", ctx: { owner: "Ana", memory_id: "m-1", memory: {} } });
    const guest = ctx(lead, false);
    expect(guest?.machines).toMatchObject({ commander: "pc-2", memory_id: "m-1" });
    expect(guest?.overlay).toContain("guests");
    expect(guest?.note).toContain("commanded from another PC");
    h.engine.host.adopt?.(lead.id, null);
    expect(ctx(lead, false)?.overlay ?? null).toBeNull();
  } finally {
    h.hub.mesh.peers.delete("pc-2");
    h.hub.mesh.on = false;
  }
});
