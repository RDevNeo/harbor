import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as media from "@harbor/media";
import { MediaRows } from "../src/mediarows.ts";
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
