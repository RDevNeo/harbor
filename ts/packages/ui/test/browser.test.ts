import { expect, test } from "bun:test";
import { crashing, helperPath, hostOf, keyMessages } from "../src/browser.ts";
import { web } from "../src/logic/browser.ts";

test("only_web_pages_open_outside", () => {
  expect(web("https://example.com/a") && web("HTTP://localhost:3000")).toBe(true);
  for (const u of ["file:///etc/passwd", "x-test:hello", "javascript:alert(1)", "about:blank", ""]) expect(web(u)).toBe(false);
});

test("keys reach the page as browser.rs forwards them", () => {
  const none = { ctrl: false, shift: false, alt: false, meta: false };
  expect(keyMessages("a", true, none)).toEqual([
    { t: "key", key: "a", code: "", down: true },
    { t: "key", key: "a", code: "", down: false },
  ]);
  expect(keyMessages("a", false, none)).toEqual([]);
  expect(keyMessages("\n", false, none)).toEqual([{ t: "key", key: "Enter", code: "", down: false, ...none }]);
  expect(keyMessages("A", true, { ...none, ctrl: true })).toEqual([{ t: "key", key: "a", code: "", down: true, ...none, ctrl: true }]);
  expect(keyMessages("\u{f704}", true, none)).toEqual([]);
});

test("the error page names the host; a missing HARBOR_BROWSER finds no engine", () => {
  expect(hostOf("http://localhost:3999/")).toBe("localhost:3999");
  expect(crashing()).toBeNull();
  expect(helperPath({ HARBOR_BROWSER: "/nonexistent/harbor-browser" })).toBeNull();
});
