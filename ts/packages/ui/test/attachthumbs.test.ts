import { expect, test } from "bun:test";
import { AttachThumbs, sameFile } from "../src/attachthumbs.ts";
import type { Pixels } from "../src/logos.ts";
import { noPixels } from "../src/window.ts";

const pic = (w: number): Pixels => ({ width: w, height: w, data: new Uint8Array(w * w * 4) });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("images become numbered tiles showing their picture once decoded, other files stay chips", async () => {
  const asked: [string, number][] = [];
  let loaded = 0;
  const t = new AttachThumbs(
    (p, cap) => {
      asked.push([p, cap]);
      return Promise.resolve(pic(8));
    },
    () => void loaded++,
  );
  const files = ["/d/pastes/pasted-1.png", "/d/notes.txt", "/d/shot.JPG"];
  const first = t.items(files);
  expect(first.map((f) => [f.name, f.image, f.tile, f.number, f.slot])).toEqual([
    ["pasted-1.png", true, true, 1, 0],
    ["notes.txt", false, false, 0, 0],
    ["shot.JPG", true, true, 2, 1],
  ]);
  expect(first[0]?.thumb).toBe(noPixels);
  await tick();
  expect(loaded).toBe(2);
  const second = t.items(files);
  expect(second[0]?.thumb.width).toBe(8);
  expect(sameFile(first[0]!, second[0]!)).toBe(false);
  expect(sameFile(second[0]!, t.items(files)[0]!)).toBe(true);
  // Removing an earlier tile moves the surviving one, even though its pixels haven't changed.
  const moved = t.items(files.slice(1))[1]!;
  expect(moved.slot).toBe(0);
  expect(sameFile(second[2]!, { ...second[2]!, slot: moved.slot })).toBe(false);
  // Each picture is decoded once, small.
  expect(asked).toEqual([
    ["/d/pastes/pasted-1.png", AttachThumbs.CAP],
    ["/d/shot.JPG", AttachThumbs.CAP],
  ]);
});

test("an image that can't be decoded falls back to its chip; one no draft holds is let go", async () => {
  let calls = 0;
  const t = new AttachThumbs(
    () => {
      calls++;
      return Promise.reject(new Error("not an image"));
    },
    () => {},
  );
  const files = ["/d/notes.txt", "/d/broken.png", "/d/more.txt"];
  expect(t.items(files).map((f) => [f.tile, f.slot])).toEqual([[false, 0], [true, 0], [false, 1]]);
  await tick();
  const fallback = t.items(files);
  expect(fallback[1]).toMatchObject({ image: true, tile: false, number: 1 });
  expect(fallback.map((f) => f.slot)).toEqual([0, 1, 2]);
  t.keep([[]]);
  t.items(["/d/broken.png"]);
  expect(calls).toBe(2);
});

test("before the media package loads, images show blank tiles and are decoded later", async () => {
  let ready = false;
  const t = new AttachThumbs(
    () => (ready ? Promise.resolve(pic(4)) : null),
    () => {},
  );
  expect(t.items(["/d/a.png"])[0]).toMatchObject({ tile: true, thumb: noPixels });
  ready = true;
  t.items(["/d/a.png"]);
  await tick();
  expect(t.items(["/d/a.png"])[0]?.thumb.width).toBe(4);
});
