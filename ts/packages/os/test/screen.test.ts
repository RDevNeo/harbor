import { describe, expect, test } from "bun:test";
import { type LinuxTool, linuxGaps, linuxPlan } from "../src/screen/backend.ts";
import { bgraToRgba, clampRect, crop, decode, parseBmp, parsePpm, png, resize } from "../src/screen/image.ts";
import { evdevCode, keysym, macFlags, macKeycode, parseCombo, parseKeys, winVk, wtypeMod, xdotoolCombo } from "../src/screen/keys.ts";
import { parseLayout } from "../src/screen/linux.ts";
import { decodePng } from "../src/win32/formats.ts";

const solid = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      rgba.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { w, h, rgba };
};

describe("screen images", () => {
  test("a PPM from grim or ImageMagick, comments and all", () => {
    const head = new TextEncoder().encode("P6\n# grim\n2 1\n255\n");
    const img = parsePpm(new Uint8Array([...head, 255, 0, 0, 0, 0, 255]));
    expect(img).toEqual({ w: 2, h: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) });
    expect(parsePpm(new TextEncoder().encode("P5\n1 1\n255\n\0"))).toBeNull();
    expect(decode(new Uint8Array([...head, 1, 2, 3, 4, 5, 6]))?.w).toBe(2);
  });

  test("a BMP bottom-up, 24 bits, rows padded to 4 bytes", () => {
    const w = 1;
    const h = 2;
    const b = new Uint8Array(54 + 8);
    const v = new DataView(b.buffer);
    b.set([0x42, 0x4d]);
    v.setUint32(10, 54, true);
    v.setInt32(18, w, true);
    v.setInt32(22, h, true);
    v.setUint16(28, 24, true);
    // Bottom row first: blue, then the top row red (BGR order).
    b.set([255, 0, 0], 54);
    b.set([0, 0, 255], 58);
    expect(parseBmp(b)?.rgba).toEqual(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
  });

  test("BGRA to RGBA, opaque", () => {
    expect(bgraToRgba(new Uint8Array([1, 2, 3, 0]))).toEqual(new Uint8Array([3, 2, 1, 255]));
  });

  test("crop and clamp stay inside the image", () => {
    const img = solid(4, 3, (x, y) => [x * 10, y * 10, 0]);
    expect(clampRect(img, { x: -5, y: 1, w: 100, h: 1 })).toEqual({ x: 0, y: 1, w: 4, h: 1 });
    const c = crop(img, { x: 2, y: 1, w: 2, h: 2 });
    expect([c.w, c.h, c.rgba[0], c.rgba[1]]).toEqual([2, 2, 20, 10]);
  });

  test("shrinking averages what each pixel covers; growing repeats", () => {
    // A checkerboard of black and white averages to grey.
    const board = solid(4, 4, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
    const small = resize(board, 2, 2);
    expect([...small.rgba.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
    // 3 to 2: fractional edges weighted (white 1.5 of the first output pixel's 1.5 source pixels).
    const stripe = resize(solid(3, 1, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 0])), 2, 1);
    expect(stripe.rgba[0]).toBe(170);
    expect(stripe.rgba[4]).toBe(0);
    const big = resize(solid(1, 1, () => [7, 8, 9]), 3, 2);
    expect([big.w, big.h, big.rgba[20], big.rgba[21], big.rgba[22]]).toEqual([3, 2, 7, 8, 9]);
  });

  test("the PNG decodes to the same pixels", async () => {
    const img = solid(17, 9, (x, y) => [(x * 13) & 255, (y * 29) & 255, (x * y) & 255]);
    const p = await png(img);
    const back = decodePng(p);
    expect(back?.w).toBe(17);
    expect(back?.h).toBe(9);
    expect(back?.rgba).toEqual(img.rgba);
    // A flat screen compresses to almost nothing.
    expect((await png(solid(1280, 720, () => [30, 30, 30]))).length).toBeLessThan(10_000);
  });
});

describe("keys", () => {
  test("xdotool's names, aliases and chords", () => {
    expect(parseCombo("Return")).toEqual({ mods: [], key: "return" });
    expect(parseCombo("ctrl+s")).toEqual({ mods: ["ctrl"], key: "s" });
    expect(parseCombo("Control_L+Shift_L+t")).toEqual({ mods: ["ctrl", "shift"], key: "t" });
    expect(parseCombo("cmd+Page_Down")).toEqual({ mods: ["super"], key: "page_down" });
    expect(parseCombo("super")).toEqual({ mods: ["super"], key: "" });
    expect(parseCombo("alt+F4")).toEqual({ mods: ["alt"], key: "f4" });
    expect(parseCombo("KP_Enter")).toEqual({ mods: [], key: "return" });
    expect(parseCombo("Prior")).toEqual({ mods: [], key: "page_up" });
  });

  test("shifted characters and capitals press shift", () => {
    expect(parseCombo("A")).toEqual({ mods: ["shift"], key: "a" });
    expect(parseCombo("ctrl+plus")).toEqual({ mods: ["ctrl", "shift"], key: "equal" });
    expect(parseCombo("ctrl++")).toEqual({ mods: ["ctrl", "shift"], key: "equal" });
    expect(parseCombo("question")).toEqual({ mods: ["shift"], key: "slash" });
    expect(parseCombo("/")).toEqual({ mods: [], key: "slash" });
  });

  test("unknown keys and two keys at once are refused", () => {
    expect(() => parseCombo("ctrl+nosuchkey")).toThrow("unknown key 'nosuchkey'");
    expect(() => parseCombo("a+b")).toThrow("two keys at once");
    expect(() => parseCombo("ctrl+")).toThrow("can't read");
    expect(() => parseKeys("  ")).toThrow("no key given");
  });

  test("several chords separated by spaces", () => {
    expect(parseKeys("ctrl+a Delete").map((c) => c.key)).toEqual(["a", "delete"]);
  });

  test("each system's codes", () => {
    expect(winVk("return")).toEqual([0x0d, false]);
    expect(winVk("delete")).toEqual([0x2e, true]);
    expect(winVk("a")).toEqual([0x41, false]);
    expect(winVk("7")).toEqual([0x37, false]);
    expect(winVk("f12")).toEqual([0x7b, false]);
    expect(winVk("super")).toEqual([0x5b, true]);
    expect(macKeycode("a")).toBe(0);
    expect(macKeycode("return")).toBe(36);
    expect(macKeycode("super")).toBe(55);
    expect(macFlags(["super", "shift"])).toBe(0x100000 | 0x20000);
    expect(evdevCode("return")).toBe(28);
    expect(evdevCode("a")).toBe(30);
    expect(evdevCode("f13")).toBe(183);
    expect(keysym("page_up")).toBe("Prior");
    expect(keysym("f5")).toBe("F5");
    expect(xdotoolCombo(parseCombo("ctrl+shift+Return"))).toBe("ctrl+shift+Return");
    expect(wtypeMod("super")).toBe("logo");
    expect(() => macKeycode("f24")).toThrow("no macOS key");
  });
});

describe("which Linux tools do what", () => {
  const has = (...tools: LinuxTool[]) => (t: LinuxTool) => tools.includes(t);

  test("Hyprland: grim, hyprctl moves, wtype keys, ydotool buttons", () => {
    const env = { WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "abc" };
    const p = linuxPlan(env, has("grim", "hyprctl", "wtype", "ydotool"));
    expect(p).toMatchObject({ kind: "hyprland", shot: "grim", move: "hyprctl", click: "ydotool", press: "ydotool", keys: "wtype", cursor: "hyprctl", layout: "hyprctl" });
    expect(linuxGaps(p)).toEqual({ missing: [], limits: [] });
  });

  test("Hyprland without ydotool clicks with wlrctl and says what it can't do", () => {
    const p = linuxPlan({ WAYLAND_DISPLAY: "w", HYPRLAND_INSTANCE_SIGNATURE: "x" }, has("grim", "hyprctl", "wtype", "wlrctl"));
    expect([p.click, p.press, p.scroll]).toEqual(["wlrctl", null, "wlrctl"]);
    const g = linuxGaps(p);
    expect(g.missing).toEqual([]);
    expect(g.limits[0]).toContain("left_mouse_down");
  });

  test("Hyprland with nothing installed says what to install", () => {
    const g = linuxGaps(linuxPlan({ WAYLAND_DISPLAY: "w", HYPRLAND_INSTANCE_SIGNATURE: "x" }, has("hyprctl")));
    expect(g.missing.join("\n")).toContain("grim");
    expect(g.missing.join("\n")).toContain("ydotool (with ydotoold) or wlrctl");
    expect(g.missing.join("\n")).toContain("wtype");
  });

  test("Sway does the pointer through swaymsg", () => {
    const p = linuxPlan({ WAYLAND_DISPLAY: "w", SWAYSOCK: "/run/sway" }, has("grim", "swaymsg", "wtype"));
    expect(p).toMatchObject({ kind: "sway", move: "swaymsg", click: "swaymsg", press: "swaymsg", scroll: "swaymsg", keys: "wtype", layout: "swaymsg" });
    expect(linuxGaps(p).missing).toEqual([]);
  });

  test("GNOME on Wayland needs ydotool for input", () => {
    const p = linuxPlan({ WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "GNOME" }, has("gnome-screenshot"));
    expect(p.kind).toBe("gnome-wayland");
    expect(linuxGaps(p).missing.some((m) => m.includes("ydotool"))).toBe(true);
    const ok = linuxPlan({ WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "GNOME" }, has("gnome-screenshot", "ydotool"));
    expect(linuxGaps(ok).missing).toEqual([]);
  });

  test("X11: xdotool and the first screenshot tool there is", () => {
    const p = linuxPlan({ DISPLAY: ":0" }, has("xdotool", "scrot", "maim"));
    expect(p).toMatchObject({ kind: "x11", shot: "maim", move: "xdotool", keys: "xdotool", cursor: "xdotool" });
    expect(linuxGaps(linuxPlan({ DISPLAY: ":0" }, has()))).toEqual({ missing: ["a screenshot tool: ImageMagick (import), maim or scrot", "xdotool (mouse and keyboard on X11)"], limits: [] });
  });

  test("no session at all", () => {
    expect(linuxGaps(linuxPlan({}, has("xdotool"))).missing[0]).toContain("graphical session");
  });

  test("the compositor's layout: offsets, scales and turned monitors", () => {
    const hypr = JSON.stringify([
      { x: 0, y: 0, width: 2560, height: 1440, scale: 1.25, transform: 0 },
      { x: 2048, y: -200, width: 1080, height: 1920, scale: 1, transform: 1 },
      { x: 9999, y: 0, width: 10, height: 10, scale: 1, disabled: true },
    ]);
    expect(parseLayout("hyprctl", hypr)).toEqual({ x: 0, y: -200, w: 2048 + 1920, h: 1352, scale: 1.25 });
    const sway = JSON.stringify([{ active: true, rect: { x: 0, y: 0, width: 1280, height: 800 }, scale: 2 }]);
    expect(parseLayout("swaymsg", sway)).toEqual({ x: 0, y: 0, w: 1280, h: 800, scale: 2 });
    expect(parseLayout("swaymsg", "not json")).toBeNull();
  });
});
