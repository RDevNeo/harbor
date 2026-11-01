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

  test("an unknown command and no command say what this build has", async () => {
    const [code, , err] = await harbor(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command frobnicate");
    expect(err).toContain("mesh");
    const [code2, , err2] = await harbor([]);
    expect(code2).toBe(2);
    expect(err2).toContain("the window isn't in this build yet");
  });

  test("mesh on, allow and remove write the kv a running Harbor re-reads", async () => {
    expect(await harbor(["mesh", "on"])).toEqual([0, "sharing chats with your other PCs: on\n", ""]);
    const fp = "ab".repeat(32);
    const [c1, o1] = await harbor(["mesh", "allow", fp]);
    expect([c1, o1]).toEqual([0, "allowed abab abab abab abab\n"]);
    const [c2, o2] = await harbor(["mesh", "remove", fp]);
    expect([c2, o2]).toEqual([0, "removed abab abab abab abab\n"]);
    expect((await harbor(["mesh", "join", "x"]))[0]).toBe(2);
  });

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
