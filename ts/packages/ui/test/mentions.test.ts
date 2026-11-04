import { expect, test } from "bun:test";
import { tipParts } from "../src/logic/tips.ts";
import { MAX_CHARS, MENTION_HIDE_SECS, MENTION_SETTLE_SECS, type Box, type Mention, SelectionButton, add, chipTip, excerpt, folded, locate, mentionFromJson, mentionToJson, merged, newMention, prompt, scrollTarget } from "../src/logic/mentions.ts";

function whole(item: number, text: string): Mention {
  return newMention({ item, from: "Claude", text, len: Array.from(text).length });
}

test("old_mentions_load_as_whole_messages", () => {
  const m = mentionFromJson(JSON.parse('{"item":3,"from":"you","text":"hi"}'));
  expect(m?.excerpt).toBe(false);
  // And whole ones are saved as before, without the new field.
  expect(JSON.stringify(mentionToJson(whole(1, "x")))).not.toContain("excerpt");
});

test("an_excerpt_is_quoted_alone", () => {
  const m = excerpt(whole(2, "First line.\nThe part that matters.\nLast line."), "The part that matters.");
  expect(m.excerpt).toBe(true);
  expect(prompt([m])).toBe("> [excerpt of a message from Claude]\n> The part that matters.\n\n");
  expect(prompt([whole(2, "a\nb")])).toBe("> [mentioned message from Claude]\n> a\n> b\n\n");
});

test("notes_go_under_their_quote", () => {
  const a = excerpt(whole(2, "One. Two. Three."), "Two.");
  a.note = "  why two?\n";
  const b = whole(3, "Done.");
  expect(prompt([a, b])).toBe("> [excerpt of a message from Claude]\n> Two.\nwhy two?\n\n> [mentioned message from Claude]\n> Done.\n\n");
  // Old mentions have no note; an empty one isn't saved.
  const m = mentionFromJson(JSON.parse('{"item":3,"from":"you","text":"hi","excerpt":true}'));
  expect(m?.note).toBe("");
  expect(m === null ? "note" : JSON.stringify(mentionToJson(m))).not.toContain("note");
});

test("long_excerpts_are_cut", () => {
  const long = "x".repeat(MAX_CHARS + 10);
  const m = excerpt(whole(0, long), long);
  expect(Array.from(m.text).length).toBe(MAX_CHARS);
  expect(prompt([m])).toContain(`(truncated: the first ${MAX_CHARS} of ${MAX_CHARS + 10} characters)`);
});

test("excerpts_of_one_message_add_once_each", () => {
  const list: Mention[] = [];
  add(list, whole(1, "a b c"));
  add(list, whole(1, "a b c"));
  add(list, excerpt(whole(1, "a b c"), "b"));
  add(list, excerpt(whole(1, "a b c"), "b"));
  add(list, excerpt(whole(1, "a b c"), "c"));
  expect(list.length).toBe(3);
  expect(folded(" a\n  b\tc ")).toBe("a b c");
});

function found(texts: string[], ex: string): string[] | null {
  const ps = texts.map((t) => Array.from(t));
  return locate(ps, ex)?.map(([p, a, b]) => (ps[p] ?? []).slice(a, b).join("")) ?? null;
}

test("an_excerpt_is_found_with_any_whitespace", () => {
  expect(found(["One two three four."], "two three")).toEqual(["two three"]);
  expect(found(["One two  three four."], "two\nthree")).toEqual(["two  three"]);
  expect(found(["One two\nthree four."], "  two three\n")).toEqual(["two\nthree"]);
  expect(found(["Run ", "cargo", "test now"], "Run cargo test now")).toEqual(["Run", "cargo", "test now"]);
});

test("an_excerpt_spans_labels_and_lines", () => {
  expect(found(["First ", "bold", " last"], "st bold la")).toEqual(["st", "bold", "la"]);
  expect(found(["end of one.", "Start of two."], "of one.\n\nStart")).toEqual(["of one.", "Start"]);
  expect(found(["1.", "First item", "2.", "Second item"], "First item\nSecond")).toEqual(["First item", "Second"]);
});

test("a_long_gap_is_not_part_of_an_excerpt", () => {
  expect(found(["Alpha", "a whole paragraph that was not selected", "Beta"], "Alpha Beta")).toBeNull();
});

test("the_end_of_a_cut_excerpt_is_found", () => {
  expect(found(["It answers nothing to send and stops."], "answers nothing\u2026")).toEqual(["answers nothing"]);
  expect(found(["It answers nothing."], "\u2026answers\u2026")).toEqual(["answers"]);
  expect(found(["Well\u2026 maybe"], "Well\u2026")).toEqual(["Well\u2026"]);
  const long = "word ".repeat(2000);
  const m = excerpt(whole(0, long), long);
  expect(found([long], m.text)).not.toBeNull();
});

test("what_isnt_there_is_not_found", () => {
  expect(found(["Some text."], "other")).toBeNull();
  expect(found(["Some text."], "   ")).toBeNull();
  expect(found(["Some text."], "\u2026")).toBeNull();
  expect(found([], "x")).toBeNull();
  expect(found(["Some text."], "text. And more")).toBeNull();
});

test("the_first_start_that_goes_through_wins", () => {
  expect(found(["ab ab abc"], "abc")).toEqual(["abc"]);
});

const box = (l: number, t: number, w: number, h = 20): Box => ({ left: l, top: t, right: l + w, bottom: t + h });

test("a_line_of_labels_is_one_row_and_lines_stay_apart", () => {
  expect(merged([box(0, 0, 40), box(44, 1, 30), box(0, 20, 50)])).toEqual([{ left: 0, top: 0, right: 74, bottom: 21 }, box(0, 20, 50)]);
  expect(merged([box(0, 0, 40), box(300, 0, 30)]).length).toBe(2);
});

test("a_tall_excerpt_scrolls_to_its_start", () => {
  const rows = [box(10, 100, 50, 20), box(0, 120, 80, 900)];
  expect(scrollTarget(rows, 2000)).toEqual(box(0, 100, 80, 920));
  expect(scrollTarget(rows, 500)).toEqual(box(0, 100, 80, 400));
});

test("the selection's button waits for the selection to rest, then goes after a while unless the pointer is on it", () => {
  const b = new SelectionButton(10);
  const first = b.step(10.2, false, false);
  expect(first.show).toBe(false);
  expect(first.wake ?? 0).toBeCloseTo(MENTION_SETTLE_SECS - 0.2);
  expect(b.step(10.5, true, false).show).toBe(false);
  expect(b.step(10.9, false, false).show).toBe(false);
  expect(b.step(11.2, false, false)).toEqual({ show: true, wake: MENTION_HIDE_SECS });
  expect(b.step(14, false, true)).toEqual({ show: true, wake: MENTION_HIDE_SECS });
  expect(b.step(18.5, false, false).show).toBe(true);
  expect(b.step(19, false, false)).toEqual({ show: false, wake: null });
  expect(b.step(19.1, false, true).show).toBe(false);
});

test("a_chips_tooltip_says_who_the_text_the_note_then_what_a_click_does", () => {
  const msg = newMention({ from: "Claude", text: "Done.\n\nAll tests pass.", excerpt: true, note: " check it " });
  expect(tipParts(chipTip(msg, true))).toEqual({ rich: true, title: "Claude", sub: "Excerpt", body: "Done. All tests pass.", rows: [{ label: "Your note", value: "check it" }], hint: "" });
  expect(tipParts(chipTip(msg, false)).rows).toEqual([]);
  const chat = newMention({ kind: "chat", chat: "g1", title: "Fix the build", from: "harbor" });
  expect(tipParts(chipTip(chat, true))).toMatchObject({ title: "Fix the build", sub: "harbor", body: "", rows: [], hint: "" });
});
