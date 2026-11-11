import { expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { guessHeight, newOpened, PAGE, transcriptCards } from "../src/cards.ts";
import { WarmChats } from "../src/logic/warmchats.ts";
import { noPixels, type MediaRow } from "../src/window.ts";

const reply = (i: number, lines = 1): Item => ({ kind: "text", text: Array.from({ length: lines }, (_, k) => `reply ${i} line ${k}`).join("\n"), at: 100 + i });
const texts = (cards: { kind: string; seq: number }[]) => cards.filter((c) => c.kind === "text").map((c) => c.seq);

test("a chat's first frame builds only the latest cards that fill it; the rest of the page keeps its built cards", () => {
  const items = Array.from({ length: 40 }, (_, i) => reply(i, 4));
  const open = newOpened();
  const page = transcriptCards(items, false, [], open, "");
  expect(texts(page)).toHaveLength(PAGE);
  const kept = page.find((c) => c.seq === 30);
  // Opened again: four-line replies (~104 px each) to fill 300 px.
  open.fill = 300;
  const first = transcriptCards(items, false, [], open, "");
  expect(texts(first)).toEqual([37, 38, 39]);
  expect(first[1]).toMatchObject({ kind: "earlier", label: "Show earlier messages (37)" });
  // The page's other cards kept what they were built as: the next build makes nothing again.
  open.fill = undefined;
  const rest = transcriptCards(items, false, [], open, "");
  expect(texts(rest)).toEqual(texts(page));
  expect(rest.find((c) => c.seq === 30)).toBe(kept as never);
  // Always a few, and never more than the page.
  open.fill = 0;
  expect(texts(transcriptCards(items, false, [], open, ""))).toHaveLength(3);
  open.fill = 1e9;
  expect(texts(transcriptCards(items, false, [], open, ""))).toHaveLength(PAGE);
});

test("a card's guessed height grows with its lines and its images", () => {
  const one = guessHeight({ kind: "text", text: "hi", at: 1, forkable: false });
  expect(guessHeight({ kind: "text", text: "a\nb\nc", at: 1, forkable: false })).toBe(one + 44);
  expect(guessHeight({ kind: "text", text: "x".repeat(250), at: 1, forkable: false })).toBe(one + 44);
  expect(guessHeight({ kind: "text", text: "![s](/tmp/a.png)", at: 1, forkable: false })).toBe(one + 240);
  expect(guessHeight({ kind: "hidden" })).toBe(0);
});

test("an image's pixels coming in leave its card's built text as it was", () => {
  const items: Item[] = [{ kind: "text", text: "Here: ![s](/tmp/x.png) and **more**", at: 1 }];
  let image = noPixels;
  const row = (): MediaRow => ({ image, caption: "s", large: true, w: 480, h: 300, path: "/tmp/x.png", video: false, name: "", slot: -1, thumbs: 0 });
  const open = newOpened();
  const a = transcriptCards(items, false, [], open, "", 0, () => [row()]).find((c) => c.kind === "text");
  image = { width: 480, height: 300, data: new Uint8Array(480 * 300 * 4) };
  const b = transcriptCards(items, false, [], open, "", 0, () => [row()]).find((c) => c.kind === "text");
  expect(b).not.toBe(a as never);
  expect(b?.media[0]?.image).toBe(image);
  expect(b?.blocks).toBe(a?.blocks as never);
  // Built again from there on: the same card.
  expect(transcriptCards(items, false, [], open, "", 0, () => [row()]).find((c) => c.kind === "text")).toBe(b as never);
});

test("the chats left last stay warm: at most a few, within a budget of items, the one left last always", () => {
  const sizes: Record<number, number> = { 1: 100, 2: 200, 3: 300, 4: 4000, 5: 50 };
  const gone: number[] = [];
  const w = new WarmChats(3, 1000, (id) => sizes[id] ?? 0, (id) => gone.push(id));
  for (const id of [1, 2, 3]) w.leave(id);
  expect(w.list).toEqual([3, 2, 1]);
  // Back on screen: no longer warm, nothing goes.
  expect(w.take(2)).toBe(true);
  expect(w.list).toEqual([3, 1]);
  w.leave(2);
  w.leave(5);
  expect(w.list).toEqual([5, 2, 3]);
  expect(gone).toEqual([1]);
  // A huge one stays alone: the others go.
  w.leave(4);
  expect(w.list).toEqual([4]);
  expect(gone).toEqual([1, 5, 2, 3]);
  expect(w.take(9)).toBe(false);
});
