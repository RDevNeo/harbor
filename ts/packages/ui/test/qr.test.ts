import { describe, expect, test } from "bun:test";
import { qrPixels } from "../src/qr.ts";

describe("devices.rs qr_image", () => {
  test("draws_dark_modules_black_on_white_with_a_quiet_zone", () => {
    const img = qrPixels(2, new Uint8Array([1, 0, 0, 1]), 1, 2);
    expect([img.width, img.height]).toEqual([8, 8]);
    const at = (x: number, y: number) => [...img.data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(2, 2)).toEqual([0, 0, 0, 255]);
    expect(at(3, 3)).toEqual([0, 0, 0, 255]);
    expect(at(4, 2)).toEqual([255, 255, 255, 255]);
    expect(at(4, 4)).toEqual([0, 0, 0, 255]);
    expect(at(7, 7)).toEqual([255, 255, 255, 255]);
  });

  test("the_default_is_four_modules_of_quiet_and_six_pixels_a_module", () => {
    const img = qrPixels(21, new Uint8Array(21 * 21));
    expect(img.width).toBe((21 + 8) * 6);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });
});
