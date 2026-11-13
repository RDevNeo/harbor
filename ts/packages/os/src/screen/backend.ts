// What a system's screen backend does, and which one this desktop gets. Coordinates are the screen's own pixels
// (`size()`), the space screenshots come in: each backend maps them to what its input calls take.
import type { Combo } from "./keys.ts";
import type { Image, Rect } from "./image.ts";

export type Button = "left" | "right" | "middle";
export type Direction = "up" | "down" | "left" | "right";

export interface Backend {
  /** Short, for the agent and Settings: "Windows (GDI, SendInput)", "Hyprland (grim, hyprctl, wtype, ydotool)". */
  name: string;
  /** The screen in pixels (all monitors on Linux' compositors, the primary one elsewhere). */
  size(): Promise<{ w: number; h: number }>;
  /** The screen, or `region` of it, as pixels; `out` asks for that size (a backend may scale natively, else the caller does). */
  capture(region?: Rect, out?: { w: number; h: number }): Promise<Image>;
  move(x: number, y: number): Promise<void>;
  /** Presses (down), releases (up) or clicks `count` times. */
  button(b: Button, how: "down" | "up" | "click", count?: number): Promise<void>;
  /** `amount` notches of the wheel. */
  scroll(dir: Direction, amount: number): Promise<void>;
  /** A chord: modifiers down, key down/up, modifiers up; `how` down or up holds or lets go of all of it. */
  key(c: Combo, how?: "press" | "down" | "up"): Promise<void>;
  /** Holds a chord for `ms` (where a held key must stay in one call of the tool); else key down, wait, key up. */
  hold?(c: Combo, ms: number): Promise<void>;
  type(text: string): Promise<void>;
  /** Where the pointer is, or null when this system won't say. */
  cursor(): Promise<{ x: number; y: number } | null>;
}

/** What `probe` found: the backend that would run, or why none can and what to install. */
export interface Probe {
  ok: boolean;
  /** "windows", "macos", "hyprland", "sway", "wlroots", "gnome-wayland", "kde-wayland", "x11", "none". */
  kind: string;
  name: string;
  /** Programs, permissions or services missing, each a short line saying what it's for. */
  missing: string[];
  /** Actions that won't work with what's here (e.g. "left_mouse_down" without ydotool on Hyprland). */
  limits: string[];
}

/** The Linux tools a backend may use. */
export const LINUX_TOOLS = ["grim", "hyprctl", "swaymsg", "wlrctl", "wtype", "ydotool", "xdotool", "import", "maim", "scrot", "gnome-screenshot", "spectacle"] as const;
export type LinuxTool = (typeof LINUX_TOOLS)[number];

/** A Linux desktop's backend plan: which tool does what. Pure, from the environment and the tools on PATH. */
export interface LinuxPlan {
  kind: string;
  shot: "grim" | "import" | "maim" | "scrot" | "gnome-screenshot" | "spectacle" | null;
  /** Absolute pointer moves. */
  move: "hyprctl" | "swaymsg" | "xdotool" | "ydotool" | null;
  /** Button presses (down/up separately when `press` isn't null). */
  click: "xdotool" | "swaymsg" | "ydotool" | "wlrctl" | null;
  press: "xdotool" | "swaymsg" | "ydotool" | null;
  scroll: "xdotool" | "swaymsg" | "ydotool" | "wlrctl" | null;
  keys: "xdotool" | "wtype" | "ydotool" | null;
  text: "xdotool" | "wtype" | "ydotool" | null;
  cursor: "xdotool" | "hyprctl" | null;
  /** The compositor's layout, for logical (not buffer) coordinates and monitor offsets. */
  layout: "hyprctl" | "swaymsg" | null;
}

type Env = Record<string, string | undefined>;

function desktop(env: Env): string {
  return `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.XDG_SESSION_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`.toLowerCase();
}

/** Which tool does what on this Linux desktop, from its environment and `has` (a program on PATH). */
export function linuxPlan(env: Env, has: (t: LinuxTool) => boolean): LinuxPlan {
  const pick = <T extends LinuxTool>(...ts: T[]): T | null => ts.find((t) => has(t)) ?? null;
  const wayland = (env.WAYLAND_DISPLAY ?? "") !== "" || env.XDG_SESSION_TYPE === "wayland";
  const d = desktop(env);
  if (!wayland) {
    const x = (env.DISPLAY ?? "") !== "" ? "x11" : "none";
    const xdo = has("xdotool") ? ("xdotool" as const) : null;
    return { kind: x, shot: pick("import", "maim", "scrot"), move: xdo, click: xdo, press: xdo, scroll: xdo, keys: xdo, text: xdo, cursor: xdo, layout: null };
  }
  const ydo = has("ydotool") ? ("ydotool" as const) : null;
  const wt = has("wtype") ? ("wtype" as const) : null;
  if ((env.HYPRLAND_INSTANCE_SIGNATURE ?? "") !== "" && has("hyprctl")) {
    return {
      kind: "hyprland",
      shot: pick("grim"),
      move: "hyprctl",
      click: ydo ?? pick("wlrctl"),
      press: ydo,
      scroll: ydo ?? pick("wlrctl"),
      keys: wt ?? ydo,
      text: wt ?? ydo,
      cursor: "hyprctl",
      layout: "hyprctl",
    };
  }
  if ((env.SWAYSOCK ?? "") !== "" && has("swaymsg")) {
    return { kind: "sway", shot: pick("grim"), move: "swaymsg", click: "swaymsg", press: "swaymsg", scroll: "swaymsg", keys: wt ?? ydo, text: wt ?? ydo, cursor: null, layout: "swaymsg" };
  }
  if (d.includes("gnome") || d.includes("kde") || d.includes("plasma")) {
    const gnome = d.includes("gnome");
    return {
      kind: gnome ? "gnome-wayland" : "kde-wayland",
      shot: gnome ? pick("gnome-screenshot", "grim") : pick("spectacle", "grim"),
      move: ydo,
      click: ydo,
      press: ydo,
      scroll: ydo,
      keys: ydo,
      text: ydo,
      cursor: null,
      layout: null,
    };
  }
  // Another wlroots compositor (river, labwc, wayfire…): grim and the virtual-keyboard and -pointer protocols.
  return { kind: "wlroots", shot: pick("grim"), move: ydo, click: ydo ?? pick("wlrctl"), press: ydo, scroll: ydo ?? pick("wlrctl"), keys: wt ?? ydo, text: wt ?? ydo, cursor: null, layout: null };
}

/** What a Linux plan lacks, as lines for the agent and Settings, and the actions it can't do. */
export function linuxGaps(p: LinuxPlan): { missing: string[]; limits: string[] } {
  const missing: string[] = [];
  const limits: string[] = [];
  if (p.kind === "none") return { missing: ["a graphical session (no WAYLAND_DISPLAY or DISPLAY): Harbor runs without a desktop here"], limits };
  const x11 = p.kind === "x11";
  if (p.shot === null) {
    missing.push(
      x11
        ? "a screenshot tool: ImageMagick (import), maim or scrot"
        : p.kind === "gnome-wayland"
          ? "gnome-screenshot (GNOME's Wayland lets only it or the portal read the screen)"
          : p.kind === "kde-wayland"
            ? "spectacle (KDE's screenshot tool)"
            : "grim (screenshots on wlroots compositors and Hyprland)",
    );
  }
  if (x11 && p.move === null) missing.push("xdotool (mouse and keyboard on X11)");
  if (!x11) {
    if (p.move === null) missing.push("ydotool with its ydotoold service running (pointer moves on this compositor; needs access to /dev/uinput)");
    if (p.click === null) missing.push(p.kind === "hyprland" || p.kind === "wlroots" ? "ydotool (with ydotoold) or wlrctl, for clicks" : "ydotool (with ydotoold), for clicks");
    if (p.keys === null) missing.push(p.kind === "gnome-wayland" || p.kind === "kde-wayland" ? "ydotool (with ydotoold), for the keyboard" : "wtype (or ydotool), for the keyboard");
    if (p.click !== null && p.press === null) limits.push("left_mouse_down, left_mouse_up and left_click_drag need ydotool (with ydotoold) here");
    if (p.scroll === null && p.click !== null) limits.push("scroll needs ydotool or wlrctl here");
    if (p.cursor === null) limits.push("cursor_position is where Harbor last moved the pointer (this compositor doesn't say)");
    if (p.keys === "ydotool") limits.push("ydotool types US-layout key positions: other layouts may get other characters");
    if (p.keys === "wtype" && p.press !== "ydotool") limits.push("modifier keys held during clicks and scrolls (their text) need ydotool here: wtype lets go of keys when it exits");
  }
  return { missing, limits };
}
