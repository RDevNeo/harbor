import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { media } from "../packages/media/src/index.ts";
import { Api, cardJson, Hub, ok, project, type ApiDeps } from "../packages/net/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "hts-media-serve-"));
const was = process.env.XDG_DATA_HOME;
let api: Api;
let port = 0;

/** What hub.ts gives the api for `/v1/image` and `/v1/media`. */
const mediaDeps: Partial<ApiDeps> = {
  image: (path, max) => media.imageAnswer(path, max),
  mediaCheck: (path) => {
    const c = media.check(path);
    return c.ok ? null : c.error;
  },
  mime: (path) => media.mime(path),
  located: (path) => media.located(path),
  mediaWait: (path) => media.waitFor(path, 20_000),
};

beforeAll(async () => {
  process.env.XDG_DATA_HOME = join(root, "data");
  const hub = new Hub([{ token: "tok", name: "", created: 0, group: "", fp: "", account: "", account_name: "" }], 0);
  api = new Api({
    hub,
    id: () => null,
    uploadsDir: join(root, "uploads"),
    route: async () => ok({}),
    account: null,
    appInfo: () => ({ version_code: 0, url: "/app.apk", hub: null }),
    apk: () => null,
    mesh: async () => ({ status: 404, body: { error: "no such call" } }),
    meshAdmitted: () => false,
    relay: async () => {},
    hubs: () => ({ hubs: [] }),
    ...mediaDeps,
  });
  hub.enabled = true;
  hub.port = 0;
  await api.listen(["127.0.0.1"]);
  port = api.port();
});

afterAll(() => {
  api.close();
  if (was === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = was;
  rmSync(root, { recursive: true, force: true });
});

function get(path: string, extra = ""): Promise<[string, Buffer]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () => c.write(`GET ${path} HTTP/1.1\r\nAuthorization: Bearer tok\r\n${extra}Connection: close\r\n\r\n`));
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    c.on("error", reject);
    c.on("close", () => {
      const i = out.indexOf("\r\n\r\n");
      resolve([out.subarray(0, i).toString(), out.subarray(i + 4)]);
    });
  });
}

const q = (p: string): string => encodeURIComponent(p);

test("a_video_is_served_in_parts_within_medias_rules", async () => {
  mkdirSync(join(root, ".ssh"), { recursive: true });
  const mp4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypmp42\0\0\0\0", "latin1"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 0xff))]);
  writeFileSync(join(root, "run.mp4"), mp4);
  writeFileSync(join(root, ".ssh/key.mp4"), mp4);
  const path = join(root, "run.mp4");
  let [head, body] = await get(`/v1/media?path=${q(path)}`);
  expect(head).toStartWith("HTTP/1.1 200");
  expect(head).toContain("Accept-Ranges: bytes");
  expect(body.equals(mp4)).toBe(true);
  [head, body] = await get(`/v1/media?path=${q(path)}`, "Range: bytes=100-199\r\n");
  expect(head).toStartWith("HTTP/1.1 206");
  expect(head).toContain(`Content-Range: bytes 100-199/${mp4.length}`);
  expect(head).toContain("Content-Length: 100");
  expect(body.equals(mp4.subarray(100, 200))).toBe(true);
  [, body] = await get(`/v1/media?path=${q(path)}`, "Range: bytes=-16\r\n");
  expect(body.equals(mp4.subarray(mp4.length - 16))).toBe(true);
  [head] = await get(`/v1/media?path=${q(path)}`, `Range: bytes=${mp4.length}-\r\n`);
  expect(head).toStartWith("HTTP/1.1 416");
  expect(head).toContain(`Content-Range: bytes */${mp4.length}`);
  // A range reaches nothing a whole request wouldn't.
  [head] = await get(`/v1/media?path=${q(join(root, ".ssh/key.mp4"))}`, "Range: bytes=0-10\r\n");
  expect(head).toStartWith("HTTP/1.1 404");
  [head] = await get(`/v1/media?path=${q(join(root, "missing.mp4"))}`, "Range: bytes=0-10\r\n");
  expect(head).toStartWith("HTTP/1.1 404");
});

test("a_replys_images_are_served_even_after_their_temp_file_is_gone", async () => {
  const proj = join(root, "proj");
  const tmp = join(root, "tmp");
  mkdirSync(join(proj, "out"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const png = (w: number, h: number): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: "#000" } }).png().toBuffer();
  writeFileSync(join(proj, "out/chart.png"), await png(40, 20));
  const shot = join(tmp, "shot.png");
  writeFileSync(shot, await png(30, 30));
  const text = `The chart:\n\n![Weekly chart](out/chart.png)\n\nAnd the page:\n\n![Login page](${shot})`;
  const found = media.find(text, proj);
  expect(found.map((m) => m.caption)).toEqual(["Weekly chart", "Login page"]);
  expect(found.map((m) => m.path)).toEqual([join(proj, "out/chart.png"), shot]);
  // Each goes after the paragraph that introduces it.
  const cards = project([{ kind: "text", text, at: 1 }], false, []);
  const shown = cards[0];
  if (!shown) throw new Error("no card");
  const card = cardJson(shown, 1, (t) => media.find(t, proj), "g1", undefined, { strip: (md) => media.stripRefs(md), parts: (md) => media.parts(md) });
  const placed = card.media as { caption: string; after: number }[];
  expect(placed.map((m) => [m.caption, m.after])).toEqual([
    ["Weekly chart", 1],
    ["Login page", 2],
  ]);
  expect((card.blocks as unknown[]).length).toBe(2);
  const ok200 = async (p: string, max = ""): Promise<[string, Buffer]> => get(`/v1/image?path=${q(p)}${max}`);
  let [head, body] = await ok200(shot);
  expect(head).toStartWith("HTTP/1.1 200");
  expect(head).toContain("Content-Type: image/png");
  [head, body] = await ok200(join(proj, "out/chart.png"), "&max=16");
  expect(head).toContain("Content-Type: image/jpeg");
  expect((await sharp(body).metadata()).width).toBe(16);
  media.keep(text, proj);
  for (let i = 0; i < 50 && !media.located(shot).includes("kept"); i++) {
    await Bun.sleep(20);
    if (i === 0) rmSync(shot);
  }
  [head, body] = await ok200(shot);
  expect(head).toStartWith("HTTP/1.1 200");
  expect((await sharp(body).metadata()).width).toBe(30);
});
