import { expect, test } from "bun:test";
import { richTip, tipParts } from "../src/logic/tips.ts";

test("a_rich_tip_reads_back", () => {
  const tip = richTip({ title: "ship", sub: "Opus 5.5", rows: [["Task", "Rebase, release and publish"], ["Working", "4m"]], hint: "Click to open the agent" });
  expect(tipParts(tip)).toEqual({
    rich: true,
    title: "ship",
    sub: "Opus 5.5",
    body: "",
    rows: [
      { label: "Task", value: "Rebase, release and publish" },
      { label: "Working", value: "4m" },
    ],
    hint: "Click to open the agent",
  });
});

test("a_plain_tip_stays_plain", () => {
  for (const tip of ["", "Settings", "clip.mp4\nPlay", "a\tb"]) expect(tipParts(tip).rich).toBe(false);
});

test("only_the_title_is_needed", () => {
  expect(tipParts(richTip({ title: "Fix the build" }))).toEqual({ rich: true, title: "Fix the build", sub: "", body: "", rows: [], hint: "" });
});

test("newlines_and_tabs_inside_a_part_become_spaces", () => {
  const p = tipParts(richTip({ title: "two\nlines", body: "First paragraph.\n\nSecond\tone.", rows: [["Your\tnote", "keep it\nshort"]], hint: " Click " }));
  expect(p.title).toBe("two lines");
  expect(p.body).toBe("First paragraph. Second one.");
  expect(p.rows).toEqual([{ label: "Your note", value: "keep it short" }]);
  expect(p.hint).toBe("Click");
});

test("rows_with_no_value_are_left_out", () => {
  expect(tipParts(richTip({ title: "t", rows: [["Plan", ""], ["Note", "  "], ["5h", "40% used"]] })).rows).toEqual([{ label: "5h", value: "40% used" }]);
});
