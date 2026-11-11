import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSize, sizeOf } from "../src/imagesize.ts";
import { sharpLib } from "../src/sharplib.ts";

const raw = (w: number, h: number) => ({ raw: { width: w, height: h, channels: 3 as const } });
async function make(w: number, h: number, f: (s: import("sharp").Sharp) => import("sharp").Sharp): Promise<Uint8Array> {
  const sharp = await sharpLib();
  return new Uint8Array(await f(sharp(Buffer.alloc(w * h * 3, 128), raw(w, h))).toBuffer());
}

describe("sizeOf", () => {
  test("PNG, GIF, JPEG and WebP (lossy and lossless) give their size", async () => {
    expect(sizeOf(await make(321, 123, (s) => s.png()))).toEqual([321, 123]);
    expect(sizeOf(await make(70, 33, (s) => s.gif()))).toEqual([70, 33]);
    expect(sizeOf(await make(640, 360, (s) => s.jpeg()))).toEqual([640, 360]);
    expect(sizeOf(await make(500, 260, (s) => s.webp()))).toEqual([500, 260]);
    expect(sizeOf(await make(501, 261, (s) => s.webp({ lossless: true })))).toEqual([501, 261]);
  });

  test("a JPEG its EXIF turns is drawn turned", async () => {
    expect(sizeOf(await make(640, 360, (s) => s.jpeg().withMetadata({ orientation: 6 })))).toEqual([360, 640]);
    expect(sizeOf(await make(640, 360, (s) => s.jpeg().withMetadata({ orientation: 3 })))).toEqual([640, 360]);
  });

  test("anything else, or too little of it, is not known", () => {
    expect(sizeOf(new TextEncoder().encode("hello, not an image"))).toBeNull();
    expect(sizeOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sizeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBeNull();
  });
});

describe("fileSize", () => {
  test("reads a file's head; a missing file is not known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagesize-"));
    writeFileSync(join(dir, "a.png"), await make(40, 30, (s) => s.png()));
    expect(fileSize(join(dir, "a.png"))).toEqual([40, 30]);
    expect(fileSize(join(dir, "missing.png"))).toBeNull();
  });
});
