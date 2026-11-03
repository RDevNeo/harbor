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

test("a copy of another PC's chat: the home PC's messages show its owner, this PC's own none", () => {
  const viewer = { dev: "pc:work-pc", label: "work-pc (Sam Rig)", home: { name: "home-pc", owner: "Kim Rig" } };
  const mine: Item = { ...user(200), sender: "work-pc (Sam Rig)", who: "Sam Rig", via: "pc", dev: "pc:work-pc" } as Item;
  const open = newOpened();
  const cards = transcriptCards([user(100), mine], false, [], open, "", 0, () => [], () => false, viewer).filter((c) => c.kind === "user");
  expect(cards.map((c) => [c.sender, c.icon !== "", c.joined])).toEqual([
    ["Kim Rig", true, false],
    ["", false, false],
  ]);
  // The home PC's own desktop: no row for its own message.
  const home = transcriptCards([user(100)], false, [], newOpened(), "").filter((c) => c.kind === "user");
  expect(home.map((c) => c.sender)).toEqual([""]);
});
