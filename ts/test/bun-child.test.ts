import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("test CLI scripts and child bun commands use the suite's own Bun in its sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hts-bun-child-"));
  try {
    const script = join(dir, "fake-cli");
    const source = "console.log(JSON.stringify({ exe: process.execPath, version: process.versions.bun }));";
    writeFileSync(script, `#!/usr/bin/env bun\n${source}\n`);
    chmodSync(script, 0o700);
    for (const argv of [[script], ["bun", "-e", source]]) {
      const child = Bun.spawn(argv, { cwd: dir, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toEqual({ exe: process.execPath, version: process.versions.bun });
    }
    // Direct interpreter shebangs also work when callers omit env (Bun then uses its startup env),
    // and when a test deliberately gives its child a PATH with no toolchain at all.
    writeFileSync(script, `#!${process.execPath}\n${source}\n`);
    const direct = Bun.spawn([script], { cwd: dir, env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(direct.stdout).text(), direct.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ exe: process.execPath, version: process.versions.bun });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
