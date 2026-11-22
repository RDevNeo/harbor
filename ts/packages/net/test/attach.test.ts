import { expect, test } from "bun:test";
import { attachBefore, attachMeta, attachments, fileKind, fileSize, isAttachPath, stripAttachments } from "../src/attach.ts";

const KEPT = "/home/u/.local/share/harbor/uploads/12/files/0123456789abcdef0123/app-debug.apk";

test("a reply's attached files are read from its text alone", () => {
  const md = `Here it is:\n\n[app-debug.apk](${KEPT} "12345678 bytes")\n\nAnd [the notes](</d/uploads/-3/files/aaaaaaaaaaaaaaaaaaaa/release notes.pdf> "900 bytes") too.`;
  expect(attachments(md)).toEqual([
    { path: KEPT, name: "app-debug.apk", size: 12345678, end: 3 },
    { path: "/d/uploads/-3/files/aaaaaaaaaaaaaaaaaaaa/release notes.pdf", name: "release notes.pdf", size: 900, end: 5 },
  ]);
  // Each card goes after the blocks before its link: the first where its paragraph was, the second under its sentence.
  const [a, b] = attachments(md);
  expect(stripAttachments(attachBefore(md, a ?? { path: "", name: "", size: null }))).toBe("Here it is:");
  expect(attachBefore(md, b ?? { path: "", name: "", size: null })).toBe(md);
  // Not attachments: images, web links, other paths, code, a path that climbs out.
  expect(attachments(`![x](${KEPT})`)).toEqual([]);
  expect(attachments("[a](https://example.com/files/x.zip) [b](/tmp/files/x.zip)")).toEqual([]);
  expect(attachments(`\`[a](${KEPT})\``)).toEqual([]);
  expect(attachments("[a](/d/uploads/1/files/0123456789abcdef0123/../x)")).toEqual([]);
  // The same file twice is one card; no size said is null.
  expect(attachments(`[a](${KEPT}) [b](${KEPT})`)).toEqual([{ path: KEPT, name: "app-debug.apk", size: null, end: 1 }]);
});

test("a paragraph of attachment links alone is its cards; a link in a sentence stays", () => {
  const md = `Built it.\n\n[app-debug.apk](${KEPT} "5 bytes")\n\nInstall [it](${KEPT}) on the phone.\n`;
  expect(stripAttachments(md)).toBe(`Built it.\n\nInstall [it](${KEPT}) on the phone.`);
  expect(stripAttachments(`[a](${KEPT})`)).toBe("");
  expect(stripAttachments("no files")).toBe("no files");
  // In a list it stays (the bullet would be left empty).
  expect(stripAttachments(`- [a](${KEPT})`)).toBe(`- [a](${KEPT})`);
  expect(isAttachPath(KEPT)).toBe(true);
  expect(isAttachPath("C:\\Users\\u\\AppData\\harbor\\uploads\\4\\files\\0123456789abcdef0123\\a.zip")).toBe(true);
  expect(isAttachPath("/d/uploads/4/a.zip")).toBe(false);
});

test("a file card's line says its size and kind", () => {
  expect(fileKind("a.APK")).toBe("APK");
  expect(fileKind("b.tar.gz")).toBe("Archive");
  expect(fileKind("c.pdf")).toBe("PDF");
  expect(fileKind("d.bin")).toBe("BIN");
  expect(fileKind("README")).toBe("File");
  expect(fileSize(812)).toBe("812 B");
  expect(fileSize(14 * 1024)).toBe("14 KB");
  expect(fileSize(3.44 * 2 ** 20)).toBe("3.4 MB");
  expect(attachMeta({ path: KEPT, name: "x.apk", size: 13 * 2 ** 20 })).toBe("13 MB · APK");
  expect(attachMeta({ path: KEPT, name: "x.zip", size: null })).toBe("Archive");
});
