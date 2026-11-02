import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, REPORT_MAX, doing, logo, reportLine, shortElapsed, title } from "../src/logic/agentstrip.ts";
import type { Item } from "../src/logic/item.ts";

function tool(name: string, summary: string, input: string, done: boolean): Item {
  return { kind: "tool", id: "t", name, summary, input, result: done ? "ok" : null, is_error: false };
}

test("doing_reads_the_latest_step", () => {
  const root = "/work/app";
  const user: Item = { kind: "user", text: "go", files: [], at: 1, mentions: [], sender: "", intent: "" };
  expect(doing([], root)).toBe("starting");
  expect(doing([user], root)).toBe("starting");
  expect(doing([user, { kind: "thinking", text: "h" }], root)).toBe("thinking");
  expect(doing([user, tool("Edit", "/work/app/src/chat.rs", "{}", false)], root)).toBe("editing src/chat.rs");
  expect(doing([tool("Edit", "/elsewhere/x/src/chat.rs", "{}", true)], root)).toBe("editing src/chat.rs");
  expect(doing([tool("Edit", "update src/api.rs", "", false)], root)).toBe("editing src/api.rs");
  expect(doing([tool("Read", "/work/app/README.md", "{}", false)], root)).toBe("reading README.md");
  expect(doing([tool("Bash", "cd /work/app && cargo test api::", "{}", false)], root)).toBe("running tests");
  expect(doing([tool("Bash", "~/.cache/harbor-rel/build.sh check", "{}", false)], root)).toBe("building");
  expect(doing([tool("Shell", "git push origin main", "", false)], root)).toBe("pushing");
  expect(doing([tool("Bash", "RUST_LOG=1 npm install left-pad", "{}", false)], root)).toBe("running npm install");
  expect(doing([tool("mcp__harbor__send_message", "", '{"to":"lead","text":"hi"}', false)], root)).toBe("messaging lead");
  expect(doing([tool("mcp__github__get_pr", "", "{}", false)], root)).toBe("github · get_pr");
  expect(doing([tool("WebFetch", "https://docs.rs/egui/latest", "{}", false)], root)).toBe("reading docs.rs");
  expect(doing([tool("Grep", "fn main", "{}", false), { kind: "text", text: "Done: all good", at: 2 }], root)).toBe("writing");
  // An earlier turn's steps don't count.
  expect(doing([tool("Grep", "x", "{}", true), user], root)).toBe("starting");
});

test("report_line_takes_the_first_sentence", () => {
  expect(reportLine("api", "Added tests for the parser. Also fixed a typo.\n\nDetails…")).toBe("api finished: Added tests for the parser");
  expect(reportLine("ui", "## Summary\n\n**Done**: moved the strip above the composer")).toBe("ui finished: Done: moved the strip above the composer");
  expect(reportLine("ui", "(no text reply)")).toBe("ui finished");
  expect(reportLine("db", "Error: the build failed")).toBe("db failed: the build failed");
  const line = reportLine("x", "word ".repeat(60));
  expect(line.endsWith("…") && [...line].length <= REPORT_MAX + "x finished: ".length).toBe(true);
});

test("elapsed_and_titles", () => {
  expect(shortElapsed(40)).toBe("40s");
  expect(shortElapsed(150)).toBe("2m");
  expect(shortElapsed(3900)).toBe("1h 5m");
  expect(title(1, 0)).toBe("1 agent working");
  expect(title(3, 2)).toBe("3 agents working  ·  2 queued");
});

test("every_provider_has_its_logo_file", () => {
  const logos = join(import.meta.dir, "../../../../assets/logos");
  for (const k of PROVIDERS) {
    const [f] = logo(k);
    expect([f, existsSync(join(logos, f))]).toEqual([f, true]);
  }
});
