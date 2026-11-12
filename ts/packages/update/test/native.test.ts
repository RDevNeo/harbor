import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addonPath, extractNative, loadAddon, nativeBase } from "../src/native.ts";
import { cleanup, tmp } from "./support.ts";

afterEach(cleanup);

function source(files: Record<string, string>): Record<string, string> {
  const dir = tmp();
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name.replaceAll("/", "_"));
    writeFileSync(p, body);
    out[name] = p;
  }
  return out;
}

const FILES = {
  "sharp/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node": "addon",
  "sharp/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7": "libvips",
  "sherpa/sherpa-onnx.node": "sherpa",
  "sherpa/libonnxruntime.so": "onnx",
  "slint/slint-ui.linux-x64-gnu.node": "slint",
};

test("the files are written side by side, once, under a folder named by what they are", () => {
  const base = tmp();
  const dir = extractNative(source(FILES), base);
  expect(readFileSync(join(dir, "sharp/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7"), "utf8")).toBe("libvips");
  expect(readFileSync(join(dir, "sherpa/libonnxruntime.so"), "utf8")).toBe("onnx");
  expect(existsSync(join(dir, ".complete"))).toBe(true);
  writeFileSync(join(dir, "sherpa/libonnxruntime.so"), "kept");
  expect(extractNative(source(FILES), base)).toBe(dir);
  expect(readFileSync(join(dir, "sherpa/libonnxruntime.so"), "utf8")).toBe("kept");
});

test("other files make another folder, and the old one goes", () => {
  const base = tmp();
  const a = extractNative(source(FILES), base);
  const b = extractNative(source({ ...FILES, "sherpa/libonnxruntime.so": "a newer, longer one" }), base);
  expect(b).not.toBe(a);
  expect(existsSync(a)).toBe(false);
  expect(existsSync(join(b, ".complete"))).toBe(true);
});

test("a folder that was not finished is not trusted", () => {
  const base = tmp();
  const dir = extractNative(source(FILES), base);
  const half = `${dir}.999`;
  mkdirSync(half, { recursive: true });
  writeFileSync(join(half, "x"), "x");
  expect(extractNative(source(FILES), base)).toBe(dir);
  expect(existsSync(half)).toBe(true);
});

test("each addon is found by its place in the list, and a runtime without it says so", () => {
  expect(addonPath(FILES, "sharp")).toBe("sharp/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node");
  expect(addonPath(FILES, "sherpa")).toBe("sherpa/sherpa-onnx.node");
  expect(addonPath(FILES, "slint")).toBe("slint/slint-ui.linux-x64-gnu.node");
  expect(addonPath({}, "sharp")).toBeNull();
  expect(() => loadAddon({}, "sherpa", tmp())).toThrow("this runtime carries no sherpa");
});

test("the files go under the cache folder, not the runtime folder", () => {
  expect(nativeBase({ XDG_CACHE_HOME: "/c", HOME: "/h" })).toBe(join("/c", "harbor"));
  if (process.platform !== "win32") expect(nativeBase({ HOME: "/h" })).toBe("/h/.cache/harbor");
  else expect(nativeBase({ LOCALAPPDATA: "C:\\L" })).toBe("C:\\L\\Cache\\harbor");
});
