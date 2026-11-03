import { expect, test } from "bun:test";
import { newer, parse, parseGlibc, tagged, versionCode, repoRef } from "../src/version.ts";

test("versions compare as releases: 0.2.0 > 0.2.0-rc.1 > 0.1.9", () => {
  expect(newer("0.2.0", "0.1.9")).toBe(true);
  expect(newer("v1.0.0", "0.9.9")).toBe(true);
  expect(newer("0.2.0", "0.2.0-rc.1")).toBe(true);
  expect(newer("0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("garbage", "0.1.0")).toBe(false);
  expect(newer("0.10.0", "0.9.0")).toBe(true);
});

test("a version without a patch number reads as .0, and junk does not read", () => {
  expect(parse("0.2")).toEqual([0, 2, 0, true]);
  expect(parse("1")).toBeNull();
  expect(parse("a.b.c")).toBeNull();
  expect(parse(" v3.4.5-rc.1 ")).toEqual([3, 4, 5, false]);
});

test("apk_version_codes: the Android versionCode follows the version", () => {
  expect(versionCode("0.7.0")).toBe(7000);
  expect(versionCode("v1.2.3")).toBe(1_002_003);
  expect(versionCode("0.10.12")).toBe(10_012);
  expect(versionCode("0.7.1")).toBeGreaterThan(versionCode("0.7.0"));
  expect(versionCode("0.8.0")).toBeGreaterThan(versionCode("0.7.999"));
  expect(versionCode("junk")).toBe(0);
});

test("release_address: the release address gives the tag", () => {
  expect(tagged("https://github.com/o/r/releases/tag/v1.2.3\n")).toBe("1.2.3");
  expect(() => tagged("")).toThrow("no release published yet");
  expect(() => tagged("https://github.com/o/r/releases")).toThrow("no release published yet");
  expect(() => tagged("https://github.com/o/r/releases/tag/nightly")).toThrow("unexpected release tag");
});

test("glibc versions parse", () => {
  expect(parseGlibc("2.39")).toEqual([2, 39]);
  expect(parseGlibc("2.35\n")).toEqual([2, 35]);
  expect(parseGlibc("junk")).toBeNull();
});

test("the repository ref a build fetches its own files at: its commit, else its release tag, never a runtime's label", () => {
  expect(repoRef("abcdef0123456789abcdef0123456789abcdef01", "0.2.0")).toBe("abcdef0123456789abcdef0123456789abcdef01");
  expect(repoRef(null, "0.116.1")).toBe("v0.116.1");
  expect(repoRef(null, "0.109.0.ts")).toBeUndefined();
  expect(repoRef(null, "0.0.0-dev")).toBeUndefined();
});
