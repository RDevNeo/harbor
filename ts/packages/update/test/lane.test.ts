import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RUNTIME_SOURCES, buildManifest, dependencyChanges, lane } from "../src/lane.ts";
import { parseManifest } from "../src/manifest.ts";
import { releaseCli, type ReleaseDeps } from "../src/release-cli.ts";

const here = import.meta.dir;
const root = resolve(here, "..", "..", "..", "..");

const pkg = (over: Record<string, unknown> = {}, deps: Record<string, string> = {}): string =>
  JSON.stringify({ packageManager: "bun@1.4.3", engines: { bun: "1.4.3" }, dependencies: { "slint-ui": "1.18.1", "sherpa-onnx-node": "2.0.1", "@xterm/headless": "6.0.0", ...deps }, ...over });

test("a code-only change ships the bundle lane", () => {
  const r = lane({ changed: ["ts/packages/ui/src/chat.ts", "ts/packages/net/src/mesh.ts", "ts/PROGRESS.md", "README.md"], packageJson: { before: pkg(), after: pkg() } });
  expect(r).toEqual({ lane: "bundle", reasons: [] });
});

test("the runtime lane runs only when its inputs change", () => {
  const same = { before: pkg(), after: pkg() };
  expect(lane({ changed: ["video/build.sh"], packageJson: same }).lane).toBe("runtime");
  expect(lane({ changed: ["packaging/install.sh"], packageJson: same }).lane).toBe("runtime");
  expect(lane({ changed: ["slint/keep-compiler-state.patch"], packageJson: same }).lane).toBe("runtime");
  expect(lane({ changed: ["ts/runtime.ts"], packageJson: same }).lane).toBe("runtime");
  expect(lane({ changed: ["ts/packages/update/src/launcher.ts"], packageJson: same }).lane).toBe("runtime");
  expect(lane({ changed: ["ts/packages/update/src/notices.ts", "ts/packages/update/src/lane.ts"], packageJson: same }).lane).toBe("bundle");
  const bun = lane({ changed: ["ts/package.json"], packageJson: { before: pkg(), after: pkg({ packageManager: "bun@1.5.0", engines: { bun: "1.5.0" } }) } });
  expect(bun).toEqual({ lane: "runtime", reasons: ["Bun's version changed"] });
  expect(lane({ changed: ["ts/package.json"], packageJson: { before: pkg(), after: pkg({}, { "slint-ui": "1.19.0" }) } }).reasons).toEqual(["slint-ui changed"]);
  expect(lane({ changed: ["ts/package.json"], packageJson: { before: pkg(), after: pkg({}, { "sherpa-onnx-node": "2.1.0" }) } }).reasons).toEqual(["sherpa-onnx-node changed"]);
});

test("other dependencies and the lock file alone do not cause a runtime release", () => {
  expect(dependencyChanges(pkg(), pkg({}, { "@xterm/headless": "7.0.0", qrcode: "1.5.0" }))).toEqual([]);
  expect(lane({ changed: ["ts/package.json", "ts/bun.lock"], packageJson: { before: pkg(), after: pkg({}, { qrcode: "1.5.0" }) } }).lane).toBe("bundle");
  expect(dependencyChanges(null, pkg()).length).toBeGreaterThan(0);
  expect(dependencyChanges("junk", "junk")).toEqual([]);
});

test("the list of runtime sources is exactly what the runtime entry imports", () => {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    const rel = file.slice(root.length + 1);
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import) "(\.[^"]+\.ts)"/g)) walk(resolve(dirname(file), m[1] ?? ""));
  };
  walk(join(root, "ts", "runtime.ts"));
  expect([...seen].sort()).toEqual([...RUNTIME_SOURCES].sort());
});

test("a manifest for the runtime lane names itself as the runtime", () => {
  const m = buildManifest({ version: "1.2.0", lane: "runtime", previous: null });
  expect(m).toEqual({ version: "1.2.0", minRuntime: "1.2.0", runtime: "1.2.0" });
  expect(parseManifest(JSON.stringify(m))).toEqual(m);
});

test("a manifest for the bundle lane keeps the runtime and the extras of the release before (not the old browser engine)", () => {
  const previous = parseManifest(JSON.stringify({ version: "1.2.0", minRuntime: "1.1.0", runtime: "1.2.0", browser: { id: "b", release: "1.0.0" }, video: { id: "v", release: "1.0.0" }, apk: { code: 1002000, release: "1.2.0" } }));
  const m = buildManifest({ version: "1.2.1", lane: "bundle", previous });
  expect(m).toEqual({ version: "1.2.1", minRuntime: "1.1.0", runtime: "1.2.0", video: { id: "v", release: "1.0.0" }, apk: { code: 1002000, release: "1.2.0" } });
  const n = buildManifest({ version: "1.2.1", lane: "bundle", previous, video: { id: "v" }, apk: { code: 1002001 } });
  expect(n.video).toEqual({ id: "v", release: "1.2.1" });
  expect(n.apk).toEqual({ code: 1002001, release: "1.2.1" });
  expect(() => buildManifest({ version: "1.2.1", lane: "bundle", previous: null })).toThrow("previous release's manifest");
});

test("a runtime release whose phone app didn't change names the latest release's APK again", () => {
  const previous = parseManifest(JSON.stringify({ version: "1.2.1", minRuntime: "1.2.0", runtime: "1.2.0", apk: { code: 1002000, release: "1.2.0" } }));
  const m = buildManifest({ version: "1.3.0", lane: "runtime", previous });
  expect(m).toEqual({ version: "1.3.0", minRuntime: "1.3.0", runtime: "1.3.0", apk: { code: 1002000, release: "1.2.0" } });
  expect(buildManifest({ version: "1.3.0", lane: "runtime", previous, apk: { code: 1003000 } }).apk).toEqual({ code: 1003000, release: "1.3.0" });
});

test("the manifest is read strictly", () => {
  expect(() => parseManifest("junk")).toThrow("unreadable");
  expect(() => parseManifest("[]")).toThrow("unreadable");
  expect(() => parseManifest(JSON.stringify({ version: "x", minRuntime: "1.0.0", runtime: "1.0.0" }))).toThrow("version is not a version");
  expect(parseManifest(JSON.stringify({ version: "v1.0.0", minRuntime: "1.0.0", runtime: "1.0.0", browser: { id: "" }, extra: 1 }))).toEqual({ version: "1.0.0", minRuntime: "1.0.0", runtime: "1.0.0" });
});

function deps(files: Record<string, string>, git: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const d: ReleaseDeps = {
    git: async (args) => {
      const v = git[args.join(" ")];
      if (v === undefined) throw new Error("no such thing");
      return v;
    },
    readFile: (p) => files[p] ?? null,
    writeFile: (p, data) => void (written[p] = data),
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
  };
  return { d, out, err, written };
}

test("the lane command prints the lane and why", async () => {
  const a = deps({ "ts/package.json": pkg() }, { "diff --name-only v1.0.0...HEAD": "ts/packages/ui/src/a.ts\npackaging/install.sh\n", "show v1.0.0:ts/package.json": pkg() });
  expect(await releaseCli(["lane", "--base", "v1.0.0"], a.d)).toBe(0);
  expect(a.out).toEqual(["lane=runtime"]);
  expect(a.err).toEqual(["packaging/install.sh changed"]);
  const b = deps({ "ts/package.json": pkg() }, { "diff --name-only v1.0.0...HEAD": "ts/packages/ui/src/a.ts\n", "show v1.0.0:ts/package.json": pkg() });
  await releaseCli(["lane", "--base", "v1.0.0", "--force", "auto"], b.d);
  expect(b.out).toEqual(["lane=bundle"]);
  const c = deps({ "ts/package.json": pkg() }, { "diff --name-only v1.0.0...HEAD": "ts/packages/ui/src/a.ts\n", "show v1.0.0:ts/package.json": pkg() });
  await releaseCli(["lane", "--base", "v1.0.0", "--force", "runtime"], c.d);
  expect(c.out).toEqual(["lane=runtime"]);
  expect(c.err).toEqual(["lane forced to runtime"]);
  const first = deps({}, {});
  await releaseCli(["lane", "--first"], first.d);
  expect(first.out).toEqual(["lane=runtime"]);
  const none = deps({}, {});
  expect(await releaseCli(["lane"], none.d)).toBe(2);
  expect(await releaseCli([], none.d)).toBe(2);
});

test("a base without ts/package.json counts as a runtime change", async () => {
  const a = deps({ "ts/package.json": pkg() }, { "diff --name-only v0.9.0...HEAD": "ts/x.ts\n" });
  await releaseCli(["lane", "--base", "v0.9.0"], a.d);
  expect(a.out).toEqual(["lane=runtime"]);
});

test("the manifest command writes harbor-app.json", async () => {
  const prev = JSON.stringify({ version: "1.0.0", minRuntime: "1.0.0", runtime: "1.0.0" });
  const a = deps({ "prev.json": prev }, {});
  expect(await releaseCli(["manifest", "--version", "1.0.1", "--lane", "bundle", "--previous", "prev.json", "--out", "m.json", "--apk-code", "1000001", "--video-id", "v2"], a.d)).toBe(0);
  expect(JSON.parse(a.written["m.json"] ?? "")).toEqual({ version: "1.0.1", minRuntime: "1.0.0", runtime: "1.0.0", video: { id: "v2", release: "1.0.1" }, apk: { code: 1000001, release: "1.0.1" } });
  expect(await releaseCli(["manifest", "--version", "1.0.1"], a.d)).toBe(2);
});
