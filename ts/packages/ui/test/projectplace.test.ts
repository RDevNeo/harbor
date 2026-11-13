import { expect, test } from "bun:test";
import { clashingNames, draftPlaceLine, placeHint, placeLine } from "../src/logic/projectplace.ts";

const laptop = { pc: "pc:laptop", name: "Laptop", online: true };

test("a project whose folder is on another PC names that PC; two projects with one name are told apart", () => {
  const clash = clashingNames([{ name: "blox" }, { name: "blox" }, { name: "site" }]);
  expect([...clash]).toEqual(["blox"]);
  // The other PC's entry says which PC; this PC's own says its folder's parent.
  // No PC is named after a project: the folder's parent tells two of one name apart.
  expect(placeHint(laptop, "/home/other/Documents/blox", clash.has("blox"))).toBe("/home/other/Documents");
  expect(placeHint(null, "~/Documents/blox", clash.has("blox"))).toBe("~/Documents");
  // A name of its own: nothing to add.
  expect(placeHint(null, "~/site", clash.has("site"))).toBe("");
  // No PC known: still not this PC's.
  expect(placeHint({ pc: "", name: "", online: false }, "/x/blox", false)).toBe("");
  expect(placeLine(laptop, "/home/other/Documents/blox")).toBe("On Laptop: /home/other/Documents/blox");
  expect(placeLine({ pc: "", name: "", online: false }, "/x")).toBe("Not on this PC: /x");
  expect(placeLine(null, "~/site")).toBe("~/site");
});

test("a draft in a project on another PC says before the message where it starts", () => {
  expect(draftPlaceLine("blox", null, null)).toBeNull();
  // Its PC picked: the device chip already says where it starts.
  expect(draftPlaceLine("blox", laptop, "pc:laptop")).toBeNull();
  // This PC picked instead: where the folder is, and how to start there.
  expect(draftPlaceLine("blox", laptop, null)).toContain("blox's folder is on Laptop");
  expect(draftPlaceLine("blox", { ...laptop, online: false }, null)).toContain("which is off");
  expect(draftPlaceLine("blox", { pc: "", name: "", online: false }, null)).toContain("isn't on this PC");
  // Another device picked: nothing to say.
  expect(draftPlaceLine("blox", laptop, "ssh-box")).toBeNull();
});
