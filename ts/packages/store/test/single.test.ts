import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, placeEnv, placeRule, release } from "../src/single.ts";

test("a second instance on the same socket is refused until the first lets go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hsingle-"));
  const env = { HARBOR_SOCK: join(dir, "harbor.sock") };
  expect(await acquire(env)).toBe(true);
  const other = Bun.spawnSync([process.execPath, "-e", `import { acquire } from ${JSON.stringify(join(import.meta.dir, "../src/single.ts"))}; process.exit((await acquire(${JSON.stringify(env)})) ? 0 : 3);`]);
  expect(other.exitCode).toBe(3);
  release();
  const after = Bun.spawnSync([process.execPath, "-e", `import { acquire } from ${JSON.stringify(join(import.meta.dir, "../src/single.ts"))}; process.exit((await acquire(${JSON.stringify(env)})) ? 0 : 3);`]);
  expect(after.exitCode).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("a restart's window opens on the old one's workspace, without focus unless it had it, a floating one in its place", () => {
  const tiled = { pid: 1, workspace: { id: 3, name: "3" }, floating: false, at: [10, 20] as [number, number], size: [800, 600] as [number, number] };
  expect(placeRule(tiled, true)).toBe('{ workspace = "3 silent" }');
  expect(placeRule(tiled, false)).toBe('{ workspace = "3 silent", no_initial_focus = true, focus_on_activate = false }');
  expect(placeRule({ ...tiled, floating: true }, true)).toBe('{ workspace = "3 silent", float = true, move = "10 20", size = "800 600" }');
  expect(placeRule({ pid: 1, workspace: { id: -98, name: "special:scratchpad" } }, false)).toContain('workspace = "special:scratchpad silent"');
  expect(placeRule({ pid: 1, workspace: { id: 7, name: "web" } }, true)).toBe('{ workspace = "name:web silent" }');
  expect(placeRule({ pid: 1 }, true)).toBeNull();
});

test("no Hyprland, no placing", async () => {
  expect(await placeEnv({})).toEqual({});
});
