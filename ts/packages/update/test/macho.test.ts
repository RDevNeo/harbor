import { expect, test } from "bun:test";
import * as macho from "../src/macho.ts";

/** A 64-bit Mach-O header with one LC_ID_DYLIB and two LC_LOAD_DYLIB, each name with room for 64 bytes. */
function fake(id: string, links: string[]): Buffer {
  const cmds = [[0xd, id] as const, ...links.map((l) => [0xc, l] as const)];
  const size = 24 + 64;
  const b = Buffer.alloc(32 + cmds.length * size);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cmds.length, 16);
  b.writeUInt32LE(cmds.length * size, 20);
  cmds.forEach(([cmd, name], i) => {
    const off = 32 + i * size;
    b.writeUInt32LE(cmd, off);
    b.writeUInt32LE(size, off + 4);
    b.writeUInt32LE(24, off + 8);
    b.write(name, off + 24, "utf8");
  });
  return b;
}

test("a library's links and install name are read and changed in place", () => {
  const b = fake("/opt/x/libfoo.1.dylib", ["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/gettext/lib/libintl.8.dylib"]);
  expect(macho.id(b)).toBe("/opt/x/libfoo.1.dylib");
  expect(macho.links(b)).toEqual(["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/gettext/lib/libintl.8.dylib"]);
  expect(macho.changeLink(b, "/opt/homebrew/opt/gettext/lib/libintl.8.dylib", "@loader_path/libintl.8.dylib")).toBe(1);
  expect(macho.links(b)).toEqual(["/usr/lib/libSystem.B.dylib", "@loader_path/libintl.8.dylib"]);
  expect(macho.changeLink(b, "/nope", "/x")).toBe(0);
  expect(macho.changeId(b, "@rpath/libfoo.1.dylib")).toBe(true);
  expect(macho.id(b)).toBe("@rpath/libfoo.1.dylib");
  expect(b.length).toBe(32 + 3 * 88);
});

test("a name that doesn't fit, or a file that isn't 64-bit Mach-O, is refused", () => {
  const b = fake("/a", ["/b"]);
  expect(() => macho.changeLink(b, "/b", `/${"x".repeat(70)}`)).toThrow("doesn't fit");
  expect(() => macho.links(Buffer.from("\x7fELF............................"))).toThrow("not a 64-bit");
});
