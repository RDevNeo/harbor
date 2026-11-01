import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as media from "@harbor/media";
import { inlineCap, MediaRows } from "../src/mediarows.ts";
import { VIDEO_KEYS } from "../src/videopane.ts";

const dir = mkdtempSync(join(tmpdir(), "hvid-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a reply naming a video shows a dark card the size Rust gives it until its poster comes, also when it never does", async () => {
  const file = join(dir, "clip.mp4");
  writeFileSync(file, new Uint8Array(4096).fill(7));
  let loads = 0;
  const rows = new MediaRows(media, () => void loads++);
  const card = { kind: "text" as const, text: `Here it is: ${file}`, at: 1, forkable: false };
  const first = rows.rows(card, dir, 900);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ video: true, large: true, name: "clip.mp4", path: file, w: 360, h: 203 });
  expect(first[0]?.image.width).toBeLessThanOrEqual(1);
  for (let i = 0; i < 100 && loads === 0; i++) await Bun.sleep(20);
  expect(loads).toBe(1);
  expect(rows.rows(card, dir, 900)[0]).toMatchObject({ video: true, w: 360, h: 203 });
  expect(rows.rows(card, dir, 200)[0]).toMatchObject({ w: 200, h: 113 });
});

test("the viewer's keys are video.rs `take_keys`: Space, the arrows, M, F, Esc, Page Up and Down", () => {
  expect(VIDEO_KEYS[" "]).toBe("space");
  expect(VIDEO_KEYS["\u{f72c}"]).toBe("pageUp");
  expect(VIDEO_KEYS["\u{f72d}"]).toBe("pageDown");
  expect([VIDEO_KEYS.f, VIDEO_KEYS.F, VIDEO_KEYS.m, VIDEO_KEYS.M]).toEqual(["f", "f", "m", "m"]);
  expect(VIDEO_KEYS.Escape).toBe("escape");
  expect(VIDEO_KEYS.q).toBeUndefined();
});

test("only the images of the cards last built stay decoded; one let go while decoding isn't kept", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const [a, b, c] = ["a.png", "b.png", "c.png"].map((n) => join(dir, n)) as [string, string, string];
  for (const f of [a, b, c]) writeFileSync(f, png);
  let loads = 0;
  const rows = new MediaRows(media, () => void loads++);
  const card = (f: string) => ({ kind: "text" as const, text: `![shot](${f})`, at: 1, forkable: false });
  const settle = async (n: number) => {
    for (let i = 0; i < 100 && loads < n; i++) await Bun.sleep(20);
  };
  expect(rows.rows(card(a), dir, 760)).toHaveLength(0);
  rows.sweep();
  await settle(1);
  expect(rows.rows(card(a), dir, 760)).toHaveLength(1);
  rows.sweep();
  // A build without `a`'s card lets it go: shown again, it's decoded again.
  rows.rows(card(b), dir, 760);
  rows.sweep();
  await settle(2);
  expect(rows.rows(card(a), dir, 760)).toHaveLength(0);
  rows.sweep();
  await settle(3);
  expect(loads).toBe(3);
  // `c` starts decoding, then two builds pass without it: its result is dropped and nobody is told.
  rows.rows(card(c), dir, 760);
  rows.sweep();
  rows.sweep();
  await Bun.sleep(300);
  expect(loads).toBe(3);
});

test("a large image is decoded to the width it's drawn at, in the screen's pixels", () => {
  expect(inlineCap(760, 1, 1280)).toBe(480);
  expect(inlineCap(760, 1.25, 1280)).toBe(600);
  expect(inlineCap(760, 2, 1280)).toBe(960);
  expect(inlineCap(760, 4, 1280)).toBe(1280);
  expect(inlineCap(300, 1, 1280)).toBe(300);
  expect(inlineCap(760, Number.NaN, 1280)).toBe(960);
});
