// Which browser Harbor's built-in Playwright MCP server (`npx @playwright/mcp`) drives. @playwright/mcp defaults to
// the Google Chrome channel and fails when Chrome isn't installed, so Hub's own entry picks: the user's Chrome
// where it is, else their Microsoft Edge (always there on Windows), else none (Hub never downloads a browser: the
// entry isn't set up and says why). The places looked at are Playwright's own (playwright-core's registry), so
// "found" here means Playwright finds it too.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Platform, platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** `--browser` for @playwright/mcp: Chrome's channel (its default) or Edge's. */
export type PlaywrightBrowser = "chrome" | "msedge";

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
 * The installed browser for Hub's default Playwright entry: Chrome (Playwright's default, nothing to pass), else
 * Edge, else null (none installed: Hub downloads none). `exists` is the file check (tests hand in their own).
 */
export function playwrightBrowser(p: Platform = platform(), env: Env = process.env, exists: (path: string) => boolean = existsSync): PlaywrightBrowser | null {
  if (chromePaths(p, env).some(exists)) return "chrome";
  if (edgePaths(p, env).some(exists)) return "msedge";
  return null;
}
