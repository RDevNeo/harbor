import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../src/paths.ts";
import { expectPerm } from "../../../test/perm.ts";

// Turns that start together each write the same app files (GitHub's signed-out hosts.yml): with one shared
// temporary name, one writer renamed the other's file away and the other's rename threw, killing its turn.
test("processes writing the same file at once all succeed, and leave only the whole file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hts-writeprivate-"));
  try {
    const file = join(dir, "hosts.yml");
    const paths = join(import.meta.dir, "../src/paths.ts");
    const script = `const { writePrivate } = await import(${JSON.stringify(paths)});
for (let i = 0; i < 300; i++) writePrivate(${JSON.stringify(file)}, "github.com:\\n    user: harbor\\n".repeat(50));`;
    const ps = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }));
    const ends = await Promise.all(ps.map(async (p) => [await p.exited, await new Response(p.stderr).text()] as const));
    expect(ends.filter(([code]) => code !== 0)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("github.com:\n    user: harbor\n".repeat(50));
    expectPerm(file, 0o600);
    expect(readdirSync(dir)).toEqual(["hosts.yml"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a write that fails leaves no temporary file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "hts-writeprivate-"));
  try {
    // A folder where the file should go: the rename fails.
    const target = join(dir, "taken");
    mkdirSync(target);
    writePrivate(join(target, "x"), "inside");
    expect(() => writePrivate(target, "data")).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
