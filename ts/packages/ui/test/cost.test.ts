import { expect, test } from "bun:test";
import { dayLabel } from "../src/logic/cost.ts";

test("days", () => {
  expect(dayLabel(0)).toBe("Thu 1 Jan");
  // 2026-10-26 is a Monday.
  expect(dayLabel(20_752)).toBe("Mon 26 Oct");
});
