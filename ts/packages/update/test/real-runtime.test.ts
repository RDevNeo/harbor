import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Windows checks a new program before its first start (seconds): the runtime built here gets time for it.
if (process.platform === "win32") setDefaultTimeout(60_000);

const here = import.meta.dir;
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
/** A whole commit, as release.yml passes it. */
const SHA = "abcdef0123456789abcdef0123456789abcdef01";

async function run(args: string[], isolated = true, extra: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: isolated ? { ...process.env, HOME: dir, XDG_RUNTIME_DIR: dir, ...extra } : process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

beforeAll(async () => {
  dir = folder("real-");
  writeFileSync(join(dir, ".managed"), "");
  writeFileSync(join(dir, "VERSION"), "0.2.0");
  expect((await run([process.execPath, script, "runtime", join(dir, "harbor"), "--version", "0.1.0"], false)).code).toBe(0);
  expect((await run([process.execPath, script, "app", join(dir, "harbor-app.js"), "--version", "0.2.0", "--min-runtime", "0.1.0", "--sha", SHA], false)).code).toBe(0);
}, 120_000);

afterAll(() => {
  // Windows holds an executable a moment after the last process that ran it: tried again for up to 10 s.
  for (const d of folders) {
    for (let i = 0; ; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i >= 40 || !["EPERM", "EBUSY"].includes((e as { code?: string }).code ?? "")) throw e;
        Bun.sleepSync(250);
      }
    }
  }
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

test("the runtime's own sharp, sherpa and Slint load by path from where it wrote them: an image, an svg, the speech engine and the window's addon", async () => {
  const cache = folder("cache-");
  const r = await run([join(dir, "harbor"), "--check-native"], true, { XDG_CACHE_HOME: cache });
  expect(r.err).toBe("");
  expect(r.out).toMatch(/^sharp: ok, libvips \d+\.\d+\.\d+, a \d+ byte png, a \d+ byte png from an svg\nsherpa: ok\nslint: ok$/);
  expect(r.code).toBe(0);
  expect(readdirSync(join(cache, "harbor")).filter((d) => d.startsWith("native-"))).toHaveLength(1);
}, 30_000);

test("harbor --speech-worker starts from the compiled binary with sherpa's libraries found, and answers a request it cannot serve", async () => {
  const cache = folder("cache-");
  const model = folder("model-");
  const p = Bun.spawn([join(dir, "harbor"), "--speech-worker"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: dir, XDG_CACHE_HOME: cache } });
  p.stdin.write(`${JSON.stringify({ op: "load", dir: model })}\n`);
  p.stdin.write(`${JSON.stringify({ op: "nonsense" })}\n`);
  p.stdin.end();
  const lines = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l) as { error?: string });
  expect(await p.exited).toBe(0);
  expect(lines[1]?.error).toBe("unknown request");
  expect(lines[0]?.error).toBeDefined();
  expect(lines[0]?.error).not.toMatch(/libonnxruntime|libsherpa|Could not load|cannot open shared object/);
});

/** `harbor app discord` as an agent starts it: initialize, then the tool list. */
async function discordTools(env: Record<string, string>): Promise<{ tools: { name: string; description: string }[]; err: string }> {
  // As installed: no rig's HARBOR_DISCORD_* from the environment the tests run in.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HARBOR_DISCORD_")));
  const p = Bun.spawn([join(dir, "harbor"), "app", "discord"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...base, HOME: dir, XDG_RUNTIME_DIR: dir, XDG_DATA_HOME: join(dir, "data"), ...env } });
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await p.stdin.flush();
  let out = "";
  const reader = p.stdout.getReader();
  const until = Date.now() + 60_000;
  // The whole line: a long tool list comes in several reads.
  const answered = (): boolean => out.split("\n").slice(0, -1).some((l) => l.includes('"id":2'));
  while (!answered() && Date.now() < until) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  p.kill();
  const err = await new Response(p.stderr).text();
  const line = out.split("\n").find((l) => l.includes('"id":2')) ?? "{}";
  return { tools: (JSON.parse(line) as { result?: { tools?: { name: string; description: string }[] } }).result?.tools ?? [], err };
}

test("the bundle fetches its Discord shell at its own commit, never the runtime's version", async () => {
  const repoDiscord = resolve(here, "..", "..", "..", "..", "discord");
  const asked: string[] = [];
  let serve = false;
  const github = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      asked.push(path);
      const prefix = `/RDevNeo/harbor/${SHA}/discord/`;
      if (serve && path.startsWith(prefix)) return new Response(Bun.file(join(repoDiscord, path.slice(prefix.length))));
      return new Response("404: Not Found", { status: 404 });
    },
  });
  try {
    const env: Record<string, string> = { HARBOR_DISCORD_SHELL_ORIGIN: `http://127.0.0.1:${github.port}` };
    // GitHub doesn't have it: the agent still gets discord_status, which says why, and nothing is left half done.
    const failed = await discordTools(env);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((p) => p.startsWith(`/RDevNeo/harbor/${SHA}/discord/`))).toBe(true);
    expect(asked.some((p) => p.includes("0.1.0") || p.includes("0.2.0") || p.includes("0.109.0"))).toBe(false);
    expect(failed.tools.map((t) => t.name)).toEqual(["discord_status"]);
    expect(failed.tools[0]?.description).toContain("couldn't download its Discord shell");
    const app = join(dir, "data", "harbor", "apps", "discord");
    expect(readdirSync(app).filter((n) => n.startsWith("shell-"))).toEqual([]);
    // Now it does: every tool.
    serve = true;
    const ok = await discordTools(env);
    expect(ok.tools.length).toBeGreaterThan(20);
    expect(ok.tools.map((t) => t.name)).toContain("discord_send");
    expect(readdirSync(app).filter((n) => n.startsWith("shell-") && n.includes(".tmp"))).toEqual([]);
  } finally {
    github.stop(true);
  }
}, 120_000);
