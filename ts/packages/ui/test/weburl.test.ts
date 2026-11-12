import { expect, test } from "bun:test";
import { web } from "../src/logic/weburl.ts";

test("only_web_pages_open_outside", () => {
  expect(web("https://example.com/a") && web("HTTP://localhost:3000")).toBe(true);
  for (const u of ["file:///etc/passwd", "x-test:hello", "javascript:alert(1)", "about:blank", ""]) expect(web(u)).toBe(false);
});
