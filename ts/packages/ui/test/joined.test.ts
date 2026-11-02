import { expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { newOpened, transcriptCards } from "../src/cards.ts";

const user = (at: number): Item => ({ kind: "user", text: `m${at}`, files: [], at, mentions: [], sender: "", intent: "" });

test("a joined card and the tight one above it; the same objects on the next build", () => {
  const items = [user(100), user(110), { kind: "text", text: "ok", at: 120 } as Item];
  const open = newOpened();
  const a = transcriptCards(items, false, [], open, "").filter((c) => c.kind === "user");
  expect(a.map((c) => [c.joined, c.tight])).toEqual([
    [false, true],
    [true, false],
  ]);
  const b = transcriptCards(items, false, [], open, "").filter((c) => c.kind === "user");
  expect(b[0]).toBe(a[0] as never);
  expect(b[1]).toBe(a[1] as never);
});

test("the first card under 'Show earlier messages' joins nothing", () => {
  const open = newOpened();
  open.limit = 1;
  const cards = transcriptCards([user(100), user(110)], false, [], open, "").filter((c) => c.kind === "user");
  expect(cards.map((c) => [c.seq, c.joined, c.tight])).toEqual([[1, false, false]]);
});
