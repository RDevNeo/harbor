// Harbor's icon for Windows from packaging/harbor.svg: harbor.ico (16 to 256 px, PNG entries, for the
// executable and the Start menu) and harbor.png (256 px, the toasts' app icon, install.ps1 puts it beside
// harbor.exe):
//   bun scripts/winicon.ts OUTDIR
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

export async function png(svg: Uint8Array, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 512) * 4) }).resize(size, size).png().toBuffer();
}

/** An .ico of PNG images (Windows Vista and later read those at every size). */
export function ico(images: readonly { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((im, i) => {
    const e = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, e); // 0 means 256
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, e + 1);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(im.png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += im.png.length;
  });
  return Buffer.concat([head, dir, ...images.map((im) => im.png)]);
}

export async function writeIcons(svgPath: string, out: string): Promise<{ ico: string; png: string }> {
  const svg = await Bun.file(svgPath).bytes();
  const images = await Promise.all(SIZES.map(async (size) => ({ size, png: await png(svg, size) })));
  const icoPath = join(out, "harbor.ico");
  const pngPath = join(out, "harbor.png");
  writeFileSync(icoPath, ico(images));
  writeFileSync(pngPath, images[images.length - 1]?.png ?? Buffer.alloc(0));
  return { ico: icoPath, png: pngPath };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error("usage: winicon.ts OUTDIR");
    process.exit(2);
  }
  const svg = join(dirname(new URL(import.meta.url).pathname), "..", "..", "packaging", "harbor.svg");
  const r = await writeIcons(svg, out);
  console.log(`${r.ico}\n${r.png}`);
  process.exit(0);
}
