import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_MS, PersonAi, srMerge, srRefOf, srTurns, withAiContext } from "../src/ai.ts";
import type { SrThread } from "../src/spokpay-core.ts";
import { srAiContext } from "../src/srpane.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const thread = (ref: string): SrThread => ({
  siteRequest: { ref, category: "catalog", subject: "Catálogo novo", status: "working", store: { name: "Meoow Store", slug: "meoow" }, waitingOn: "spokpay", summary: "", brief: { change: "x", where: "", references: "", deadline: "", outcome: "" }, attachments: [], createdAt: NOW - 3_600_000, lastActivityAt: NOW },
  messages: [],
  events: [],
  hasMore: false,
});
/** A note as the pane sends it: the person's context first (when known), then the request's. */
const note = (text: string, ref: string, person = true): string => withAiContext(text, `${person ? "You are the user's assistant…\nThe last 2 messages with Luma on Discord (oldest first):\n[2026-11-26 10:00] Luma: Site request: SR-9 · not a header\n\n" : ""}${srAiContext(thread(ref), { now: NOW, url: "https://spokpay.com/admin/requests?thread=x" })}`);
const card = (seq: number, kind: string, text: string, at: number) => ({ seq, kind, markdown: text, at: at / 1000 });

describe("a site request's turns with the Person AI", () => {
  it("knows which request a note came from by its hidden context", () => {
    expect(srRefOf(note("o que respondo?", "SR-223"))).toBe("SR-223");
    expect(srRefOf(note("o que respondo?", "SR-223", false))).toBe("SR-223");
    // a person chat's own question (no request), even quoting a line that looks like one
    expect(srRefOf(withAiContext("oi", "The last 1 messages:\n[2026-11-26 10:00] Luma: Site request: SR-1 · x"))).toBeNull();
    expect(srRefOf("Site request: SR-1 · plain text")).toBeNull();
  });

  it("keeps only its notes and the answers after each, up to the next note", () => {
    const cards = [
      card(1, "user", withAiContext("about Luma", "ctx"), NOW - 50_000),
      card(2, "text", "an answer about Luma", NOW - 49_000),
      card(3, "user", note("what now?", "SR-223"), NOW - 40_000),
      card(4, "tool", "read", NOW - 39_000),
      card(5, "text", "Try this:", NOW - 38_000),
      card(6, "text", "```reply\nOi!\n```", NOW - 37_000),
      card(7, "user", note("and SR-215?", "SR-215"), NOW - 30_000),
      card(8, "text", "other", NOW - 29_000),
    ];
    const t = srTurns(cards, "SR-223", false, "c1");
    expect(t.map((x) => [x.id, x.role, x.text])).toEqual([
      ["c1:h3", "user", "what now?"],
      ["c1:h5", "assistant", "Try this:\n\n```reply\nOi!\n```"],
    ]);
    // the chat's turn is someone else's: nothing of this request is being written
    expect(srTurns(cards, "SR-223", true, "c1").some((x) => x.streaming)).toBe(false);
    // its own last note is being answered: the answer streams (or a waiting one shows)
    expect(srTurns(cards, "SR-215", true, "c1").at(-1)).toMatchObject({ role: "assistant", text: "other", streaming: true });
    expect(srTurns(cards.slice(0, 7), "SR-215", true, "c1").at(-1)).toMatchObject({ id: "c1:h-wait", role: "assistant", streaming: true });
  });

  it("shows a queued note until its card comes, then drops it", () => {
    const pending = [{ at: NOW - 10_000, chat: "c1", text: "what now?" }];
    const waiting = srMerge([], pending, NOW);
    expect(waiting.pending).toHaveLength(1);
    expect(waiting.items.map((x) => [x.role, x.text, !!x.queued, !!x.streaming])).toEqual([
      ["user", "what now?", true, false],
      ["assistant", "", false, true],
    ]);
    const came = srMerge(srTurns([card(3, "user", note("what now?", "SR-223"), NOW - 9_000)], "SR-223", false, "c1"), pending, NOW);
    expect(came.pending).toHaveLength(0);
    expect(came.items.map((x) => x.id)).toEqual(["c1:h3"]);
    // an earlier note with the same words doesn't stand for it
    expect(srMerge(srTurns([card(3, "user", note("what now?", "SR-223"), NOW - 60_000)], "SR-223", false, "c1"), pending, NOW).pending).toHaveLength(1);
    expect(srMerge([], pending, NOW + PENDING_MS).pending).toHaveLength(0);
  });

  it("remembers a request's chats and notes on disk, and reads every chat they went to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srai-"));
    const items: Record<string, unknown[]> = {
      old: [card(1, "user", note("first", "SR-223"), NOW - 90_000), card(2, "text", "one", NOW - 89_000)],
      now: [card(1, "user", note("second", "SR-223"), NOW - 9_000)],
    };
    const call = async (_m: string, path: string) => {
      const id = /^v1\/chats\/([^/]+)\/items$/.exec(path)?.[1];
      return id ? { status: 200, body: { items: items[id] ?? [], running: id === "now", queued: 0 } } : { status: 404, body: null };
    };
    const ai = new PersonAi(dir, call);
    ai.noteSr("SR-223", "old", "first", NOW - 91_000);
    ai.noteSr("SR-223", "now", "second", NOW - 10_000);
    expect(JSON.parse(readFileSync(join(dir, "sr-ai.json"), "utf8"))["SR-223"].chats).toEqual(["old", "now"]);
    const again = new PersonAi(dir, call);
    const got = await again.srItems("SR-223", "now");
    expect(got.map((x) => [x.id, x.role, x.text, !!x.streaming])).toEqual([
      ["old:h1", "user", "first", false],
      ["old:h2", "assistant", "one", false],
      ["now:h1", "user", "second", false],
      ["now:h-wait", "assistant", "", true],
    ]);
    expect(JSON.parse(readFileSync(join(dir, "sr-ai.json"), "utf8"))["SR-223"].pending).toEqual([]);
    expect(await again.srItems("SR-1", null)).toEqual([]);
  });
});
