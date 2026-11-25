// Which browser Harbor's built-in Playwright MCP server (`npx @playwright/mcp`) drives. @playwright/mcp defaults to
// the Google Chrome channel and fails when Chrome isn't installed, so Hub's own entry picks: the user's Chrome
// where it is, else their Microsoft Edge (always there on Windows), else another Chromium build they have installed
// (Helium, Chromium, Brave: passed by its path, `--executable-path`), else none (Hub never downloads a browser: the
// entry isn't set up and says why). Chrome's and Edge's places are Playwright's own (playwright-core's registry).
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type Platform, platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** `--browser` for @playwright/mcp (Chrome's channel, its default, or Edge's), or another Chromium build by its path. */
export type PlaywrightBrowser = "chrome" | "msedge" | { name: string; executable: string };

/** Chromium builds Playwright can drive by path: their commands on PATH and where their packages put the binary. */
const CHROMIUM_BUILDS: { name: string; commands: string[]; binary: string; places: (home: string) => string[] }[] = [
  {
    name: "Helium",
    commands: ["helium-browser", "helium"],
    binary: "helium",
    places: (h) => ["/opt/helium-browser-bin/helium", "/opt/helium/helium", join(h, ".local/opt/helium/helium"), join(h, ".local/share/helium/helium"), join(h, ".local/bin/helium"), "/Applications/Helium.app/Contents/MacOS/Helium"],
  },
  { name: "Chromium", commands: ["chromium", "chromium-browser"], binary: "chromium", places: () => ["/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser", "/Applications/Chromium.app/Contents/MacOS/Chromium"] },
  { name: "Brave", commands: ["brave", "brave-browser"], binary: "brave", places: () => ["/opt/brave.com/brave/brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] },
];

export interface FindDeps {
  exists: (path: string) => boolean;
  /** A file's real path (links followed), or null. */
  real: (path: string) => string | null;
}

const realOf = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * An installed Chromium build (Helium first) on Linux or macOS: a command on PATH, its link followed to the package's
 * folder and its real binary there (Helium's `helium-browser` is a wrapper script beside `helium`), else the
 * packages' usual places. Null: none.
 */
export function chromiumBuild(p: Platform = platform(), env: Env = process.env, deps: FindDeps = { exists: existsSync, real: realOf }): { name: string; executable: string } | null {
  if (p !== "linux" && p !== "darwin") return null;
  const home = env.HOME ?? "";
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  for (const b of CHROMIUM_BUILDS) {
    for (const cmd of b.commands) {
      for (const d of dirs) {
        const at = join(d, cmd);
        if (!deps.exists(at)) continue;
        const real = deps.real(at) ?? at;
        const beside = join(dirname(real), b.binary);
        return { name: b.name, executable: deps.exists(beside) ? beside : real };
      }
    }
    const found = b.places(home).find((x) => deps.exists(x));
    if (found) return { name: b.name, executable: found };
  }
  return null;
}

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
 * Edge, else another Chromium build (Helium…) by its path, else null (none installed: Hub downloads none). `exists`
 * and `real` are the file checks (tests hand in their own).
 */
export function playwrightBrowser(p: Platform = platform(), env: Env = process.env, exists: (path: string) => boolean = existsSync, real: (path: string) => string | null = realOf): PlaywrightBrowser | null {
  if (chromePaths(p, env).some(exists)) return "chrome";
  if (edgePaths(p, env).some(exists)) return "msedge";
  return chromiumBuild(p, env, { exists, real });
}
