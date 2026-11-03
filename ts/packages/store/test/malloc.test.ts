import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { capArenas, trim, trimEvery } from "../src/malloc.ts";

const glibc = process.platform === "linux" && !existsSync("/lib/ld-musl-x86_64.so.1") && !existsSync("/lib/ld-musl-aarch64.so.1");

test("a MALLOC_ARENA_MAX of the person's own wins", () => {
  expect(capArenas(2, { MALLOC_ARENA_MAX: "4" })).toBe(false);
});

test.skipIf(!glibc)("on glibc the arenas are capped and trims run", () => {
  expect(capArenas(2, {})).toBe(true);
  expect(typeof trim()).toBe("boolean");
  const stop = trimEvery(60_000);
  stop();
});

test.skipIf(process.platform === "linux")("elsewhere both are nothing", () => {
  expect(capArenas(2, {})).toBe(false);
  expect(trim()).toBe(false);
});
