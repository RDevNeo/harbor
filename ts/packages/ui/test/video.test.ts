import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as media from "@harbor/media";
import { inlineCap, MediaRows } from "../src/mediarows.ts";
import { noPixels } from "../src/window.ts";
import { pressOf } from "../src/composer.ts";
import { VIDEO_KEYS } from "../src/videopane.ts";

const dir = mkdtempSync(join(tmpdir(), "hvid-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a reply naming a video shows a dark card the size Rust gives it until its poster comes, also when it never does", async () => {
  const file = join(dir, "clip.mp4");
  writeFileSync(file, new Uint8Array(4096).fill(7));
  let loads = 0;
  const rows = new MediaRows(media, () => void loads++);
  const card = { kind: "text" as const, text: `Here it is: ${file}`, at: 1, forkable: false };
  const first = rows.rows(card, dir, 900);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ video: true, large: true, name: "clip.mp4", path: file, w: 360, h: 203 });
  expect(first[0]?.image.width).toBeLessThanOrEqual(1);
  for (let i = 0; i < 100 && loads === 0; i++) await Bun.sleep(20);
  expect(loads).toBe(1);
  expect(rows.rows(card, dir, 900)[0]).toMatchObject({ video: true, w: 360, h: 203 });
  expect(rows.rows(card, dir, 200)[0]).toMatchObject({ w: 200, h: 113 });
});

test("the viewer's keys are video.rs `take_keys`: Space, the arrows, M, F, Esc, Page Up and Down", () => {
  expect(VIDEO_KEYS[" "]).toBe("space");
  expect(VIDEO_KEYS["\u{f72c}"]).toBe("pageUp");
  expect(VIDEO_KEYS["\u{f72d}"]).toBe("pageDown");
  expect([VIDEO_KEYS.f, VIDEO_KEYS.F, VIDEO_KEYS.m, VIDEO_KEYS.M]).toEqual(["f", "f", "m", "m"]);
  expect(VIDEO_KEYS.Escape).toBe("escape");
  // ← and → as Slint sends them (Key.LeftArrow, Key.RightArrow) seek 5 s back and on (#114).
  const no = { control: false, shift: false, alt: false };
  expect(VIDEO_KEYS[pressOf("\u{f702}", no).key]).toBe("left");
  expect(VIDEO_KEYS[pressOf("\u{f703}", no).key]).toBe("right");
  expect(media.video.NUDGE).toBe(5);
  expect(VIDEO_KEYS.q).toBeUndefined();
});

test("an image keeps its place at its size while it's decoded; one no build shows rests a while, the least recently shown going first", async () => {
  const sharp = (await import("sharp")).default;
  const two = await sharp({ create: { width: 4, height: 2, channels: 4, background: "#3a6" } }).png().toBuffer();
  const [a, b, c, d] = ["a.png", "b.png", "c.png", "d.png"].map((n) => join(dir, `rest-${n}`)) as [string, string, string, string];
  for (const f of [a, b, c, d]) writeFileSync(f, two);
  let loads = 0;
  // Room for one resting image (4×2×4 bytes each).
  const rows = new MediaRows(media, () => void loads++, (p) => p, 40);
  const card = (f: string) => ({ kind: "text" as const, text: `![shot](${f})`, at: 1, forkable: false });
  const settle = async (n: number) => {
    for (let i = 0; i < 100 && loads < n; i++) await Bun.sleep(20);
  };
  const drawn = (f: string) => rows.rows(card(f), dir, 760)[0]?.image.width === 4;
  // Before its decode: its place, at the size the file says, with no pixels yet.
  const first = rows.rows(card(a), dir, 760);
  expect(first).toMatchObject([{ path: a, large: true, w: 4, h: 2 }]);
  expect(first[0]?.image).toBe(noPixels);
  rows.sweep();
  await settle(1);
  expect(drawn(a)).toBe(true);
  rows.sweep();
  // A build without `a`'s card: it rests, and is drawn at once when its card comes back.
  rows.rows(card(b), dir, 760);
  rows.sweep();
  await settle(2);
  expect(drawn(a)).toBe(true);
  rows.sweep();
  expect(loads).toBe(2);
  // `c` shown alone: `a` rests too, and `b`, which rested first, goes (one fits).
  rows.rows(card(c), dir, 760);
  rows.sweep();
  await settle(3);
  expect(drawn(a)).toBe(true);
  expect(drawn(b)).toBe(false);
  rows.sweep();
  await settle(4);
  expect(loads).toBe(4);
  // `d` starts decoding, then two builds pass without it (its chat was left): nobody is told when it's there, and
  // it rests, so it's drawn at once when its card comes back.
  rows.rows(card(d), dir, 760);
  rows.sweep();
  rows.sweep();
  await Bun.sleep(300);
  expect(loads).toBe(4);
  expect(drawn(d)).toBe(true);
  expect(loads).toBe(4);
  // A file that's missing has no place to keep: nothing until it's there.
  expect(rows.rows(card(join(dir, "rest-missing.png")), dir, 760)).toHaveLength(0);
});

test("a large image is decoded to the width it's drawn at, in the screen's pixels", () => {
  expect(inlineCap(760, 1, 1280)).toBe(480);
  expect(inlineCap(760, 1.25, 1280)).toBe(600);
  expect(inlineCap(760, 2, 1280)).toBe(960);
  expect(inlineCap(760, 4, 1280)).toBe(1280);
  expect(inlineCap(300, 1, 1280)).toBe(300);
  expect(inlineCap(760, Number.NaN, 1280)).toBe(960);
});

test("a zoom or a new display scale never blanks a shown image: the old decode stays until the new one is there", async () => {
  const sharp = (await import("sharp")).default;
  const big = join(dir, "wide.png");
  const small = join(dir, "tiny.png");
  writeFileSync(big, await sharp({ create: { width: 2000, height: 1000, channels: 4, background: "#3a6" } }).png().toBuffer());
  writeFileSync(small, await sharp({ create: { width: 200, height: 100, channels: 4, background: "#a36" } }).png().toBuffer());
  const rows = new MediaRows(media, () => {});
  const card = { kind: "text" as const, text: `![a](${big}) ![b](${small})`, at: 1, forkable: false };
  // Every build (and its sweep) is checked: both images, each at its one logical size, never an empty image.
  const build = (scale: number) => {
    const r = rows.rows(card, dir, 760, scale);
    rows.sweep();
    return r;
  };
  const shown = (scale: number) => {
    const r = build(scale);
    expect(r.map((m) => [m.path, m.w, m.h])).toEqual([
      [big, 480, 240],
      [small, 200, 100],
    ]);
    for (const m of r) expect(m.image.width).toBeGreaterThan(1);
    return r.map((m) => m.image.width);
  };
  const until = async (scale: number, widths: number[]) => {
    for (let i = 0; i < 300; i++) {
      if (build(scale).length === 2 && shown(scale).join() === widths.join()) return;
      await Bun.sleep(10);
    }
    expect(shown(scale)).toEqual(widths);
  };
  for (let i = 0; i < 300 && build(1).some((m) => m.image.width <= 1); i++) await Bun.sleep(10);
  expect(shown(1)).toEqual([480, 200]);
  // Zoom keys in a row, each build while the sharper decodes run: the 480 px decode stays on the screen.
  for (const scale of [1.25, 1.5, 2]) expect(shown(scale)).toEqual([480, 200]);
  await until(2, [960, 200]);
  // Zoomed out to 50%: the sharper one shows until the smaller decode is there, drawn at the same size.
  expect(shown(0.5)).toEqual([960, 200]);
  await until(0.5, [240, 200]);
  // Back: the image shown at each step is never let go before its successor.
  for (const scale of [0.5, 1, 0.5, 1, 1.25]) shown(scale);
  await until(1.25, [600, 200]);
});

test("another PC's chat: an image that isn't on this PC comes from that PC once, and is drawn from the copy kept here", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "data-home");
  try {
    let loads = 0;
    const rows = new MediaRows(media, () => void loads++);
    const there = `/home/nobody-${Date.now()}/Documents/game/church.png`;
    const card = { kind: "text" as const, text: `The church: ![The whole church](${there})`, at: 1, forkable: false };
    const asked: string[] = [];
    const fetch = async (p: string) => {
      asked.push(p);
      return new Uint8Array(png);
    };
    const settle = async (n: number) => {
      for (let i = 0; i < 100 && loads < n; i++) await Bun.sleep(20);
    };
    // Without a fetch (this PC's own chat): a link, as before.
    expect(rows.rows(card, dir, 760)).toHaveLength(0);
    await settle(1);
    expect(rows.rows(card, dir, 760)).toHaveLength(0);
    // Another PC's chat: asked for once, then drawn.
    const other = new MediaRows(media, () => void loads++);
    other.rows(card, dir, 760, 1, fetch);
    await settle(2);
    other.rows(card, dir, 760, 1, fetch);
    await settle(3);
    expect(other.rows(card, dir, 760, 1, fetch)).toMatchObject([{ path: there, large: true, caption: "The whole church" }]);
    expect(asked).toEqual([there]);
    // The PC off or without it: it stays a link, and isn't asked for again.
    const none = new MediaRows(media, () => void loads++);
    const card2 = { ...card, text: `![gone](${there.replace("church", "gone")})` };
    const nothing = async (p: string) => (asked.push(p), null);
    none.rows(card2, dir, 760, 1, nothing);
    await settle(5);
    none.rows(card2, dir, 760, 1, nothing);
    await Bun.sleep(100);
    expect(none.rows(card2, dir, 760, 1, nothing)).toHaveLength(0);
    expect(asked.length).toBe(2);
  } finally {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  }
});

test("an image that failed to show is tried again while it's on the screen: a file that turns up, or its PC coming back", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const prevData = process.env.XDG_DATA_HOME;
  const prevRetry = MediaRows.RETRY_MS;
  process.env.XDG_DATA_HOME = join(dir, "data-retry");
  MediaRows.RETRY_MS = 40;
  try {
    let loads = 0;
    const settle = async (f: () => boolean) => {
      for (let i = 0; i < 150 && !f(); i++) await Bun.sleep(20);
    };
    // This PC's chat: the file isn't there yet, then it is (copied in by hand, written late).
    const late = join(dir, `late-${Date.now()}.png`);
    const card = { kind: "text" as const, text: `![Late](${late})`, at: 1, forkable: false };
    const rows = new MediaRows(media, () => void loads++);
    expect(rows.rows(card, dir, 760)).toHaveLength(0);
    await settle(() => loads > 0);
    expect(rows.rows(card, dir, 760)).toHaveLength(0);
    writeFileSync(late, png);
    await settle(() => rows.rows(card, dir, 760).length > 0);
    expect(rows.rows(card, dir, 760)).toMatchObject([{ path: late, large: true, caption: "Late" }]);
    // Another PC's chat whose PC was off: asked again later, then drawn.
    const there = `/home/nobody-${Date.now()}/shots/away.png`;
    const away = { ...card, text: `![Away](${there})` };
    let on = false;
    const asked: string[] = [];
    const fetch = async (p: string) => (asked.push(p), on ? new Uint8Array(png) : null);
    const other = new MediaRows(media, () => void loads++);
    expect(other.rows(away, dir, 760, 1, fetch)).toHaveLength(0);
    await settle(() => asked.length === 1);
    on = true;
    await settle(() => other.rows(away, dir, 760, 1, fetch).length > 0);
    expect(other.rows(away, dir, 760, 1, fetch)).toMatchObject([{ path: there, caption: "Away" }]);
    expect(asked).toEqual([there, there]);
    // Once it's here it's drawn from the copy kept here, not asked for again.
    const third = new MediaRows(media, () => void loads++);
    third.rows(away, dir, 760, 1, fetch);
    await settle(() => third.rows(away, dir, 760, 1, fetch).length > 0);
    expect(third.rows(away, dir, 760, 1, fetch)).toHaveLength(1);
    expect(asked).toHaveLength(2);
  } finally {
    MediaRows.RETRY_MS = prevRetry;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  }
});

test("every view draws from one store: a chat moved to another pane, or decoded ahead, shows its images at once", async () => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 6, height: 3, channels: 4, background: "#36a" } }).png().toBuffer();
  const [a, b, c] = ["a", "b", "c"].map((n) => join(dir, `shared-${n}.png`)) as [string, string, string];
  for (const f of [a, b, c]) writeFileSync(f, png);
  const card = (f: string) => ({ kind: "text" as const, text: `![shot](${f})`, at: 1, forkable: false });
  let one = 0;
  let two = 0;
  const main = new MediaRows(media, () => void one++);
  const pane = new MediaRows(media, () => void two++, undefined, undefined, main.store);
  const drawn = (v: MediaRows, f: string) => v.rows(card(f), dir, 760)[0]?.image.width === 6;
  // Shown in the usual view: decoded once, and that view is told.
  expect(drawn(main, a)).toBe(false);
  main.sweep();
  for (let i = 0; i < 100 && one === 0; i++) await Bun.sleep(20);
  expect([one, two]).toEqual([1, 0]);
  // The chat goes to a pane: drawn there at once, nothing decoded again.
  expect(drawn(pane, a)).toBe(true);
  pane.sweep();
  main.sweep();
  main.sweep();
  // The pane closes: its images rest, and come back drawn wherever the chat shows next.
  pane.close();
  expect(drawn(main, a)).toBe(true);
  main.sweep();
  // Decoded ahead (a chat about to be opened): nobody is told, and its first build draws them.
  const ready = main.ahead([card(b), card(c)], dir, 760);
  expect(ready).not.toBeNull();
  await ready;
  expect(one).toBe(1);
  expect(drawn(main, b) && drawn(main, c)).toBe(true);
  main.sweep();
  // Nothing left to decode: no wait.
  expect(main.ahead([card(a), card(b)], dir, 760)).toBeNull();
});
