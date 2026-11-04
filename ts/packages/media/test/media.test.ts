import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as m from "../src/media.ts";

const dirs: string[] = [];
const prevData = process.env.XDG_DATA_HOME;

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `hmedia-${name}-`));
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

const PNG = Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1");
const MP4 = Buffer.from("\0\0\0\x18ftypmp42\0\0\0\0", "latin1");

test("finds_markdown_images_outside_code", () => {
  const md = 'Here ![The chart](out/chart.png) and `![no](x.png)`\n\n```\n![no](y.png)\n```\n![](<a b.mp4> "t")';
  expect(m.refs(md)).toEqual([["The chart", "out/chart.png"], ["", "a b.mp4"]]);
  expect(m.stripRefs("a ![c](x.png) b ![l](logo)")).toBe("a  b ![l](logo)");
  expect(m.stripRefs("no images")).toBe("no images");
});

test("cuts_a_reply_at_its_images", () => {
  const md = "The chart:\n\n![Chart](out/c.png)\n\nAnd ![inline](x.png) in a line.\n\n- ![in a list](l.png)\n\n![a](a.png)\n![b](b.mp4)\n\nEnd.";
  const t = (text: string): m.Part => ({ type: "text", text });
  const v = (text: string): m.Part => ({ type: "media", text });
  expect(m.parts(md)).toEqual([
    t("The chart:\n\n"),
    v("![Chart](out/c.png)\n"),
    t("\nAnd ![inline](x.png) in a line.\n\n- ![in a list](l.png)\n\n"),
    v("![a](a.png)\n![b](b.mp4)\n"),
    t("\nEnd."),
  ]);
  expect(m.parts("no images")).toEqual([t("no images")]);
  expect(m.parts("![only](a.png)")).toEqual([v("![only](a.png)")]);
  expect(m.parts("![logo](logo)")).toEqual([t("![logo](logo)")]);
  expect(m.parts("[![c](a.png)](https://x.y)")).toEqual([t("[![c](a.png)](https://x.y)")]);
});

test("resolves_paths_and_urls", () => {
  const d = tmp("resolve");
  mkdirSync(join(d, "out"));
  writeFileSync(join(d, "out/a.png"), PNG);
  const abs = join(d, "out/a.png");
  expect(m.resolve("out/a.png", d)?.[0]).toBe(abs);
  expect(m.resolve("./out/../out/a.png", d)?.[0]).toBe(abs);
  expect(m.resolve(`file://${abs.replaceAll(" ", "%20")}`, null)?.[0]).toBe(abs);
  expect(m.resolve(abs, null)?.[0]).toBe(abs);
  expect(m.resolve("../../etc/x.png", d)).toBeNull();
  expect(m.resolve("out/a.png", null)).toBeNull();
  const web = m.resolve("https://example.com/a/b.webp?x=1", null);
  expect(web?.[0].endsWith(".webp") && web[1] === "https://example.com/a/b.webp?x=1").toBe(true);
  expect(m.resolve("http://example.com/b.png", null)).toBeNull();
  expect(m.resolve("data:image/png;base64,AAAA", null)).toBeNull();
  expect(m.resolve("/home/x/.ssh/id.png", null)).toBeNull();
  expect(m.resolve(join(d, "notes.txt"), null)).toBeNull();
  symlinkSync("/etc", join(d, "etc"));
  expect(m.resolve("etc/x.png", d) === null || !existsSync(join(d, "etc/x.png"))).toBe(true);
});

test("checks_type_contents_and_size", () => {
  const d = tmp("check");
  writeFileSync(join(d, "a.png"), PNG);
  writeFileSync(join(d, "v.mp4"), MP4);
  writeFileSync(join(d, "fake.png"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  writeFileSync(join(d, "pic.svg"), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(d, "v.webm"), PNG);
  expect(m.check(join(d, "a.png"))).toEqual({ ok: true, video: false });
  expect(m.check(join(d, "v.mp4"))).toEqual({ ok: true, video: true });
  expect(m.check(join(d, "pic.svg"))).toEqual({ ok: true, video: false });
  expect(m.check(join(d, "fake.png")).ok).toBe(false);
  expect(m.check(join(d, "v.webm")).ok).toBe(false);
  expect(m.check(join(d, "missing.png")).ok).toBe(false);
  expect(m.check(d).ok).toBe(false);
  const fd = openSync(join(d, "big.png"), "w");
  ftruncateSync(fd, m.MAX_IMAGE + 1);
  closeSync(fd);
  const big = m.check(join(d, "big.png"));
  expect(!big.ok && big.error.includes("too large")).toBe(true);
});

test("a_kept_file_shows_after_it_is_gone", () => {
  const d = tmp("keep");
  const shot = join(d, "shot.png");
  writeFileSync(shot, PNG);
  expect(m.keepOne(shot)).toBeNull();
  expect(m.located(shot)).toBe(shot);
  rmSync(shot);
  const kept = m.located(shot);
  expect(kept.startsWith(m.cacheDir()) && kept !== shot).toBe(true);
  expect(m.check(shot)).toEqual({ ok: true, video: false });
  expect(readFileSync(kept)).toEqual(PNG);
  writeFileSync(join(d, "fake.png"), "not a png");
  expect(m.keepOne(join(d, "fake.png"))).not.toBeNull();
  expect(m.keepOne("/home/x/.ssh/id.png")).not.toBeNull();
});

test("a_file_named_under_another_persons_home_is_found_under_this_pcs_or_as_fetched_from_its_pc", () => {
  const here = tmp("home");
  const prevHome = process.env.HOME;
  process.env.HOME = here;
  try {
    // A chat that moved here from another PC names its project's images by that PC's home.
    expect(m.underThisHome("/home/sam/Documents/game/a.png", here)).toBe(`${here}/Documents/game/a.png`);
    expect(m.underThisHome("/Users/sam/Documents/game/a.png", here)).toBe(`${here}/Documents/game/a.png`);
    expect(m.underThisHome(`${here}/Documents/a.png`, here)).toBeNull();
    expect(m.underThisHome("/srv/game/a.png", here)).toBeNull();
    expect(m.underThisHome("/home/sam/../../etc/a.png", here)).toBeNull();
    const theirs = "/home/sam-nobody/Documents/game/previews/church.png";
    expect(m.located(theirs)).toBe(theirs);
    expect(m.check(theirs).ok).toBe(false);
    mkdirSync(join(here, "Documents/game/previews"), { recursive: true });
    writeFileSync(join(here, "Documents/game/previews/church.png"), PNG);
    expect(m.located(theirs)).toBe(join(here, "Documents/game/previews/church.png"));
    expect(m.check(theirs)).toEqual({ ok: true, video: false });
    // Not where this PC keeps secrets, though.
    mkdirSync(join(here, ".ssh"), { recursive: true });
    writeFileSync(join(here, ".ssh/key.png"), PNG);
    expect(m.located("/home/sam-nobody/.ssh/key.png")).toBe("/home/sam-nobody/.ssh/key.png");
    // Not on this PC at all: the copy fetched from the chat's PC.
    const gone = "/home/sam-nobody/Documents/game/previews/new.png";
    expect(m.saveRemote(gone, PNG)).toBe(m.remotePath(gone));
    expect(m.located(gone)).toBe(m.remotePath(gone));
    expect(m.check(gone)).toEqual({ ok: true, video: false });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("find_lists_shown_media_then_named_files", () => {
  const d = tmp("find");
  writeFileSync(join(d, "a.png"), PNG);
  writeFileSync(join(d, "v.mp4"), MP4);
  const named = join(d, "a.png");
  const found = m.find(`Saved ${named}.\n\n![Demo run](v.mp4)\n![gone](missing.png)`, d);
  expect(found.length).toBe(3);
  expect([found[0]?.caption, found[0]?.video, found[0]?.shown]).toEqual(["Demo run", true, true]);
  expect(found[1]?.path.endsWith("missing.png") && found[1].shown).toBe(true);
  expect([found[2]?.path, found[2]?.shown]).toEqual([named, false]);
  expect(found[0] && m.mediaName(found[0])).toBe("v.mp4");
});

test("mime, sniff and names", () => {
  expect(m.mime("a.JPG")).toBe("image/jpeg");
  expect(m.mime("a.bin")).toBe("application/octet-stream");
  expect(m.sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe(false);
  expect(m.sniff(Buffer.from("﻿  <SVG/>"))).toBe(false);
  expect(m.sniff(Buffer.from("hello"))).toBeNull();
  expect(m.mediaName({ path: "/x/y", caption: "", video: false, shown: true, url: "https://a.b/c/d.png?x=1#f" })).toBe("d.png");
});

test("a_replys_own_images_are_kept_in_its_chats_uploads_by_their_contents_and_named_there", () => {
  const proj = tmp("proj");
  const scratch = tmp("scratch");
  mkdirSync(join(proj, "out"), { recursive: true });
  const shot = join(scratch, "shot.png");
  writeFileSync(shot, PNG);
  writeFileSync(join(proj, "out/chart.png"), Buffer.concat([PNG, Buffer.from("chart")]));
  writeFileSync(join(scratch, "fake.png"), "not a png");
  const clip = join(scratch, "a clip.mp4");
  writeFileSync(clip, MP4);
  const md = [
    `The page: ![Login page](${shot} "title")`,
    "",
    "![Weekly chart](out/chart.png)",
    "",
    `![A clip](<${clip}>) and ![web](https://example.com/a.png) and ![gone](${join(scratch, "gone.png")}) and ![fake](${join(scratch, "fake.png")})`,
    "",
    "`![in code](" + shot + ")`",
  ].join("\n");
  const out = m.adopt(md, proj, 42);
  const up = join(m.uploadsDir(), "42");
  const found = m.find(out, proj).filter((x) => x.shown);
  expect(found.map((x) => x.caption)).toEqual(["Login page", "Weekly chart", "A clip", "web", "gone", "fake"]);
  const [a, b, c] = found.map((x) => x.path);
  for (const p of [a, b, c]) expect(p?.startsWith(`${up}/`)).toBe(true);
  expect(a).toMatch(/\/[0-9a-f]{20}\.png$/);
  expect(c).toMatch(/\.mp4$/);
  expect(readFileSync(a ?? "")).toEqual(PNG);
  // What isn't a file here that Harbor shows is left as written; so is code.
  expect(out).toContain("![web](https://example.com/a.png)");
  expect(out).toContain(`![gone](${join(scratch, "gone.png")})`);
  expect(out).toContain(`![fake](${join(scratch, "fake.png")})`);
  expect(out).toContain("`![in code](" + shot + ")`");
  expect(out.startsWith(`The page: ![Login page](${a})`)).toBe(true);
  // Kept once: the same contents are the same file, and a reply already named there stays as it is.
  expect(m.adopt(out, proj, 42)).toBe(out);
  const again = join(scratch, "again.png");
  writeFileSync(again, PNG);
  expect(m.adopt(`![same](${again})`, null, 42)).toBe(`![same](${a})`);
  // The temp file goes: the reply still shows, from its chat's uploads.
  rmSync(shot);
  expect(m.check(a ?? "")).toEqual({ ok: true, video: false });
  // A private file isn't copied anywhere.
  const priv = join(scratch, ".ssh");
  mkdirSync(priv);
  writeFileSync(join(priv, "k.png"), PNG);
  expect(m.adopt(`![k](${join(priv, "k.png")})`, null, 42)).toBe(`![k](${join(priv, "k.png")})`);
  // A plain reply is returned as it is.
  expect(m.adopt("no images here", proj, 42)).toBe("no images here");
});
