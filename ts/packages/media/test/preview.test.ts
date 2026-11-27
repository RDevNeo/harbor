import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as preview from "../src/preview.ts";

const dir = mkdtempSync(join(tmpdir(), "harbor-preview-"));
const was = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = join(dir, "data");
afterAll(() => {
  if (was === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = was;
  rmSync(dir, { recursive: true, force: true });
});

/** A two-page PDF with plain (uncompressed) objects. */
function pdf(): string {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>", "<< /Type/Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const f = join(dir, "two.pdf");
  writeFileSync(f, out, "latin1");
  return f;
}

describe("previews of attached files", () => {
  test("a PDF's pages counted from its page objects, not its page tree", () => {
    expect(preview.countPages("<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page/Parent 2 0 R >>")).toBe(2);
    expect(preview.countPages("no pages here")).toBe(0);
  });

  test("a PDF's page count and first page (pdfinfo / pdftoppm where installed)", async () => {
    const f = pdf();
    expect(await preview.pdfPages(f)).toBe(2);
    const page = await preview.pdfPage(f, 120);
    if (Bun.which("pdftoppm")) expect(page !== null && existsSync(page)).toBe(true);
    else expect(page).toBeNull();
  });

  test("a video's length and still (ffprobe / ffmpeg where installed)", async () => {
    if (!Bun.which("ffmpeg") || !Bun.which("ffprobe")) return;
    const f = join(dir, "clip.mp4");
    const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2", "-pix_fmt", "yuv420p", f]);
    if (made.exitCode !== 0) return;
    const d = await preview.duration(f);
    expect(d).not.toBeNull();
    expect(Math.round(d!)).toBe(2);
    const still = await preview.still(f, 100);
    expect(still !== null && existsSync(still)).toBe(true);
    expect(await preview.still(f, 100)).toBe(still);
  });

  test("files that aren't media, or aren't there, have no length or still", async () => {
    const f = join(dir, "notes.txt");
    writeFileSync(f, "hello");
    expect(await preview.duration(f)).toBeNull();
    expect(await preview.still(join(dir, "missing.mp4"))).toBeNull();
    expect(await preview.pdfPages(join(dir, "missing.pdf"))).toBeNull();
  });
});
