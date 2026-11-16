// Which browser Harbor's built-in Playwright MCP server (`npx @playwright/mcp`) drives. @playwright/mcp defaults to
// the Google Chrome channel and fails when Chrome isn't installed, so Harbor's own entry picks: Chrome where it
// is, else Microsoft Edge (always there on Windows), else Playwright's own Chromium (Chrome for Testing), which
// Harbor downloads into Playwright's cache (agents' pwbrowser.ts). The places looked at are Playwright's own
// (playwright-core's registry), so "found" here means Playwright finds it too.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Platform, platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** `--browser` for @playwright/mcp: Chrome's channel (its default), Edge's, or Playwright's own Chromium. */
export type PlaywrightBrowser = "chrome" | "msedge" | "chromium";

/** Windows' folders an installed browser can be in (per user first), as Playwright looks. */
function winRoots(env: Env): string[] {
  return [env.LOCALAPPDATA, env.PROGRAMFILES ?? env.ProgramFiles, env["PROGRAMFILES(X86)"] ?? env["ProgramFiles(x86)"]].filter((d): d is string => d !== undefined && d !== "");
}

/** Where Google Chrome (stable) is on `p`. */
export function chromePaths(p: Platform = platform(), env: Env = process.env): string[] {
  if (p === "win32") return winRoots(env).map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe"));
  if (p === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (p === "linux") return ["/opt/google/chrome/chrome"];
  return [];
}

/** Where Microsoft Edge (stable) is on `p`. */
export function edgePaths(p: Platform = platform(), env: Env = process.env): string[] {
  if (p === "win32") return winRoots(env).map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
  if (p === "darwin") return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  if (p === "linux") return ["/opt/microsoft/msedge/msedge"];
  return [];
}

/**
 * The browser for Harbor's default Playwright entry: Chrome when it's installed (Playwright's default, nothing to
 * pass), else Edge, else Playwright's Chromium (which then has to be downloaded). `exists` is the file check
 * (tests hand in their own).
 */
export function playwrightBrowser(p: Platform = platform(), env: Env = process.env, exists: (path: string) => boolean = existsSync): PlaywrightBrowser {
  if (chromePaths(p, env).some(exists)) return "chrome";
  if (edgePaths(p, env).some(exists)) return "msedge";
  return "chromium";
}

/** Playwright's browser cache (`ms-playwright` in the OS's cache folder; PLAYWRIGHT_BROWSERS_PATH overrides it). */
export function playwrightCache(p: Platform = platform(), env: Env = process.env, home: string = env.HOME || env.USERPROFILE || homedir()): string {
  const set = env.PLAYWRIGHT_BROWSERS_PATH;
  if (set !== undefined && set !== "" && set !== "0") return set;
  if (p === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright");
  if (p === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "ms-playwright");
}

/**
 * The Chromium programs Playwright installed in `cache` (full and headless shell), for a start check: Linux only,
 * where they need system libraries Harbor can't install without root (macOS and Windows builds carry theirs).
 */
export function playwrightChromiums(cache: string, p: Platform = platform(), arch: string = process.arch): string[] {
  if (p !== "linux") return [];
  const a = arch === "arm64" ? "linux-arm64" : "linux64";
  let names: string[];
  try {
    names = readdirSync(cache);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort().reverse()) {
    if (/^chromium-\d+$/.test(n)) out.push(join(cache, n, `chrome-${a}`, "chrome"));
    else if (/^chromium_headless_shell-\d+$/.test(n)) out.push(join(cache, n, `chrome-headless-shell-${a}`, "chrome-headless-shell"));
  }
  return out.filter((f) => existsSync(f));
}
