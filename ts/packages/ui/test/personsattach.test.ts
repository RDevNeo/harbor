import { describe, expect, test } from "bun:test";
import { attachMeta, attachType, attachTypeOf, extOf, lengthText, sizeText } from "../src/tabs/persons/attachkind.ts";
import { needsStill, restFiles } from "../src/tabs/persons/view.ts";

describe("the composer's attachment tiles", () => {
  test("each file's kind by its extension, any case", () => {
    const kinds = (names: string[]): string[] => names.map((n) => attachType(n).kind);
    expect(kinds(["a.JPG", "b.png", "c.webp", "d.gif", "e.avif", "f.svg", "g.bmp", "h.HEIC"])).toEqual(Array(8).fill("image"));
    expect(kinds(["/x/screenrecording-2026-11-27_12-19-33.mp4", "a.mov", "a.mkv", "a.webm", "a.avi", "a.mpv"])).toEqual(Array(6).fill("video"));
    expect(kinds(["a.mp3", "a.ogg", "a.opus", "a.wav", "a.m4a", "a.flac"])).toEqual(Array(6).fill("audio"));
    expect(kinds(["contract.PDF"])).toEqual(["pdf"]);
    expect(kinds(["a.docx", "a.xlsx", "a.csv", "a.txt", "a.zip", "a.apk", "README", ".bashrc"])).toEqual(Array(8).fill("file"));
  });

  test("pictures sharp reads go straight to the decoder; BMP and HEIC through ffmpeg", () => {
    expect(attachType("a.jpeg").direct).toBe(true);
    expect(attachType("a.bmp").direct).toBe(false);
    expect(attachType("a.heic").direct).toBe(false);
  });

  test("other files get their type's icon, colour and extension", () => {
    expect(attachType("report.docx")).toMatchObject({ icon: "FILE_TEXT", ext: "DOCX" });
    expect(attachType("app-release.apk")).toMatchObject({ icon: "SMARTPHONE", ext: "APK" });
    expect(attachType("files.zip")).toMatchObject({ icon: "ARCHIVE", ext: "ZIP" });
    expect(attachType("sheet.xlsx").tint).not.toBe(attachType("report.docx").tint);
    expect(attachType("noext")).toMatchObject({ icon: "FILE", ext: "" });
    expect(extOf("C:\\Users\\me\\a.Tar.GZ")).toBe("gz");
  });

  test("sizes and lengths as people read them", () => {
    expect(sizeText(980)).toBe("980 B");
    expect(sizeText(812 * 1024)).toBe("812 KB");
    expect(sizeText(12.34 * 1024 * 1024)).toBe("12 MB");
    expect(sizeText(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(sizeText(1000 * 1024)).toBe("1.0 MB");
    expect(lengthText(7.4)).toBe("0:07");
    expect(lengthText(272)).toBe("4:32");
    expect(lengthText(3725)).toBe("1:02:05");
  });

  test("the line under the name: type, length or pages, size, each when known", () => {
    expect(attachMeta(attachType("a.mp4"), { size: 2.5 * 1024 * 1024, duration: 42 })).toBe("MP4 · 0:42 · 2.5 MB");
    expect(attachMeta(attachType("a.pdf"), { size: 812 * 1024, pages: 3 })).toBe("PDF · 3 pages · 812 KB");
    expect(attachMeta(attachType("a.pdf"), { pages: 1 })).toBe("PDF · 1 page");
    expect(attachMeta(attachType("a.mp3"), { size: null, duration: null })).toBe("MP3");
  });
});

describe("files in the chat's bubbles", () => {
  test("a received file without an extension gets its type from its MIME type", () => {
    expect(attachTypeOf("comprovante", "application/pdf").kind).toBe("pdf");
    expect(attachTypeOf("comprovante", "application/pdf").ext).toBe("PDF");
    expect(attachTypeOf("planilha", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").ext).toBe("XLSX");
    expect(attachTypeOf("a.pdf", "application/octet-stream").kind).toBe("pdf");
    expect(attachTypeOf("x", null).kind).toBe("file");
  });

  test("file cards: every file that isn't a picture, a video or the bubble's audio", () => {
    const f = (name: string, kind: string, o: Record<string, unknown> = {}) => ({ name, url: `/f/${name}`, raw: name, type: null, size: 1, width: null, height: null, kind, image: kind === "image", video: kind === "video", duration: null, ...o });
    const files = [f("a.jpg", "image"), f("b.mp4", "video"), f("c.ogg", "audio"), f("d.pdf", "file"), f("e.mp3", "audio"), f("f.zip", "file")];
    expect(restFiles({ files, voice: false }).map((x) => x.name)).toEqual(["d.pdf", "e.mp3", "f.zip"]);
    expect(needsStill("IMG_1.HEIC")).toBe(true);
    expect(needsStill("photo", "image/heic")).toBe(true);
    expect(needsStill("a.jpg")).toBe(false);
    expect(needsStill("a.pdf")).toBe(false);
  });
});
