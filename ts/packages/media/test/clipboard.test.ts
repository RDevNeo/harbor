import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as clip from "../src/clipboard.ts";
import { clipboard as osClipboard } from "@harbor/os";

// The desktop tools (wl-copy, xclip) where the system has no clipboard Harbor talks to itself (Linux).
const linuxTools = !osClipboard.available();

let dir = "";
const saved = { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hclip-"));
  clip.resetBackend();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clip.resetBackend();
  rmSync(dir, { recursive: true, force: true });
});

function fakeWayland(types: string, contents: Record<string, string>): void {
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const script = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "wl-paste",
    `if [ "$1" = "--version" ]; then echo wl-paste 2.0; exit 0; fi
if [ "$1" = "--list-types" ]; then printf '%s\\n' ${types}; exit 0; fi
t=""; while [ $# -gt 0 ]; do if [ "$1" = "--type" ]; then t="$2"; fi; shift; done
f="${dir}/paste-$(echo "$t" | tr '/;=' '___')"; [ -f "$f" ] && cat "$f" || exit 1`,
  );
  script(
    "wl-copy",
    `t=text; while [ $# -gt 0 ]; do if [ "$1" = "--type" ]; then t="$2"; fi; shift; done
echo "$t" > "${dir}/copied-type"; cat > "${dir}/copied-data"`,
  );
  for (const [type, data] of Object.entries(contents)) writeFileSync(join(dir, `paste-${type.replace(/[/;=]/g, "_")}`), data);
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.WAYLAND_DISPLAY = "wayland-test";
}

test.if(linuxTools)("text wins over an image, then an image, then a uri list", async () => {
  fakeWayland("text/plain image/png", { "text/plain": "hello" });
  expect(await clip.read()).toEqual({ type: "text", text: "hello" });
  clip.resetBackend();
  fakeWayland("image/png text/uri-list", { "image/png": "PNGDATA", "text/uri-list": "file:///a\n" });
  expect(await clip.read()).toEqual({ type: "image", bytes: new Uint8Array(Buffer.from("PNGDATA")) });
  rmSync(join(dir, "paste-image_png"));
  clip.resetBackend();
  expect(await clip.read()).toBeNull();
  clip.resetBackend();
  fakeWayland("text/uri-list", { "text/uri-list": "file:///a\n" });
  expect(await clip.read()).toEqual({ type: "text", text: "file:///a\n" });
});

test.if(linuxTools)("copies text and images through wl-copy, images as png", async () => {
  fakeWayland("text/plain", {});
  await clip.copyText("héllo");
  expect(readFileSync(join(dir, "copied-data"), "utf8")).toBe("héllo");
  const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).jpeg().toBuffer();
  expect(await clip.copyImage(jpeg)).toBe(true);
  expect(readFileSync(join(dir, "copied-type"), "utf8").trim()).toBe("image/png");
  const out = readFileSync(join(dir, "copied-data"));
  expect(out.subarray(1, 4).toString()).toBe("PNG");
  expect(await clip.copyImage(Buffer.from("not an image"))).toBe(false);
});

test.if(linuxTools)("nothing happens without a clipboard tool", async () => {
  process.env.PATH = dir;
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  expect(await clip.read()).toBeNull();
});

test.if(linuxTools)("a paste brings text with unix line ends or a decoded image", async () => {
  fakeWayland("text/plain", { "text/plain": "a\r\nb" });
  expect(await clip.readForPaste()).toEqual({ type: "text", text: "a\nb" });
  clip.resetBackend();
  const png = await sharp({ create: { width: 6, height: 3, channels: 4, background: "#00f" } }).png().toBuffer();
  fakeWayland("image/png", {});
  writeFileSync(join(dir, "paste-image_png"), png);
  const got = await clip.readForPaste();
  expect(got?.type === "image" && [got.image.width, got.image.height]).toEqual([6, 3]);
});

test("preview_is_one_short_line", () => {
  expect(clip.preview("  https://example.com/x \n")).toBe("https://example.com/x");
  expect(clip.preview("\n  first\nsecond")).toBe("first…");
  expect(clip.preview("a".repeat(80))).toBe(`${"a".repeat(60)}…`);
  expect(clip.preview(" \n\t")).toBeNull();
});

test("same_notice_within_a_second_is_skipped", () => {
  let last: { body: string; at: number } | null = null;
  const at = (body: string, t: number): boolean => {
    const r = clip.fresh(last, body, t);
    last = r.last;
    return r.show;
  };
  expect(at("a", 0)).toBe(true);
  expect(at("a", 500)).toBe(false);
  expect(at("b", 600)).toBe(true);
  expect(at("b", 1700)).toBe(true);
});

test("clipboard keys map to paste, copy and cut", () => {
  const k = (key: string, mods: Partial<clip.ClipKey> = {}): clip.ClipKey => ({ key, ctrl: false, alt: false, shift: false, ...mods });
  expect(clip.shortcut(k("V", { ctrl: true }), false, false)).toBe("paste");
  expect(clip.shortcut(k("V", { ctrl: true, shift: true }), false, false)).toBe("paste");
  expect(clip.shortcut(k("Insert", { shift: true }), false, false)).toBe("paste");
  expect(clip.shortcut(k("C", { ctrl: true }), false, false)).toBe("copy");
  expect(clip.shortcut(k("Insert", { ctrl: true }), false, false)).toBe("copy");
  expect(clip.shortcut(k("X", { ctrl: true }), false, false)).toBe("cut");
  expect(clip.shortcut(k("C", { ctrl: true, shift: true }), true, false)).toBeNull();
  expect(clip.shortcut(k("C", { ctrl: true, shift: true }), false, false)).toBe("copy");
  expect(clip.shortcut(k("C", { ctrl: true }), false, true)).toBeNull();
  expect(clip.shortcut(k("V", { ctrl: true }), false, true)).toBe("paste");
  expect(clip.shortcut(k("C", { ctrl: true, alt: true }), false, false)).toBeNull();
});
