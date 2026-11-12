// Harbor's icon for Windows from packaging/harbor.svg: harbor.ico (16 to 256 px, PNG entries, for the
// executable and the Start menu) and harbor.png (256 px, the toasts' app icon, install.ps1 puts it beside
// harbor.exe); with --stamp, harbor.exe gets that icon and its version information (name, version) in its
// resources, which Bun can't set when it builds for Windows elsewhere:
//   bun scripts/winicon.ts OUTDIR [--stamp EXE --version V]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ResEdit from "resedit";
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

const EN_US = 1033;
const UNICODE = 1200;

/** "0.180.1" (or "v0.180.1-ts") as the four numbers Windows shows. */
export function versionParts(v: string): [number, number, number, number] {
  const n = v.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const at = (i: number): number => (Number.isFinite(n[i]) ? Math.min(65535, Math.max(0, n[i] ?? 0)) : 0);
  return [at(0), at(1), at(2), 0];
}

/**
 * The executable's resources. pe-library won't read them when a section other than .reloc follows .rsrc, as
 * Bun's ".bun" (its JavaScript) does: it can't tell what refers to such a section by address. Bun finds .bun
 * by its name in the section table, so .bun is hidden for the read only; writing the grown resources moves
 * .reloc and .bun along (their table entries and the image size are updated).
 */
function resourcesOf(pe: ResEdit.NtExecutable): ResEdit.NtExecutableResource {
  const sections = (pe as unknown as { _sections: { info: { name: string } }[] })._sections;
  if (!Array.isArray(sections)) throw new Error("pe-library changed: no section list to read past .bun");
  const at = sections.findIndex((x) => x.info.name === ".bun");
  if (at < 0) return ResEdit.NtExecutableResource.from(pe);
  const [bun] = sections.splice(at, 1);
  try {
    return ResEdit.NtExecutableResource.from(pe);
  } finally {
    if (bun) sections.splice(at, 0, bun);
  }
}

/**
 * Puts Harbor's icon (every icon group the executable has, else group 1) and version information into a
 * Windows executable's resources, in place. Bun's own payload (its ".bun" section) is kept as it is.
 */
export function stamp(exe: string, icoPath: string, version: string): void {
  const pe = ResEdit.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
  const res = resourcesOf(pe);
  const icons = ResEdit.Data.IconFile.from(readFileSync(icoPath)).icons.map((i) => i.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, EN_US, icons);
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
  const [a, b, c, d] = versionParts(version);
  const v = `${a}.${b}.${c}`;
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  info.lang = EN_US;
  info.setFileVersion(a, b, c, d, EN_US);
  info.setProductVersion(a, b, c, d, EN_US);
  info.replaceAvailableLanguages([{ lang: EN_US, codepage: UNICODE }]);
  info.setStringValues(
    { lang: EN_US, codepage: UNICODE },
    {
      FileDescription: "Harbor",
      ProductName: "Harbor",
      CompanyName: "Harbor",
      InternalName: "harbor",
      OriginalFilename: "harbor.exe",
      FileVersion: v,
      ProductVersion: v,
      LegalCopyright: "Harbor's authors",
    },
  );
  info.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  writeFileSync(exe, Buffer.from(pe.generate()));
}

if (import.meta.main) {
  const [out, ...rest] = process.argv.slice(2);
  const opt = (k: string): string | undefined => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const exe = opt("--stamp");
  const version = opt("--version");
  if (out === undefined || (exe !== undefined && version === undefined)) {
    console.error("usage: winicon.ts OUTDIR [--stamp EXE --version V]");
    process.exit(2);
  }
  const svg = join(dirname(new URL(import.meta.url).pathname), "..", "..", "packaging", "harbor.svg");
  const r = await writeIcons(svg, out);
  console.log(`${r.ico}\n${r.png}`);
  if (exe !== undefined && version !== undefined) {
    stamp(exe, r.ico, version);
    console.log(`${exe}: icon and version ${versionParts(version).join(".")}`);
  }
  process.exit(0);
}
