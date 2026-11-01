import "./sandbox.ts";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { shQuote } from "@harbor/net";
import { OUTPUT_MAX, Tail, shell } from "../src/shell.ts";

test("shell_keeps_the_end_and_returns_despite_background_children: shell keeps the end and returns despite background children", async () => {
  const dir = tmpdir();
  const big = await shell("head -c 3000000 /dev/zero | tr '\\0' a; echo; echo last", dir, 20_000);
  expect(big.kind).toBe("exit");
  expect(big.kind === "exit" && big.code).toBe(0);
  expect(big.text.startsWith("[… ")).toBe(true);
  expect(big.text.endsWith("\nlast\n")).toBe(true);
  expect(big.text.length).toBeLessThan(OUTPUT_MAX + 100);
  const t = Date.now();
  const bg = await shell("sleep 300 & echo started", dir, 20_000);
  expect(bg.kind === "exit" && bg.code).toBe(0);
  expect(bg.text.startsWith("started\n")).toBe(true);
  expect(bg.text).toContain("stopped the background processes");
  expect(Date.now() - t).toBeLessThan(5000);
  const slow = await shell("sleep 300", dir, 1000);
  expect(slow.kind).toBe("stopped");
  expect(Date.now() - t).toBeLessThan(9000);
}, 30_000);

test("shell says why it could not start", async () => {
  const r = await shell("true", "/nonexistent-dir-for-harbor-tests", 5000);
  expect(r).toEqual({ kind: "failed", why: "cannot run it in /nonexistent-dir-for-harbor-tests: No such file or directory (os error 2)", text: "" });
});

test("the tail never starts inside a character", () => {
  const t = new Tail();
  t.push(Buffer.from("é".repeat(30_000)));
  const text = t.text(OUTPUT_MAX - 1);
  expect(text).not.toContain("�");
  expect(text.startsWith("[… ")).toBe(true);
});

test("shQuote wraps in single quotes", () => {
  expect(shQuote("it's")).toBe("'it'\\''s'");
});
