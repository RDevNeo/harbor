import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkJsonl } from "../src/fork.ts";

const dir = mkdtempSync(join(tmpdir(), "hts-fork-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (type: string, text: string) => JSON.stringify({ type, sessionId: "old", message: { content: [{ type: "text", text }] } });

test("a reply whose images the chat keeps in its uploads still forks at its place in the session", () => {
  const src = join(dir, "old.jsonl");
  writeFileSync(src, `${[line("user", "show me"), line("assistant", "Here:\n\n![The page](/tmp/shot.png)"), line("user", "thanks"), line("assistant", "welcome")].join("\n")}\n`);
  // The transcript names the kept copy (media.ts `adopt`); the session, the file the agent wrote.
  forkJsonl(src, "new", [
    { kind: "user", text: "show me", files: [], at: 1, mentions: [], sender: "", intent: "" },
    { kind: "text", text: "Here:\n\n![The page](/home/sam/.local/share/harbor/uploads/7/0123456789abcdef0123.png)", at: 2 },
  ]);
  const out = readFileSync(join(dir, "new.jsonl"), "utf8").trim().split("\n");
  expect(out).toHaveLength(2);
  expect(JSON.parse(out[1] ?? "{}").sessionId).toBe("new");
  // A reply that isn't in the session still isn't found.
  expect(() => forkJsonl(src, "bad", [{ kind: "text", text: "Here:\n\n![Another](/tmp/other.png) and more", at: 2 }])).toThrow("isn't in the session");
});
