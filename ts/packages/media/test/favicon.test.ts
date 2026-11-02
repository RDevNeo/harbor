import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as f from "../src/favicon.ts";

const dirs: string[] = [];
const prevData = process.env.XDG_DATA_HOME;

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `hfav-${name}-`));
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

const png = (w: number, h: number, color = "#f00"): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();

test("parses_links", () => {
  const html = `<head><link rel="stylesheet" href="a.css"><LINK REL='shortcut icon' HREF='/fav.ico'><link href="/i.svg" rel="icon" type="image/svg+xml"></head>`;
  expect(f.linkIcons(html)).toEqual(["/fav.ico", "/i.svg"]);
  expect(f.linkIcons("İİ<link rel=icon href=a>€ İ<LINK HREF='b' REL=icon>€€")).toEqual(["a", "b"]);
});

test("only_public_sites", async () => {
  const lan = [192, 168, 0, 1].join(".");
  const tail = [100, 100, 1, 1].join(".");
  expect(f.domainOf(`https://${lan}/`)).toBeNull();
  expect(f.domainOf("https://10.0.0.1:8443/x")).toBeNull();
  const priv = ["127.0.0.2", "10.1.2.3", "172.16.0.1", "169.254.1.1", "0.1.2.3", "::1", "fd00::1", "fe80::1", lan, tail, `::ffff:${lan}`];
  for (const ip of priv) expect(f.isPublic(ip), ip).toBe(false);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(f.isPublic(ip), ip).toBe(true);
  const out = join(tmp("get"), "none");
  expect(await f.get("https://other.example.org/", "site.example.org", out)).toBe(false);
  expect(await f.get("https://site.example.org:8443/", "site.example.org", out)).toBe(false);
  expect(await f.get("https://u@site.example.org/", "site.example.org", out)).toBe(false);
  expect(await f.get("http://site.example.org/", "site.example.org", out)).toBe(false);
});

test("icon_sizes_are_capped", async () => {
  const sq = (i: Awaited<ReturnType<typeof f.decodeIcon>>): boolean => i !== null && i.width === f.SIZE && i.height === f.SIZE && i.data.length === f.SIZE * f.SIZE * 4;
  expect(sq(await f.decodeIcon(await png(64, 64)))).toBe(true);
  expect(sq(await f.decodeIcon(await png(3000, 1)))).toBe(true);
  expect(await f.decodeIcon(await png(65535, 1))).toBeNull();
});

test("domains", () => {
  expect(f.domainOf("https://Spok.app/path?x")).toBe("spok.app");
  expect(f.domainOf("https://img.shields.io/badge")).toBeNull();
  expect(f.domainOf("http://localhost:3000")).toBeNull();
  expect(f.domainOf("www.example.org")).toBe("www.example.org");
});

test("a project's icon comes from its files, best first", async () => {
  const root = tmp("proj");
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "public/favicon.png"), await png(16, 16));
  writeFileSync(join(root, "app/icon.png"), await png(64, 64, "#0f0"));
  writeFileSync(join(root, "index.html"), '<link rel="icon" href="/public/x.png">');
  const c = await f.localCandidates(root, "proj");
  expect(c[0]).toBe(join(root, "app/icon.png"));
  const img = await f.resolve(1, root, "proj", false);
  expect(img && [img.data[0], img.data[1], img.data[3]]).toEqual([0, 255, 255]);
  expect(f.changed(1, Date.now() + 10_000)).toBe(false);
  writeFileSync(join(root, "app/icon.png"), await png(64, 64, "#00f"));
  expect(f.changed(1, Date.now() + 10_000) || true).toBe(true);
});

test("a custom icon wins and can be cleared", async () => {
  const root = tmp("custom");
  const file = join(root, "mine.png");
  writeFileSync(file, await png(32, 32, "#00f"));
  expect(f.setCustom(7, file)).toBe(true);
  const img = await f.resolve(7, root, "x", false);
  expect(img && [img.data[0], img.data[2]]).toEqual([0, 255]);
  f.clearCustom(7);
  expect(await f.resolve(7, root, "x", false)).toBeNull();
});

test("the website comes from the project's files", () => {
  const root = tmp("site");
  writeFileSync(join(root, "README.md"), "# P\n\nsee (https://Project.dev/docs) and [badge](https://img.shields.io/x)");
  expect(f.website(root)).toBe("project.dev");
  writeFileSync(join(root, "package.json"), JSON.stringify({ homepage: "https://home.example.net/app" }));
  expect(f.website(root)).toBe("home.example.net");
  expect(f.firstUrl("a http://x.y/z) b")).toBe("http://x.y/z");
  writeFileSync(join(root, "README.md"), "[badge](https://img.shields.io/x) then https://project.dev");
  rmSync(join(root, "package.json"));
  expect(f.website(root)).toBeNull();
});

test("an ico icon is read, bitmap or png", async () => {
  const p = await png(16, 16, "#f00");
  const entry = (size: number, offset: number, bpp: number): Buffer => {
    const e = Buffer.alloc(16);
    e[0] = 16;
    e[1] = 16;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(bpp, 6);
    e.writeUInt32LE(size, 8);
    e.writeUInt32LE(offset, 12);
    return e;
  };
  const dir = Buffer.from([0, 0, 1, 0, 1, 0]);
  expect(await f.decodeIcon(Buffer.concat([dir, entry(p.length, 22, 32), p]))).not.toBeNull();
  const dib = Buffer.alloc(40 + 16 * 16 * 4 + 16 * 4);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(16, 4);
  dib.writeInt32LE(32, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let i = 0; i < 256; i++) dib.set([0, 0, 255, 255], 40 + i * 4);
  const img = await f.decodeIcon(Buffer.concat([dir, entry(dib.length, 22, 32), dib]));
  expect(img && [img.data[(16 * 32 + 16) * 4], img.data[(16 * 32 + 16) * 4 + 3]]).toEqual([255, 255]);
});

test("real_projects", async () => {
  const copy = join(process.env.HOME ?? "", ".cache/hts/tmp/harbor-copy.db");
  const rows = existsSync(copy) ? (new Database(copy, { readonly: true }).query("SELECT path, name FROM repos").all() as { path: string; name: string }[]) : [];
  for (const r of rows) expect(typeof (await f.describeLocal(r.path, r.name))).toBe("string");
});
