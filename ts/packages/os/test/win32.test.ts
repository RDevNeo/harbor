// Windows' pieces that are plain code (formats, layouts, registry values), checked on any system.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { decodeCfHtml, decodeDib, decodeHdrop, decodePng, encodeCfHtml, encodeDib, encodeHdrop, encodePng, pathsOfUriList, uriListOfPaths } from "../src/win32/formats.ts";
import { plan } from "../src/win32/clipboard.ts";
import { command, isOn } from "../src/win32/login.ts";
import { toastXml } from "../src/win32/notify.ts";
import { fitRect } from "../src/win32/desktop.ts";
import { argvOf, shimTarget } from "../src/win32/shim.ts";
import { menuLabel, notifyIconData } from "../src/win32/tray.ts";
import { guid } from "../src/win32/gui.ts";

const px = (w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([(i * 37) & 255, (i * 11) & 255, (i * 5) & 255, i % 3 === 0 ? 128 : 255], i * 4);
  return out;
};

describe("PNG and DIB", () => {
  test("a PNG decodes to the pixels it was made of", () => {
    const rgba = px(7, 5);
    expect(decodePng(encodePng(rgba, 7, 5))).toEqual({ w: 7, h: 5, rgba });
  });

  test("a DIB keeps the pixels, bottom row first, BGRA", () => {
    const rgba = px(3, 2);
    const dib = encodeDib({ w: 3, h: 2, rgba });
    expect(dib.length).toBe(40 + 3 * 2 * 4);
    // First stored pixel: the bottom row's first (pixel 3), as B, G, R, A.
    expect([...dib.subarray(40, 44)]).toEqual([14, 13, 12, 15].map((i) => rgba[i] ?? -1));
    expect(decodeDib(dib)).toEqual({ w: 3, h: 2, rgba });
  });

  test("a 24-bit DIB with padded rows is opaque", () => {
    const head = Buffer.alloc(40);
    head.writeUInt32LE(40, 0);
    head.writeInt32LE(1, 4);
    head.writeInt32LE(-2, 8); // top-down
    head.writeUInt16LE(1, 12);
    head.writeUInt16LE(24, 14);
    const rows = Buffer.from([1, 2, 3, 0, 4, 5, 6, 0]); // BGR + 1 byte of padding each
    expect(decodeDib(new Uint8Array(Buffer.concat([head, rows])))).toEqual({ w: 1, h: 2, rgba: new Uint8Array([3, 2, 1, 255, 6, 5, 4, 255]) });
  });

  test("a 32-bit DIB with no alpha at all is opaque", () => {
    const rgba = px(2, 2).map((v, i) => (i % 4 === 3 ? 0 : v));
    const back = decodeDib(encodeDib({ w: 2, h: 2, rgba }));
    expect(back?.rgba.filter((_, i) => i % 4 === 3)).toEqual(new Uint8Array([255, 255, 255, 255]));
  });

  test("a palette PNG decodes through its palette", () => {
    const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.set([8, 3, 0, 0, 0], 8);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("PLTE", Buffer.from([10, 20, 30, 40, 50, 60])),
      chunk("tRNS", Buffer.from([0])),
      chunk("IDAT", deflateSync(Buffer.from([0, 1, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(decodePng(new Uint8Array(png))).toEqual({ w: 2, h: 1, rgba: new Uint8Array([40, 50, 60, 255, 10, 20, 30, 0]) });
  });
});

describe("HTML Format", () => {
  test("its offsets point at the fragment, in bytes", () => {
    const html = "<p>café ☕</p>";
    const b = Buffer.from(encodeCfHtml(html));
    const text = b.toString("latin1");
    const at = (k: string): number => Number(new RegExp(`${k}:(\\d+)`).exec(text)?.[1]);
    expect(b.toString("utf8", at("StartFragment"), at("EndFragment"))).toBe(html);
    expect(at("EndHTML")).toBe(b.length);
    expect(b.toString("utf8", at("StartHTML"), at("StartHTML") + 6)).toBe("<html>");
    expect(decodeCfHtml(b)).toBe(html);
  });
});

describe("files", () => {
  test("CF_HDROP round trip", () => {
    const paths = ["C:\\Users\\me\\a b.png", "D:\\x\\ü.txt"];
    expect(decodeHdrop(encodeHdrop(paths))).toEqual(paths);
  });

  test("uri-lists and Windows paths", () => {
    const paths = ["C:\\Users\\me\\a b#.png", "\\\\server\\share\\f.txt"];
    const list = uriListOfPaths(paths);
    expect(list).toBe("file:///C:/Users/me/a%20b%23.png\r\nfile://server/share/f.txt\r\n");
    expect(pathsOfUriList(`# comment\r\n${list}https://example.com/x\n`)).toEqual(paths);
  });
});

describe("clipboard plan", () => {
  const f = { png: 0xc001, html: 0xc002 };
  test("text, HTML, PNG with its bitmap, files; the first of each kind wins", () => {
    const png = encodePng(px(2, 2), 2, 2);
    const enc = new TextEncoder();
    const out = plan(
      [
        { mime: "text/plain;charset=utf-8", data: enc.encode("hi") },
        { mime: "UTF8_STRING", data: enc.encode("other") },
        { mime: "text/html", data: enc.encode("<b>hi</b>") },
        { mime: "image/png", data: png },
        { mime: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
        { mime: "text/uri-list", data: enc.encode("file:///C:/a.png\r\n") },
      ],
      f,
    );
    expect([...out.keys()]).toEqual([13, f.html, f.png, 8, 15]);
    expect(Buffer.from(out.get(13) ?? []).toString("utf16le")).toBe("hi\0");
    expect(out.get(f.png)).toBe(png);
    expect(decodeDib(out.get(8) ?? new Uint8Array())?.rgba).toEqual(px(2, 2));
    expect(decodeHdrop(out.get(15) ?? new Uint8Array())).toEqual(["C:\\a.png"]);
  });
});

describe("start at login", () => {
  test("the Run value, and Task Manager's off switch", () => {
    expect(command("C:\\Program Files\\Harbor\\harbor.exe", "--background")).toBe('"C:\\Program Files\\Harbor\\harbor.exe" --background');
    expect(isOn('"C:\\h.exe" --background', null, "--background")).toBe(true);
    expect(isOn('"C:\\h.exe" --background', new Uint8Array([2, 0, 0]), "--background")).toBe(true);
    expect(isOn('"C:\\h.exe" --background', new Uint8Array([3, 0, 0]), "--background")).toBe(false);
    expect(isOn('"C:\\h.exe"', null, "--background")).toBe(false);
    expect(isOn(null, null, "--background")).toBe(false);
  });
});

describe("tray and toasts", () => {
  test("NOTIFYICONDATAW's layout", () => {
    const d = notifyIconData(0x1234, 0x5678, "Harbor & co");
    expect(d.length).toBe(976);
    expect(d.readUInt32LE(0)).toBe(976);
    expect(d.readBigUInt64LE(8)).toBe(0x1234n);
    expect(d.readUInt32LE(16)).toBe(1);
    expect(d.readUInt32LE(20)).toBe(7);
    expect(d.readUInt32LE(24)).toBe(0x401);
    expect(d.readBigUInt64LE(32)).toBe(0x5678n);
    expect(d.toString("utf16le", 40, 40 + 22)).toBe("Harbor & co");
    expect(d.readUInt16LE(40 + 22)).toBe(0);
    expect(menuLabel("Save & quit")).toBe("Save && quit");
  });

  test("toast XML is escaped, silent unless it sounds", () => {
    expect(toastXml("A <b>", 'say "hi" & go', false)).toBe(
      '<toast><visual><binding template="ToastGeneric"><text>A &lt;b&gt;</text><text>say &quot;hi&quot; &amp; go</text></binding></visual><audio silent="true"/></toast>',
    );
    expect(toastXml("T", "", true)).toBe('<toast><visual><binding template="ToastGeneric"><text>T</text></binding></visual></toast>');
  });

  test("GUIDs in COM's byte order", () => {
    expect([...guid("50AC103F-D235-4598-BBEF-98FE4D1A3AD4")]).toEqual([0x3f, 0x10, 0xac, 0x50, 0x35, 0xd2, 0x98, 0x45, 0xbb, 0xef, 0x98, 0xfe, 0x4d, 0x1a, 0x3a, 0xd4]);
  });
});

describe("fitRect", () => {
  const work = { left: 0, top: 0, right: 1920, bottom: 1032 };
  test("a window that fits stays", () => {
    expect(fitRect({ left: 100, top: 50, right: 1500, bottom: 950 }, work)).toBeNull();
  });
  test("1400x900 at 150 % shrinks into the work area, centred", () => {
    const r = fitRect({ left: 200, top: 100, right: 2300, bottom: 1450 }, work);
    expect(r).toEqual({ left: 39, top: 21, right: 1882, bottom: 1012 });
  });
  test("one only off the edge keeps its size and is centred", () => {
    expect(fitRect({ left: 900, top: 0, right: 2300, bottom: 900 }, work)).toEqual({ left: 260, top: 66, right: 1660, bottom: 966 });
  });
  test("a second screen's work area is honoured", () => {
    const r = fitRect({ left: 1920, top: 0, right: 4020, bottom: 1350 }, { left: 1920, top: 0, right: 3840, bottom: 1080 });
    expect(r?.left).toBeGreaterThanOrEqual(1920);
    expect(r?.right).toBeLessThanOrEqual(3840);
  });
});

describe("npm shims", () => {
  // cmd-shim's output for a package's bin (npm 10), as codex.cmd has it.
  const NODE_SHIM = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    "",
  ].join("\r\n");
  test("a node script's shim names the script", () => {
    expect(shimTarget(NODE_SHIM)).toEqual({ target: "node_modules\\@openai\\codex\\bin\\codex.js", node: true });
  });
  test("a program's shim names the program", () => {
    expect(shimTarget('@ECHO off\r\n"%~dp0\\..\\tool\\bin\\tool.exe"   %*\r\n')).toEqual({ target: "..\\tool\\bin\\tool.exe", node: false });
  });
  test("anything else is no shim", () => {
    expect(shimTarget("@echo off\r\necho hi\r\n")).toBeNull();
  });
  test("argvOf: node and the script, or the program as it was", () => {
    const d = mkdtempSync(join(tmpdir(), "shim-"));
    try {
      mkdirSync(join(d, "node_modules", "@openai", "codex", "bin"), { recursive: true });
      writeFileSync(join(d, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
      // Windows' separators in the shim; this test runs anywhere, so its own separator is used.
      writeFileSync(join(d, "codex.cmd"), NODE_SHIM.replaceAll("\\node_modules\\@openai\\codex\\bin\\", `\\node_modules${sep}@openai${sep}codex${sep}bin${sep}`));
      const target = join(d, "node_modules", "@openai", "codex", "bin", "codex.js");
      expect(argvOf(join(d, "codex.cmd"), () => "/x/node")).toEqual(["/x/node", target]);
      expect(argvOf(join(d, "codex.cmd"), () => null)).toEqual([join(d, "codex.cmd")]);
      expect(argvOf(join(d, "codex.exe"), () => "/x/node")).toEqual([join(d, "codex.exe")]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
