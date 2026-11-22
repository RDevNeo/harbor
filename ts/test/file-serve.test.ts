// A file a reply attached (`[name](path)`, media's files.ts): the phone's card for it and `GET /v1/file`, by Range.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files, media } from "../packages/media/src/index.ts";
import { Api, attachments, cardJson, Hub, ok, project } from "../packages/net/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "hts-file-serve-"));
const was = process.env.XDG_DATA_HOME;
let api: Api;
let port = 0;

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
    // What hub.ts gives it.
    fileCheck: async (path) => (!files.servable(path) ? "not a file a reply attached" : (await files.fileWait(path)) ? null : "it's gone from this PC"),
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

function get(path: string, extra = "", token = "tok"): Promise<[string, Buffer]> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () => c.write(`GET ${path} HTTP/1.1\r\nAuthorization: Bearer ${token}\r\n${extra}Connection: close\r\n\r\n`));
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    c.on("error", reject);
    c.on("close", () => {
      const i = out.indexOf("\r\n\r\n");
      resolve([out.subarray(0, i).toString(), out.subarray(i + 4)]);
    });
  });
}

test("an attached file is served whole and in parts, then the phone's card names it", async () => {
  const apk = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff));
  writeFileSync(join(root, "app-debug.apk"), apk);
  const text = files.adoptFiles(`Built:\n\n[app-debug.apk](${join(root, "app-debug.apk")})`, null, 5);
  const [att] = attachments(text);
  expect(att?.size).toBe(3000);
  const path = att?.path ?? "";
  const shown = project([{ kind: "text", text, at: 1 }], false, [])[0];
  if (!shown) throw new Error("no card");
  const card = cardJson(shown, 1, (t) => media.find(t, null), "g5", undefined, { strip: (md) => media.stripRefs(md), parts: (md) => media.parts(md) });
  const url = `/v1/file?path=${encodeURIComponent(path)}&chat=g5`;
  // Drawn after the one block before it ("Built:"), where its link was.
  expect(card.files).toEqual([{ name: "app-debug.apk", kind: "APK", meta: "2.9 KB · APK", glyph: expect.any(String), url, size: 3000, after: 1 }]);
  // The paragraph of the link alone is its card: the text keeps "Built:".
  expect(JSON.stringify(card.blocks)).not.toContain("app-debug");

  let [head, body] = await get(url);
  expect(head).toStartWith("HTTP/1.1 200");
  expect(head).toContain("Accept-Ranges: bytes");
  expect(Buffer.compare(body, apk)).toBe(0);
  [head, body] = await get(url, "Range: bytes=1000-\r\n");
  expect(head).toStartWith("HTTP/1.1 206");
  expect(head).toContain("Content-Range: bytes 1000-2999/3000");
  expect(Buffer.compare(body, apk.subarray(1000))).toBe(0);
  [head] = await get(url, "Range: bytes=5000-\r\n");
  expect(head).toStartWith("HTTP/1.1 416");
  // Without the token: refused.
  [head] = await get(url, "", "nope");
  expect(head).toStartWith("HTTP/1.1 401");
});

test("only kept copies of attached files are served", async () => {
  writeFileSync(join(root, "secret.txt"), "no");
  for (const p of [join(root, "secret.txt"), "/etc/passwd", join(media.uploadsDir(), "5", "files", "0123456789abcdef0123", "gone.zip")]) {
    const [head] = await get(`/v1/file?path=${encodeURIComponent(p)}`);
    expect(head).toStartWith("HTTP/1.1 404");
  }
});
