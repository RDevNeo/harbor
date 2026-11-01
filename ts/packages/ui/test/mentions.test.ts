import { expect, test } from "bun:test";
import { MAX_CHARS, type Mention, add, excerpt, folded, mentionFromJson, mentionToJson, newMention, prompt } from "../src/logic/mentions.ts";

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
