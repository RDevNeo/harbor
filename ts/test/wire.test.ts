import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, movechat, setAgentEnv, signedOutEnv } from "../packages/agents/src/index.ts";
import { bridge } from "../packages/mcp/src/index.ts";
import { profileSetup, shSetup } from "../packages/net/src/index.ts";
import { wire } from "../wire.ts";

const before = { ...agent.integrations };
afterAll(() => {
  bridge.close();
  agent.integrate(before);
  setAgentEnv(signedOutEnv);
});

test("remote_turn_sends_the_login_on_stdin through net's launcher and mcp's bridge", async () => {
  wire();
  const home = process.env.HOME ?? "/";
  const configDir = join(home, ".claude2");
  const account = { id: "claude2", kind: "Claude" as const, name: "Claude 2", email: "", badge: "C2", plan: "", configDir, bin: null, loggedIn: true, usage: [] };
  const spec = (token: string | null): agent.TurnSpec => ({
    chatId: 999_996,
    cwd: tmpdir(),
    prompt: "hi",
    files: [],
    sessionId: "abc",
    resume: true,
    account,
    model: "",
    effort: "",
    access: "full",
    team: null,
    fast: false,
    base: 0,
    remote: { ssh: ["-o", "BatchMode=yes"], host: "box", name: "box", family: "posix", dir: "~", setup: profileSetup(home, configDir), bridge: false, commands: false, workspace: false, token, note: "" },
    trusted: true,
    context: agent.ownContext(),
  });
  let { cmd, stdin, grant } = await agent.build(spec("sk-ant-oat01-secret"));
  if (grant) bridge.revoke(grant.token);
  const input = stdin ?? "";
  const nl = input.indexOf("\n");
  expect(input.slice(0, nl)).toBe("sk-ant-oat01-secret");
  const rest = input.slice(nl + 1);
  expect(rest.startsWith("{")).toBe(true);
  expect(rest).toContain('"type":"user"');
  expect(rest.endsWith("\n")).toBe(true);
  expect(cmd.args.some((a) => a.includes("sk-ant-oat01"))).toBe(false);
  const script = cmd.args[cmd.args.length - 1] ?? "";
  const at = (needle: string): number => {
    const i = script.indexOf(needle);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };
  const [login, profile, session, cli] = [at("read -r CLAUDE_CODE_OAUTH_TOKEN"), at("export CLAUDE_CONFIG_DIR="), at("/projects"), at("--input-format")];
  expect(login < profile && profile < session && session < cli).toBe(true);
  // Not signed in here: no line reads stdin, the message comes first.
  ({ cmd, stdin, grant } = await agent.build(spec(null)));
  if (grant) bridge.revoke(grant.token);
  expect(stdin?.startsWith("{")).toBe(true);
  expect(cmd.args.some((a) => a.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(false);
});

// The line a POSIX device runs (remote.ts remoteCommand), run here with sh: Linux and macOS, not Windows.
test.if(process.platform !== "win32")("resumed_sessions_follow_the_folder", () => {
  const root = mkdtempSync(join(tmpdir(), "hts-sess-"));
  try {
    const cfg = join(root, "cfg");
    const work = join(root, "my work");
    mkdirSync(join(cfg, "projects/-elsewhere"), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(cfg, "projects/-elsewhere/abc.jsonl"), "{}");
    const r = Bun.spawnSync(["sh", "-c", shSetup({ kind: "session", id: "abc" })], { cwd: work, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
    expect(r.success).toBe(true);
    expect(existsSync(join(cfg, "projects", movechat.projectSlug(work), "abc.jsonl"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
