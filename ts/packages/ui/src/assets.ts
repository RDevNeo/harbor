// In a `bun build --compile` executable these imports aren't files on disk: they are written out
// once, to a folder named by their hash, and loaded from there (from source too).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import geistMedium from "../../../../assets/fonts/Geist-Medium.ttf" with { type: "file" };
import geistRegular from "../../../../assets/fonts/Geist-Regular.ttf" with { type: "file" };
import geistSemibold from "../../../../assets/fonts/Geist-SemiBold.ttf" with { type: "file" };
import geistMono from "../../../../assets/fonts/GeistMono-Regular.ttf" with { type: "file" };
import lucide from "../../../../assets/fonts/lucide.ttf" with { type: "file" };
import gallery from "../slint/gallery.slint" with { type: "file" };
import icons from "../slint/icons.slint" with { type: "file" };
import theme from "../slint/theme.slint" with { type: "file" };
import widgets from "../slint/widgets.slint" with { type: "file" };

export const FILES: Readonly<Record<string, string>> = {
  "gallery.slint": gallery,
  "icons.slint": icons,
  "theme.slint": theme,
  "widgets.slint": widgets,
  "fonts/Geist-Regular.ttf": geistRegular,
  "fonts/Geist-Medium.ttf": geistMedium,
  "fonts/Geist-SemiBold.ttf": geistSemibold,
  "fonts/GeistMono-Regular.ttf": geistMono,
  "fonts/lucide.ttf": lucide,
};

function base(env: Record<string, string | undefined>): string {
  return env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tmpdir();
}

export async function uiDir(env: Record<string, string | undefined> = process.env): Promise<string> {
  const blobs: [string, Uint8Array][] = [];
  const h = createHash("sha256");
  for (const [name, path] of Object.entries(FILES)) {
    const b = await Bun.file(path).bytes();
    blobs.push([name, b]);
    h.update(name).update(b);
  }
  const dir = join(base(env), `harbor-ui-${h.digest("hex").slice(0, 16)}`);
  if (existsSync(join(dir, ".complete"))) return dir;
  const tmp = `${dir}.${process.pid}`;
  mkdirSync(join(tmp, "fonts"), { recursive: true, mode: 0o700 });
  for (const [name, b] of blobs) writeFileSync(join(tmp, name), b);
  writeFileSync(join(tmp, ".complete"), "");
  try {
    renameSync(tmp, dir);
  } catch {
    // Another Harbor wrote the same folder first.
  }
  return dir;
}
