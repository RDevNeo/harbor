import { expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import * as slint from "slint-ui";
import { pixels } from "../src/logos.ts";
import { noPixels } from "../src/window.ts";

const protectedNow = (): number => {
  Bun.gc(true);
  return heapStats().protectedObjectCount;
};

// A window needs a display (the build machines have none): the Pixels type (Uint8ClampedArray) is the guard there.
const display = !!(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

test.skipIf(!display)("images handed to the window leave nothing protected behind, however often they're read", () => {
  const ui = slint.loadSource(`export component T inherits Window { in-out property <image> img; in property <[{i: image}]> rows; }`, "imageleak.slint") as unknown as {
    T: new () => { img: unknown; rows: unknown };
  };
  const t = new ui.T();
  const logo = pixels(new Uint8Array(48 * 48));
  const before = protectedNow();
  for (let i = 0; i < 200; i++) {
    t.img = noPixels;
    t.img = logo;
    t.rows = new slint.ArrayModel([{ i: noPixels }, { i: logo }]);
  }
  // slint-ui reads a plain Uint8Array's pixels through a failed Uint8ClampedArray conversion that leaves an N-API
  // reference behind: one protected object per read, never let go. Clamped pixels (logos.ts `Pixels`) leave none.
  expect(protectedNow() - before).toBeLessThan(10);
  t.img = { width: 1, height: 1, data: new Uint8Array(4) };
  expect(protectedNow() - before).toBeGreaterThan(0);
});
