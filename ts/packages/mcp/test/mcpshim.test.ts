import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSocket } from "../src/control.ts";
import type { Json } from "../src/json.ts";
import { callApp, run, tools } from "../src/mcpshim.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hshim-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const names = (role: string): string[] => tools(role).map((t) => String(t.name));

test("only_leads_open_chats: only leads open chats", () => {
  for (const t of ["open_chat", "list_chats", "message_chat"]) {
    expect(names("lead")).toContain(t);
    expect(names("sub")).not.toContain(t);
  }
  const open = tools("lead").find((t) => t.name === "open_chat");
  expect((open?.inputSchema as { required: string[] }).required).toEqual(["prompt"]);
});

test("only_leads_retire_agents: only leads retire agents", () => {
  expect(names("lead")).toContain("retire_agent");
  expect(names("sub")).not.toContain("retire_agent");
  const retire = tools("lead").find((t) => t.name === "retire_agent");
  expect((retire?.inputSchema as { required: string[] }).required).toEqual(["agent"]);
});

test("subs get the team tools and everyone the shared ones", () => {
  expect(names("sub")).toContain("send_message");
  expect(names("sub")).toContain("read_messages");
  expect(names("lead")).not.toContain("send_message");
  expect(names("lead")).toHaveLength(27);
  // Only the lead moves agents between accounts.
  expect(names("lead")).toContain("switch_agent_account");
  expect(names("sub")).not.toContain("switch_agent_account");
  expect(names("sub")).toHaveLength(13);
  for (const t of ["list_processes", "start_process", "list_secrets", "run_with_secrets", "find_chats"]) expect(names("sub")).toContain(t);
});

test("leads steer or queue their messages and take queued ones back", () => {
  const lead = tools("lead");
  for (const n of ["message_agent", "message_chat"]) {
    const s = lead.find((t) => t.name === n)?.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(s.properties.mode?.enum).toEqual(["queue", "steer"]);
    expect(s.required).not.toContain("mode");
  }
  const un = lead.find((t) => t.name === "unqueue_message")?.inputSchema as { required: string[] };
  expect(un.required).toEqual(["id"]);
  expect(names("sub")).not.toContain("unqueue_message");
});

async function* from(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

test("the stdio server answers initialize, tools/list, tools/call, ping and unknown methods", async () => {
  const out: Json[] = [];
  const calls: [number, string, Json][] = [];
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "not json",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: { x: 1 } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nope" }),
  ];
  await run(["--chat", "42", "--role", "lead"], {
    version: "9.9.9",
    io: { lines: from(lines), write: (l) => (out.push(JSON.parse(l) as Json), true) },
    call: async (c, n, a) => (calls.push([c, n, a]), [false, "boom"]),
  });
  expect(out).toHaveLength(5);
  expect(out[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "harbor", version: "9.9.9" } } });
  const list = out[1] as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((t) => t.name)).toContain("spawn_agent");
  expect(out[2]).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "boom" }], isError: true } });
  expect(calls).toEqual([[42, "list_agents", { x: 1 }]]);
  expect(out[3]).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
  expect(out[4]).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "method not found" } });
});

test("the server stops when the client went away", async () => {
  let n = 0;
  await run([], { io: { lines: from([JSON.stringify({ id: 1, method: "ping" }), JSON.stringify({ id: 2, method: "ping" })]), write: () => (n++, false) } });
  expect(n).toBe(1);
});

test("calls reach the app over its socket", async () => {
  const path = join(root, "h.sock");
  const l = startSocket({
    path,
    send: (i) => {
      if (i.kind === "tool") i.call.reply(true, `chat ${i.call.chatId} ran ${i.call.tool}`);
    },
  });
  expect(await callApp(5, "list_agents", {}, { path })).toEqual([true, "chat 5 ran list_agents"]);
  l?.stop();
});

test("a missing socket reports that Harbor is not running", async () => {
  expect(await callApp(1, "x", {}, { path: join(root, "none.sock"), waitMs: 300 })).toEqual([false, "Harbor is not running"]);
});

test("an app that closes without answering says it restarted", async () => {
  const path = join(root, "h.sock");
  const server = Bun.listen<undefined>({ unix: path, socket: { data(s) {
        s.end();
      }, open() {}, close() {}, error() {} } });
  const [ok, text] = await callApp(1, "x", {}, { path });
  expect(ok).toBe(false);
  expect(text).toStartWith("Harbor restarted before answering");
  server.stop(true);
});

test("`harbor mcp` over real stdio, relaying to a fake app", async () => {
  const path = join(root, "h.sock");
  const l = startSocket({
    path,
    send: (i) => {
      if (i.kind === "tool") i.call.reply(true, `ran ${i.call.tool}`);
    },
  });
  const script = join(root, "main.ts");
  writeFileSync(script, `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/mcpshim.ts"))};\nawait run(process.argv.slice(2), { version: "1.2.3" });\n`);
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_processes", arguments: {} } }),
    "",
  ].join("\n");
  const p = Bun.spawn([process.execPath, script, "--chat", "3", "--role", "sub"], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HARBOR_SOCK: path } });
  const text = await new Response(p.stdout).text();
  await p.exited;
  const replies = text.trim().split("\n").map((x) => JSON.parse(x) as { id: number; result: Json });
  expect(replies.map((r) => r.id)).toEqual([1, 2]);
  expect(replies[1]?.result).toEqual({ content: [{ type: "text", text: "ran list_processes" }], isError: false });
  l?.stop();
});
