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
  expect(first.map((f) => [f.name, f.image, f.tile, f.number])).toEqual([
    ["pasted-1.png", true, true, 1],
    ["notes.txt", false, false, 0],
    ["shot.JPG", true, true, 2],
  ]);
  expect(first[0]?.thumb).toBe(noPixels);
  await tick();
  expect(loaded).toBe(2);
  const second = t.items(files);
  expect(second[0]?.thumb.width).toBe(8);
  expect(sameFile(first[0]!, second[0]!)).toBe(false);
  expect(sameFile(second[0]!, t.items(files)[0]!)).toBe(true);
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
  t.items(["/d/broken.png"]);
  await tick();
  expect(t.items(["/d/broken.png"])[0]).toMatchObject({ image: true, tile: false, number: 1 });
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
