import { expect, test } from "bun:test";
import { CaptchaPane, type CaptchaApi, type CaptchaWindow, noCaptcha } from "../src/captchapane.ts";
import type { discord } from "@harbor/mcp";

const pixels = { width: 2, height: 1, data: new Uint8Array(8) };

function rig(frames: (discord.CaptchaFrame | undefined)[]) {
  const sent: [string, number, number][] = [];
  let cancelled = 0;
  const api: CaptchaApi = {
    signedIn: () => true,
    frame: async () => frames.shift(),
    input: async (kind, x, y) => {
      await Bun.sleep(5);
      sent.push([kind, x, y]);
    },
    cancel: async () => {
      cancelled++;
    },
  };
  const w: CaptchaWindow = { cap_open: false, cap_shown: false, cap_data: noCaptcha };
  const decoded: number[] = [];
  const pane = new CaptchaPane(w, async (b) => {
    decoded.push(b.length);
    return pixels;
  }, api);
  return { w, pane, sent, decoded, cancelled: () => cancelled };
}

const frame = (data?: string): discord.CaptchaFrame => ({ guild: "Big Server", width: 1280, height: 720, rect: { x: 400, y: 200, width: 300, height: 200 }, ...(data !== undefined ? { data } : {}) });

test("a captcha comes up in front with its frame, and goes when the host has none", async () => {
  const r = rig([frame(Buffer.from("jpeg").toString("base64")), undefined]);
  await r.pane.look();
  expect(r.w.cap_open).toBe(true);
  expect(r.w.cap_shown).toBe(true);
  expect(r.w.cap_data).toMatchObject({ guild: "Big Server", width: 1280, height: 720, rect_x: 400, rect_y: 200, rect_w: 300, rect_h: 200 });
  expect(r.w.cap_data.image).toBe(pixels);
  expect(r.decoded).toEqual([4]);
  await r.pane.look();
  expect(r.w.cap_open).toBe(false);
  expect(r.w.cap_data).toBe(noCaptcha);
  r.pane.stop();
});

test("hidden it stays a pill, decodes nothing, and takes no pointer", async () => {
  const r = rig([frame("AAAA"), frame("AAAA")]);
  await r.pane.look();
  r.pane.show(false);
  r.pane.stop();
  await r.pane.look();
  expect(r.w.cap_open).toBe(true);
  expect(r.w.cap_shown).toBe(false);
  expect(r.decoded.length).toBe(1);
  r.pane.pointer("down", 450, 250);
  await r.pane.settled();
  expect(r.sent).toEqual([]);
  r.pane.stop();
});

test("presses keep their order, moves only the newest, other buttons nothing", async () => {
  const r = rig([frame("AAAA")]);
  await r.pane.look();
  r.pane.stop();
  r.pane.pointer("move", 401, 201);
  r.pane.pointer("move", 402, 202);
  r.pane.pointer("move", 403, 203);
  r.pane.pointer("down", 410, 210);
  r.pane.pointer("up", 410, 210);
  r.pane.pointer("key", 1, 1);
  await r.pane.settled();
  expect(r.sent).toEqual([
    ["move", 403, 203],
    ["down", 410, 210],
    ["up", 410, 210],
  ]);
});

test("Don't join closes the captcha at Discord", async () => {
  const r = rig([frame("AAAA")]);
  await r.pane.look();
  r.pane.cancel();
  r.pane.stop();
  await Bun.sleep(10);
  expect(r.cancelled()).toBe(1);
  expect(r.w.cap_shown).toBe(false);
});
