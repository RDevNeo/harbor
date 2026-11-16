import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as osEnv } from "@harbor/os";
import { noderuntime } from "@harbor/agents";
import * as pwbrowser from "../src/pwbrowser.ts";
import { playwrightArgs } from "../src/mcp.ts";

let root: string;
const saved = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hpwb-"));
  process.env.HOME = root;
  process.env.XDG_DATA_HOME = join(root, "data");
  // An npx of its own on PATH: Harbor's Node isn't needed (and never downloaded under test).
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npx = osEnv.execSuffixes().includes(".cmd") ? "npx.cmd" : "npx";
  writeFileSync(join(bin, npx), npx === "npx.cmd" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(bin, osEnv.execSuffixes().includes(".cmd") ? "node.exe" : "node"), "", { mode: 0o755 });
  process.env.PATH = bin;
  noderuntime.resetForTests();
  pwbrowser.resetForTests();
});

afterEach(() => {
  process.env = { ...saved };
  pwbrowser.resetForTests();
  rmSync(root, { recursive: true, force: true });
});

test("Harbor's Playwright entry passes the browser unless it's Chrome", () => {
  expect(playwrightArgs("chrome")).toEqual(["-y", "@playwright/mcp@latest", "--headless"]);
  expect(playwrightArgs("msedge")).toEqual(["-y", "@playwright/mcp@latest", "--headless", "--browser", "msedge"]);
  expect(playwrightArgs("chromium")).toEqual(["-y", "@playwright/mcp@latest", "--headless", "--browser", "chromium"]);
});

test("nothing is installed when the entry doesn't use Playwright's Chromium", async () => {
  const runs: string[][] = [];
  expect(await pwbrowser.ensure({ needed: () => false, run: async (a) => (runs.push(a), { code: 0, out: "" }) })).toBe(true);
  expect(runs).toEqual([]);
  expect(pwbrowser.current().kind).toBe("idle");
});

test("Playwright's installer from the server's own package, then a start check", async () => {
  const runs: string[][] = [];
  const tips: (string | null)[] = [];
  const off = pwbrowser.onChange(() => tips.push(pwbrowser.tip()));
  const p = pwbrowser.ensure({ needed: () => true, installed: () => ["/cache/chromium-1/chrome-linux64/chrome"], run: async (a) => (runs.push(a), { code: 0, out: "" }) });
  expect(pwbrowser.pending()).toBe(p);
  expect(await p).toBe(true);
  off();
  expect(runs[0]?.slice(-6)).toEqual(["-y", "--package", "@playwright/mcp@latest", "playwright", "install", "chromium"]);
  expect(runs[0]?.some((a) => a.includes("--with-deps"))).toBe(false);
  expect(runs[1]).toEqual(["/cache/chromium-1/chrome-linux64/chrome", "--version"]);
  expect(tips).toEqual(["Installing a browser for it\u{2026}", null]);
  expect(pwbrowser.current().kind).toBe("ready");
  expect(pwbrowser.pending()).toBeNull();
});

test("a failed install says why in the tip; missing Linux libraries say which", async () => {
  expect(await pwbrowser.ensure({ needed: () => true, installed: () => [], run: async () => ({ code: 1, out: "a\nb\nError: getaddrinfo ENOTFOUND cdn.playwright.dev\n" }) })).toBe(false);
  expect(pwbrowser.tip()).toContain("Couldn't install its browser: playwright install chromium exited 1");
  expect(pwbrowser.tip()).toContain("ENOTFOUND");
  pwbrowser.resetForTests();
  const run: pwbrowser.Run = async (a) => (a[1] === "--version" ? { code: 127, out: "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file" } : { code: 0, out: "" });
  expect(await pwbrowser.ensure({ needed: () => true, installed: () => ["/c/chrome"], run })).toBe(false);
  expect(pwbrowser.current()).toEqual({ kind: "libs", missing: ["libnss3.so"] });
  expect(pwbrowser.tip()).toContain("missing system libraries (libnss3.so)");
});
