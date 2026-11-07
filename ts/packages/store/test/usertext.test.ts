import { expect, test } from "bun:test";
import type { Mention } from "../src/index.ts";
import { tokens } from "../src/tagsyntax.ts";
import {
  commands,
  defuse,
  dropFile,
  imagesFollow,
  display,
  erase,
  eraseSpans,
  forgetImage,
  imageCount,
  imageNumbers,
  images,
  imagesPrompt,
  insertImage,
  kept,
  label,
  LABEL_CHARS,
  mapImages,
  namedImages,
  type Part,
  parts,
  pasted,
  pastedCopy,
  plain,
  shiftImages,
  whole,
  wire,
  withoutImages,
} from "../src/usertext.ts";

function chat(title: string, gid: string): Mention {
  return { item: 0, from: "", at: 0, text: "", len: 0, excerpt: false, note: "", kind: "chat", chat: gid, title };
}

function kinds(ps: Part[]): [string, string][] {
  return ps.map((p) => {
    const k = p.kind === "chat" ? `chat:${p.chat}` : p.kind === "image" ? `image:${p.image}` : p.kind;
    return [k, p.text];
  });
}

test("a_copied_token_brings_its_image_and_any_other_token_names_nothing", () => {
  const [a, b, c] = ["/up/a.png", "/up/b.png", "/up/c.png"];
  const doc = "/up/d.pdf";
  const files = [a, doc, b];
  // Numbers count images, so the PDF is no number; a token past the images names nothing.
  expect(namedImages("[Image #2] [Image #1] [Image #2] [Image #3]", files)).toEqual([
    [1, a],
    [2, b],
  ]);
  // Cut #1 and #2: the composer went on with c as #1, and they come back after it.
  const named: [number, string][] = [
    [1, a],
    [2, b],
  ];
  const left = [c];
  expect(pasted("[Image #2] and [Image #1]", named, left)).toBe("[Image #2] and [Image #3]");
  expect(left).toEqual([c, b, a]);
  // Still here (a copy, not a cut): the same images, at their numbers here, and no twice.
  files.shift();
  files.push(a);
  expect(pasted("[Image #2] [Image #1]", named, files)).toBe("[Image #1] [Image #2]");
  expect(files.length).toBe(3);
  // Text from elsewhere names none of them.
  const none = [a];
  expect(pasted("old [Image #1]", [], none)).toBe("old [Image 1]");
  expect(none).toEqual([a]);
  // One the copy didn't name, either.
  expect(pasted("[Image #1] [Image #7]", named, none)).toBe("[Image #1] [Image 7]");
});

test("finds_commands", () => {
  const cmds = (s: string) => commands(s).map(([i, n]) => s.slice(i, i + n));
  expect(cmds("/review this, then /plugin:skill.")).toEqual(["/review", "/plugin:skill"]);
  expect(cmds("see /tmp/x and a/b and //x and /5 and (/compact)")).toEqual(["/compact"]);
  expect(cmds("é /ñ /ok")).toEqual(["/ok"]);
});

test("a_written_chat_title_is_a_link", () => {
  const ms = [chat("Fix login", "g1")];
  const p = parts("look at Fix login, then /review @src/a.rs #12", ms);
  expect(kinds(p)).toEqual([
    ["plain", "look at "],
    ["chat:g1", "Fix login"],
    ["plain", ", then "],
    ["command", "/review"],
    ["plain", " "],
    ["tag", "@src/a.rs"],
    ["plain", " "],
    ["tag", "#12"],
  ]);
  expect(display(p)).toBe("look at Fix login, then /review @src/a.rs #12");
  expect(plain(parts("just words", []))).toBe(true);
});

test("longer_titles_win_and_tags_inside_titles_stay_the_title", () => {
  const ms = [chat("Fix", "g1"), chat("Fix @login page", "g2")];
  const p = parts("Fix @login page and Fix", ms);
  expect(kinds(p)).toEqual([
    ["chat:g2", "Fix @login page"],
    ["plain", " and "],
    ["chat:g1", "Fix"],
  ]);
});

test("older_messages_show_the_chat_before_the_text", () => {
  const m = chat("Website host", "g1");
  const p = parts("what's its status?", [m]);
  expect(kinds(p)).toEqual([
    ["chat:g1", "Website host"],
    ["plain", "\nwhat's its status?"],
  ]);
  m.note = "same bug?";
  expect(display(parts("", [m]))).toBe("Website host — same bug?");
  expect(display(parts("", [chat("Only", "g2")]))).toBe("Only");
});

test("a_title_taken_out_drops_its_mention", () => {
  const ms = [chat("Fix login", "g1"), chat("Other", "g2"), { ...chat("", ""), kind: "" }];
  const left = kept("see Fix login", ms);
  expect(left.map((m) => m.chat)).toEqual(["g1", ""]);
});

test("long_titles_are_cut_for_the_composer", () => {
  expect(label("  Short  ")).toBe("Short");
  const l = label("word ".repeat(30));
  expect(l.endsWith("…") && [...l].length <= LABEL_CHARS).toBe(true);
});

test("the_wire_has_kinds_and_chats", () => {
  const v = wire(parts("Fix login /go", [chat("Fix login", "g1")]));
  expect(v).toEqual([{ text: "Fix login", kind: "chat", chat: "g1" }, { text: " " }, { text: "/go", kind: "command" }]);
});

test("images_stay_in_the_text_with_their_numbers", () => {
  const text = "Hey Claude, take a look on this [Image #1] I want to remove that thing I draw over! Image #2 [Image #x] [Image #0]";
  expect(images(text).length).toBe(1);
  const p = parts(text, []);
  expect(kinds(p)[1]).toEqual(["image:1", "[Image #1]"]);
  // The text stays the user's own.
  expect(display(p)).toBe(text);
  expect(wire(parts("[Image #2]", []))).toEqual([{ text: "[Image #2]", kind: "image", image: 2 }]);
  expect(imageNumbers("[Image #3] [Image #1] [Image #3]")).toEqual([1, 3]);
});

test("the_agent_is_told_which_image_each_number_is", () => {
  const files = ["/up/a.png", "/up/notes.txt", "/up/b.JPG"];
  expect(imageCount(files)).toBe(2);
  expect(imagesPrompt("see [Image #2] and [Image #1]", files)).toBe("\n\n[Images in this message, in the order attached:\n- Image #1: /up/a.png\n- Image #2: /up/b.JPG]");
  // No token, or nothing to name: nothing to say.
  expect(imagesPrompt("see these", files)).toBe("");
  expect(imagesPrompt("see [Image #1]", files.slice(1, 2))).toBe("");
});

test("an_image_goes_in_at_the_cursor", () => {
  expect(insertImage("", 0, 1)).toEqual(["[Image #1] ", 11]);
  // After a word and before one: spaces where it touches them, none doubled.
  expect(insertImage("look at", 7, 1)).toEqual(["look at [Image #1] ", 19]);
  expect(insertImage("look  there", 5, 2)).toEqual(["look [Image #2] there", 15]);
  expect(insertImage("ab", 1, 1)).toEqual(["a [Image #1] b", 13]);
  expect(insertImage("é", 1, 1)[0]).toBe("é [Image #1] ");
  // Past the end (a draft that changed under the cursor): at the end.
  expect(insertImage("a", 9, 1)[0]).toBe("a [Image #1] ");
});

test("an_image_that_leaves_moves_the_later_ones_down", () => {
  const text = "a [Image #1] b [Image #2] c [Image #3] d";
  const [t, at] = forgetImage(text, 2, text.length);
  expect(t).toBe("a [Image #1] b c [Image #2] d");
  expect(at).toBe(t.length);
  // The cursor keeps its place in the words.
  expect(forgetImage(text, 1, 2)[1]).toBe(2);
  expect(forgetImage(text, 3, 0)[0]).toBe("a [Image #1] b [Image #2] c d");
  // Inside the token: where it was.
  expect(forgetImage(text, 2, 18)[1]).toBe(15);
  // Numbers of two digits grow shorter: the cursor follows.
  expect(forgetImage("[Image #1] [Image #10] x", 1, 24)).toEqual(["[Image #9] x", 12]);
  // Its token already gone (erased in the text): only the numbers change.
  expect(forgetImage("[Image #2] x", 1, 0)[0]).toBe("[Image #1] x");
  expect(forgetImage("[Image #1] ", 1, 11)).toEqual(["", 0]);
});

test("merged_drafts_keep_their_images_apart", () => {
  expect(shiftImages("a [Image #1] b [Image #2]", 3)).toBe("a [Image #4] b [Image #5]");
  expect(withoutImages("[Image #1] look at [Image #2] this")).toBe("look at this");
  expect(defuse("see [Image #1], [Image #2] and Image #3")).toBe("see [Image 1], [Image 2] and Image #3");
  expect(images(defuse("[Image #12]"))).toEqual([]);
  expect(tokens(defuse("[Image #4]"))).toEqual([]);
  expect(mapImages("[Image #3] [Image #1]", (n) => (n > 1 ? n - 1 : null))).toBe("[Image #2] [Image 1]");
});

test("picked_tokens_go_in_one_erase", () => {
  const toks = ["@src/a.rs", "#12", "/review", "Fix login"];
  const text = "see Fix login and @src/a.rs, #12 /review";
  const sp = whole(text, toks);
  expect(sp.map(([a, z]) => text.slice(a, z))).toEqual(["Fix login", "@src/a.rs", "#12", "/review"]);
  const at = (s: string) => text.indexOf(s);
  // Backspace at its end, inside it, or after the space that follows it.
  expect(erase(text, at(" and"), true, sp)).toEqual(["see and @src/a.rs, #12 /review", 4]);
  expect(erase(text, at("login") + 2, true, sp)?.[0]).toBe("see and @src/a.rs, #12 /review");
  expect(erase(text, at(" and") + 1, true, sp)?.[0]).toBe("see and @src/a.rs, #12 /review");
  expect(erase(text, text.length, true, sp)).toEqual(["see Fix login and @src/a.rs, #12 ", 33]);
  // Delete at its start.
  expect(erase(text, at("#12"), false, sp)?.[0]).toBe("see Fix login and @src/a.rs, /review");
  // Elsewhere: an ordinary key; at its start Backspace isn't in it.
  expect(erase(text, 2, true, sp)).toBeNull();
  expect(erase(text, at("Fix"), true, sp)).toBeNull();
  expect(erase(text, at(" and"), false, sp)).toBeNull();
});

test("whole_tokens_stand_apart", () => {
  const toks = ["/review", "@a"];
  expect(whole("/reviewer and x@a and @ab", toks)).toEqual([]);
  expect(whole("(/review) @a.", toks)).toEqual([
    [1, 8],
    [10, 12],
  ]);
  // After the pick: "token " with the cursor after the space, the text ending there.
  expect(erase("hi @a ", 6, true, whole("hi @a ", toks))).toEqual(["hi ", 3]);
  expect(erase("é @a", 4, true, whole("é @a", toks))).toEqual(["é ", 2]);
});

test("removing_an_attached_image_takes_its_token_and_renumbers", () => {
  const files = ["/up/a.png", "/up/notes.txt", "/up/b.jpg", "/up/c.png"];
  const text = "see [Image #1] then [Image #2] and [Image #3]";
  // The second image is file 2 (a text file sits between): its token goes, #3 becomes #2.
  const r = dropFile(text, files, 2, text.length);
  expect(r.files).toEqual(["/up/a.png", "/up/notes.txt", "/up/c.png"]);
  expect(r.text).toBe("see [Image #1] then and [Image #2]");
  expect(r.cursor).toBe(r.text.length);
  expect(imagesPrompt(r.text, r.files)).toBe("\n\n[Images in this message, in the order attached:\n- Image #1: /up/a.png\n- Image #2: /up/c.png]");
  // At the start: no space left in front.
  expect(dropFile("[Image #1] look", ["/a.png"], 0, 0)).toEqual({ text: "look", files: [], cursor: 0 });
  // A file that isn't an image leaves the text alone.
  expect(dropFile(text, files, 1, 3)).toEqual({ text, files: ["/up/a.png", "/up/b.jpg", "/up/c.png"], cursor: 3 });
});

test("erasing_an_image_token_takes_its_image", () => {
  const files = ["/a.png", "/b.png", "/c.png"];
  const before = "x [Image #1] y [Image #2] z [Image #3]";
  const after = "x [Image #1] y z [Image #3]";
  const r = imagesFollow(before, after, files, 4);
  expect(r).toEqual({ text: "x [Image #1] y z [Image #2]", files: ["/a.png", "/c.png"], cursor: 4 });
  // Everything erased: every named image goes.
  expect(imagesFollow(before, "", files, 0)).toEqual({ text: "", files: [], cursor: 0 });
  // A token half erased by hand no longer names its image.
  expect(imagesFollow("[Image #1] hi", "[Image #1 hi", ["/a.png"], 9)?.files).toEqual([]);
  // Still written elsewhere, typing around tokens, or a number no file has: nothing changes.
  expect(imagesFollow("[Image #1] [Image #1]", "[Image #1]", files, 0)).toBeNull();
  expect(imagesFollow("[Image #1]", "[Image #1] ok", files, 0)).toBeNull();
  expect(imagesFollow("[Image #7]", "", files, 0)).toBeNull();
  // Images attached without a token stay; the numbers after the one that went move down.
  expect(imagesFollow("[Image #2] [Image #3]", "[Image #3]", files, 0)).toEqual({ text: "[Image #2]", files: ["/a.png", "/c.png"], cursor: 0 });
});

test("the_composer_erases_picked_tokens_chat_titles_and_images_whole", () => {
  const text = "ask @src/a.rs about Fix login [Image #1] /review then @src/a.rsx";
  const sp = eraseSpans(text, ["@src/a.rs", "/review"], [["Fix login", "7"]]);
  expect(sp.map(([a, z]) => text.slice(a, z))).toEqual(["@src/a.rs", "Fix login", "[Image #1]", "/review"]);
  const back = (word: string) => erase(text, text.indexOf(word) + word.length, true, sp)?.[0];
  expect(back("@src/a.rs ")).toBe("ask about Fix login [Image #1] /review then @src/a.rsx");
  expect(back("Fix login")).toBe("ask @src/a.rs about [Image #1] /review then @src/a.rsx");
  expect(back("/review")).toBe("ask @src/a.rs about Fix login [Image #1] then @src/a.rsx");
  // Typed by hand, not picked: one character at a time.
  expect(erase(text, text.length, true, sp)).toBeNull();
});

test("a message copied with its images pastes them back: its tokens name them, the rest come after", () => {
  const files = ["/d/old.png"];
  const text = pastedCopy("see [Image #2] then [Image #1]", [[1, "/m/a.png"], [2, "/m/b.png"]], ["/m/a.png", "/m/b.png", "/m/c.jpg"], files);
  expect(text).toBe("see [Image #2] then [Image #3] [Image #4] ");
  expect(files).toEqual(["/d/old.png", "/m/b.png", "/m/a.png", "/m/c.jpg"]);
  // A reply's images: no tokens of its own, a token each after its text; a stray token stops being one.
  const none: string[] = [];
  expect(pastedCopy("look [Image #1]", [], ["/r/x.png"], none)).toBe("look [Image 1] [Image #1] ");
  expect(none).toEqual(["/r/x.png"]);
});
