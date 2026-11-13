// Computer use's system side: which backend this desktop gets (Windows, macOS, a Linux compositor or X11), what
// it lacks, and the backend itself. Features above call `probe()` to say what works and `backend()` to act.
import { platform } from "../platform.ts";
import type { Backend, Probe } from "./backend.ts";

export type { Backend, Button, Direction, Probe } from "./backend.ts";
export { type Combo, parseCombo, parseKeys } from "./keys.ts";
export { crop, decode, type Image, png, type Rect, resize } from "./image.ts";

type Env = Record<string, string | undefined>;

const WINDOWS: Probe = { ok: true, kind: "windows", name: "Windows (GDI screenshots, SendInput)", missing: [], limits: ["windows of programs running as administrator take no input from Harbor (unless Harbor runs as administrator too)"] };

/** What this desktop can do, and what's missing (a program to install, a permission to give). `ask`: macOS may show
 *  its permission prompt (when an agent wants the screen, not when Settings looks). */
export function probe(env: Env = process.env, ask = false): Probe {
  switch (platform(env)) {
    case "win32":
      return WINDOWS;
    case "darwin":
      return (require("../darwin-screen.ts") as typeof import("../darwin-screen.ts")).probe(ask);
    case "linux":
      return (require("./linux.ts") as typeof import("./linux.ts")).probe(env);
    default:
      return { ok: false, kind: "none", name: "none", missing: ["a supported system (Windows, macOS or Linux)"], limits: [] };
  }
}

let made: { key: string; b: Backend } | undefined;

/** The backend for this desktop, made once per environment; throws saying what's missing when there's none. */
export function backend(env: Env = process.env): Backend {
  const p = platform(env);
  // A Linux session's compositor can change under a long-running Harbor (a re-login): the key follows it.
  const key = `${p}:${env.WAYLAND_DISPLAY ?? ""}:${env.HYPRLAND_INSTANCE_SIGNATURE ?? ""}:${env.SWAYSOCK ?? ""}:${env.DISPLAY ?? ""}`;
  if (made?.key === key) return made.b;
  let b: Backend;
  if (p === "win32") b = (require("../win32/screen.ts") as typeof import("../win32/screen.ts")).backend();
  else if (p === "darwin") {
    const mac = require("../darwin-screen.ts") as typeof import("../darwin-screen.ts");
    const pr = mac.probe(true);
    if (!pr.ok) throw new Error(`computer use needs ${pr.missing.join("; ")}`);
    b = mac.backend();
  } else if (p === "linux") b = (require("./linux.ts") as typeof import("./linux.ts")).backend(env);
  else throw new Error("computer use isn't available on this system");
  made = { key, b };
  return b;
}

export { authApp, focusedClass, linuxFocus, macFocus, parseWinFocus, type SecureFocus } from "./secure.ts";
