import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const script = resolve(here, "..", "..", "..", "scripts", "build.ts");
const scratch = resolve(here, "..", ".tmp");
const folders: string[] = [];

function folder(prefix: string): string {
  mkdirSync(scratch, { recursive: true });
  const d = mkdtempSync(join(scratch, prefix));
  folders.push(d);
  return d;
}
let dir = "";

async function run(args: string[], isolated = true): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: isolated ? { ...process.env, HOME: dir, XDG_RUNTIME_DIR: dir } : process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

beforeAll(async () => {
  dir = folder("real-");
  writeFileSync(join(dir, ".managed"), "");
  writeFileSync(join(dir, "VERSION"), "0.2.0");
  expect((await run([process.execPath, script, "runtime", join(dir, "harbor"), "--version", "0.1.0"], false)).code).toBe(0);
  expect((await run([process.execPath, script, "app", join(dir, "harbor-app.js"), "--version", "0.2.0", "--min-runtime", "0.1.0", "--sha", "abcdef0123"], false)).code).toBe(0);
}, 120_000);

afterAll(() => {
  for (const d of folders) rmSync(d, { recursive: true, force: true });
});

test("the compiled runtime says its version and loads the real bundle built for it", async () => {
  expect(await run([join(dir, "harbor"), "runtime-version"])).toMatchObject({ out: "0.1.0", code: 0 });
  expect(await run([join(dir, "harbor"), "smoke-bundle", join(dir, "harbor-app.js")])).toMatchObject({ out: "harbor 0.2.0", code: 0 });
  expect(await run([join(dir, "harbor"), "--version"])).toMatchObject({ out: "harbor 0.2.0 (abcdef0)", code: 0 });
  expect(await run([join(dir, "harbor"), "preview", "status"])).toMatchObject({ out: "Previews are off on this PC.\nRunning the release.", code: 0 });
});

test("an unknown command is refused by the bundle", async () => {
  const r = await run([join(dir, "harbor"), "bogus"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown command bogus");
});

test("a bundle built for a newer runtime is refused before it runs", async () => {
  const other = folder("other-");
  const built = await run([process.execPath, script, "app", join(other, "harbor-app.js"), "--version", "0.3.0", "--min-runtime", "9.0.0"], false);
  expect(built.code).toBe(0);
  const r = await run([join(dir, "harbor"), "smoke-bundle", join(other, "harbor-app.js")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("needs runtime 9.0.0 or newer; this is 0.1.0");
});

test("--restore-previous with nothing kept says so and fails", async () => {
  const r = await run([join(dir, "harbor"), "--restore-previous"]);
  expect(r).toMatchObject({ code: 1, err: "harbor: no previous version kept" });
});

test("harbor turn runs the program of cmd.json and records its output and exit code", async () => {
  const turn = folder("turn-");
  const program = join(turn, "say.sh");
  writeFileSync(program, "#!/bin/sh\necho \"said $1\"\n");
  chmodSync(program, 0o755);
  writeFileSync(join(turn, "cmd.json"), JSON.stringify({ program, args: ["hello"], cwd: turn, env: [], input: false }));
  expect((await run([join(dir, "harbor"), "turn", turn])).code).toBe(0);
  expect(readFileSync(join(turn, "out"), "utf8")).toBe("said hello\n");
  expect(readFileSync(join(turn, "exit"), "utf8")).toBe("0");
});

test("harbor mcp answers the protocol itself and relays tool calls over the app's socket", async () => {
  const sock = join(folder("sock-"), "h.sock");
  const seen: string[] = [];
  const server = Bun.listen<{ text: string }>({
    unix: sock,
    socket: {
      open: (s) => void (s.data = { text: "" }),
      data: (s, d) => {
        s.data.text += d.toString();
        if (!s.data.text.includes("\n")) return;
        const call = JSON.parse(s.data.text) as { chat: number; tool: string };
        seen.push(`${call.chat}:${call.tool}`);
        s.write(`${JSON.stringify({ ok: true, text: `ran ${call.tool}` })}\n`);
        s.end();
      },
    },
  });
  try {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_processes", arguments: {} } },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n");
    const p = Bun.spawn([join(dir, "harbor"), "mcp", "--chat", "7"], { stdin: new Blob([`${input}\n`]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: dir, HARBOR_SOCK: sock } });
    const out = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: { serverInfo?: { version: string }; tools?: unknown[]; content?: Array<{ text: string }> } });
    expect(await p.exited).toBe(0);
    expect(out[0]?.result.serverInfo?.version).toBe("0.2.0");
    expect(out[1]?.result.tools?.length).toBeGreaterThan(5);
    expect(out[2]?.result.content?.[0]?.text).toBe("ran list_processes");
    expect(seen).toEqual(["7:list_processes"]);
  } finally {
    server.stop(true);
  }
});
