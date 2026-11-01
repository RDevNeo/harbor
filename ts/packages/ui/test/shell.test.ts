import { expect, test } from "bun:test";
import { EARLIER, groupSeq, newOpened, stripDrawn, toggle, transcriptCards } from "../src/cards.ts";
import { byteAt, charAt, pressOf } from "../src/composer.ts";
import type { Item } from "../src/logic/item.ts";
import { fitIn } from "../src/mediarows.ts";
import { parseSteps } from "../src/script.ts";


const user = (text: string): Item => ({ kind: "user", text, files: ["/tmp/a.txt"], at: 1, mentions: [], sender: "", intent: "" });
const tool = (id: string, result: string | null): Item => ({ kind: "tool", id, name: "Bash", summary: "ls", input: "{}", result, is_error: false });

test("a transcript's cards: spaces at the ends, tool runs folded behind a row, open on toggle", () => {
  const items: Item[] = [user("hi"), tool("a", "ok"), tool("b", null), { kind: "text", text: "# Done\n\n- one", at: 2 }];
  const open = newOpened();
  let cards = transcriptCards(items, false, [], open, "");
  expect(cards.map((c) => c.kind)).toEqual(["space", "user", "group", "text", "space"]);
  expect(cards[1]?.files).toEqual(["a.txt"]);
  expect(cards[2]?.label).toBe("2 tool calls");
  expect(cards[2]?.pending).toBe(true);
  expect(cards[3]?.blocks.map((b) => b.kind)).toEqual(["h", "li"]);
  toggle(open, groupSeq(1));
  cards = transcriptCards(items, false, [], open, "Working 3s");
  expect(cards.map((c) => c.kind)).toEqual(["space", "user", "group", "tool", "tool", "text", "status", "space"]);
  expect(cards[3]?.open).toBe(false);
  toggle(open, 1);
  expect(transcriptCards(items, false, [], open, "")[3]?.open).toBe(true);
});

test("a lead's transcript hides its tool calls", () => {
  const cards = transcriptCards([user("hi"), tool("a", "ok"), { kind: "text", text: "ok", at: 2 }], true, [], newOpened(), "");
  expect(cards.map((c) => c.kind)).toEqual(["space", "user", "text", "space"]);
});

test("Slint's byte cursor and the logic's char positions map both ways", () => {
  const t = "é @ñ.";
  expect(charAt(t, 3)).toBe(2);
  expect(byteAt(t, 2)).toBe(3);
  expect(byteAt(t, charAt(t, Buffer.byteLength(t)))).toBe(Buffer.byteLength(t));
  expect(pressOf("\n", { control: false, shift: true, alt: false })).toEqual({ key: "Enter", ctrl: false, shift: true, alt: false });
  expect(pressOf("\u{f701}", { control: true, shift: false, alt: false }).key).toBe("ArrowDown");
});

test("HARBOR_POINTER steps parse like the Rust app's", () => {
  expect(parseSteps("10,20,click,2;5,6;x,1;7,8,type:a,b,0.5")).toEqual([
    { x: 10, y: 20, action: "click", at: 2 },
    { x: 5, y: 6, action: "", at: 1 },
    { x: 7, y: 8, action: "type:a", at: 1 },
  ]);
});

test("a large image fits the transcript's box and keeps its shape", () => {
  expect(fitIn(1600, 900, [480, 300])).toEqual([480, 270]);
  expect(fitIn(200, 100, [480, 300])).toEqual([200, 100]);
  expect(fitIn(300, 1200, [480, 300])).toEqual([75, 300]);
});

test("an image drawn under a reply leaves its reference out of the text", () => {
  expect(stripDrawn("See ![shot](./out/a.png) and ![other](b.png)", ["/p/out/a.png"])).toBe("See  and ![other](b.png)");
  expect(stripDrawn("![x](~/a.png)", [])).toBe("![x](~/a.png)");
});

test("a long transcript builds its latest cards and offers the earlier ones", () => {
  const items: Item[] = Array.from({ length: 200 }, (_, i): Item => ({ kind: "text", text: `reply ${i}`, at: i }));
  const open = newOpened();
  let cards = transcriptCards(items, true, [], open, "");
  expect(cards[1]?.kind).toBe("earlier");
  expect(cards[1]?.label).toBe("Show earlier messages (120)");
  expect(cards.filter((c) => c.kind === "text")).toHaveLength(80);
  toggle(open, EARLIER);
  cards = transcriptCards(items, true, [], open, "");
  expect(cards.filter((c) => c.kind === "text")).toHaveLength(160);
});
