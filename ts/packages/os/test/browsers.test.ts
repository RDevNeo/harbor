import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("without Chrome: Edge, else Playwright's Chromium", () => {
  expect(browsers.playwrightBrowser("win32", win, has(join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")))).toBe("msedge");
  expect(browsers.playwrightBrowser("darwin", {}, has("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))).toBe("msedge");
  expect(browsers.playwrightBrowser("linux", {}, has("/opt/microsoft/msedge/msedge"))).toBe("msedge");
  expect(browsers.playwrightBrowser("linux", {}, has())).toBe("chromium");
  expect(browsers.playwrightBrowser("darwin", {}, has())).toBe("chromium");
  expect(browsers.playwrightBrowser("win32", win, has())).toBe("chromium");
  // An unset folder variable isn't looked in (no "Google/Chrome/…" relative to the current folder).
  expect(browsers.chromePaths("win32", { LOCALAPPDATA: "" })).toEqual([]);
  expect(browsers.edgePaths("other", {})).toEqual([]);
});

test("Playwright's cache folder per OS", () => {
  expect(browsers.playwrightCache("linux", {}, "/home/u")).toBe(join("/home/u", ".cache", "ms-playwright"));
  expect(browsers.playwrightCache("linux", { XDG_CACHE_HOME: "/c" }, "/home/u")).toBe(join("/c", "ms-playwright"));
  expect(browsers.playwrightCache("darwin", {}, "/Users/u")).toBe(join("/Users/u", "Library", "Caches", "ms-playwright"));
  expect(browsers.playwrightCache("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\Users\\u")).toBe(join("C:\\L", "ms-playwright"));
  expect(browsers.playwrightCache("linux", { PLAYWRIGHT_BROWSERS_PATH: "/pw" }, "/home/u")).toBe("/pw");
});

test("the installed Chromiums to check are Linux's only", () => {
  const cache = mkdtempSync(join(tmpdir(), "hpw-"));
  try {
    const full = join(cache, "chromium-1200", "chrome-linux64", "chrome");
    const shell = join(cache, "chromium_headless_shell-1200", "chrome-headless-shell-linux64", "chrome-headless-shell");
    for (const f of [full, shell]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "");
    }
    mkdirSync(join(cache, "firefox-1500"));
    expect(browsers.playwrightChromiums(cache, "linux", "x64").sort()).toEqual([full, shell].sort());
    expect(browsers.playwrightChromiums(cache, "linux", "arm64")).toEqual([]);
    expect(browsers.playwrightChromiums(cache, "win32", "x64")).toEqual([]);
    expect(browsers.playwrightChromiums(join(cache, "none"), "linux", "x64")).toEqual([]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
