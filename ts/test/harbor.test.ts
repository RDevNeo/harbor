import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const root = mkdtempSync(join(tmpdir(), "harbor-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = { HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "cfg"), PATH: process.env.PATH ?? "" };

async function harbor(args: string[], stdin = ""): Promise<[number, string, string]> {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "harbor.ts"), ...args], { env, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return [await p.exited, out, err];
}

describe("harbor (main.rs)", () => {
  test("--version and -V", async () => {
    expect(await harbor(["--version"])).toEqual([0, `harbor ${pkg.version} (ts)\n`, ""]);
    expect((await harbor(["-V"]))[1]).toBe(`harbor ${pkg.version} (ts)\n`);
  });

  test("an unknown command says what this build has", async () => {
    const [code, , err] = await harbor(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command frobnicate");
    expect(err).toContain("mesh");
  });

  test("--check-video names the player it would use, or says it has none", async () => {
    const [code, out, err] = await harbor(["--check-video"]);
    const text = out + err;
    expect(text).toMatch(/^(player: |no video player: )/);
    expect(code).toBe(text.startsWith("player: ") ? 0 : 1);
  });

  test("mesh status runs; the pairing commands are gone", async () => {
    const [code, out] = await harbor(["mesh", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("this workspace's PCs:");
    expect((await harbor(["mesh", "pair"]))[0]).toBe(2);
    expect((await harbor(["mesh", "join", "x", "y"]))[0]).toBe(2);
    // Three whole-Harbor starts: 2-3 s on a quick sandbox, twice that on a slow one.
  }, 20_000);

  test("nc pipes stdin to a host's port and back", async () => {
    const s = createServer((c) => c.pipe(c));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    const [code, out] = await harbor(["nc", "127.0.0.1", String(port)], "hello through nc");
    s.close();
    expect([code, out]).toEqual([0, "hello through nc"]);
    expect((await harbor(["nc"]))[0]).toBe(2);
  });
});
