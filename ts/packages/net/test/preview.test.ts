import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../src/client.ts";
import { announcePreview, fetchPreviewFile, PREVIEW_FETCH_MS, previewOffer, takesPreviews } from "../src/preview.ts";
import { newPeer, Shared } from "../src/shared.ts";

const offer = { id: "p1", sha256: "ab".repeat(32), note: "try this", kind: "bundle" };

test("an offer needs an id and a sha256; note and kind default to empty", () => {
  expect(previewOffer(offer)).toEqual(offer);
  expect(previewOffer({ id: "p1", sha256: "x" })).toEqual({ id: "p1", sha256: "x", note: "", kind: "" });
  expect(previewOffer({ id: "", sha256: "x" })).toBeNull();
  expect(previewOffer({ sha256: "x" })).toBeNull();
  expect(previewOffer("p1")).toBeNull();
});

test("only PCs with previews on that run bundles take them (a Rust PC runs binaries)", () => {
  expect(takesPreviews({ preview_on: true, preview_kind: "bundle" })).toBe(true);
  expect(takesPreviews({ preview_on: true })).toBe(false);
  expect(takesPreviews({ preview_on: false, preview_kind: "bundle" })).toBe(false);
  expect(takesPreviews(null)).toBe(false);
});

test("announcing offers the preview to the online PCs that take previews, and says who answered", async () => {
  const shared = new Shared();
  const mk = (id: string, name: string, online: boolean, update: unknown) => {
    const p = newPeer({ id, name, online, addr: `127.0.0.1:${id.length}`, update });
    shared.peers.set(id, p);
  };
  mk("a", "a", true, { preview_on: true, preview_kind: "bundle" });
  mk("bb", "b", true, { preview_on: true });
  mk("ccc", "c", false, { preview_on: true, preview_kind: "bundle" });
  mk("dddd", "d", true, { preview_on: true, preview_kind: "bundle" });
  const sent: [string, string][] = [];
  const said = await announcePreview(shared, offer, async (d, method, path) => {
    sent.push([d.addr, `${method} ${path}`]);
    return d.addr.endsWith(":4") ? [403, { error: "previews are off on this PC" }] : [200, { taking: true }];
  });
  expect(sent).toEqual([
    ["127.0.0.1:1", "POST /mesh/v1/preview"],
    ["127.0.0.1:4", "POST /mesh/v1/preview"],
  ]);
  expect(said).toEqual(["a"]);
});

test("a preview's file is asked again while its sender restarts, until the time is up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpreview-"));
  try {
    let t = 0;
    let calls = 0;
    const paths: string[] = [];
    const answer = (status: number, body: string): Answer => ({ status, ctype: "", range: "", body: new TextEncoder().encode(body) });
    const raw = async (_d: unknown, _m: string, path: string): Promise<Answer> => {
      paths.push(path);
      calls++;
      if (calls < 3) throw new Error("connection refused");
      return answer(200, "bundle bytes");
    };
    const to = join(dir, "got");
    await fetchPreviewFile({ addr: "127.0.0.1:1", fp: "" }, "p 1", "bundle", to, { raw, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(readFileSync(to, "utf8")).toBe("bundle bytes");
    expect(paths[0]).toBe("/mesh/v1/preview/file?kind=bundle&id=p%201");
    t = 0;
    const gone = async (): Promise<Answer> => answer(404, '{"error":"that preview isn\'t on offer here"}');
    await expect(fetchPreviewFile({ addr: "127.0.0.1:1", fp: "" }, "p1", "bundle", to, { raw: gone, now: () => t, sleep: async (ms) => void (t += ms * 100) })).rejects.toThrow("404");
    expect(t).toBeLessThanOrEqual(PREVIEW_FETCH_MS + 50_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
