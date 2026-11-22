import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachments } from "../../net/src/attach.ts";
import * as f from "../src/files.ts";
import { uploadsDir } from "../src/media.ts";

const dirs: string[] = [];
const prevData = process.env.XDG_DATA_HOME;

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `hfiles-${name}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.XDG_DATA_HOME = tmp("data");
});

afterEach(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a reply's link to a local file is kept in its chat and names the copy", async () => {
  const proj = tmp("proj");
  mkdirSync(join(proj, "dist"));
  writeFileSync(join(proj, "dist/app-debug.apk"), "APK!");
  writeFileSync(join(proj, "out.zip"), "zip");
  writeFileSync(join(proj, "main.ts"), "code");
  const abs = join(proj, "dist/app-debug.apk");
  const md = `Done: [app-debug.apk](${abs}) and [the zip](out.zip).\n\nSee [main.ts](main.ts), [x](https://e.com/a.zip), [gone](/nope/a.zip), ![i](a.png).`;
  const out = f.adoptFiles(md, proj, 7);
  const att = attachments(out);
  expect(att.map((a) => [a.name, a.size])).toEqual([
    ["app-debug.apk", 4],
    ["out.zip", 3],
  ]);
  for (const a of att) {
    expect(a.path.startsWith(join(uploadsDir(), "7", "files"))).toBe(true);
    expect(f.servable(a.path)).toBe(true);
  }
  // The link keeps its label; everything else is as written.
  expect(out).toContain("[the zip](");
  expect(out).toContain("See [main.ts](main.ts), [x](https://e.com/a.zip), [gone](/nope/a.zip), ![i](a.png).");
  // The copy is made in the background, and outlives the file.
  expect(await f.fileWait(att[0]?.path ?? "")).toBe(true);
  rmSync(abs);
  expect(readFileSync(att[0]?.path ?? "", "utf8")).toBe("APK!");
  // Adopted again, it's as it is.
  expect(f.adoptFiles(out, proj, 7)).toBe(out);
});

test("private, missing, image and too large files aren't attached", () => {
  const home = tmp("home");
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh/id.zip"), "k");
  writeFileSync(join(home, "a.png"), "p");
  for (const p of [join(home, ".ssh/id.zip"), join(home, "a.png"), join(home, "none.zip"), home]) expect(f.adoptFiles(`[x](${p})`, null, 1)).toBe(`[x](${p})`);
  expect(f.localTarget("../outside.zip", home)).toBeNull();
  expect(f.localTarget("mailto:a@b.c", home)).toBeNull();
  expect(f.localTarget("#top", home)).toBeNull();
  expect(f.localTarget("file:///tmp/a%20b.zip", null)).toBe("/tmp/a b.zip");
  expect(f.MAX_FILE).toBe(200 * 2 ** 20);
});

test("only kept copies are served", () => {
  const up = uploadsDir();
  expect(f.servable(join(up, "3", "files", "0123456789abcdef0123", "a.apk"))).toBe(true);
  expect(f.servable(join(up, "3", "a.apk"))).toBe(false);
  expect(f.servable(join(up, "3", "files", "0123456789abcdef0123", "..", "..", "x"))).toBe(false);
  expect(f.servable("/etc/passwd")).toBe(false);
});

test("a download never overwrites a file in Downloads", async () => {
  const proj = tmp("proj2");
  writeFileSync(join(proj, "app.apk"), "new");
  const kept = attachments(f.adoptFiles(`[app.apk](${join(proj, "app.apk")})`, null, 2))[0]?.path ?? "";
  const dl = tmp("dl");
  writeFileSync(join(dl, "app.apk"), "old");
  const to = await f.saveTo(dl, kept, "app.apk", null);
  expect(to).toBe(join(dl, "app (1).apk"));
  expect(readFileSync(to, "utf8")).toBe("new");
  expect(readFileSync(join(dl, "app.apk"), "utf8")).toBe("old");
  // Another PC's file comes part by part.
  const parts = [Buffer.from("ab"), Buffer.from("cd")];
  const got = await f.saveTo(dl, "/elsewhere/uploads/9/files/0123456789abcdef0123/r.zip", "r.zip", async (from) => ({ body: parts[from / 2] ?? Buffer.alloc(0), total: 4 }));
  expect(readFileSync(got, "utf8")).toBe("abcd");
  await expect(f.saveTo(dl, "/elsewhere/x", "x.zip", null)).rejects.toThrow();
});
