import type { BlockImage } from "./logic/settings-blocks.ts";

/** The modules of a QR code (row by row, 1 dark) as RGBA pixels: black on white with a quiet zone, as devices.rs `qr_image` draws it. */
export function qrPixels(size: number, modules: Uint8Array, quiet = 4, scale = 6): BlockImage {
  const side = (size + 2 * quiet) * scale;
  const data = new Uint8Array(side * side * 4).fill(255);
  for (let i = 0; i < size * size; i++) {
    if (modules[i] !== 1) continue;
    const mx = (i % size) + quiet;
    const my = Math.floor(i / size) + quiet;
    for (let y = my * scale; y < (my + 1) * scale; y++) {
      for (let x = mx * scale; x < (mx + 1) * scale; x++) {
        const o = (y * side + x) * 4;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
      }
    }
  }
  return { width: side, height: side, data };
}

const blank = (): BlockImage => ({ width: 1, height: 1, data: new Uint8Array(4).fill(255) });

/** The QR encoder: the `qrcode` package, loaded when a code is first drawn. A text that doesn't fit gives a white pixel, as in Rust. */
export async function loadQr(): Promise<(text: string) => BlockImage> {
  const { default: QRCode } = await import("qrcode");
  return (text) => {
    try {
      const q = QRCode.create(text, { errorCorrectionLevel: "M" });
      return qrPixels(q.modules.size, q.modules.data);
    } catch {
      return blank();
    }
  };
}
