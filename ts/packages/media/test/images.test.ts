import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Images, MID_PX, cover, decode, decodeBytes, inlineSize, step } from "../src/images.ts";

const dirs: string[] = [];
const prevData = process.env.XDG_DATA_HOME;

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `himg-${name}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.XDG_DATA_HOME = tmp("data");
});

afterEach(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const png = (w: number, h: number, alpha = 0): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 0, b: 0, alpha } } }).png().toBuffer();

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

test("the_viewer_stops_at_either_end_and_widens_to_the_card", () => {
  expect([step(0, 3, -1), step(0, 3, 1), step(2, 3, 1), step(2, 3, -1)]).toEqual([null, 1, null, 1]);
  expect(step(0, 1, 1)).toBeNull();
  const imgs = new Images();
  const keys = (v: string[]): string[] => v.map((s) => `/x/${s}.png`);
  imgs.inCard(7);
  imgs.openClicked("/x/d.png", keys(["c", "d"]));
  expect([imgs.takeOpened(), imgs.takeOpened()]).toEqual([7, null]);
  imgs.widen(keys(["a", "b", "c", "d", "e"]));
  expect([imgs.openKey(), imgs.galleryKeys().length]).toEqual(["/x/d.png", 5]);
  imgs.widen(keys(["z"]));
  expect(imgs.galleryKeys().length).toBe(5);
  imgs.pressKey("prev");
  imgs.applyKeys();
  expect(imgs.openKey()).toBe("/x/c.png");
  imgs.pressKey("close");
  imgs.applyKeys();
  expect(imgs.isOpen()).toBe(false);
});

test("decodes_a_normal_png", async () => {
  const { image, dims } = await decode("t.png", await png(64, 64), 384);
  expect(dims).toEqual([64, 64]);
  expect([image.width, image.height, image.data.length]).toEqual([64, 64, 64 * 64 * 4]);
});

test("refuses_huge_declared_dimensions_before_allocating", async () => {
  const b = await png(1, 1);
  b.writeUInt32BE(2 ** 26, 16);
  b.writeUInt32BE(2 ** 30, 20);
  b.writeUInt32BE(crc32(b.subarray(12, 29)), 29);
  await expect(decode("t.png", b, 384)).rejects.toThrow();
});

test("shrinks to the cap, keeps the original size and unmultiplied colours", async () => {
  const { image, dims } = await decodeBytes(await png(800, 400, 0.5), 100);
  expect(dims).toEqual([800, 400]);
  expect([image.width, image.height]).toEqual([100, 50]);
  const [r, g, b, a] = image.data;
  expect([r, g, b]).toEqual([255, 0, 0]);
  expect(a).toBeGreaterThan(120);
  expect(a).toBeLessThan(135);
});

test("reads jpeg, webp, gif and svg", async () => {
  const base = await png(40, 20, 1);
  for (const f of ["jpeg", "webp", "gif"] as const) {
    const bytes = await sharp(base)[f]().toBuffer();
    const { dims } = await decodeBytes(bytes, 384);
    expect(dims, f).toEqual([40, 20]);
  }
  const d = tmp("svg");
  writeFileSync(join(d, "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>');
  const { dims } = await decode(join(d, "a.svg"), null, 384);
  expect(dims[0]).toBeGreaterThanOrEqual(40);
});

test("a gif gives its first frame and a photo is turned upright", async () => {
  const frames = await sharp(Buffer.concat([await png(10, 10, 1), await png(10, 10, 1)]), { raw: { width: 10, height: 20, channels: 4 } })
    .gif({ loop: 0 })
    .toBuffer()
    .catch(() => null);
  if (frames) expect((await decodeBytes(frames, 384)).dims[0]).toBe(10);
  const sideways = await sharp(await png(30, 10, 1)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const { dims, image } = await decodeBytes(sideways, 384);
  expect(dims).toEqual([10, 30]);
  expect([image.width, image.height]).toEqual([10, 30]);
});

test("images_of_another_pcs_chat_come_from_that_pc", async () => {
  const imgs = new Images();
  const asked: string[] = [];
  const home = await png(40, 30);
  imgs.setSource({
    image: async (p) => {
      asked.push(p);
      return p === "/home-pc/uploads/1-photo.png" ? new Uint8Array(home) : null;
    },
    video: async () => null,
  });
  const a = await imgs.ready("/home-pc/uploads/1-photo.png");
  expect(a.state === "ready" && a.dims).toEqual([40, 30]);
  const b = await imgs.ready(imgs.midKey("/home-pc/uploads/1-photo.png"));
  expect(b.state === "ready" && b.dims).toEqual([40, 30]);
  expect(asked).toEqual(["/home-pc/uploads/1-photo.png"]);
  const gone = await imgs.ready("/home-pc/uploads/2-gone.png");
  expect(gone.state === "failed" && gone.error.includes("off")).toBe(true);
  const d = tmp("here");
  writeFileSync(join(d, "here.png"), await png(8, 8));
  const local = await imgs.ready(join(d, "here.png"));
  expect(local.state === "ready" && local.dims).toEqual([8, 8]);
  imgs.setSource(null);
  expect((await imgs.ready("/home-pc/uploads/3-other.png")).state).toBe("failed");
  expect(asked.length).toBe(3);
  expect(MID_PX).toBe(1280);
});

test("sizes and crops", () => {
  expect(inlineSize(900)).toEqual([480, 300]);
  expect(inlineSize(200)).toEqual([200, 300]);
  expect(cover([200, 100], [100, 100])).toEqual([0.25, 0, 0.75, 1]);
  expect(cover([100, 200], [100, 100])).toEqual([0, 0.25, 1, 0.75]);
});
