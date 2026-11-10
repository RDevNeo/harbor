import { describe, expect, test } from "bun:test";
import { initials, nameHash, popRows, popStart, popStep, tintIndex, TINTS } from "../src/logic/projectpop.ts";

const P = [
  { id: 1, name: "acme-web" },
  { id: 2, name: "field-notes" },
  { id: 3, name: "field-kit" },
  { id: 4, name: "asset-library" },
];

describe("project popover", () => {
  test("initials: two words, camel case, one word", () => {
    expect(initials("acme-web")).toBe("AW");
    expect(initials("asset_library")).toBe("AL");
    expect(initials("assetLibrary")).toBe("AL");
    expect(initials("harbor")).toBe("HA");
    expect(initials("x")).toBe("X");
    expect(initials("--")).toBe("?");
  });

  test("the tint follows Java's String.hashCode, as the phone's", () => {
    expect(nameHash("hello")).toBe(99162322);
    expect(nameHash("a long project name that overflows")).toBe(Number(BigInt.asIntN(32, [..."a long project name that overflows"].reduce((h, c) => h * 31n + BigInt(c.charCodeAt(0)), 0n))));
    for (const p of P) expect(tintIndex(p.name)).toBeGreaterThanOrEqual(0), expect(tintIndex(p.name)).toBeLessThan(TINTS.length);
  });

  test("rows: No project, the projects, Add project; a search keeps matches and Add project", () => {
    expect(popRows(P, "").map((r) => r.label)).toEqual(["No project", "acme-web", "field-notes", "field-kit", "asset-library", "Add project"]);
    expect(popRows(P, " FIELD ").map((r) => r.label)).toEqual(["field-notes", "field-kit", "Add project"]);
    expect(popRows(P, "zzz").map((r) => r.kind)).toEqual(["add"]);
    expect(popRows(P, "no p").map((r) => r.kind)).toEqual(["none", "add"]);
  });

  test("the highlight starts on the current project, or the first match", () => {
    const rows = popRows(P, "");
    expect(popStart(rows, null, "")).toBe(0);
    expect(popStart(rows, 3, "")).toBe(3);
    expect(popStart(popRows(P, "field"), 3, "field")).toBe(0);
    expect(popStep(0, 6, false)).toBe(5);
    expect(popStep(5, 6, true)).toBe(0);
    expect(popStep(0, 0, true)).toBe(0);
  });
});
