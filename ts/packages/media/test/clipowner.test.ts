import { expect, test } from "bun:test";
import sharp from "sharp";
import { richOffers } from "../src/clipboard.ts";
import { Args, events, request } from "../src/clipowner.ts";
import { pathToFileURL } from "node:url";

test("requests are laid out as the Wayland wire wants: header, uints, padded strings", () => {
  const r = request(5, 1, [7, "wl_seat", 2]);
  const v = new DataView(r.buffer);
  expect(v.getUint32(0, true)).toBe(5);
  expect(v.getUint32(4, true)).toBe((r.length << 16) | 1);
  expect(v.getUint32(8, true)).toBe(7);
  expect(v.getUint32(12, true)).toBe(8); // "wl_seat" and its NUL
  expect(new TextDecoder().decode(r.subarray(16, 23))).toBe("wl_seat");
  expect(r[23]).toBe(0);
  expect(v.getUint32(24, true)).toBe(2);
  expect(r.length).toBe(28);
});

test("events come out whole, a partial one waits for the rest", () => {
  const a = request(2, 0, [9, "ext_data_control_manager_v1", 1]);
  const b = request(3, 0, [42]);
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  const half = events(both.subarray(0, a.length + 4));
  expect(half.list.length).toBe(1);
  expect(half.used).toBe(a.length);
  const all = events(both);
  expect(all.list.map((e) => [e.id, e.op])).toEqual([
    [2, 0],
    [3, 0],
  ]);
  const g = new Args(all.list[0]?.body ?? new Uint8Array());
  expect([g.u(), g.s(), g.u()]).toEqual([9, "ext_data_control_manager_v1", 1]);
});

const files: Record<string, Uint8Array> = {};
const read = (p: string) => files[p] ?? null;

test("a message with one image offers its text, HTML holding the image, the image as PNG and its own type, and the file", async () => {
  files["/x/a b.jpg"] = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00f" } }).jpeg().toBuffer());
  const offers = await richOffers({ text: "hi <b>\nthere", images: ["/x/a b.jpg", "/x/missing.png"], named: [] }, read);
  const types = offers.map((o) => o.mime);
  expect(types).toEqual(["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT", "text/html", "image/png", "image/jpeg", "text/uri-list"]);
  const get = (m: string) => new TextDecoder().decode(offers.find((o) => o.mime === m)?.data);
  expect(get("text/plain")).toBe("hi <b>\nthere");
  expect(get("text/html")).toStartWith('<meta charset="utf-8"><p>hi &lt;b&gt;<br>there</p><img src="data:image/jpeg;base64,');
  // The file as a URL of this system ("/x" is on drive C: on Windows).
  expect(get("text/uri-list")).toBe(`${pathToFileURL("/x/a b.jpg").href}\r\n`);
  const png = offers.find((o) => o.mime === "image/png")?.data ?? new Uint8Array();
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("several images: no single image type, all in the HTML and the file list; images alone without text", async () => {
  files["/x/1.png"] = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#f00" } }).png().toBuffer());
  files["/x/2.png"] = files["/x/1.png"];
  const offers = await richOffers({ text: "", images: ["/x/1.png", "/x/2.png"], named: [] }, read);
  expect(offers.map((o) => o.mime)).toEqual(["text/html", "text/uri-list"]);
  const html = new TextDecoder().decode(offers[0]?.data);
  expect(html.match(/<img /g)?.length).toBe(2);
  expect(await richOffers({ text: "", images: ["/x/none"], named: [] }, read)).toEqual([]);
});
