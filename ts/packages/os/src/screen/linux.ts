// Computer use on Linux, through the desktop's own tools (linuxPlan picks them): grim on Wayland compositors,
// ImageMagick/maim/scrot on X11, gnome-screenshot or spectacle on GNOME and KDE; the pointer through the
// compositor's IPC where it has one (hyprctl, swaymsg), else xdotool (X11) or ydotool; keys through wtype,
// xdotool or ydotool. Screen pixels are the screenshot's: on a compositor with a layout they're converted to its
// logical coordinates (monitor offsets and scales), as `grim` composes every output at the highest scale.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Backend, type Button, type Direction, type LinuxPlan, type LinuxTool, LINUX_TOOLS, linuxGaps, linuxPlan, type Probe } from "./backend.ts";
import { decode, type Image } from "./image.ts";
import { type Combo, evdevCode, keysym, wtypeMod, xdotoolCombo } from "./keys.ts";

type Env = Record<string, string | undefined>;

async function run(argv: string[], opts: { stdin?: string } = {}): Promise<Uint8Array> {
  const p = Bun.spawn(argv, { stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${argv[0]} failed (exit ${code})${err.trim() === "" ? "" : `: ${err.trim().split("\n").slice(-3).join(" ")}`}`);
  return new Uint8Array(out);
}

const text = async (argv: string[]): Promise<string> => new TextDecoder().decode(await run(argv));

/** The tools of LINUX_TOOLS on PATH. */
export function tools(env: Env = process.env): Set<LinuxTool> {
  const path = env.PATH ?? "";
  return new Set(LINUX_TOOLS.filter((t) => Bun.which(t, { PATH: path }) !== null));
}

export function plan(env: Env = process.env, have: Set<LinuxTool> = tools(env)): LinuxPlan {
  return linuxPlan(env, (t) => have.has(t));
}

export function probe(env: Env = process.env): Probe {
  const p = plan(env);
  const { missing, limits } = linuxGaps(p);
  const used = [p.shot, p.move, p.click, p.keys].filter((t, i, a): t is NonNullable<typeof t> => t !== null && a.indexOf(t) === i);
  return { ok: missing.length === 0, kind: p.kind, name: `${label(p.kind)} (${used.join(", ") || "no tools"})`, missing, limits };
}

function label(kind: string): string {
  return (
    { hyprland: "Hyprland", sway: "Sway", wlroots: "Wayland (wlroots)", "gnome-wayland": "GNOME on Wayland", "kde-wayland": "KDE Plasma on Wayland", x11: "X11", none: "no desktop" } as Record<string, string>
  )[kind] ?? kind;
}

/** The compositor's layout in logical coordinates: its top-left corner, size, and the highest monitor scale. */
interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

/** A layout from hyprctl's or swaymsg's monitor list (JSON). Pure. */
export function parseLayout(kind: "hyprctl" | "swaymsg", json: string): Layout | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const boxes: { x: number; y: number; w: number; h: number; s: number }[] = [];
  for (const m of v as Record<string, unknown>[]) {
    const scale = typeof m.scale === "number" && m.scale > 0 ? m.scale : 1;
    if (kind === "hyprctl") {
      if (m.disabled === true) continue;
      const turned = typeof m.transform === "number" && m.transform % 2 === 1;
      const pw = Number(m.width);
      const ph = Number(m.height);
      boxes.push({ x: Number(m.x), y: Number(m.y), w: (turned ? ph : pw) / scale, h: (turned ? pw : ph) / scale, s: scale });
    } else {
      if (m.active === false) continue;
      const r = (m.rect ?? {}) as Record<string, unknown>;
      boxes.push({ x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height), s: scale });
    }
  }
  const ok = boxes.filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0);
  if (ok.length === 0) return null;
  const x = Math.min(...ok.map((b) => b.x));
  const y = Math.min(...ok.map((b) => b.y));
  return { x, y, w: Math.max(...ok.map((b) => b.x + b.w)) - x, h: Math.max(...ok.map((b) => b.y + b.h)) - y, scale: Math.max(...ok.map((b) => b.s)) };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ydotool's button codes: 0x40 down, 0x80 up, 0xC0 both; left 0, right 1, middle 2. */
const YDO_BUTTON: Record<Button, number> = { left: 0, right: 1, middle: 2 };
const X_BUTTON: Record<Button, string> = { left: "1", right: "3", middle: "2" };

export function backend(env: Env = process.env): Backend {
  const p = plan(env);
  const { missing } = linuxGaps(p);
  if (missing.length > 0) throw new Error(`computer use needs ${missing.join("; ")}`);
  let layoutAt = 0;
  let layoutNow: Layout | null = null;
  const layout = async (): Promise<Layout | null> => {
    if (p.layout === null) return null;
    if (Date.now() - layoutAt < 2000) return layoutNow;
    const json = p.layout === "hyprctl" ? await text(["hyprctl", "monitors", "-j"]) : await text(["swaymsg", "-t", "get_outputs", "-r"]);
    layoutNow = parseLayout(p.layout, json);
    layoutAt = Date.now();
    return layoutNow;
  };
  /** Screen pixels to the compositor's logical coordinates. */
  const toLogical = async (x: number, y: number): Promise<[number, number]> => {
    const l = await layout();
    return l === null ? [Math.round(x), Math.round(y)] : [Math.round(l.x + x / l.scale), Math.round(l.y + y / l.scale)];
  };
  let last: { x: number; y: number } | null = null;

  const shoot = async (): Promise<Image> => {
    let bytes: Uint8Array;
    if (p.shot === "grim") bytes = await run(["grim", "-t", "ppm", "-"]);
    else if (p.shot === "import") bytes = await run(["import", "-silent", "-window", "root", "ppm:-"]);
    else if (p.shot === "maim") bytes = await run(["maim", "--format=png", "--hidecursor"]);
    else {
      const dir = mkdtempSync(join(tmpdir(), "harbor-shot-"));
      const file = join(dir, "screen.png");
      try {
        if (p.shot === "scrot") await run(["scrot", "-o", "-z", file]);
        else if (p.shot === "gnome-screenshot") await run(["gnome-screenshot", "-f", file]);
        else await run(["spectacle", "-b", "-n", "-f", "-o", file]);
        bytes = new Uint8Array(readFileSync(file));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const img = decode(bytes);
    if (img === null) throw new Error(`couldn't read ${p.shot}'s screenshot`);
    return img;
  };

  const ydoKey = (c: Combo, how: "press" | "down" | "up"): string[] => {
    const codes = [...c.mods, ...(c.key === "" ? [] : [c.key])].map(evdevCode);
    const downs = codes.map((k) => `${k}:1`);
    const ups = [...codes].reverse().map((k) => `${k}:0`);
    return ["ydotool", "key", ...(how === "down" ? downs : how === "up" ? ups : [...downs, ...ups])];
  };
  const wtypeKey = (c: Combo, how: "press" | "down" | "up", holdMs = 0): string[] => {
    const a = ["wtype"];
    if (how !== "up") for (const m of c.mods) a.push("-M", wtypeMod(m));
    if (c.key !== "") {
      if (how === "press") a.push("-k", keysym(c.key));
      else if (how === "down") a.push("-P", keysym(c.key));
      if (holdMs > 0) a.push("-s", String(holdMs), "-p", keysym(c.key));
      else if (how === "up") a.push("-p", keysym(c.key));
    } else if (holdMs > 0) a.push("-s", String(holdMs));
    if (how !== "down" || holdMs > 0) for (const m of [...c.mods].reverse()) a.push("-m", wtypeMod(m));
    return a;
  };

  return {
    name: probe(env).name,
    size: async () => {
      const l = await layout();
      if (l !== null) return { w: Math.round(l.w * l.scale), h: Math.round(l.h * l.scale) };
      if (p.move === "xdotool") {
        const [w, h] = (await text(["xdotool", "getdisplaygeometry"])).trim().split(/\s+/).map(Number);
        if (w && h) return { w, h };
      }
      const img = await shoot();
      return { w: img.w, h: img.h };
    },
    capture: async () => shoot(),
    move: async (x, y) => {
      const [lx, ly] = await toLogical(x, y);
      if (p.move === "hyprctl") await run(["hyprctl", "dispatch", "movecursor", String(lx), String(ly)]);
      else if (p.move === "swaymsg") await run(["swaymsg", "seat", "-", "cursor", "set", String(lx), String(ly)]);
      else if (p.move === "xdotool") await run(["xdotool", "mousemove", "--sync", String(lx), String(ly)]);
      else await run(["ydotool", "mousemove", "--absolute", "-x", String(lx), "-y", String(ly)]);
      last = { x: Math.round(x), y: Math.round(y) };
    },
    button: async (b, how, count = 1) => {
      if (how !== "click" && p.press === null) throw new Error(`pressing and releasing a button separately needs ydotool (with ydotoold) on ${label(p.kind)}`);
      const tool = how === "click" ? p.click : p.press;
      if (tool === "xdotool") {
        if (how === "click") await run(["xdotool", "click", "--repeat", String(count), "--delay", "80", X_BUTTON[b]]);
        else await run(["xdotool", how === "down" ? "mousedown" : "mouseup", X_BUTTON[b]]);
      } else if (tool === "swaymsg") {
        const btn = `button${X_BUTTON[b]}`;
        for (let i = 0; i < (how === "click" ? count : 1); i++) {
          if (how !== "up") await run(["swaymsg", "seat", "-", "cursor", "press", btn]);
          if (how !== "down") await run(["swaymsg", "seat", "-", "cursor", "release", btn]);
        }
      } else if (tool === "ydotool") {
        const code = YDO_BUTTON[b] | (how === "down" ? 0x40 : how === "up" ? 0x80 : 0xc0);
        const hex = `0x${code.toString(16).toUpperCase()}`;
        await run(["ydotool", "click", ...(how === "click" && count > 1 ? ["--repeat", String(count), "--next-delay", "80"] : []), hex]);
      } else if (tool === "wlrctl") {
        for (let i = 0; i < count; i++) {
          if (i > 0) await pause(80);
          await run(["wlrctl", "pointer", "click", b]);
        }
      } else throw new Error(`no tool clicks on ${label(p.kind)}`);
    },
    scroll: async (dir: Direction, amount) => {
      if (p.scroll === "xdotool" || p.scroll === "swaymsg") {
        const btn = { up: "4", down: "5", left: "6", right: "7" }[dir];
        if (p.scroll === "xdotool") await run(["xdotool", "click", "--repeat", String(amount), "--delay", "30", btn]);
        else for (let i = 0; i < amount; i++) await run(["swaymsg", "seat", "-", "cursor", "press", `button${btn}`]).then(() => run(["swaymsg", "seat", "-", "cursor", "release", `button${btn}`]));
        return;
      }
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      if (p.scroll === "wlrctl") await run(["wlrctl", "pointer", "scroll", String(dy * 15), String(dx * 15)]);
      // evdev's wheel: positive is away from the user (up), so down is negative.
      else if (p.scroll === "ydotool") await run(["ydotool", "mousemove", "--wheel", "-x", String(dx), "-y", String(-dy)]);
      else throw new Error(`scrolling needs ydotool or wlrctl on ${label(p.kind)}`);
    },
    key: async (c, how = "press") => {
      if (p.keys === "xdotool") await run(["xdotool", how === "press" ? "key" : how === "down" ? "keydown" : "keyup", "--clearmodifiers", xdotoolCombo(c)]);
      // wtype's keys go up when it exits: a key held across calls (modifiers on a click) needs ydotool.
      else if (p.keys === "wtype" && how !== "press" && p.press === "ydotool") await run(ydoKey(c, how));
      else if (p.keys === "wtype" && how !== "press") throw new Error(`holding keys across a click needs ydotool (with ydotoold) on ${label(p.kind)}`);
      else if (p.keys === "wtype") await run(wtypeKey(c, how));
      else if (p.keys === "ydotool") await run(ydoKey(c, how));
      else throw new Error(`no keyboard tool on ${label(p.kind)}`);
    },
    hold: async (c, ms) => {
      // wtype's virtual keyboard goes with its process: the hold is one wtype run.
      if (p.keys === "wtype") return void (await run(wtypeKey(c, "down", ms)));
      await (p.keys === "xdotool" ? run(["xdotool", "keydown", xdotoolCombo(c)]) : run(ydoKey(c, "down")));
      await pause(ms);
      await (p.keys === "xdotool" ? run(["xdotool", "keyup", xdotoolCombo(c)]) : run(ydoKey(c, "up")));
    },
    type: async (t) => {
      if (p.text === "xdotool") await run(["xdotool", "type", "--delay", "12", "--", t]);
      else if (p.text === "wtype") await run(["wtype", "-d", "4", "--", t]);
      else if (p.text === "ydotool") await run(["ydotool", "type", "--key-delay", "6", "--", t]);
      else throw new Error(`no keyboard tool on ${label(p.kind)}`);
    },
    cursor: async () => {
      if (p.cursor === "xdotool") {
        const out = await text(["xdotool", "getmouselocation", "--shell"]);
        const x = /X=(-?\d+)/.exec(out)?.[1];
        const y = /Y=(-?\d+)/.exec(out)?.[1];
        return x !== undefined && y !== undefined ? { x: Number(x), y: Number(y) } : null;
      }
      if (p.cursor === "hyprctl") {
        const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(await text(["hyprctl", "cursorpos"]));
        const l = await layout();
        if (m && l) return { x: Math.round((Number(m[1]) - l.x) * l.scale), y: Math.round((Number(m[2]) - l.y) * l.scale) };
      }
      return last;
    },
  };
}
