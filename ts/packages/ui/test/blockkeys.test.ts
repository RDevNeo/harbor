import { expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { earlier, forget, mdBlocks, newOpened, PAGE, PageBlocks, sameBlock, transcriptCards, trim } from "../src/cards.ts";
import { BLOCKS_BUDGET, blockStats, registerBlock, releaseBlocks, selectionAt } from "../src/markdown.ts";
import type { CardData } from "../src/window.ts";

const text = (t: string, at = 1): Item => ({ kind: "text", text: t, at });
const user = (t: string): Item => ({ kind: "user", text: t, files: [], at: 1, mentions: [], sender: "", intent: "" });
const reply = (cards: CardData[]): CardData | undefined => cards.findLast((c) => c.kind === "text");

/** A streamed reply: each change adds a paragraph with a link. */
const streamed = (n: number): string => Array.from({ length: n }, (_, i) => `Step ${i}: see [docs ${i}](https://example.com/${i}) for more.`).join("\n\n");

test("a streaming reply rebuilt many times keeps one key per block, and its selections still work", () => {
  const before = blockStats();
  const open = newOpened();
  const items: Item[] = [user("go"), text("")];
  let last: CardData | undefined;
  for (let i = 1; i <= 300; i++) {
    items[1] = text(streamed(Math.ceil(i / 10)));
    last = reply(transcriptCards(items, false, [], open, "Working…"));
  }
  const blocks = last?.blocks ?? [];
  expect(blocks.length).toBe(30);
  expect(blockStats().blocks - before.blocks).toBe(30);
  const first = blocks[0]?.key ?? "";
  expect(selectionAt(`sel:${first}:0:6:0:0`)?.text).toBe("Step 0");
  expect(selectionAt(`sel:${blocks[29]?.key}:0:7:0:0`)?.text).toBe("Step 29");
  expect(blocks[29]?.links[0]?.url).toBe("https://example.com/29");
  expect(selectionAt(`sel:${first}:0:6:10:20`)).toEqual({ seq: 1, text: "Step 0", x: 10, y: 20 });
  // The window may keep an older parse of an unchanged block (sameBlock): its key is the new one's.
  items[1] = text(`${streamed(30)}\n\nOne more.`);
  const again = reply(transcriptCards(items, false, [], open, "Working…"))?.blocks ?? [];
  expect(sameBlock(blocks[0] as never, again[0] as never)).toBe(true);
  expect(selectionAt(`sel:${first}:0:6:0:0`)?.text).toBe("Step 0");
  // A chat no longer shown lets its keys go.
  forget(open);
  expect(selectionAt(`sel:${first}:0:6:0:0`)).toBeNull();
  expect(blockStats().blocks).toBe(before.blocks);
});

test("a reply that shrinks or leaves the built cards takes its keys with it", () => {
  const before = blockStats().blocks;
  const open = newOpened();
  const items: Item[] = [text("[a](https://a.dev)\n\n[b](https://b.dev)\n\n[c](https://c.dev)")];
  const three = reply(transcriptCards(items, false, [], open, ""))?.blocks ?? [];
  expect(blockStats().blocks - before).toBe(3);
  items[0] = text("[a](https://a.dev)");
  transcriptCards(items, false, [], open, "");
  expect(blockStats().blocks - before).toBe(1);
  expect(selectionAt(`sel:${three[2]?.key}:0:1:0:0`)).toBeNull();
  expect(selectionAt(`sel:${three[0]?.key}:0:1:0:0`)?.text).toBe("a");
  // Scrolled up a page and back: the cards that leave the window leave the table too.
  const many: Item[] = Array.from({ length: PAGE * 3 }, (_, i) => text(`[l${i}](https://x.dev/${i})`));
  earlier(open);
  earlier(open);
  transcriptCards(many, false, [], open, "");
  expect(blockStats().blocks - before).toBe(PAGE * 3);
  trim(open);
  transcriptCards(many, false, [], open, "");
  expect(blockStats().blocks - before).toBe(PAGE);
  forget(open);
  expect(blockStats().blocks).toBe(before);
});

test("numbered keys (blocks outside a card) are bounded by the byte budget, the newest kept", () => {
  const big = "x".repeat(256 * 1024);
  const keys = Array.from({ length: (2 * BLOCKS_BUDGET) / (512 * 1024) }, (_, i) => registerBlock(`${i}${big}`, 0));
  expect(blockStats().bytes).toBeLessThanOrEqual(BLOCKS_BUDGET);
  expect(selectionAt(`sel:${keys[0]}:0:1:0:0`)).toBeNull();
  expect(selectionAt(`sel:${keys.at(-1)}:0:${String(keys.length - 1).length}:0:0`)?.text).toBe(String(keys.length - 1));
  // A block larger than the per-entry cap draws and selects, but a selection of it isn't mentioned.
  expect(registerBlock("y".repeat(2 ** 20), 0)).toBe("");
  const owned = mdBlocks("[z](https://z.dev)", 4, "t.4");
  expect(owned[0]?.key).toBe("t.4.0");
  releaseBlocks("t.4");
  expect(selectionAt("sel:t.4.0:0:1:0:0")).toBeNull();
});

test("a page's markdown is the same blocks while drawn, and goes with its keys once a render no longer draws it", () => {
  const before = blockStats().blocks;
  const page = new PageBlocks();
  const body = page.get("PR body with [a link](https://a.dev)");
  const note = page.get("A comment with [another](https://b.dev)");
  page.drawn();
  expect(page.get("PR body with [a link](https://a.dev)")).toBe(body);
  page.drawn();
  expect(page.size).toBe(1);
  // A page's blocks open their links themselves: none takes a key (nothing on a page is mentioned).
  expect(body[0]?.links.map((w) => w.url)).toEqual(["https://a.dev", "https://a.dev"]);
  expect([body[0]?.key, note[0]?.key]).toEqual(["", ""]);
  expect(blockStats().blocks).toBe(before);
  page.drawn();
  page.drawn();
  expect(page.size).toBe(0);
  expect(blockStats().blocks).toBe(before);
});
