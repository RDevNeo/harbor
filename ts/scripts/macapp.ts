// Harbor.app for macOS from the single executable (build.ts single OUT --target darwin-arm64):
//   bun scripts/macapp.ts EXE OUTDIR --version V
// Contents/MacOS holds what ~/.local/lib/harbor holds on Linux (the executable, VERSION; install.sh adds
// .managed), so the updater swaps the runtime and the bundle there as it does on Linux. The executable is
// already signed ad hoc (Bun); the bundle isn't signed (no Apple Developer account yet: a `curl | sh`
// install isn't quarantined, so Gatekeeper doesn't stop it).
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { APP_ID } from "../packages/os/src/autostart.ts";

/** Below this macOS can't run it: Bun's executable and the libintl Slint's addon gets need 13. */
export const MIN_MACOS = "13.0";

const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function infoPlist(version: string): string {
  const v = xml(version.replace(/^v/, ""));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleName</key><string>Harbor</string>
  <key>CFBundleDisplayName</key><string>Harbor</string>
  <key>CFBundleExecutable</key><string>harbor</string>
  <key>CFBundleIconFile</key><string>harbor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${v}</string>
  <key>CFBundleVersion</key><string>${v}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSMicrophoneUsageDescription</key><string>Harbor records your voice to type what you say.</string>
</dict>
</plist>
`;
}

/** An .icns file of PNGs (128 to 1024 px) drawn from Harbor's SVG icon. */
export async function icns(svg: Uint8Array): Promise<Buffer> {
  const entries: Buffer[] = [];
  for (const [type, size] of [["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]] as const) {
    const png = await sharp(Buffer.from(svg), { density: Math.ceil((72 * size) / 512) * 2 }).resize(size, size).png().toBuffer();
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(png.length + 8, 4);
    entries.push(head, png);
  }
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Writes OUTDIR/Harbor.app; its path. */
export async function makeApp(exe: string, out: string, version: string, svgPath: string): Promise<string> {
  const app = join(out, "Harbor.app");
  const contents = join(app, "Contents");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  copyFileSync(exe, join(contents, "MacOS", "harbor"));
  chmodSync(join(contents, "MacOS", "harbor"), 0o755);
  writeFileSync(join(contents, "MacOS", "VERSION"), `${version.replace(/^v/, "")}\n`);
  writeFileSync(join(contents, "Resources", "harbor.icns"), await icns(await Bun.file(svgPath).bytes()));
  writeFileSync(join(contents, "Info.plist"), infoPlist(version));
  writeFileSync(join(contents, "PkgInfo"), "APPL????");
  return app;
}

if (import.meta.main) {
  const [exe, out, ...rest] = process.argv.slice(2);
  const at = rest.indexOf("--version");
  const version = at >= 0 ? rest[at + 1] : undefined;
  if (exe === undefined || out === undefined || version === undefined) {
    console.error("usage: macapp.ts EXE OUTDIR --version V");
    process.exit(2);
  }
  const svg = join(dirname(new URL(import.meta.url).pathname), "..", "..", "packaging", "harbor.svg");
  console.log(await makeApp(exe, out, version, svg));
  process.exit(0);
}
