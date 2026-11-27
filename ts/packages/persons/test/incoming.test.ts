import { describe, expect, test } from "bun:test";
import { FRESH_MS, freshIncoming } from "../src/incoming.ts";
import type { Message } from "../src/model/types.ts";

const now = Date.parse("2026-11-26T12:00:00Z");
const msg = (id: string, agoMs: number, o: Partial<Message> = {}): Message => ({ id, channelId: "c", authorId: "a", fromMe: false, content: `text ${id}`, timestamp: new Date(now - agoMs).toISOString(), ...o });

describe("freshIncoming", () => {
  test("only their new, recent, unread messages", () => {
    const before = { channelId: "c", messages: [msg("old", 60_000)] };
    const got = freshIncoming(before, [msg("old", 60_000), msg("n2", 5_000), msg("me", 4_000, { fromMe: true }), msg("n1", 9_000), msg("hist", FRESH_MS + 1000), msg("done", 2_000)], now, new Set(["done"]));
    expect(got).toEqual([
      { id: "n1", text: "text n1", at: Math.floor((now - 9_000) / 1000) },
      { id: "n2", text: "text n2", at: Math.floor((now - 5_000) / 1000) },
    ]);
  });

  test("read in the app already: nothing", () => {
    const seen = new Date(now - 1_000).toISOString();
    expect(freshIncoming(undefined, [msg("a", 3_000), msg("b", 500)], now, new Set(), seen).map((x) => x.id)).toEqual(["b"]);
  });

  test("attachments and emails read as their preview", () => {
    const got = freshIncoming(undefined, [msg("v", 1_000, { content: "", voice: true }), msg("e", 900, { content: "Olá", subject: "Proposta", threadId: "t" })], now, new Set());
    expect(got.map((x) => x.text)).toEqual(["🎤 Voice message", "Proposta: Olá"]);
  });
});
