import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { choose, installedConfig, isWindowLaunch, launch } from "../src/launcher.ts";
import { rolledBack, skipped } from "../src/install.ts";
import { readAttempt } from "../src/startup.ts";
import { writeMeta, type Meta } from "../src/previewmeta.ts";
import { cleanup, configFor, makeInstall, tmp, wait, type Install } from "./support.ts";

afterEach(cleanup);

const src = join(dirname(new URL(import.meta.url).pathname), "..", "src");

const goodBundle = (version: string, marker: string): string => `import { writeFileSync } from "node:fs";
import { defaultConfig } from ${JSON.stringify(join(src, "config.ts"))};
import { confirmStart } from ${JSON.stringify(join(src, "startup.ts"))};
export const meta = { version: ${JSON.stringify(version)}, minRuntime: "1.0.0" };
export async function main(argv) {
  writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)} + " " + JSON.stringify(argv));
  await confirmStart(defaultConfig(), 20);
  return 0;
}
`;

const crashingBundle = (version: string): string => `export const meta = { version: ${JSON.stringify(version)}, minRuntime: "1.0.0" };
export async function main() { throw new Error("boom"); }
`;

const previous = (inst: Install, version: string, source: string): void => {
  mkdirSync(join(inst.dir, ".previous"));
  writeFileSync(join(inst.dir, ".previous", "harbor-app.js"), source);
  writeFileSync(join(inst.dir, ".previous", "VERSION"), version);
};

const run = async (inst: Install, args: string[] = []): Promise<number> => await Bun.spawn([inst.exe, ...args], { stdout: "ignore", stderr: "ignore" }).exited;

test("the runtime loads the bundle beside it, passes its arguments and a good start is confirmed", async () => {
  const marker = join(tmp(), "ran");
  const inst = makeInstall({ version: "1.1.0", bundle: goodBundle("1.1.0", marker) });
  expect(await run(inst)).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("1.1.0 []");
  const a = readAttempt(inst.dir);
  expect(a).toMatchObject({ stage: "ok", kind: "release", version: "1.1.0" });
  expect(skipped(configFor(inst), "1.1.0")).toBe(false);
});

test("a bundle that crashes on start falls back to the previous one, which is skipped on this PC and the mesh can be told", async () => {
  const marker = join(tmp(), "ran");
  const inst = makeInstall({ version: "1.1.0", bundle: crashingBundle("1.1.0") });
  previous(inst, "1.0.0", goodBundle("1.0.0", marker));
  const code = await run(inst, ["--background"]);
  expect(code).not.toBe(0);
  await wait(() => existsSync(marker) && readAttempt(inst.dir)?.stage === "ok");
  expect(readFileSync(marker, "utf8")).toBe('1.0.0 ["--background"]');
  const cfg = configFor(inst);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(skipped(cfg, "1.1.0")).toBe(true);
  expect(rolledBack(cfg)).toMatchObject({ version: "1.1.0", restored: "1.0.0", why: "it exited while starting" });
  expect(existsSync(join(inst.dir, ".previous"))).toBe(false);
});

test("a helper command such as harbor turn does not start an attempt that could roll Harbor back", async () => {
  const marker = join(tmp(), "ran");
  const inst = makeInstall({ version: "1.1.0", bundle: goodBundle("1.1.0", marker) });
  expect(await run(inst, ["turn", "x"])).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe('1.1.0 ["turn","x"]');
  expect(readAttempt(inst.dir)).toBeNull();
});

const liveAttempt = (inst: Install, pid: number, stage: "trying" | "ok"): void =>
  writeFileSync(join(inst.dir, "starting.json"), JSON.stringify({ version: "1.1.0", pid, at: Date.now(), stage, kind: "release", args: [], id: "" }));

test("a second Harbor started while one runs leaves that one's start alone, and a restart takes over from the one it replaces", async () => {
  const inst = makeInstall({ version: "1.1.0" });
  const cfg = configFor(inst);
  const first = Bun.spawn(["sleep", "30"]);
  try {
    const bundle = { meta: { version: "1.1.0", minRuntime: "1.0.0" }, main: () => 0 };
    const opts = { cfg, load: async () => bundle, armWatchdog: false };
    liveAttempt(inst, first.pid, "ok");
    await launch([], { ...opts, env: {} });
    expect(readAttempt(inst.dir)).toMatchObject({ pid: first.pid, stage: "ok" });
    await launch([], { ...opts, env: { HARBOR_RELOADED_PID: String(first.pid) } });
    expect(readAttempt(inst.dir)).toMatchObject({ pid: process.pid, stage: "trying" });
  } finally {
    first.kill();
  }
});

test("windows are watched, helper commands are not", () => {
  expect(isWindowLaunch([])).toBe(true);
  expect(isWindowLaunch(["--background"])).toBe(true);
  expect(isWindowLaunch(["turn"])).toBe(false);
  expect(isWindowLaunch(["--version"])).toBe(false);
  expect(isWindowLaunch(["--background", "x"])).toBe(false);
});

test("runtime-version and smoke-bundle answer without starting the app", async () => {
  const marker = join(tmp(), "ran");
  const inst = makeInstall({ version: "1.1.0", runtime: "1.4.0", bundle: goodBundle("1.1.0", marker) });
  const out = async (args: string[]): Promise<string> => {
    const p = Bun.spawn([inst.exe, ...args], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text.trim();
  };
  expect(await out(["runtime-version"])).toBe("1.4.0");
  expect(await out(["smoke-bundle", join(inst.dir, "harbor-app.js")])).toBe("harbor 1.1.0");
  expect(existsSync(marker)).toBe(false);
  const junk = join(tmp(), "junk.js");
  writeFileSync(junk, "export const x = 1;");
  expect(await out(["smoke-bundle", junk])).toBe("");
});

test("launch reports a file that is not a bundle and runs main with the arguments", async () => {
  const errs: string[] = [];
  const outs: string[] = [];
  const cfg = configFor(null, { exe: join(tmp(), "harbor") });
  const bad = await launch(["x"], { cfg, load: async () => ({}), err: (l) => void errs.push(l), out: (l) => void outs.push(l) });
  expect(bad).toBe(1);
  expect(errs[0]).toContain("is not a Harbor bundle");
  let got: string[] = [];
  const ok = await launch(["a", "b"], {
    cfg,
    load: async () => ({
      meta: { version: "1.0.0", minRuntime: "1.0.0" },
      main: (argv: string[]) => {
        got = argv;
        return 7;
      },
    }),
  });
  expect(ok).toBe(7);
  expect(got).toEqual(["a", "b"]);
});

const meta = (over: Partial<Meta> = {}): Meta => ({ id: "abc", sha256: "00", version: "1.2.0", note: "", from: "", at: 5, stage: "ok", why: "", shown_ms: 0, ...over });

test("a waiting preview is chosen only when previews are on, the slot is there and the release hasn't passed it", () => {
  const inst = makeInstall({ version: "1.1.0" });
  const cfg = configFor(inst);
  expect(choose(cfg).kind).toBe("release");
  writeMeta(inst.dir, meta());
  expect(choose(cfg).kind).toBe("release");
  writeFileSync(join(inst.dir, ".preview"), "");
  expect(choose(cfg).kind).toBe("release");
  writeMeta(inst.dir, meta());
  writeFileSync(join(inst.dir, "harbor-preview.js"), "x");
  expect(choose(cfg)).toMatchObject({ kind: "preview", id: "abc", version: "1.2.0" });
  writeMeta(inst.dir, meta({ stage: "failed" }));
  expect(choose(cfg).kind).toBe("release");
  writeMeta(inst.dir, meta({ version: "1.0.5" }));
  expect(choose(cfg).kind).toBe("release");
  expect(existsSync(join(inst.dir, "preview.json"))).toBe(false);
});

test("a source build runs the bundle beside the executable without watching anything", () => {
  const cfg = configFor(null, { exe: "/opt/x/harbor" });
  expect(choose(cfg)).toMatchObject({ kind: "release", path: "/opt/x/harbor-app.js" });
});

test("harbor --update and --restore-previous see the installed version, not the runtime's", () => {
  const inst = makeInstall({ version: "1.1.0", bundle: crashingBundle("1.1.0") });
  const cfg = { ...configFor(inst), version: "0.0.0-dev" };
  expect(installedConfig(cfg).version).toBe("1.1.0");
  expect(installedConfig({ ...cfg, dir: null }).version).toBe("0.0.0-dev");
});
