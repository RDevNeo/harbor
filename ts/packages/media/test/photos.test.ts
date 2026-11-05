import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as p from "../src/photos.ts";

const prevData = process.env.XDG_DATA_HOME;
let data = "";

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "hphotos-"));
  process.env.XDG_DATA_HOME = data;
});

afterEach(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  rmSync(data, { recursive: true, force: true });
});

const jpeg = (w: number, h: number): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: "#3b6ea8" } }).jpeg().toBuffer();
const alpha = (img: { data: Uint8Array; width: number }, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

test("a photo comes out square and round: corners clear, middle solid", async () => {
  const img = await p.round(await jpeg(300, 200));
  expect(img?.width).toBe(p.SIZE);
  expect(img?.height).toBe(p.SIZE);
  expect(alpha(img!, 0, 0)).toBe(0);
  expect(alpha(img!, p.SIZE - 1, p.SIZE - 1)).toBe(0);
  expect(alpha(img!, p.SIZE / 2, p.SIZE / 2)).toBe(255);
});

test("what isn't an image is no photo", async () => {
  expect(await p.round(new TextEncoder().encode("not an image"))).toBeNull();
});

test("fetched once, then from the cache folder", async () => {
  const bytes = new Uint8Array(await jpeg(80, 80));
  let asked = 0;
  const fetcher = async () => {
    asked++;
    return bytes;
  };
  const url = "https://img.example/up/u1-1.jpg";
  expect(await p.load(url, fetcher)).not.toBeNull();
  expect(readdirSync(join(data, "harbor", "photos")).length).toBe(1);
  expect(await p.load(url, fetcher)).not.toBeNull();
  expect(asked).toBe(1);
});

test("the source answers at once, then draws again when the photo came; a failed one isn't asked again soon", async () => {
  let redraws = 0;
  let asked = 0;
  const get = p.source(
    () => redraws++,
    async (u) => {
      asked++;
      return u.endsWith("ok") ? new Uint8Array(await jpeg(40, 40)) : null;
    },
  );
  expect(get("https://img.example/ok")).toBeNull();
  expect(get("https://img.example/bad")).toBeNull();
  expect(get("")).toBeNull();
  await Bun.sleep(300);
  expect(redraws).toBe(1);
  expect(get("https://img.example/ok")).not.toBeNull();
  expect(get("https://img.example/bad")).toBeNull();
  expect(asked).toBe(2);
});

test("only HTTPS is fetched", async () => {
  expect(await p.fetchPhoto("http://img.example/a.jpg")).toBeNull();
});

test("made-up photos for shots are drawn, never fetched", async () => {
  const img = await p.load("https://photos.example/sam", async () => {
    throw new Error("fetched");
  });
  expect(img?.width).toBe(p.SIZE);
  expect(existsSync(join(data, "harbor", "photos"))).toBe(false);
});
