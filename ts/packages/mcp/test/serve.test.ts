import { expect, test } from "bun:test";
import * as mcp from "../src/mcp.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairAccount, serve } from "../src/serve.ts";

test("an unknown app is refused", async () => {
  const lines: string[] = [];
  const err = console.error;
  console.error = (m: string) => lines.push(m);
  try {
    expect(await serve(["nope"])).toBe(2);
    expect(await serve([])).toBe(2);
  } finally {
    console.error = err;
  }
  expect(lines).toEqual(["harbor app: unknown app", "harbor app: unknown app"]);
  expect(mcp.app("gmail")?.mcp).toEqual({ kind: "harbor", name: "gmail" });
});

test("the apps agents get from Harbor are the ones serve starts", async () => {
  const names = mcp.APPS.flatMap((a) => (a.mcp.kind === "harbor" ? [a.mcp.name] : []));
  expect(names).toEqual(["gmail", "discord"]);
});

test("Discord's repair runs on this PC's signed-in Claude Code, the main login first", () => {
  const dir = mkdtempSync(join(tmpdir(), "hrepair-"));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.HOME = dir;
    process.env.PATH = join(dir, "bin");
    expect(repairAccount()).toBeUndefined();
    mkdirSync(join(dir, ".claude2"));
    writeFileSync(join(dir, ".claude2", ".credentials.json"), "{}");
    expect(repairAccount()?.env).toContainEqual(["CLAUDE_CONFIG_DIR", join(dir, ".claude2")]);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", ".credentials.json"), "{}");
    const a = repairAccount();
    expect(a?.bin).toBe(join(dir, "bin", "claude"));
    expect(a?.env).toContainEqual(["CLAUDE_CONFIG_DIR", null]);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
