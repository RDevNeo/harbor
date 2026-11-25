import { expect, test } from "bun:test";
import { join } from "node:path";
import { browsers } from "../src/index.ts";

const win = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" };
const has =
  (...files: string[]) =>
  (p: string): boolean =>
    files.includes(p);

test("Chrome where Playwright finds it is kept (its default channel)", () => {
  expect(browsers.playwrightBrowser("win32", win, has(join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")))).toBe("chrome");
  expect(browsers.playwrightBrowser("win32", win, has(join(win.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")))).toBe("chrome");
  expect(browsers.playwrightBrowser("darwin", {}, has("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))).toBe("chrome");
  expect(browsers.playwrightBrowser("linux", {}, has("/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge"))).toBe("chrome");
});

test("without Chrome: Edge, else none (Hub downloads no browser)", () => {
  expect(browsers.playwrightBrowser("win32", win, has(join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")))).toBe("msedge");
  expect(browsers.playwrightBrowser("darwin", {}, has("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))).toBe("msedge");
  expect(browsers.playwrightBrowser("linux", {}, has("/opt/microsoft/msedge/msedge"))).toBe("msedge");
  expect(browsers.playwrightBrowser("linux", {}, has())).toBeNull();
  expect(browsers.playwrightBrowser("darwin", {}, has())).toBeNull();
  expect(browsers.playwrightBrowser("win32", win, has())).toBeNull();
  // An unset folder variable isn't looked in (no "Google/Chrome/…" relative to the current folder).
  expect(browsers.chromePaths("win32", { LOCALAPPDATA: "" })).toEqual([]);
  expect(browsers.edgePaths("other", {})).toEqual([]);
});
