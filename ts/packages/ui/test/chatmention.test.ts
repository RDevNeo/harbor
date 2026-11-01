import { expect, test } from "bun:test";
import { MAX_CHARS, TURNS, type Cand, type TurnItem, candMention, context, lastTurns, quote, rank, word } from "../src/logic/chatmention.ts";
import { type Mention, add, isChat, mentionFromJson, mentionToJson } from "../src/logic/mentions.ts";

function cand(title: string, project: string, here: boolean, settled: boolean, updated: number): Cand {
  return { gid: `g-${title}`, title, project, pc: "desk", status: settled ? "settled" : "idle", updated, here, settled };
}

test("finds_the_dollar_word", () => {
  expect(word("see $fix", 8)).toEqual({ start: 4, end: 8, query: "fix" });
  expect(word("$", 1)).toEqual({ start: 0, end: 1, query: "" });
  expect(word("(\u{24}lo", 4)?.start).toBe(1);
  // Money.
  expect(word("costs $5", 8)).toBeNull();
  // Inside a word.
  expect(word("a$b", 3)).toBeNull();
  expect(word("$$x", 3)).toBeNull();
  const w = word("$abc def", 2);
  expect(w === null ? null : [w.end, w.query]).toEqual([4, "a"]);
});

test("ranks_this_project_and_active_chats_first", () => {
  const cs = [cand("Old settled", "harbor", true, true, 50), cand("Other project", "site", false, false, 100), cand("Fix login", "harbor", true, false, 10), cand("Fix tests", "harbor", true, false, 20)];
  const titles = (q: string) => rank(cs, q, 10).map((c) => c.title);
  expect(titles("")).toEqual(["Fix tests", "Fix login", "Old settled", "Other project"]);
  expect(titles("login")).toEqual(["Fix login"]);
  // By project.
  expect(titles("site")).toEqual(["Other project"]);
  expect(titles("fix").slice(0, 2)).toEqual(["Fix tests", "Fix login"]);
});

const user = (t: string): TurnItem => ({ kind: "user", text: t });
const text = (t: string): TurnItem => ({ kind: "text", text: t });

test("context_has_the_last_turns_within_the_cap", () => {
  const items: TurnItem[] = [];
  for (let i = 0; i < 9; i++) items.push(user(`ask ${i}`), text(`thinking out loud ${i}`), text(`answer ${i}`));
  const turns = lastTurns(items);
  expect(turns.length).toBe(TURNS);
  expect(turns[0]).toEqual(["ask 3", "answer 3"]);
  const c = cand("Fix login", "harbor", true, false, 1);
  const ctx = context(c, "Fixed the cookie; tests pass.", items);
  expect(ctx.startsWith("Title: Fix login\nProject: harbor\nPC: desk\nStatus: idle\nRecap: Fixed the cookie; tests pass.\nLast 6 turns:\nUser: ask 3\nAgent: answer 3\n")).toBe(true);
  expect(ctx.endsWith("User: ask 8\nAgent: answer 8")).toBe(true);
  expect(ctx).not.toContain("thinking out loud");
  // Long chats stay within the cap, the newest turn kept.
  const big: TurnItem[] = [];
  for (let i = 0; i < 6; i++) big.push(user("q".repeat(5000)), text(`${i}${"a".repeat(9000)}`));
  const long = context(c, null, big);
  expect(Array.from(long).length).toBeLessThanOrEqual(MAX_CHARS);
  expect(long).toContain("Agent: 5aaa");
  expect(context(c, null, []).split("\n").pop()).toBe("(no messages yet)");
});

test("the_quote_names_the_chat", () => {
  const m = candMention(cand("Fix login", "harbor", true, false, 1));
  expect(isChat(m) && m.text === "").toBe(true);
  m.text = "Title: Fix login\nStatus: idle";
  m.note = "same bug?";
  m.chat = "g1";
  expect(quote(m)).toBe("> [mentioned chat “Fix login”, chat id g1 (message_chat takes it; link it as harbor://chat/g1)]\n> Title: Fix login\n> Status: idle\nsame bug?\n\n");
  // On the wire: kind, chat and title; a message mention stays as before.
  const v = mentionToJson(m);
  expect([v.kind, v.chat, v.title]).toEqual(["chat", "g1", "Fix login"]);
  const back = mentionFromJson({ kind: "chat", chat: "g1", title: "T" });
  expect(back !== null && isChat(back) && back.item === 0 && back.from === "").toBe(true);
  // One chat once.
  const list: Mention[] = [];
  add(list, { ...m });
  add(list, m);
  expect(list.length).toBe(1);
});
