import { expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { earlier, forget, mdBlocks, newOpened, PAGE, PageBlocks, sameBlock, transcriptCards, trim } from "../src/cards.ts";
import { BLOCKS_BUDGET, blockStats, linkAt, registerBlock, releaseBlocks, selectionAt } from "../src/markdown.ts";
import type { CardData } from "../src/window.ts";

const text = (t: string, at = 1): Item => ({ kind: "text", text: t, at });
const user = (t: string): Item => ({ kind: "user", text: t, files: [], at: 1, mentions: [], sender: "", intent: "" });
const reply = (cards: CardData[]): CardData | undefined => cards.findLast((c) => c.kind === "text");

/** A streamed reply: each change adds a paragraph with a link. */
const streamed = (n: number): string => Array.from({ length: n }, (_, i) => `Step ${i}: see [docs ${i}](https://example.com/${i}) for more.`).join("\n\n");

test("a streaming reply rebuilt many times keeps one key per block, and its links and selections still work", () => {
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
  expect(linkAt(`at:${first}:${Buffer.byteLength("Step 0: see d")}`)).toBe("https://example.com/0");
  expect(linkAt(`at:${blocks[29]?.key}:${Buffer.byteLength("Step 29: see d")}`)).toBe("https://example.com/29");
  expect(selectionAt(`sel:${first}:0:6:10:20`)).toEqual({ seq: 1, text: "Step 0", x: 10, y: 20 });
  // The window may keep an older parse of an unchanged block (sameBlock): its key is the new one's.
  items[1] = text(`${streamed(30)}\n\nOne more.`);
  const again = reply(transcriptCards(items, false, [], open, "Working…"))?.blocks ?? [];
  expect(sameBlock(blocks[0] as never, again[0] as never)).toBe(true);
  expect(linkAt(`at:${first}:${Buffer.byteLength("Step 0: see d")}`)).toBe("https://example.com/0");
  // A chat no longer shown lets its keys go.
  forget(open);
  expect(linkAt(`at:${first}:${Buffer.byteLength("Step 0: see d")}`)).toBeNull();
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
  expect(linkAt(`at:${three[2]?.key}:0`)).toBeNull();
  expect(linkAt(`at:${three[0]?.key}:0`)).toBe("https://a.dev");
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

test("other pages' numbered keys are bounded by the byte budget, the newest kept", () => {
  const big = "x".repeat(256 * 1024);
  const keys = Array.from({ length: (2 * BLOCKS_BUDGET) / (512 * 1024) }, (_, i) => registerBlock(big, [{ from: 0, to: 1, url: `https://n.dev/${i}` }], -1));
  expect(blockStats().bytes).toBeLessThanOrEqual(BLOCKS_BUDGET);
  expect(linkAt(`at:${keys[0]}:0`)).toBeNull();
  expect(linkAt(`at:${keys.at(-1)}:0`)).toBe(`https://n.dev/${keys.length - 1}`);
  // A block larger than the per-entry cap draws but isn't clickable.
  expect(registerBlock("y".repeat(2 ** 20), [{ from: 0, to: 1, url: "https://y.dev" }], -1)).toBe("");
  const owned = mdBlocks("[z](https://z.dev)", 4, "t.4");
  expect(owned[0]?.key).toBe("t.4.0");
  releaseBlocks("t.4");
  expect(linkAt("at:t.4.0:0")).toBeNull();
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
  expect(linkAt(`at:${body[0]?.key}:${Buffer.byteLength("PR body with a")}`)).toBe("https://a.dev");
  expect(linkAt(`at:${note[0]?.key}:${Buffer.byteLength("A comment with a")}`)).toBeNull();
  page.drawn();
  page.drawn();
  expect(page.size).toBe(0);
  expect(blockStats().blocks).toBe(before);
});
