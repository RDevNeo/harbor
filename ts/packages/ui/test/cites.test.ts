import { expect, test } from "bun:test";
import type { Item, Mention } from "@harbor/store";
import { cites, citesLabel, newOpened, queueCards, transcriptCards } from "../src/cards.ts";

const mention = (m: Partial<Mention>): Mention => ({ item: 0, from: "Claude", at: 0, text: "", len: 0, excerpt: false, note: "", kind: "", chat: "", title: "", ...m });
const user = (text: string, mentions: Mention[]): Item => ({ kind: "user", text, files: [], at: 100, mentions, sender: "", intent: "" });
const userCards = (items: Item[]) => transcriptCards(items, false, [], newOpened(), "").filter((c) => c.kind === "user");

test("a message of mentions alone: its chips and notes, and no text line", () => {
  const [c] = userCards([user("", [mention({ item: 3, text: "Most of the time went into those two builds.", len: 44, excerpt: true, note: " did these happen in harbor? " })])]);
  expect(c?.blocks).toEqual([]);
  expect(c?.cites.map((x) => [x.head, x.snippet, x.note])).toEqual([["Claude", "“Most of the time went into those two builds.”", "did these happen in harbor?"]]);
  expect(c?.cites[0]?.tip).toContain("Most of the time went into those two builds.");
  // The note is under the chip, so the tooltip doesn't repeat it.
  expect(c?.cites[0]?.tip).not.toContain("did these happen");
});

test("a message with text and mentions: the chips and the text", () => {
  const [c] = userCards([user("Compare these", [mention({ text: "first line\nsecond", len: 17 }), mention({ from: "you", text: "okay?", len: 5, note: "this one" })])]);
  expect(c?.blocks.length).toBe(1);
  expect(c?.cites.map((x) => [x.head, x.snippet, x.note])).toEqual([
    ["Claude", "first line", ""],
    ["you", "okay?", "this one"],
  ]);
});

test("a mentioned chat is a link in the text, not a chip", () => {
  const [c] = userCards([user("", [mention({ kind: "chat", chat: "g1", title: "Fix login", from: "harbor" })])]);
  expect(c?.cites).toEqual([]);
  expect(c?.blocks.length).toBe(1);
});

test("a message with no mentions has no chips; old items' mentions without every field still read", () => {
  expect(userCards([user("hi", [])])[0]?.cites).toEqual([]);
  expect(cites([{ item: 2, from: "Claude", at: 1, text: "On it.", len: 6, note: "stop" }]).map((x) => [x.snippet, x.note])).toEqual([["On it.", "stop"]]);
  expect(cites([{ item: "x" }, null])).toEqual([]);
});

test("a queued message of mentions alone reads as its notes, else its chips", () => {
  const ms = [mention({ text: "Three changes are still finishing", len: 33, excerpt: true, note: "lmk when done" }), mention({ text: "Branch deleted.", len: 15 })];
  expect(citesLabel(ms)).toBe("lmk when done\n@Claude Branch deleted.");
  const q = (text: string, files: number, mentions: Mention[], steering = false) => ({ id: 1, text, files, written: false, steering, note: "", editing: "", mentions });
  const state = { running: true, steerable: true, held: false, editing: null, unfolded: false };
  expect(queueCards([q("", 0, ms)], state).next[1]?.text).toBe("lmk when done\n@Claude Branch deleted.");
  expect(queueCards([q("", 0, ms, true)], state).steers[0]?.text).toBe("lmk when done\n@Claude Branch deleted.");
  expect(queueCards([q("", 2, [])], state).next[1]?.text).toBe("2 attachment(s)");
  expect(queueCards([q("go on", 0, ms)], state).next[1]?.text).toBe("go on");
});
