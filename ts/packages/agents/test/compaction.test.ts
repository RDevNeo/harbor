import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Item, Store } from "@harbor/store";
import { parseClaude } from "../src/agent.ts";
import * as compaction from "../src/compaction.ts";
import * as detach from "../src/detach.ts";
import { Engine } from "../src/engine.ts";
import { compact } from "../src/json.ts";
import type { Account } from "../src/providers.ts";
import { GUARD, reap } from "./reap.ts";

const base = mkdtempSync(join(tmpdir(), "hts-compaction-"));
afterAll(() => {
  reap(base);
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
const fresh = (name: string): string => {
  const d = join(base, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const line = (v: unknown): string => `${compact(v)}\n`;
const boundary = line({ parentUuid: null, type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual" } });
/** A user entry of exactly `bytes` bytes, newline included. */
const filler = (bytes: number): string => {
  const empty = line({ type: "user", message: { role: "user", content: "" } }).length;
  return line({ type: "user", message: { role: "user", content: "x".repeat(Math.max(0, bytes - empty)) } });
};

describe("lastBoundary", () => {
  test("no boundary: the whole file is live", () => {
    const p = join(fresh("none"), "s.jsonl");
    writeFileSync(p, filler(5000) + filler(3000));
    expect(compaction.lastBoundary(p)).toBe(0);
    expect(compaction.liveBytes(p)).toBe(statSync(p).size);
  });

  test("the last real boundary, past quoted ones and chunk edges", () => {
    const p = join(fresh("found"), "s.jsonl");
    const head = filler(1_500_000) + boundary + filler((1 << 20) - 10);
    // Text that quotes the marker: escaped inside a string, or under a key of a non-system entry.
    const quoted = line({ type: "user", message: { role: "user", content: '"subtype":"compact_boundary"' } }) + line({ type: "assistant", x: { type: "system", subtype: "compact_boundary" } });
    writeFileSync(p, head + boundary + quoted + filler(2000));
    expect(compaction.lastBoundary(p)).toBe(Buffer.byteLength(head));
    expect(compaction.liveBytes(p)).toBe(statSync(p).size - Buffer.byteLength(head));
  });

  test("a missing file is empty", () => {
    expect(compaction.liveBytes(join(base, "nope.jsonl"))).toBe(0);
    expect(compaction.mayNeed(join(base, "nope.jsonl"))).toBe(false);
  });
});

test("the notice texts", () => {
  expect(compaction.compactedText({ before: 32_400_000, after: 2_100_000, ok: true, error: "" })).toBe("Session compacted (32 MB → 2.1 MB)");
  expect(compaction.compactedText({ before: 16_000_000, after: 16_000_000, ok: false, error: "rate limited" })).toBe("Couldn't compact the session (16 MB): rate limited");
  expect(compaction.compactingText(52_500_000)).toBe("Compacting the session (53 MB) before this turn");
  expect(compaction.mb(310_000)).toBe("310 KB");
  expect(compaction.claudeCompactedText(665_545, 4003)).toBe("Claude Code compacted the conversation (666k → 4k tokens)");
});

test("parses Harbor's compaction lines and Claude Code's boundary", () => {
  const evs = (s: string) => parseClaude(JSON.parse(s));
  expect(evs(compaction.startLine(20_000_000))).toEqual([{ type: "compact", state: "start", before: 20_000_000, after: 0, ok: false, error: "" }]);
  expect(evs(compaction.doneLine({ before: 20, after: 2, ok: true, error: "" }))).toEqual([{ type: "compact", state: "done", before: 20, after: 2, ok: true, error: "" }]);
  const b = { type: "system", subtype: "compact_boundary", session_id: "s", compact_metadata: { trigger: "manual", pre_tokens: 664260, post_tokens: 4003 } };
  expect(parseClaude(b)).toEqual([{ type: "compact", state: "claude", before: 664260, after: 4003, ok: true, error: "" }]);
});

// A Claude-shaped CLI for the runner: `/compact` appends a boundary to the session file
// (FAKE_SESSION), FAIL_COMPACT makes it fail; any other message is answered.
const fake = join(base, "claude");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
${GUARD()}const fs = require("node:fs");
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
let buf = "";
for await (const c of process.stdin) buf += c;
for (const l of buf.split("\\n").filter((x) => x !== "")) {
  const text = JSON.parse(l).message.content[0].text;
  if (text === "/compact") {
    if (process.env.FAIL_COMPACT) { out({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" }); process.exit(1); }
    fs.appendFileSync(process.env.FAKE_SESSION, ${JSON.stringify(boundary)} + JSON.stringify({ type: "user", message: { role: "user", content: "summary" } }) + "\\n");
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9000, post_tokens: 100 } });
    out({ type: "result", subtype: "success", is_error: false, result: "" });
  } else {
    fs.appendFileSync(process.env.FAKE_SESSION, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\\n");
    out({ type: "result", subtype: "success", is_error: false, result: "answered " + text });
  }
}
`,
);
chmodSync(fake, 0o755);

describe("the runner compacts first", () => {
  const turnDir = (session: string | undefined, env: [string, string][] = []): string => {
    const dir = fresh("turn");
    const session_ = session === undefined ? {} : { compact: session };
    writeFileSync(join(dir, "cmd.json"), compact({ program: fake, args: ["-p", "--resume", "s"], cwd: dir, env: [["FAKE_SESSION", session ?? join(dir, "none")], ...env], input: true, agent_env: false, ...session_ }));
    writeFileSync(join(dir, "in"), line({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }));
    writeFileSync(join(dir, "in.closed"), "");
    return dir;
  };
  const outLines = (dir: string): Record<string, unknown>[] =>
    readFileSync(join(dir, "out"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const withOver = async (bytes: number, f: () => Promise<void>): Promise<void> => {
    process.env.HARBOR_COMPACT_OVER = String(bytes);
    try {
      await f();
    } finally {
      delete process.env.HARBOR_COMPACT_OVER;
    }
  };

  test("a session past the threshold is compacted, then the turn runs on it", async () => {
    const session = join(fresh("long"), "s.jsonl");
    writeFileSync(session, filler(40_000) + filler(30_000));
    const dir = turnDir(session);
    await withOver(50_000, () => detach.run([dir]));
    const out = outLines(dir);
    expect(out[0]).toEqual({ type: "harbor_compact", state: "start", before: 70_000 });
    expect(out[1]).toMatchObject({ type: "harbor_compact", state: "done", before: 70_000, ok: true, error: "" });
    expect(out[1]?.after as number).toBeLessThan(1000);
    // The compaction's own output stays out of the turn's.
    expect(out.slice(2)).toEqual([{ type: "result", subtype: "success", is_error: false, result: "answered hello" }]);
    expect(readFileSync(join(dir, "exit"), "utf8")).toBe("0");
    expect(compaction.lastBoundary(session)).toBe(70_000);
    expect(readFileSync(session, "utf8").endsWith('"content":"hello"}}\n')).toBe(true);
  });

  test("a compacted session's live part is what counts", async () => {
    const session = join(fresh("short"), "s.jsonl");
    writeFileSync(session, filler(80_000) + boundary + filler(10_000));
    const dir = turnDir(session);
    await withOver(50_000, () => detach.run([dir]));
    expect(outLines(dir)).toEqual([{ type: "result", subtype: "success", is_error: false, result: "answered hello" }]);
  });

  test("a failed compaction says why and the turn still runs", async () => {
    const session = join(fresh("fail"), "s.jsonl");
    writeFileSync(session, filler(60_000));
    const dir = turnDir(session, [["FAIL_COMPACT", "1"]]);
    await withOver(50_000, () => detach.run([dir]));
    const out = outLines(dir);
    expect(out[1]).toEqual({ type: "harbor_compact", state: "done", before: 60_000, after: 60_000, ok: false, error: "API Error: 529 overloaded" });
    expect(out[2]).toMatchObject({ type: "result" });
  });

  test("cmd.json names the session only when it asks for it", () => {
    const c = detach.command("claude");
    expect(detach.cmdJson(c, true, true)).not.toContain("compact");
    c.compact = "/x/s.jsonl";
    expect(JSON.parse(detach.cmdJson(c, true, true)).compact).toBe("/x/s.jsonl");
  });
});

test("the chat shows one notice per compaction, replayed or not", () => {
  process.env.XDG_DATA_HOME = join(base, "data");
  const store = Store.openTemp();
  const account: Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "CL", plan: "", configDir: null, bin: fake, loggedIn: true, usage: [] };
  const e = new Engine({ store, accounts: () => [account], changed: () => {} });
  const chat = store.createChat({ id: 0, repoId: null, title: "t", sessionId: "s", started: true, account: "claude", model: "", effort: "", access: "full", settled: false, updated: 0, role: "chat", parent: null, name: "", device: "", gid: "", home: "", homeId: 0, retired: false });
  const run = { turn: null, at: Date.now() };
  const tr = e.transcript(chat.id);
  tr.items.push({ kind: "user", text: "hi", files: [], at: 1, mentions: [], sender: "", intent: "" } as Item);
  const feed = (): void => {
    for (const s of [compaction.startLine(32_000_000), compaction.doneLine({ before: 32_000_000, after: 150_000, ok: true, error: "" })]) for (const ev of parseClaude(JSON.parse(s))) e.onEvent(chat.id, ev, run);
  };
  feed();
  const notices = (): Item[] => tr.items.filter((it) => it.kind === "notice");
  expect(notices()).toEqual([{ kind: "notice", icon: "compact", text: "Session compacted (32 MB → 150 KB)", detail: compaction.COMPACT_DETAIL }]);
  // A reattached turn replays its output with its notices kept.
  feed();
  expect(notices().length).toBe(1);
  for (const ev of parseClaude({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 200_000, post_tokens: 3000 } })) e.onEvent(chat.id, ev, run);
  expect(notices().map((it) => (it.kind === "notice" ? it.text : ""))).toEqual(["Session compacted (32 MB → 150 KB)", "Claude Code compacted the conversation (200k → 3k tokens)"]);
});

test("a resumed local Claude turn names its long session; a short one doesn't", async () => {
  const { build } = await import("../src/agent.ts");
  const config = fresh("config");
  const cwd = fresh("cwd");
  const { sessionDir } = await import("../src/movechat.ts");
  const dir = sessionDir(config, cwd);
  mkdirSync(dir, { recursive: true });
  const session = join(dir, "abc.jsonl");
  writeFileSync(session, filler(1000));
  const account: Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "CL", plan: "", configDir: config, bin: fake, loggedIn: true, usage: [] };
  const spec = { chatId: 1, cwd, prompt: "hi", files: [], sessionId: "abc", resume: true, account, model: "", effort: "", access: "full", team: null, fast: false, base: 0, remote: null, trusted: true, context: { overlay: null, signedIn: true, note: "", machines: null } } as unknown as Parameters<typeof build>[0];
  process.env.HARBOR_COMPACT_OVER = "5000";
  try {
    expect((await build(spec)).cmd.compact).toBeUndefined();
    appendFileSync(session, filler(6000));
    expect((await build(spec)).cmd.compact).toBe(session);
    expect((await build({ ...spec, resume: false })).cmd.compact).toBeUndefined();
  } finally {
    delete process.env.HARBOR_COMPACT_OVER;
  }
});
