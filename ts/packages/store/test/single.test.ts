import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, release } from "../src/single.ts";

test("a second instance on the same socket is refused until the first lets go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hsingle-"));
  const env = { HARBOR_SOCK: join(dir, "harbor.sock") };
  expect(await acquire(env)).toBe(true);
  const other = Bun.spawnSync([process.execPath, "-e", `import { acquire } from "${join(import.meta.dir, "../src/single.ts")}"; process.exit((await acquire(${JSON.stringify(env)})) ? 0 : 3);`]);
  expect(other.exitCode).toBe(3);
  release();
  const after = Bun.spawnSync([process.execPath, "-e", `import { acquire } from "${join(import.meta.dir, "../src/single.ts")}"; process.exit((await acquire(${JSON.stringify(env)})) ? 0 : 3);`]);
  expect(after.exitCode).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});
