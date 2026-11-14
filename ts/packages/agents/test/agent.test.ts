import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "../src/agent.ts";
import { REMOTE_EXIT } from "../src/detach.ts";
import type { Account } from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-agent-"));
const dataBefore = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = join(base, "data");
afterAll(() => {
  if (dataBefore === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = dataBefore;
  rmSync(base, { recursive: true, force: true });
});

const claude = (over: Partial<Account> = {}): Account => ({
  id: "claude",
  kind: "Claude",
  name: "Claude",
  email: "",
  badge: "CL",
  plan: "",
  configDir: null,
  bin: null,
  loggedIn: true,
  usage: [],
  ...over,
});

const spec = (over: Partial<agent.TurnSpec> = {}): agent.TurnSpec => ({
  chatId: 999_995,
  cwd: tmpdir(),
  prompt: "hi",
  files: [],
  sessionId: "abc",
  resume: false,
  account: claude(),
  model: "",
  effort: "",
  access: "full",
  team: null,
  fast: false,
  base: 0,
  remote: null,
  trusted: true,
  context: agent.ownContext(),
  ...over,
});

const after = (v: string[], k: string): string | undefined => {
  const i = v.indexOf(k);
  return i < 0 ? undefined : v[i + 1];
};

// A steer is a stream-json user message with `priority: "now"`; a plain one has none.
test("steer_message_has_priority_now", () => {
  const plain = JSON.parse(agent.claudeMessage("hi", []).trim()) as Record<string, unknown>;
  expect("priority" in plain).toBe(false);
  const steer = JSON.parse(agent.claudeMessage("also the square", [], "now").trim()) as { priority: string; type: string; message: { content: { text: string }[] } };
  expect(steer.priority).toBe("now");
  expect(steer.type).toBe("user");
  expect(steer.message.content[0]?.text).toBe("also the square");
});

test("a_stopped_turns_late_exit_leaves_the_next_turn", () => {
  const exit = (d: string): agent.Event => ({ type: "exited", ok: false, dir: d });
  expect(agent.isStaleExit(exit("/t/5-1"), "/t/5-2")).toBe(true);
  expect(agent.isStaleExit(exit("/t/5-2"), "/t/5-2")).toBe(false);
  // Nothing else runs: it is the stop's own end.
  expect(agent.isStaleExit(exit("/t/5-1"), null)).toBe(false);
  expect(agent.isStaleExit({ type: "stderr", text: "x" }, "/t/5-2")).toBe(false);
});

test("a_devices_exit_line_is_no_event", () => {
  expect(agent.parseClaude({ type: REMOTE_EXIT, code: 0 })).toEqual([]);
});

// A lead's access binds it: Read only and Auto-edit leads get no shell and no bypass; an untrusted project's own settings stay off.
test("lead_follows_the_chats_access", async () => {
  const args = async (access: string, trusted: boolean): Promise<string[]> => (await agent.build(spec({ access, trusted, team: { role: "lead", system: "lead" } }))).cmd.args;
  for (const [access, mode] of [
    ["plan", "plan"],
    ["edits", "acceptEdits"],
  ] as const) {
    const v = await args(access, true);
    expect(after(v, "--permission-mode")).toBe(mode);
    expect(after(v, "--tools")).not.toContain("Bash");
    expect(v).toContain("--allowedTools=mcp__harbor");
    expect(v).not.toContain("--setting-sources");
  }
  const v = await args("full", false);
  expect(after(v, "--permission-mode")).toBe("bypassPermissions");
  expect(after(v, "--tools")).toContain("Bash");
  expect(after(v, "--setting-sources")).toBe("user");
});

/** remote.rs's script, as far as this test reads it: one line per setup step, then the agent. */
const fakeRemote: agent.Remote = {
  launch(_family, _dir, setup, argv) {
    const lines = setup.map((s) => (s.kind === "token" ? "read -r CLAUDE_CODE_OAUTH_TOKEN" : s.kind === "mcp" ? "read -r HARBOR_MCP" : s.kind === "session" ? `mkdir -p "$CLAUDE_CONFIG_DIR/projects" # ${s.id}` : s.kind === "profile" ? `export CLAUDE_CONFIG_DIR=~/${s.rel}` : ""));
    return { command: [...lines, argv.join(" ")].join("; "), input: "" };
  },
};
const fakeBridge: agent.Bridge = {
  grant: () => 4242,
  revoke: () => {},
  resume: () => {},
  remoteConfig: (g, port) => ({ mcpServers: { origin: { type: "http", url: `http://127.0.0.1:${port}/${g.token}/origin` } } }),
  origin: "origin",
};

// A remote turn carries the account's login: first on stdin, before the profile and the session lines; never in ssh's arguments.
test("remote_turn_sends_the_login_on_stdin", async () => {
  const was = { ...agent.integrations };
  agent.integrate({ remote: fakeRemote, bridge: fakeBridge });
  try {
    const remote = (token: string | null): agent.RemoteSpec => ({
      ssh: ["-o", "BatchMode=yes"],
      host: "box",
      name: "box",
      family: "posix",
      dir: "~",
      setup: [{ kind: "profile", rel: ".claude2" }],
      bridge: false,
      commands: false,
      workspace: false,
      token,
      note: "",
    });
    const s = (token: string | null): agent.TurnSpec => spec({ chatId: 999_996, resume: true, account: claude({ id: "claude2", configDir: "/x/.claude2" }), remote: remote(token) });
    let { cmd, stdin, grant } = await agent.build(s("sk-ant-oat01-secret"));
    expect(grant).not.toBeNull();
    const input = stdin ?? "";
    const nl = input.indexOf("\n");
    expect(input.slice(0, nl)).toBe("sk-ant-oat01-secret");
    const rest = input.slice(nl + 1);
    expect(rest.startsWith("{")).toBe(true);
    expect(rest).toContain('"type":"user"');
    expect(rest.endsWith("\n")).toBe(true);
    expect(cmd.program).toBe("ssh");
    expect(cmd.args.some((a) => a.includes("sk-ant-oat01"))).toBe(false);
    const script = cmd.args[cmd.args.length - 1] ?? "";
    const at = (needle: string): number => {
      const i = script.indexOf(needle);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const [login, profile, session, cli] = [at("read -r CLAUDE_CODE_OAUTH_TOKEN"), at("export CLAUDE_CONFIG_DIR="), at("/projects"), at("--input-format")];
    expect(login < profile && profile < session && session < cli).toBe(true);
    expect(cmd.env.get("HARBOR_DEVICE")).toBe("box");
    // Not signed in here: no line reads stdin, the message comes first.
    ({ cmd, stdin } = await agent.build(s(null)));
    expect(stdin?.startsWith("{")).toBe(true);
    expect(cmd.args.some((a) => a.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(false);
  } finally {
    agent.integrate(was);
  }
});

// A local turn's stdio servers go on a bridge grant of its own (they start only when a tool is called); without any, the grant is dropped.
test("a local turn hands its stdio servers to the bridge and keeps the grant only when it has some", async () => {
  const was = { ...agent.integrations };
  const revoked: string[] = [];
  agent.integrate({
    bridge: { ...fakeBridge, revoke: (t) => revoked.push(t) },
    servers: {
      ...was.servers,
      claudeConfig: (chat, extra, _apps, lazy) => {
        for (const [k, v] of extra) if (lazy) lazy.servers[k] = v;
        return `${lazy?.base ?? "none"}|${chat}`;
      },
    },
  });
  try {
    const team = { role: "lead" as const, system: "lead" };
    let { cmd, grant } = await agent.build(spec({ team }));
    expect((grant?.servers.harbor as { args: string[] }).args.slice(-5)).toEqual(["mcp", "--chat", "999995", "--role", "lead"]);
    expect(after(cmd.args, "--mcp-config")).toBe(`http://127.0.0.1:4242/${grant?.token}/|999995`);
    expect(revoked).toEqual([]);
    ({ grant } = await agent.build(spec()));
    expect(grant).toBeNull();
    expect(revoked).toHaveLength(1);
  } finally {
    agent.integrate(was);
  }
});

// With the bridge's port file known, the URLs name the runner's relay (relay.ts) and the runner is told where to relay to.
test("a local turn's MCP URLs go through the runner's relay when the bridge has a port file", async () => {
  const was = { ...agent.integrations };
  agent.integrate({
    bridge: { ...fakeBridge, portFile: () => "/run/bridge-port" },
    servers: {
      ...was.servers,
      claudeConfig: (chat, extra, _apps, lazy) => {
        for (const [k, v] of extra) if (lazy) lazy.servers[k] = v;
        return `${lazy?.base ?? "none"}|${chat}`;
      },
    },
  });
  try {
    const { cmd, grant } = await agent.build(spec({ team: { role: "lead", system: "lead" } }));
    expect(after(cmd.args, "--mcp-config")).toBe(`http://127.0.0.1:\${HARBOR_BRIDGE_PORT}/${grant?.token}/|999995`);
    expect(cmd.env.get("HARBOR_BRIDGE_PORT")).toBe("4242");
    expect(cmd.env.get("HARBOR_BRIDGE_RELAY")).toBe("/run/bridge-port");
    // No servers for the bridge: no relay either.
    const plain = await agent.build(spec());
    expect(plain.grant).toBeNull();
    expect(plain.cmd.env.has("HARBOR_BRIDGE_RELAY")).toBe(false);
  } finally {
    agent.integrate(was);
  }
});

test("a Codex turn hands its stdio servers to the bridge, with the token in its environment only", async () => {
  const was = { ...agent.integrations };
  let seen: { servers: Record<string, unknown>; base: string; tokenVar: string } | null | undefined;
  agent.integrate({
    bridge: { ...fakeBridge, portFile: () => "/run/bridge-port" },
    servers: {
      ...was.servers,
      codexArgs: (_chat, extra, lazy) => {
        seen = lazy;
        for (const [k, v] of extra) if (lazy) lazy.servers[k] = v;
        return ["-c", `mcp_servers={harbor={url="${lazy?.base}harbor",bearer_token_env_var="${lazy?.tokenVar}"}}`];
      },
    },
  });
  try {
    const { cmd, grant } = await agent.build(spec({ account: claude({ kind: "Codex", id: "codex" }), team: { role: "sub", system: "sys" } }));
    expect(seen?.base).toBe("http://127.0.0.1:${HARBOR_BRIDGE_PORT}/");
    expect((grant?.servers.harbor as { args: string[] }).args.slice(-5)).toEqual(["mcp", "--chat", "999995", "--role", "sub"]);
    expect(cmd.env.get("HARBOR_BRIDGE_TOKEN")).toBe(grant?.token ?? "?");
    expect(cmd.args.some((a) => a.includes(grant?.token ?? "?"))).toBe(false);
    expect(cmd.args.some((a) => a.startsWith("mcp_servers.harbor."))).toBe(false);
  } finally {
    agent.integrate(was);
  }
});

test("a remote turn without the net package says so instead of running", async () => {
  const remote: agent.RemoteSpec = { ssh: [], host: "box", name: "box", family: "posix", dir: "~", setup: [], bridge: false, commands: false, workspace: false, token: null, note: "" };
  const was = { ...agent.integrations };
  agent.integrate({ remote: null, bridge: null, workspace: null });
  try {
    await expect(agent.build(spec({ remote }))).rejects.toThrow(/doesn't have yet/);
    await expect(agent.build(spec({ remote, account: { ...claude(), kind: "Codex", id: "codex" } }))).rejects.toThrow("only Claude Code runs on other devices so far, not Codex");
  } finally {
    agent.integrate(was);
  }
});

describe("command lines per provider", () => {
  test("Claude: stream-json both ways, Harbor's servers only, Medium by default", async () => {
    const { cmd, stdin } = await agent.build(spec({ model: "claude-haiku-5-5" }));
    const v = cmd.args;
    expect(v.slice(0, 8)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages"]);
    expect(after(v, "--effort")).toBe("medium");
    expect(after(v, "--model")).toBe("claude-haiku-5-5");
    expect(after(v, "--session-id")).toBe("abc");
    expect(v).toContain("--strict-mcp-config");
    expect(after(v, "--mcp-config")).toBe(join(base, "data/harbor/apps/run/claude-999995.json"));
    expect(cmd.env.has("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(cmd.env.get("CLAUDE_CONFIG_DIR")).toBeNull();
    expect(stdin).toBe(agent.claudeMessage("hi", []));
  });

  test("Claude keywords and fast mode", async () => {
    let v = (await agent.build(spec({ effort: "ultracode", fast: true, resume: true }))).cmd.args;
    expect(after(v, "--effort")).toBe("xhigh");
    expect(after(v, "--settings")).toBe('{"fastMode":true}');
    expect(after(v, "--resume")).toBe("abc");
    const r = await agent.build(spec({ effort: "ultrathink" }));
    v = r.cmd.args;
    expect(v).not.toContain("--effort");
    expect(r.stdin).toContain("hi\\n\\nultrathink");
  });

  test("a guest turn runs in its overlay with the account's login named for the runner", async () => {
    const { cmd } = await agent.build(spec({ account: claude({ configDir: "/x/.claude2" }), context: { overlay: "/g/pc-b", signedIn: false, note: "who is who", machines: null } }));
    expect(cmd.env.get("CLAUDE_CONFIG_DIR")).toBe("/g/pc-b");
    expect(cmd.env.get("HARBOR_GUEST_LOGIN")).toBe("/x/.claude2");
    expect(cmd.env.get("HARBOR_GUEST_APPS")).toBe("0");
    expect(after(cmd.args, "--append-system-prompt")).toBe("who is who");
  });

  test("Codex", async () => {
    const built = await agent.build(spec({ account: claude({ kind: "Codex", id: "codex" }), access: "edits", effort: "high", fast: true, resume: true, files: ["/a.png", "/b.txt"], team: { role: "sub", system: "sys" } }));
    const v = built.cmd.args;
    expect(v.slice(0, 4)).toEqual(["exec", "resume", "--json", "--skip-git-repo-check"]);
    expect(v).toContain('sandbox_mode="workspace-write"');
    expect(v).toContain('model_reasoning_effort="high"');
    expect(v).toContain('service_tier="priority"');
    // The team server: on the turn's bridge grant when a bridge is wired in, else on Codex's command line (dotted, or in the one `mcp_servers={…}`).
    const team = '"mcp","--chat","999995","--role","sub"';
    const onGrant = JSON.stringify(built.grant?.servers.harbor ?? null).includes(team);
    expect(onGrant || v.some((a) => a.startsWith("mcp_servers") && a.includes(team))).toBe(true);
    expect(after(v, "-i")).toBe("/a.png");
    // Resumed: no team text in the message, the session id before it.
    expect(v.slice(-2)).toEqual(["abc", "hi\n\nAttached files:\n- /b.txt"]);
  });

  test("Codex's first message carries the team's instructions", async () => {
    const v = (await agent.build(spec({ account: claude({ kind: "Codex", id: "codex" }), team: { role: "sub", system: "sys" } }))).cmd.args;
    expect(v[v.length - 1]).toBe("sys\n\n---\n\nhi");
    expect(v).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("OpenCode: headless JSON with full access, the model as given, continued by its session id", async () => {
    const oc = (over: Partial<agent.TurnSpec> = {}) => agent.build(spec({ account: claude({ kind: "OpenCode", id: "opencode", bin: "/x/opencode" }), ...over }));
    const fresh = await oc({ model: "nvidia/z-ai/glm-5.3-flash", team: { role: "sub", system: "sys" } });
    expect(fresh.cmd.args).toEqual(["run", "--format", "json", "--thinking", "--auto", "--model", "nvidia/z-ai/glm-5.3-flash", "sys\n\n---\n\nhi"]);
    expect(fresh.stdin).toBeNull();
    expect((await oc({ resume: true, files: ["/a.png"] })).cmd.args).toEqual(["run", "--format", "json", "--thinking", "--auto", "--session", "abc", "hi\n\nAttached files:\n- /a.png"]);
  });
});

describe("event streams", () => {
  test("Claude", () => {
    expect(agent.parseClaude({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [{ name: "harbor", status: "connected" }] })).toEqual([
      { type: "mcp", servers: [["harbor", "connected"]] },
      { type: "session", id: "s1" },
    ]);
    expect(agent.parseClaude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } })).toEqual([{ type: "textDelta", text: "he" }]);
    expect(agent.parseClaude({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "sub" }] } })).toEqual([]);
    const [tool] = agent.parseClaude({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { description: "d", command: "ls -la\nmore" } }] } });
    expect(tool).toEqual({ type: "tool", id: "t1", name: "Bash", summary: "ls -la", input: '{\n  "command": "ls -la\\nmore",\n  "description": "d"\n}', result: null, isError: false });
    expect(agent.parseClaude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "image" }], is_error: true }] } })).toEqual([
      { type: "tool", id: "t1", name: "", summary: "", input: "", result: "a\n[image]", isError: true },
    ]);
    expect(agent.parseClaude({ type: "result", subtype: "error_max_turns", total_cost_usd: 0, duration_ms: 9, num_turns: 2, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } })).toEqual([
      { type: "error", text: "error_max_turns" },
      { type: "result", costUsd: null, durationMs: 9, turns: 2, inputTokens: 6, outputTokens: 4, cached: 5 },
    ]);
    expect(agent.parseClaude({ type: "assistant", error: "rate_limit", quotaLimits: { rateLimitType: "five_hour", resetsAt: 77 }, message: { content: [{ type: "text", text: "limit" }, { type: "text", text: "hit" }] } })).toEqual([
      { type: "limit", kind: "five_hour", resetsAt: 77, text: "limit hit" },
    ]);
    expect(agent.parseClaude({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 9, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 9 }, five_hour: { utilization: 0.5, resetsAt: 8 } } } })).toEqual([
      { type: "quota", windows: [["five_hour", 0.5, 8], ["seven_day", 1, 9]] },
      { type: "limit", kind: "seven_day", resetsAt: 9, text: "" },
    ]);
    // No usable subscription (Claude Code 2.1.325's line, trimmed): a billing "limit", by its code or by its sentence.
    const pastDue = "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead";
    expect(agent.parseClaude({ type: "assistant", error: "oauth_org_not_allowed", isApiErrorMessage: true, apiErrorStatus: 403, message: { model: "<synthetic>", content: [{ type: "text", text: pastDue }] } })).toEqual([
      { type: "limit", kind: "billing", resetsAt: null, text: pastDue, code: "oauth_org_not_allowed" },
    ]);
    expect(agent.parseClaude({ type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "Credit balance is too low" }] } })).toEqual([
      { type: "limit", kind: "billing", resetsAt: null, text: "Credit balance is too low", code: "billing_error" },
    ]);
    expect(agent.parseClaude({ type: "assistant", error: "some_new_code", message: { content: [{ type: "text", text: pastDue }] } })).toEqual([
      { type: "limit", kind: "billing", resetsAt: null, text: pastDue, code: "some_new_code" },
    ]);
    // Other errors stay text.
    expect(agent.parseClaude({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long" }] } })).toEqual([{ type: "textFinal", text: "Prompt is too long" }]);
    expect(agent.parseClaude({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } })).toEqual([{ type: "userEcho", text: "a\nb" }]);
    // Its request is out: what a steer waits for.
    expect(agent.parseClaude({ type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null })).toEqual([{ type: "querying" }]);
    expect(agent.parseClaude({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: "toolu_1" })).toEqual([]);
  });

  test("Codex", () => {
    expect(agent.parseCodex({ type: "thread.started", thread_id: "th" })).toEqual([{ type: "session", id: "th" }]);
    expect(agent.parseCodex({ type: "item.completed", item: { id: "i", type: "command_execution", command: "/usr/bin/bash -lc 'ls'", aggregated_output: "x", exit_code: 1 } })).toEqual([
      { type: "tool", id: "i", name: "Shell", summary: "ls", input: "ls", result: "x", isError: true },
    ]);
    expect(agent.parseCodex({ type: "item.started", item: { id: "f", type: "file_change", changes: [{ kind: "add", path: "a.rs" }], status: "in_progress" } })).toEqual([
      { type: "tool", id: "f", name: "Edit", summary: "add a.rs", input: "add a.rs", result: null, isError: false },
    ]);
    expect(agent.parseCodex({ type: "item.updated", item: { type: "agent_message", text: "x" } })).toEqual([]);
    expect(agent.parseCodex({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } })).toEqual([
      { type: "result", costUsd: null, durationMs: 0, turns: 1, inputTokens: 10, outputTokens: 2, cached: 4 },
    ]);
    expect(agent.parseCodex({ type: "turn.failed", error: { message: "boom" } })).toEqual([{ type: "error", text: "boom" }]);
  });

  test("OpenCode", () => {
    // `opencode run --format json -m nvidia/z-ai/glm-5.3-flash "Say OK"`, as opencode 1.19.5 wrote it.
    const real = [
      "{\"type\":\"step_start\",\"timestamp\":1794007757338,\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"part\":{\"id\":\"prt_1b331f211001C7E8V59TnOOnfN\",\"messageID\":\"msg_1b3308503001UpsER276R8W2cU\",\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"type\":\"step-start\"}}",
      "{\"type\":\"text\",\"timestamp\":1794007761124,\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"part\":{\"id\":\"prt_1b331ffbc001xv0J0dXK5CEjWG\",\"messageID\":\"msg_1b3308503001UpsER276R8W2cU\",\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"type\":\"text\",\"text\":\"OK\",\"time\":{\"start\":1794007760828,\"end\":1794007761103}}}",
      "{\"type\":\"step_finish\",\"timestamp\":1794007761124,\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"part\":{\"id\":\"prt_1b33200d500156OQhiaK5Oyy4g\",\"reason\":\"stop\",\"messageID\":\"msg_1b3308503001UpsER276R8W2cU\",\"sessionID\":\"ses_e4ccf7d62ffeKrIB1LXthybJVi\",\"type\":\"step-finish\",\"tokens\":{\"total\":50504,\"input\":49190,\"output\":0,\"reasoning\":34,\"cache\":{\"write\":0,\"read\":1280}},\"cost\":0}}",
    ];
    const oc = agent.parser("OpenCode");
    expect(real.flatMap((l) => oc(JSON.parse(l)))).toEqual([
      { type: "session", id: "ses_e4ccf7d62ffeKrIB1LXthybJVi" },
      { type: "textFinal", text: "OK" },
      { type: "result", costUsd: null, durationMs: 0, turns: 1, inputTokens: 50470, outputTokens: 34, cached: 1280 },
    ]);
    // A step that ends in tool calls adds up into the turn's one result.
    const st = agent.opencodeState();
    const step = (reason: string, cost: number) => ({ type: "step_finish", sessionID: "o", part: { reason, cost, tokens: { input: 1, output: 2, reasoning: 1, cache: { read: 3 } } } });
    expect(agent.parseOpencode(step("tool-calls", 0.25), st)).toEqual([{ type: "session", id: "o" }]);
    expect(agent.parseOpencode(step("stop", 0.25), st)).toEqual([{ type: "result", costUsd: 0.5, durationMs: 0, turns: 2, inputTokens: 8, outputTokens: 6, cached: 6 }]);
    const tool = (status: string, extra: object) => ({ type: "tool_use", sessionID: "o", part: { callID: "c1", tool: "bash", state: { status, input: { command: "echo hi" }, ...extra } } });
    expect(agent.parseOpencode(tool("running", {}), st)).toEqual([{ type: "tool", id: "c1", name: "bash", summary: "echo hi", input: '{\n  "command": "echo hi"\n}', result: null, isError: false }]);
    expect(agent.parseOpencode(tool("completed", { output: "hi\n" }), st)[0]).toMatchObject({ result: "hi\n", isError: false });
    expect(agent.parseOpencode(tool("error", { error: "denied" }), st)[0]).toMatchObject({ result: "denied", isError: true });
    expect(agent.parseOpencode({ type: "reasoning", part: { text: "hmm" } }, st)).toEqual([{ type: "thinkingFinal", text: "hmm" }]);
    expect(oc({ type: "error", error: { name: "APIError", data: { message: "m" } } })).toEqual([{ type: "error", text: "m" }]);
  });

  test("tool summaries", () => {
    expect(agent.toolSummary({ file_path: "/a/b" })).toBe("/a/b");
    expect(agent.toolSummary({})).toBe("");
    expect(agent.toolSummary(null)).toBe("");
    expect(agent.toolSummary({ z: 1, a: [2] })).toBe('{"a":[2],"z":1}');
    expect(agent.toolSummary({ command: "é".repeat(130) })).toBe("é".repeat(120));
  });
});

test("a saved grant reads back from bridge.json", () => {
  const g: agent.Grant = { token: "t", chat_id: 3, cwd: "/w", servers: { z: {}, a: { type: "http" } }, commands: true, workspace: ["read"], machines: null };
  const text = agent.grantJson(g);
  expect(text).toBe('{"token":"t","chat_id":3,"cwd":"/w","servers":{"a":{"type":"http"},"z":{}},"commands":true,"workspace":["read"],"machines":null}');
  const dir = join(base, "grant");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bridge.json"), text);
  expect(agent.savedGrant(dir)).toEqual(g);
});
