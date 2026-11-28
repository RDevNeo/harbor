import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiKeyMatches, aiUnreadCount, aiUnreadOf, PersonAi } from "../src/ai.ts";
import type { Person } from "../src/model/types.ts";

const person = (id: string): Person => ({ id, name: id, storeIds: [], listIds: [] }) as unknown as Person;
/** A Person AI whose chats are already known (ai-chats.json), with no Hub behind it. */
const make = (chats: Record<string, string>): { ai: PersonAi; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "aiunread-"));
  writeFileSync(join(dir, "ai-chats.json"), JSON.stringify(chats));
  return { ai: new PersonAi(dir, async () => ({ status: 500, body: null })), dir };
};

describe("the Person AI's unseen answers", () => {
  it("counts each ended turn of a person's AI chat on that person and section", () => {
    const { ai, dir } = make({ "p1:spokpay": "41", "p1:stores": "42", "p2:creators": "43", "sr:meoow": "44" });
    expect(ai.owns("41")).toBe(true);
    // a site request's own chat isn't a person's: Projects keeps showing it
    expect(ai.owns("44")).toBe(false);
    expect(ai.owns("99")).toBe(false);
    expect(ai.answered("41")).toBe(true);
    expect(ai.answered("41")).toBe(true);
    expect(ai.answered("42")).toBe(true);
    expect(ai.answered("44")).toBe(false);
    expect(ai.unreadOf(["p1"], "spokpay")).toBe(2);
    expect(ai.unreadOf(["p1"], null)).toBe(3);
    expect(ai.unreadOf(["p2"], null)).toBe(0);
    // kept across starts
    expect(JSON.parse(readFileSync(join(dir, "ai-unread.json"), "utf8"))).toEqual({ "p1:spokpay": 2, "p1:stores": 1 });
    expect(new PersonAi(dir, async () => ({ status: 500, body: null })).unreadOf(["p1"], null)).toBe(3);
  });

  it("clears a section's when its page is seen, the others stay", () => {
    const { ai } = make({ "p1:spokpay": "41", "p1:stores": "42" });
    ai.answered("41");
    ai.answered("42");
    expect(ai.seen(["p1"], "spokpay")).toBe(true);
    expect(ai.seen(["p1"], "spokpay")).toBe(false);
    expect(ai.unreadOf(["p1"], null)).toBe(1);
    expect(ai.seen(["p1"], null)).toBe(true);
    expect(ai.unreadOf(["p1"], null)).toBe(0);
  });

  it("a linked person's answers count on the person they're linked into", () => {
    const { ai } = make({ "p1:stores": "41", "p9:stores": "49" });
    ai.answered("49");
    expect(ai.unreadOf(["p1"], "stores")).toBe(0);
    expect(ai.unreadOf(["p1", "p9"], "stores")).toBe(1);
  });

  it("Move to… carries the unseen answers to the new section", () => {
    const { ai } = make({ "p1:stores": "41" });
    ai.answered("41");
    ai.move(person("p1"), "stores", "spokpay");
    expect(ai.unreadOf(["p1"], "stores")).toBe(0);
    expect(ai.unreadOf(["p1"], "spokpay")).toBe(1);
    expect(ai.owns("41")).toBe(true);
  });

  it("reads ai-unread.json defensively and matches keys exactly", () => {
    expect(aiUnreadOf({ "a:stores": 2, "b:stores": -1, "c:stores": 1.5, d: "x" })).toEqual({ "a:stores": 2 });
    expect(aiUnreadOf([1])).toEqual({});
    expect(aiKeyMatches("p1:stores", ["p1"], "stores")).toBe(true);
    expect(aiKeyMatches("p10:stores", ["p1"], null)).toBe(false);
    expect(aiKeyMatches("a:b:stores", ["a:b"], "stores")).toBe(true);
    expect(aiUnreadCount({ "p1:stores": 2, "p1:spokpay": 1, "p2:stores": 5 }, ["p1"], null)).toBe(3);
  });
});
