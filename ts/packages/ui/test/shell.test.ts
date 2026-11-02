import { expect, test } from "bun:test";
import { EARLIER, earlier, forget, groupSeq, newOpened, QUEUE_MORE, queueCards, type QueuedView, stripDrawn, subsRunning, toggle, transcriptCards, trim, withQueue } from "../src/cards.ts";
import { byteAt, charAt, pressOf } from "../src/composer.ts";
import type { Item } from "../src/logic/item.ts";
import { fitIn } from "../src/mediarows.ts";
import { parseSteps } from "../src/script.ts";
import { marksOf } from "../src/shell.ts";


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
  expect(cards[1]?.label).toBe("Show earlier messages (185)");
  expect(cards.filter((c) => c.kind === "text")).toHaveLength(15);
  toggle(open, EARLIER);
  cards = transcriptCards(items, true, [], open, "");
  expect(cards.filter((c) => c.kind === "text")).toHaveLength(30);
  expect(open.memo.size).toBe(30);
});

test("pages scrolled up to are let go: trimmed back to the latest, and nothing kept for a chat left", () => {
  const items: Item[] = Array.from({ length: 300 }, (_, i): Item => ({ kind: "text", text: `reply ${i}`, at: i }));
  const open = newOpened();
  transcriptCards(items, false, [], open, "");
  const latest = transcriptCards(items, false, [], open, "").find((c) => c.seq === 299);
  earlier(open);
  earlier(open);
  expect(transcriptCards(items, false, [], open, "").filter((c) => c.kind === "text")).toHaveLength(45);
  expect(open.memo.size).toBe(45);
  expect(trim(open)).toBe(true);
  expect(trim(open)).toBe(false);
  const cards = transcriptCards(items, false, [], open, "");
  expect(cards.filter((c) => c.kind === "text")).toHaveLength(15);
  expect(open.memo.size).toBe(15);
  // The latest cards kept their built data through the trim.
  expect(cards.find((c) => c.seq === 299)).toBe(latest);
  forget(open);
  expect(open.memo.size).toBe(0);
});

const queued = (id: number, text: string, more: Partial<QueuedView> = {}): QueuedView => ({ id, text, files: 0, written: false, steering: false, note: "", editing: "", ...more });
const idle = { running: false, steerable: false, held: false, editing: null, unfolded: false };

test("queue_shows_steers_apart_and_numbers_the_waiting_ones", () => {
  const q = queueCards([queued(1, "now", { steering: true }), queued(2, "", { files: 2, written: true }), queued(3, "a"), queued(4, "b")], { ...idle, running: true, steerable: true });
  expect(q.steers.map((c) => [c.kind, c.text])).toEqual([["steering", "now"]]);
  expect(q.next.map((c) => c.kind)).toEqual(["queue-head", "queued", "queued", "queued"]);
  expect(q.next[0]?.label).toBe("Up next · 3 queued");
  expect(q.next[1]).toMatchObject({ text: "2 attachment(s)", pending: true, detail: "" });
  expect(q.next.slice(2).map((c) => [c.detail, c.label, c.expandable, c.url])).toEqual([
    ["1", "Steer", true, "Send as a steer instead (Ctrl+Shift+Enter)"],
    ["2", "Steer", true, "Send as a steer instead"],
  ]);
  expect(q.next[3]?.icon).toBe("Edit in the composer (Alt+↑)");
});

test("queue_folds_past_three_and_says_why_it_waits", () => {
  const four = [queued(1, "a"), queued(2, "b"), queued(3, "c"), queued(4, "d")];
  const held = queueCards(four, { ...idle, held: true });
  expect(held.next[0]?.label).toBe("Up next · 4 queued · paused");
  expect(held.next.map((c) => c.seq)).toEqual([-6, 1, 2, QUEUE_MORE]);
  expect(held.next[1]).toMatchObject({ label: "Send now", expandable: true, url: "Send it now" });
  expect(queueCards(four, { ...idle, unfolded: true }).next).toHaveLength(5);
  const stuck = queueCards([queued(1, "a")], { ...idle, running: true, editing: 1 });
  expect(stuck.next[1]).toMatchObject({ expandable: false, url: "The agent can't be steered now: it waits for the turn to end", tone: "mine", detail: "", open: false });
});

test("steers_go_over_working_and_the_queue_after_it", () => {
  const card = (kind: "text" | "status" | "space", seq: number) => ({ ...transcriptCards([], false, [], newOpened(), "")[0], kind, seq }) as ReturnType<typeof transcriptCards>[number];
  const q = queueCards([queued(5, "s", { steering: true }), queued(6, "w")], { ...idle, running: true, steerable: true });
  const order = (cards: ReturnType<typeof transcriptCards>) => withQueue(cards, q).map((c) => c.kind);
  expect(order([card("text", 0), card("status", -2), card("space", -3)])).toEqual(["text", "steering", "status", "queue-head", "queued", "space"]);
  expect(order([card("text", 0), card("space", -3)])).toEqual(["text", "steering", "queue-head", "queued", "space"]);
  expect(subsRunning(0)).toBe("");
  expect(subsRunning(2)).toBe("  ·  2 sub-agents running");
});

test("a chat in a worktree shows its folder mark, red once gone, and its PR's state", () => {
  expect(marksOf(null, false, null)).toEqual({ worktree: "", worktree_tip: "", pr: "", pr_tip: "" });
  const pr = { number: 42, state: "open" as const, url: "https://github.com/o/r/pull/42", title: "Add thing", branch: "add-thing" };
  expect(marksOf("/w/harbor-add-thing", false, pr)).toEqual({
    worktree: "live",
    worktree_tip: "Runs in its own worktree, harbor-add-thing",
    pr: "open",
    pr_tip: "PR #42 · Open: Add thing",
  });
  expect(marksOf("/w/harbor-old-try", true, null)).toMatchObject({ worktree: "gone", worktree_tip: "Its worktree, harbor-old-try, is gone", pr: "" });
});
