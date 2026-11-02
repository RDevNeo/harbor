import type { Item } from "@harbor/store";

export const user = (text: string, files: string[] = []): Item => ({ kind: "user", text, files, at: 1, mentions: [], sender: "", intent: "" });
export const tool = (name: string, result: string | null, is_error = false, input = "{}"): Item => ({ kind: "tool", id: name, name, summary: "s", input, result, is_error });
export const text = (t: string, at = 0): Item => ({ kind: "text", text: t, at });
export const result = (): Item => ({ kind: "result", cost_usd: 3.96342, duration_ms: 4300, turns: 1, input_tokens: 189_400, output_tokens: 304, cached: 180_000, at: 9, account: "claude", model: "claude-opus-5-5" });
export const notice = (icon: string, t: string, detail: string): Item => ({ kind: "notice", icon, text: t, detail });

/** view.rs `fixture`: a lead's turn that delegates, one that answers, and the cards around them. */
export function fixture(): Item[] {
  return [
    user("build it", ["/tmp/shot.png", "/tmp/notes.txt"]),
    { kind: "thinking", text: "hmm" },
    tool("mcp__harbor__spawn_agent", "Spawned 'worker' on Claude / Opus 5.5. It reports back to you when its turn ends.", false, '{"name":"worker","title":"Build it","task":"Build it.\\n\\nAll the details."}'),
    text("Started a worker.", 2),
    result(),
    { kind: "message", from: "worker", to: "lead", text: "done" },
    notice("bot", "worker reported", "**report**"),
    tool("Bash", "ok"),
    text("All done.", 3),
    result(),
    notice("process", "dev", "http://127.0.0.1:3000"),
    { kind: "error", text: "boom" },
  ];
}
