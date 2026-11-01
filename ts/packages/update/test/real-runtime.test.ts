import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const script = resolve(here, "..", "..", "..", "scripts", "build.ts");
const scratch = resolve(here, "..", ".tmp");
const folders: string[] = [];

function folder(prefix: string): string {
  mkdirSync(scratch, { recursive: true });
  const d = mkdtempSync(join(scratch, prefix));
  folders.push(d);
  return d;
}
let dir = "";

async function run(args: string[], isolated = true): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: isolated ? { ...process.env, HOME: dir, XDG_RUNTIME_DIR: dir } : process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

beforeAll(async () => {
  dir = folder("real-");
  writeFileSync(join(dir, ".managed"), "");
  writeFileSync(join(dir, "VERSION"), "0.2.0");
  expect((await run([process.execPath, script, "runtime", join(dir, "harbor"), "--version", "0.1.0"], false)).code).toBe(0);
  expect((await run([process.execPath, script, "app", join(dir, "harbor-app.js"), "--version", "0.2.0", "--min-runtime", "0.1.0", "--sha", "abcdef0123"], false)).code).toBe(0);
}, 120_000);

afterAll(() => {
  for (const d of folders) rmSync(d, { recursive: true, force: true });
});

test("the compiled runtime says its version and loads the real bundle built for it", async () => {
  expect(await run([join(dir, "harbor"), "runtime-version"])).toMatchObject({ out: "0.1.0", code: 0 });
  expect(await run([join(dir, "harbor"), "smoke-bundle", join(dir, "harbor-app.js")])).toMatchObject({ out: "harbor 0.2.0", code: 0 });
  expect(await run([join(dir, "harbor"), "--version"])).toMatchObject({ out: "harbor 0.2.0 (abcdef0)", code: 0 });
  expect(await run([join(dir, "harbor"), "preview", "status"])).toMatchObject({ out: "Previews are off on this PC.\nRunning the release.", code: 0 });
});

test("an unknown command is refused by the bundle", async () => {
  const r = await run([join(dir, "harbor"), "bogus"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown command bogus");
});

test("a bundle built for a newer runtime is refused before it runs", async () => {
  const other = folder("other-");
  const built = await run([process.execPath, script, "app", join(other, "harbor-app.js"), "--version", "0.3.0", "--min-runtime", "9.0.0"], false);
  expect(built.code).toBe(0);
  const r = await run([join(dir, "harbor"), "smoke-bundle", join(other, "harbor-app.js")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("needs runtime 9.0.0 or newer; this is 0.1.0");
});

test("--restore-previous with nothing kept says so and fails", async () => {
  const r = await run([join(dir, "harbor"), "--restore-previous"]);
  expect(r).toMatchObject({ code: 1, err: "harbor: no previous version kept" });
});
