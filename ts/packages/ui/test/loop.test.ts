import { expect, test } from "bun:test";
import { PACED_IDLE_MAX_MS, PACED_IDLE_MS, pacedIdleMs } from "../src/loop.ts";

test("the paced loop's idle wait follows what an idle turn costs: cheap turns often, costly ones less", () => {
  // Cheap empty turns (Windows, a quick backend): the shortest wait, input feels instant.
  expect(pacedIdleMs(0.05)).toBe(PACED_IDLE_MS);
  // macOS: AppKit's loop makes an empty turn ~1.5 ms; at ~1 % of a core that's the longest wait.
  expect(pacedIdleMs(1.5)).toBe(PACED_IDLE_MAX_MS);
  expect(pacedIdleMs(0.5)).toBe(50);
  expect(pacedIdleMs(40)).toBe(PACED_IDLE_MAX_MS);
});
