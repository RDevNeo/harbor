import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeMessage, type Event, parseClaude, startTurn, textOf, toolSummary } from "../proto/turn.ts";

const dir = mkdtempSync(join(tmpdir(), "hts-turn-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseClaude", () => {
  test("init gives the session", () => {
    expect(parseClaude({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [] })).toEqual([{ type: "session", id: "s1" }]);
  });

  test("deltas", () => {
    const delta = (d: { type: string; text?: string; thinking?: string }) => parseClaude({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    expect(delta({ type: "text_delta", text: "he" })).toEqual([{ type: "text_delta", text: "he" }]);
    expect(delta({ type: "thinking_delta", thinking: "m" })).toEqual([{ type: "thinking_delta", text: "m" }]);
  });

  test("a sub-agent's lines are not this chat's", () => {
    expect(parseClaude({ type: "assistant", parent_tool_use_id: "t", message: { content: [{ type: "text", text: "x" }] } })).toEqual([]);
  });

  test("a message that isn't Claude's is ignored (agent.rs: remote exit)", () => {
    expect(parseClaude({ type: "harbor_remote_exit", code: 0 })).toEqual([]);
  });

  test("assistant blocks", () => {
    const out = parseClaude({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "yes" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.rs\nb" } },
        ],
      },
    });
    expect(out.map((e) => e.type)).toEqual(["thinking_final", "text_final", "tool"]);
    expect(out[2]).toMatchObject({ id: "t1", name: "Read", summary: "a.rs" });
  });

  test("tool results", () => {
    expect(parseClaude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }, { type: "image" }], is_error: true }] } })).toEqual([
      { type: "tool_result", id: "t1", result: "ok\n[image]", is_error: true },
    ]);
  });

  test("the result counts cached tokens as input", () => {
    const out = parseClaude({ type: "result", subtype: "success", duration_ms: 9, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } });
    expect(out).toEqual([{ type: "result", cost_usd: null, duration_ms: 9, turns: 2, input_tokens: 6, output_tokens: 4, cached: 5 }]);
  });

  test("a failed result is an error first", () => {
    const out = parseClaude({ type: "result", subtype: "error_max_turns", usage: {} });
    expect(out[0]).toEqual({ type: "error", text: "error_max_turns" });
  });
});

describe("helpers", () => {
  test("toolSummary takes the first telling key and cuts at 120 characters", () => {
    expect(toolSummary({ pattern: "x", command: "ls" })).toBe("ls");
    expect(toolSummary({ command: "é".repeat(200) })).toBe("é".repeat(120));
    expect(toolSummary({})).toBe("");
    expect(toolSummary(null)).toBe("");
    expect(toolSummary({ other: 1 })).toBe(`{"other":1}`);
  });

  test("textOf", () => {
    expect(textOf("a")).toBe("a");
    expect(textOf(null)).toBe("");
    expect(textOf(["a", { type: "text", text: "b" }])).toBe("a\nb");
  });

  test("the user's message has Claude's stream-json shape", () => {
    expect(JSON.parse(claudeMessage("hi"))).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  });

  test("a turn never resumes a session", () => {
    const args = claudeArgs("haiku");
    expect(args).not.toContain("--resume");
    expect(args).toContain("--no-session-persistence");
  });
});

describe("startTurn", () => {
  test("streams a fake CLI's lines, split across reads, and reports its exit", async () => {
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh
cat > ${dir}/stdin
printf '{"type":"system","subtype":"init","session_id":"s"}\\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po'
sleep 0.05
printf 'ng"}}}\\nnot json\\n'
exit 3
`,
    );
    chmodSync(bin, 0o755);
    const seen: Event[] = [];
    const t = startTurn({ bin, cwd: dir, model: "haiku", prompt: "hi", onEvent: (e) => seen.push(e) });
    expect(await t.done).toBe(3);
    expect(seen).toEqual([{ type: "session", id: "s" }, { type: "text_delta", text: "pong" }]);
    expect(JSON.parse(await Bun.file(join(dir, "stdin")).text()).type).toBe("user");
  });
});
